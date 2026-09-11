import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
export * from "drizzle-orm"
import { LocalContext } from "../util"
import { lazy } from "../util/lazy"
import { Global } from "../global"
import { Log } from "../util"
import { NamedError } from "@duoduo-ai/shared/util/error"
import z from "zod"
import path from "path"
import { readFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from "fs"
import { Flag } from "../flag/flag"
import { InstallationChannel } from "../installation/version"
import { InstanceState } from "@/effect"
import { registerDisposer } from "@/effect/instance-registry"
import { iife } from "@/util/iife"
import { init } from "#db"
import { Instance } from "@/project/instance"
import { projectDataDir } from "./project-dir"

declare const DUODUO_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

export function getChannelPath() {
  if (["latest", "beta", "prod"].includes(InstallationChannel) || Flag.DUODUO_DISABLE_CHANNEL_DB)
    return path.join(Global.Path.data, "duoduo.db")
  const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
  return path.join(Global.Path.data, `duoduo-${safe}.db`)
}

export const Path = iife(() => {
  if (Flag.DUODUO_DB) {
    if (Flag.DUODUO_DB === ":memory:" || path.isAbsolute(Flag.DUODUO_DB)) return Flag.DUODUO_DB
    return path.join(Global.Path.data, Flag.DUODUO_DB)
  }
  return getChannelPath()
})

export type Transaction = SQLiteTransaction<"sync", void>

type Client = ReturnType<typeof init>

type Journal = { sql: string; timestamp: number; name: string }[]

// ---------------------------------------------------------------------------
// Per-DB migration scope filtering
// ---------------------------------------------------------------------------

/** Tables that belong to the global DB (cross-project). */
const GLOBAL_TABLES = new Set([
  "project",
  "account",
  "account_state",
  "control_account",
  "workspace",
  "event",
  "event_sequence",
])

/** Tables that belong to the project DB (per-project, shared with Rust). */
const PROJECT_TABLES = new Set(["session", "message", "part", "todo", "permission", "session_entry"])

/**
 * Extract table names referenced by a single SQL statement.
 * Covers CREATE TABLE, ALTER TABLE, DROP TABLE, CREATE INDEX, DROP INDEX,
 * INSERT INTO, UPDATE, DELETE FROM, and PRAGMA foreign_keys patterns.
 */
function extractTableRefs(sql: string): Set<string> {
  const tables = new Set<string>()
  const normalized = sql.trim().toLowerCase()

  // CREATE TABLE `name` / CREATE TABLE IF NOT EXISTS `name`
  let m = normalized.match(/create\s+table\s+(?:if\s+not\s+exists\s+)?`?(\w+)/)
  if (m) {
    tables.add(m[1]!)
    return normalizeTempTables(tables)
  }

  // ALTER TABLE `name`
  m = normalized.match(/alter\s+table\s+`?(\w+)/)
  if (m) {
    tables.add(m[1]!)
    return normalizeTempTables(tables)
  }

  // DROP TABLE `name` / DROP TABLE IF EXISTS `name`
  m = normalized.match(/drop\s+table\s+(?:if\s+exists\s+)?`?(\w+)/)
  if (m) {
    tables.add(m[1]!)
    return normalizeTempTables(tables)
  }

  // CREATE INDEX `idx` ON `table` / CREATE INDEX IF NOT EXISTS `idx` ON `table`
  m = normalized.match(/create\s+index\s+(?:if\s+not\s+exists\s+)?`?\w+`?\s+on\s+`?(\w+)/)
  if (m) {
    tables.add(m[1]!)
    return normalizeTempTables(tables)
  }

  // DROP INDEX `idx` — no table ref, return empty (index-only, skip unless we can
  // determine the table; but DROP INDEX doesn't reference a table directly)
  m = normalized.match(/drop\s+index\s+(?:if\s+exists\s+)?`?(\w+)/)
  if (m) {
    return tables
  } // can't determine table from DROP INDEX alone

  // INSERT INTO `name`
  m = normalized.match(/insert\s+into\s+`?(\w+)/)
  if (m) {
    tables.add(m[1]!)
    return normalizeTempTables(tables)
  }

  // UPDATE `name`
  m = normalized.match(/update\s+`?(\w+)/)
  if (m) {
    tables.add(m[1]!)
    return normalizeTempTables(tables)
  }

  // DELETE FROM `name`
  m = normalized.match(/delete\s+from\s+`?(\w+)/)
  if (m) {
    tables.add(m[1]!)
    return normalizeTempTables(tables)
  }

  // PRAGMA foreign_keys=OFF / ON — always allow
  if (normalized.startsWith("pragma")) {
    return tables
  }

  return normalizeTempTables(tables)
}

/**
 * Map Drizzle's temporary table names (e.g. `__new_workspace`) back to the
 * original table name (`workspace`). This is critical for SQLite table-rebuild
 * migrations: Drizzle uses `CREATE TABLE __new_X → INSERT INTO __new_X SELECT
 * FROM X → DROP TABLE X → ALTER TABLE __new_X RENAME TO X` to work around
 * SQLite's lack of DROP COLUMN. Without this normalization, `__new_workspace`
 * is an unknown table → included in both scopes → the CREATE and RENAME
 * statements run in the project DB but INSERT/DROP are filtered out (they
 * reference the global table `workspace`), leaving a half-rebuilt table.
 */
function normalizeTempTables(tables: Set<string>): Set<string> {
  const result = new Set<string>()
  for (const t of tables) {
    if (t.startsWith("__new_")) {
      result.add(t.slice(6)) // __new_workspace → workspace
    } else {
      result.add(t)
    }
  }
  return result
}

/**
 * Determine if a SQL statement belongs to the given scope.
 * - If the statement references tables from only one scope, it belongs to that scope.
 * - If it references tables from both scopes (mixed), include it in both (conservative).
 * - If no table can be determined (e.g. PRAGMA, SELECT), include it in both.
 */
function statementBelongsToScope(sql: string, scope: "global" | "project"): boolean {
  const refs = extractTableRefs(sql)
  if (refs.size === 0) return true // PRAGMA, SELECT, etc. — always include

  const scopeSet = scope === "global" ? GLOBAL_TABLES : PROJECT_TABLES
  const otherSet = scope === "global" ? PROJECT_TABLES : GLOBAL_TABLES

  let hasScope = false
  let hasOther = false
  for (const t of refs) {
    if (scopeSet.has(t)) hasScope = true
    else if (otherSet.has(t)) hasOther = true
  }

  // If it only references tables from the other scope, exclude it.
  // If it references our scope (with or without the other), include it.
  // If it references neither (unknown table), include it.
  if (hasOther && !hasScope) return false
  return true
}

/**
 * Filter a migration journal entry's SQL for a given scope.
 * Splits on `--> statement-breakpoint`, filters each statement,
 * and re-joins. If no statements remain, returns `"SELECT 1;"` so
 * drizzle still records the migration as applied.
 */
function filterMigrationSql(sql: string, scope: "global" | "project"): string {
  const statements = sql.split("--> statement-breakpoint")
  const filtered = statements.filter((s) => statementBelongsToScope(s, scope))
  // If only PRAGMA statements remain (no actual table operations), treat as
  // no-op. This happens when a migration rebuilds a table that belongs to the
  // other scope — the CREATE/INSERT/DROP/RENAME are filtered out, leaving
  // only the surrounding PRAGMA foreign_keys=OFF/ON statements.
  const hasNonPragma = filtered.some((s) => {
    const normalized = s.trim().toLowerCase()
    return normalized.length > 0 && !normalized.startsWith("pragma")
  })
  if (!hasNonPragma) return "SELECT 1;"
  return filtered.join("--> statement-breakpoint")
}

// ---------------------------------------------------------------------------
// Backward-compat: remove cross-DB FK constraints from legacy project DBs
// ---------------------------------------------------------------------------

/**
 * Remove cross-DB FK constraints from the project DB.
 * Older project DBs may have been created with FK constraints referencing
 * global tables (e.g. session.project_id → project.id). These are invalid
 * in a split-DB setup and must be removed before enabling foreign_keys=ON.
 *
 * Uses the known current schema for each table to rebuild without cross-DB FKs.
 * This is safe because drizzle migrations have already been applied, so the
 * table structure matches the current schema definition.
 */
function removeCrossDbForeignKeys(db: Client): void {
  // Rebuild a table without its cross-DB foreign-key constraints.
  // Columns are read LIVE from the table (via PRAGMA table_info) so the rebuild
  // always matches the real on-disk schema — even when migrations added/removed
  // columns (e.g. `share_url`) that this compatibility shim doesn't know about.
  // This also self-heals a DB that previously crashed mid-rebuild and left a
  // dangling `__new_<table>` behind (DROP TABLE IF EXISTS first).
  const rebuild = (table: string) => {
    let hasCrossDbFk = false
    try {
      const fkRows = db.all(`PRAGMA foreign_key_list("${table}")`) as Array<{ table: string }>
      hasCrossDbFk = fkRows.some((fk) => GLOBAL_TABLES.has(fk.table))
    } catch {
      return // table doesn't exist
    }
    if (!hasCrossDbFk) return

    const cols = db.all(`PRAGMA table_info("${table}")`) as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: unknown
      pk: number
    }>
    if (cols.length === 0) return

    const defs = cols
      .map((c) => {
        let def = `"${c.name}" ${c.type ?? ""}`
        if (c.notnull) def += " NOT NULL"
        if (c.dflt_value !== null && c.dflt_value !== undefined) def += ` DEFAULT ${String(c.dflt_value)}`
        if (c.pk) def += " PRIMARY KEY"
        return def
      })
      .join(", ")
    const colNames = cols.map((c) => `"${c.name}"`).join(", ")

    db.run("PRAGMA foreign_keys = OFF")
    db.run(`DROP TABLE IF EXISTS "__new_${table}"`)
    db.run(`CREATE TABLE "__new_${table}" (${defs})`)
    db.run(`INSERT INTO "__new_${table}" (${colNames}) SELECT ${colNames} FROM "${table}"`)
    db.run(`DROP TABLE "${table}"`)
    db.run(`ALTER TABLE "__new_${table}" RENAME TO "${table}"`)
  }

  // Create an index only when its column actually exists. This function's whole
  // job is to repair databases whose schema drifted (`rebuild` above already
  // bails out on missing tables), so it must not itself become the reason a
  // drifted database cannot be opened.
  const createIndexIfColumn = (name: string, table: string, column: string) => {
    try {
      const cols = db.all(`PRAGMA table_info("${table}")`) as Array<{ name: string }>
      if (!cols.some((c) => c.name === column)) return
      db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${column})`)
    } catch {
      // table or column absent — nothing to index
    }
  }

  log.info("removing cross-DB FK constraints from project DB")
  rebuild("session")
  // Recreate session indexes (dropped together with the table above).
  createIndexIfColumn("session_project_idx", "session", "project_id")
  createIndexIfColumn("session_workspace_idx", "session", "workspace_id")
  createIndexIfColumn("session_parent_idx", "session", "parent_id")
  rebuild("permission")

  // Drop global-table shells that may exist in the project DB from legacy
  // full-scope migrations. These tables are empty (no data) and their FK
  // constraints reference tables that don't exist in the project DB.
  for (const table of GLOBAL_TABLES) {
    try {
      db.run(`DROP TABLE IF EXISTS "${table}"`)
    } catch {
      // ignore — table may have dependent objects
    }
  }

  log.info("cross-DB FK constraints removed from project DB")
}

/**
 * Ensure the global `project` table has the `remote` and `local_mirror` columns.
 *
 * These columns were added to the initial CREATE TABLE migration at the same time
 * the remote-project feature landed (commit a8fea302, 2026-08-07). Databases
 * created from the initial migration *before* that point therefore lack the
 * columns, and since drizzle only runs migrations by folder name (never re-runs a
 * folder whose name is already recorded in `__drizzle_migrations`), a plain ALTER
 * migration would either be skipped on old DBs or fail with "duplicate column" on
 * DBs that already have the columns. The only SQLite-safe, idempotent fix is a
 * runtime check: add each missing column only if `PRAGMA table_info` shows it is
 * absent. This mirrors the existing `removeCrossDbForeignKeys` self-heal pattern.
 */
function ensureProjectRemoteColumns(db: Client): void {
  try {
    const cols = new Set(
      (db.all(`PRAGMA table_info("project")`) as Array<{ name: string }>).map((c) => c.name),
    )
    for (const col of ["remote", "local_mirror"] as const) {
      if (!cols.has(col)) {
        db.run(`ALTER TABLE "project" ADD "${col}" text`)
        log.info("added missing project column", { column: col })
      }
    }
  } catch (e) {
    log.warn("ensureProjectRemoteColumns failed", { error: e })
  }
}

/** Prefix used to park tables that no migration journal accounts for. */
const UNMANAGED_PREFIX = "__unmanaged_"

/**
 * Park every table of a project DB that was created outside of the Drizzle
 * migration chain, so the migrations can build the current schema.
 *
 * A project DB can end up holding tables that no `__drizzle_migrations` row
 * accounts for. The Rust sidecar's `MessageStore` used to run
 * `CREATE TABLE IF NOT EXISTS session/message/part` against
 * `<data>/database/<project_id>/duoduo.db` — a stale fork of the schema. With
 * no journal entry, drizzle treats the file as un-migrated and replays the
 * initial migration, which then dies on "table message already exists". The
 * project can never be opened again, and reinstalling the app does not help
 * because the data directory survives the uninstall.
 *
 * Nothing is lost: each pre-existing table is renamed aside, the migrations
 * build the fresh schema, and {@link restoreUnmanagedTables} copies the rows
 * back over the column intersection before dropping the shells.
 *
 * Requires `PRAGMA foreign_keys = OFF` (guaranteed by the caller) and must run
 * before {@link applyMigrations}.
 *
 * @returns the parked table names, or `[]` when the DB is already managed.
 */
function healUnmanagedTables(client: Client): string[] {
  // A DB is managed once its journal holds at least one applied migration.
  // An *empty* journal table proves nothing: drizzle creates the table before
  // it runs any statement, so a migrate() that died midway — exactly what
  // happens on "table message already exists" — leaves the table behind with
  // zero rows, and every later open keeps replaying and failing forever.
  let journaled = false
  try {
    journaled = (client.all(`SELECT id FROM __drizzle_migrations LIMIT 1`) as Array<{ id: number }>).length > 0
  } catch {
    journaled = false
  }
  if (journaled) return []

  const tables = (client.all(`SELECT name FROM sqlite_master WHERE type = 'table'`) as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_") && name !== "__drizzle_migrations")
  if (tables.length === 0) return [] // brand-new file, nothing to heal

  log.info("healing project DB created outside of the migration chain", { tables })
  // The journal holds no applied migration, so it carries no information.
  // Drop it and let drizzle recreate it in the shape it expects.
  client.run(`DROP TABLE IF EXISTS __drizzle_migrations`)
  const parked: string[] = []
  for (const table of tables) {
    const shell = UNMANAGED_PREFIX + table
    client.run(`DROP TABLE IF EXISTS "${shell}"`)
    client.run(`ALTER TABLE "${table}" RENAME TO "${shell}"`)
    // SQLite keeps index names when a table is renamed, and a foreign copy of
    // the schema picks some of the same names the migrations use (e.g.
    // `part_session_idx`). Drop the explicitly created ones so the migrations
    // can build their own; the shells only need their columns for the copy.
    for (const index of client.all(`PRAGMA index_list("${shell}")`) as Array<{
      name: string
      origin: string
    }>) {
      // `origin` is "c" for CREATE INDEX, "u"/"pk" for table constraints —
      // the latter are owned by the table and must not be dropped here.
      if (index.origin === "c") client.run(`DROP INDEX IF EXISTS "${index.name}"`)
    }
    parked.push(shell)
  }
  return parked
}

/**
 * Put back what {@link healUnmanagedTables} parked: for tables the migrations
 * built, copy the rows over the column intersection and drop the shell; for
 * tables the migrations never built (not theirs), restore the original name.
 */
function restoreUnmanagedTables(client: Client, parked: string[]): void {
  for (const shell of parked) {
    const table = shell.slice(UNMANAGED_PREFIX.length)
    try {
      if (tableColumns(client, `main."${table}"`).length === 0) {
        // The migrations never built this table, so it is not theirs (e.g. the
        // sidecar's kg_*/memory_* tables, which live in the same file). Put it
        // back under its own name instead of dropping it — dropping would
        // destroy data the migration chain knows nothing about.
        client.run(`ALTER TABLE "${shell}" RENAME TO "${table}"`)
        continue
      }
      copyRows(client, `main."${shell}"`, `main."${table}"`)
      client.run(`DROP TABLE "${shell}"`)
    } catch (e) {
      log.warn("could not restore rows parked outside the migration chain; keeping the shell", {
        table: shell,
        error: e,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy project-DB migration: <project>/.duoduo/duoduo.db → <data>/database/<id>/duoduo.db
// ---------------------------------------------------------------------------

/**
 * Column names of a (possibly schema-qualified) table, or `[]` when the table
 * does not exist. `qualified` is a `"schema"."table"` pair such as
 * `main."message"` or `legacy."message"`.
 */
function tableColumns(client: Client, qualified: string): string[] {
  const dot = qualified.indexOf(".")
  const schema = qualified.slice(0, dot)
  const table = qualified.slice(dot + 1)
  try {
    return (client.all(`PRAGMA ${schema}.table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
  } catch {
    return []
  }
}

/**
 * Copy rows between two tables using their **column intersection**, so a
 * source table from an older (or foreign) schema still copies cleanly.
 * `INSERT OR IGNORE` keeps rows already present in the destination.
 * No-op when the two tables share no column.
 */
function copyRows(client: Client, from: string, to: string): number {
  const fromCols = new Set(tableColumns(client, from))
  const cols = tableColumns(client, to).filter((c) => fromCols.has(c))
  if (cols.length === 0) return 0
  const colList = cols.map((c) => `"${c}"`).join(", ")
  client.run(`INSERT OR IGNORE INTO ${to} (${colList}) SELECT ${colList} FROM ${from}`)
  return cols.length
}

/**
 * One-time migration of the legacy in-project database into the relocated
 * per-project database. Before the relocation, all project state (sessions,
 * messages, parts, …) lived at `<project>/.duoduo/duoduo.db`. Moving the DB
 * without migrating stranded the entire conversation history in the old file
 * — the Rust runLoop then reconstructed empty histories from the new DB
 * (root cause of the "greeting triggers arbitrary tool calls" regression).
 *
 * Strategy:
 * - Idempotent: a `__legacy_migration` marker row in the new DB guards
 *   against re-running (safe across restarts and concurrent opens via
 *   INSERT OR IGNORE + WAL busy_timeout).
 * - ATTACH the legacy file read-only-in-effect and copy each project-scoped
 *   table using the COLUMN INTERSECTION of both schemas, so legacy DBs from
 *   older migrations (missing/extra columns) still copy cleanly.
 * - `INSERT OR IGNORE` keeps any rows already written to the new DB (new DB
 *   wins on conflict — it holds the most recent activity).
 * - Runs while `PRAGMA foreign_keys = OFF` (caller guarantees this) so
 *   parent/child ordering cannot fail mid-copy.
 * - Any failure rolls back and leaves the legacy file untouched; the next
 *   open retries.
 */
function migrateLegacyProjectDb(client: Client, projectDir: string): void {
  const legacyPath = path.join(projectDir, ".duoduo", "duoduo.db")
  if (!existsSync(legacyPath)) return

  client.run(
    "CREATE TABLE IF NOT EXISTS __legacy_migration (id INTEGER PRIMARY KEY CHECK (id = 1), source TEXT NOT NULL, time INTEGER NOT NULL)",
  )
  const done = client.all("SELECT id FROM __legacy_migration WHERE id = 1") as Array<{ id: number }>
  if (done.length > 0) {
    // Data already lives in the relocated project DB. Remove any leftover legacy
    // files (duoduo.db + its -wal/-shm companions) so the project tree stays clean.
    log.info("legacy project DB already migrated, removing leftover legacy files", { legacyPath })
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(legacyPath + suffix)
      } catch {}
    }
    return
  }

  log.info("migrating legacy project DB", { from: legacyPath })
  const escaped = legacyPath.replace(/'/g, "''")
  try {
    client.run(`ATTACH DATABASE '${escaped}' AS legacy`)
  } catch (e) {
    log.warn("legacy project DB attach failed; skipping migration", { legacyPath, error: e })
    return
  }

  try {
    client.run("BEGIN IMMEDIATE")
    // Copy order respects parent→child relations (FKs are OFF, but keeping
    // referential order makes partial-failure states easier to reason about).
    const tables = ["session", "message", "part", "todo", "permission", "session_entry"]
    for (const table of tables) {
      const inLegacy = client.all(
        `SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name = '${table}'`,
      ) as Array<{ name: string }>
      if (inLegacy.length === 0) continue
      copyRows(client, `legacy."${table}"`, `main."${table}"`)
    }
    client.run(`INSERT INTO __legacy_migration (id, source, time) VALUES (1, '${escaped}', ${Date.now()})`)
    client.run("COMMIT")
    log.info("legacy project DB migration complete", { from: legacyPath })
  } catch (e) {
    try {
      client.run("ROLLBACK")
    } catch {}
    log.warn("legacy project DB migration failed; will retry on next open", { legacyPath, error: e })
  } finally {
    try {
      client.run("DETACH DATABASE legacy")
    } catch {}
    // Delete the legacy project DB only AFTER detaching it — while still attached,
    // Windows holds the file handle and unlinkSync fails (EBUSY), leaving duoduo.db
    // and its -wal/-shm companions in the project tree. SQLite creates -wal/-shm
    // automatically in WAL mode, so remove all three.
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(legacyPath + suffix)
      } catch {}
    }
  }
}

function time(tag: string) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
  if (!match) return 0
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )
}

function migrations(dir: string): Journal {
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  const sql = dirs
    .map((name) => {
      const file = path.join(dir, name, "migration.sql")
      if (!existsSync(file)) return
      return {
        sql: readFileSync(file, "utf-8"),
        timestamp: time(name),
        name,
      }
    })
    .filter(Boolean) as Journal

  return sql.sort((a, b) => a.timestamp - b.timestamp)
}

function applyMigrations(db: Client, scope: "global" | "project") {
  const entries =
    typeof DUODUO_MIGRATIONS !== "undefined"
      ? DUODUO_MIGRATIONS.map((e) => ({ ...e, sql: filterMigrationSql(e.sql, scope) }))
      : migrations(path.join(import.meta.dirname, "../../migration")).map((e) => ({
          ...e,
          sql: filterMigrationSql(e.sql, scope),
        }))
  if (entries.length > 0) {
    log.info("applying migrations", {
      scope,
      count: entries.length,
      mode: typeof DUODUO_MIGRATIONS !== "undefined" ? "bundled" : "dev",
    })
    if (Flag.DUODUO_SKIP_MIGRATIONS) {
      for (const item of entries) {
        item.sql = "select 1;"
      }
    }
    migrate(db, entries)
  }
}

export const Client = lazy(() => {
  log.info("opening global database", { path: Path })

  const db = init(Path)

  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA cache_size = -64000")
  db.run("PRAGMA foreign_keys = ON")
  db.run("PRAGMA wal_checkpoint(PASSIVE)")

  applyMigrations(db, "global")

  ensureProjectRemoteColumns(db)

  return db
})

// ---------------------------------------------------------------------------
// Project-level database (shared with Rust at <data dir>/database/<project_id>/duoduo.db)
// ---------------------------------------------------------------------------

/** Per-directory cache of project DB clients. */
const projectClients = new Map<string, Client>()

/**
 * Returns the DB path for the project-level database, derived from the current
 * Instance directory (`<data dir>/database/<project_id>/duoduo.db`).
 */
export function getProjectPath(directory?: string): string {
  const dir = directory ?? Instance.directory
  return path.join(projectDataDir(dir), "duoduo.db")
}

/**
 * Get (or create) the project-level DB client for a project directory.
 * Each project gets its own SQLite file at `<data dir>/database/<project_id>/duoduo.db`.
 *
 * When `directory` is omitted it defaults to the current Instance directory
 * (the common case). Passing an explicit directory lets cross-project queries
 * (e.g. `Session.listGlobal`) open any project's DB without an active Instance
 * context.
 */
function getProjectClient(directory?: string): Client {
  const dir = directory ?? Instance.directory
  const dbPath = getProjectPath(dir)

  let client = projectClients.get(dir)
  if (client) return client

  log.info("opening project database", { path: dbPath })

  // Ensure the project data directory exists
  const dbDir = path.dirname(dbPath)
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true })

  client = init(dbPath)

  client.run("PRAGMA journal_mode = WAL")
  client.run("PRAGMA synchronous = NORMAL")
  client.run("PRAGMA busy_timeout = 5000")
  // Temporarily disable foreign keys during migration so that legacy
  // cross-DB FK constraints (e.g. session.project_id → project.id) don't
  // cause INSERT failures. We'll re-enable and clean up after migration.
  client.run("PRAGMA foreign_keys = OFF")

  // Self-heal: park tables that exist without a migration journal before the
  // migrations run, otherwise replaying the initial migration fails with
  // "table message already exists" (see healUnmanagedTables).
  const parked = healUnmanagedTables(client)

  // Apply project-scoped migrations: only DDL for project-level tables
  // (session, message, part, todo, permission, session_entry) is executed.
  applyMigrations(client, "project")

  restoreUnmanagedTables(client, parked)

  // Backward-compat: remove cross-DB FK constraints from legacy migrations.
  // Older project DBs may have session.project_id → project(id) and
  // permission.project_id → project(id) FKs that are invalid in a split-DB
  // setup. Rebuild those tables without the cross-DB FKs.
  removeCrossDbForeignKeys(client)

  // One-time migration of the legacy in-project DB (<project>/.duoduo/duoduo.db)
  // into this relocated DB. Runs while foreign_keys is still OFF so table
  // copy order cannot trip FK checks. Idempotent via a marker table.
  migrateLegacyProjectDb(client, dir)

  // Now safe to enable foreign keys — only same-DB FKs remain
  // (e.g. message.session_id → session.id) which are valid and should be enforced.
  client.run("PRAGMA foreign_keys = ON")

  projectClients.set(dir, client)
  return client
}

/** All currently-open project clients (for shutdown / introspection). */
export function projectClientsOpen(): string[] {
  return [...projectClients.keys()]
}

// Register a disposer so that when an instance is disposed, its project DB
// client is closed and WAL is checkpointed.
registerDisposer(async (directory: string) => {
  closeProject(directory)
})

/** Close a single project DB client (called on instance dispose). */
export function closeProject(directory: string) {
  const client = projectClients.get(directory)
  if (!client) return
  try {
    client.run("PRAGMA wal_checkpoint(TRUNCATE)")
  } catch (e) {
    log.warn("project WAL checkpoint failed during close", { directory, error: e })
  }
  client.$client.close()
  projectClients.delete(directory)
}

/**
 * Close every cached project DB client whose data directory is the one for
 * `directory`. The instance disposer closes only the client keyed by the
 * instance directory, but cross-project queries (`withProjectDb`) may hold the
 * same DB under the project's worktree spelling. On Windows an open handle
 * would block deleting the project data directory, so the destroy path closes
 * every spelling variant before `rmSync`.
 */
export function closeProjectClientsMatching(directory: string) {
  const target = getProjectPath(directory)
  for (const [dir, client] of [...projectClients]) {
    if (getProjectPath(dir) !== target) continue
    try {
      client.run("PRAGMA wal_checkpoint(TRUNCATE)")
    } catch (e) {
      log.warn("project WAL checkpoint failed during close", { directory: dir, error: e })
    }
    client.$client.close()
    projectClients.delete(dir)
  }
}

export function close() {
  // Close global DB
  try {
    // Checkpoint WAL before closing to ensure all data is flushed to the
    // main database file. Without this, process.exit(0) may leave uncheckpointed
    // WAL data that could be lost on OS crash / power failure.
    Client().run("PRAGMA wal_checkpoint(TRUNCATE)")
  } catch (e) {
    log.warn("WAL checkpoint failed during close", { error: e })
  }
  Client().$client.close()
  Client.reset()

  // Close all project DBs
  for (const [dir] of projectClients) {
    closeProject(dir)
  }
}

export type TxOrDb = Transaction | Client

// Context for global-DB transactions
const ctx = LocalContext.create<{
  tx: TxOrDb
  effects: (() => void | Promise<void>)[]
}>("database")

// Context for project-DB transactions
const projectCtx = LocalContext.create<{
  tx: TxOrDb
  effects: (() => void | Promise<void>)[]
}>("project-database")

export function use<T>(callback: (trx: TxOrDb) => T): T {
  try {
    return callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
      // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
      for (const effect of effects) effect()
      return result
    }
    throw err
  }
}

export function useProject<T>(callback: (trx: TxOrDb) => T): T {
  try {
    return callback(projectCtx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const client = getProjectClient()
      const result = projectCtx.provide({ effects, tx: client }, () => callback(client))
      // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
      for (const effect of effects) effect()
      return result
    }
    throw err
  }
}

/**
 * Run a callback against a specific project's DB, addressed by its directory,
 * WITHOUT requiring an active Instance context. Used by cross-project queries
 * such as `Session.listGlobal` that must aggregate data from every project DB.
 *
 * Returns `undefined` (and does NOT create a DB) when the project DB file does
 * not exist yet — e.g. a project row that has never been opened or has no
 * sessions. This keeps a global aggregation read-only with respect to projects
 * that have no data, instead of materializing empty per-project `duoduo.db` files.
 */
export function withProjectDb<T>(directory: string, callback: (trx: TxOrDb) => T): T | undefined {
  if (!directory) return undefined
  const dbPath = getProjectPath(directory)
  if (!existsSync(dbPath)) return undefined
  const client = getProjectClient(directory)
  return callback(client)
}

/**
 * Run a callback against a specific project's DB addressed by its directory,
 * getting or creating that DB (applying project migrations) just like
 * `useProject` does for the current Instance — but WITHOUT requiring an active
 * Instance context. Unlike `withProjectDb`, this WILL create the DB file if it
 * does not exist, so it is suitable for writes (e.g. seeding / cross-project
 * updates) rather than read-only aggregation.
 */
export function useProjectAt<T>(directory: string, callback: (trx: TxOrDb) => T): T {
  const client = getProjectClient(directory)
  return callback(client)
}

export function effect(fn: () => any) {
  const bound = InstanceState.bind(fn)
  // Prefer the project-DB transaction context if active, then fall back to
  // the global-DB transaction context, otherwise run immediately.
  try {
    projectCtx.use().effects.push(bound)
    return
  } catch {}
  try {
    ctx.use().effects.push(bound)
    return
  } catch {}
  bound()
}

type NotPromise<T> = T extends Promise<any> ? never : T

export function transaction<T>(
  callback: (tx: TxOrDb) => NotPromise<T>,
  options?: {
    behavior?: "deferred" | "immediate" | "exclusive"
  },
): NotPromise<T> {
  try {
    return callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const txCallback = InstanceState.bind((tx: TxOrDb) => ctx.provide({ tx, effects }, () => callback(tx)))
      const result = Client().transaction(txCallback, { behavior: options?.behavior })
      // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
      for (const effect of effects) effect()
      return result as NotPromise<T>
    }
    throw err
  }
}

export function projectTransaction<T>(
  callback: (tx: TxOrDb) => NotPromise<T>,
  options?: {
    behavior?: "deferred" | "immediate" | "exclusive"
  },
): NotPromise<T> {
  try {
    return callback(projectCtx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const txCallback = InstanceState.bind((tx: TxOrDb) => projectCtx.provide({ tx, effects }, () => callback(tx)))
      const client = getProjectClient()
      const result = client.transaction(txCallback, { behavior: options?.behavior })
      // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
      for (const effect of effects) effect()
      return result as NotPromise<T>
    }
    throw err
  }
}
