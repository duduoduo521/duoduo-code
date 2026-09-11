import z from "zod"
import { and, Database, eq } from "../storage"
import { ProjectTable } from "./project.sql"
import { SessionTable } from "../session/session.sql"
import { Log } from "../util"
import { Flag } from "@/flag/flag"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { which } from "../util/which"
import { ProjectID } from "./schema"
import { Effect, Layer, Path, Scope, Context, Stream, Types, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { NodePath } from "@effect/platform-node"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import path from "path"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { pull, removeRemote, push, resolveSecret } from "../remote/sync"
import { mirrorDir } from "../storage/remote-mirror"
import { projectDataDir, projectId } from "../storage/project-dir"
import { snapshotRootDir } from "../snapshot"
import { Global } from "../global"
import { putCredential, deleteCredential, getCredential } from "../storage/credential"
import { KEY_DIR } from "../storage/credential-crypto"
import { getConnection } from "../remote/connection"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

const log = Log.create({ service: "project" })

const ProjectVcs = Schema.Literal("git")

const ProjectIcon = Schema.Struct({
  url: Schema.optional(Schema.String),
  override: Schema.optional(Schema.String),
  color: Schema.optional(Schema.String),
})

const ProjectCommands = Schema.Struct({
  start: Schema.optional(
    Schema.String.annotate({ description: "Startup script to run when creating a new workspace (worktree)" }),
  ),
})

const ProjectRemote = Schema.Struct({
  host: Schema.String,
  port: Schema.Number,
  remotePath: Schema.String,
  auth: Schema.Union([Schema.Literal("ssh-key"), Schema.Literal("password")]),
  credentialRef: Schema.String,
})
export type Remote = Schema.Schema.Type<typeof ProjectRemote>

const ProjectTime = Schema.Struct({
  created: Schema.Number,
  updated: Schema.Number,
  initialized: Schema.optional(Schema.Number),
})

export const Info = Schema.Struct({
  id: ProjectID,
  worktree: Schema.String,
  vcs: Schema.optional(ProjectVcs),
  name: Schema.optional(Schema.String),
  icon: Schema.optional(ProjectIcon),
  commands: Schema.optional(ProjectCommands),
  time: ProjectTime,
  sandboxes: Schema.Array(Schema.String),
  remote: Schema.optional(ProjectRemote),
  localMirror: Schema.optional(Schema.String),
})
  .annotate({ identifier: "Project" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const Event = {
  Updated: BusEvent.define("project.updated", Info.zod),
}

type Row = typeof ProjectTable.$inferSelect

export function fromRow(row: Row): Info {
  const icon =
    row.icon_url || row.icon_url_override || row.icon_color
      ? {
          url: row.icon_url ?? undefined,
          override: row.icon_url_override ?? undefined,
          color: row.icon_color ?? undefined,
        }
      : undefined
  return {
    id: row.id,
    worktree: row.worktree,
    vcs: row.vcs ? Schema.decodeUnknownSync(ProjectVcs)(row.vcs) : undefined,
    name: row.name ?? undefined,
    icon,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      initialized: row.time_initialized ?? undefined,
    },
    sandboxes: row.sandboxes,
    commands: row.commands ?? undefined,
    remote: row.remote ?? undefined,
    localMirror: row.local_mirror ?? undefined,
  }
}

/**
 * Cache for a git repository's first-commit hash.
 *
 * It lives in the duoduo data directory (`<Global.Path.data>/git-id/<key>`),
 * keyed by a stable hash of the git *common* dir path — NOT inside the project
 * tree. That keeps project discovery from writing any file into the user's
 * project (and, for a Plan C mirror, from pushing one to the remote). The cache
 * still saves the one `git rev-list --max-parents=0 HEAD` call that makes
 * discovery cheap.
 *
 * `undefined` is returned (and the cache is skipped) when `Global.Path.data`
 * is not yet available, so a misconfigured environment can never crash
 * discovery.
 */
function gitIdCacheFile(commonDir: string): string | undefined {
  if (!Global.Path.data) return undefined
  return path.join(Global.Path.data, "git-id", projectId(commonDir))
}

function readGitIdCache(commonDir: string): ProjectID | undefined {
  const file = gitIdCacheFile(commonDir)
  if (!file) return undefined
  try {
    const raw = readFileSync(file, "utf-8").trim()
    return raw ? ProjectID.make(raw) : undefined
  } catch {
    return undefined
  }
}

function writeGitIdCache(commonDir: string, id: ProjectID): void {
  const file = gitIdCacheFile(commonDir)
  if (!file) return
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, id)
  } catch {
    // Best effort — a cache write failure must never break project discovery.
  }
}

export const UpdateInput = z.object({
  projectID: ProjectID.zod,
  name: z.string().optional(),
  icon: zod(ProjectIcon).optional(),
  commands: zod(ProjectCommands).optional(),
})
export type UpdateInput = z.infer<typeof UpdateInput>

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export interface Interface {
  readonly discoverProject: (directory: string) => Effect.Effect<{ project: Info; sandbox: string }>
  readonly fromDirectory: (
    directory: string,
    precomputed?: { id: ProjectID; worktree: string; sandbox: string; vcs: Info["vcs"] },
    opts?: { create?: boolean },
  ) => Effect.Effect<{ project: Info; sandbox: string }>
  readonly discover: (input: Info) => Effect.Effect<void>
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: ProjectID) => Effect.Effect<Info | undefined>
  readonly getByDirectory: (directory: string) => Info | undefined
  readonly update: (input: UpdateInput) => Effect.Effect<Info>
  readonly initGit: (input: { directory: string; project: Info }) => Effect.Effect<Info>
  readonly setInitialized: (id: ProjectID) => Effect.Effect<void>
  readonly sandboxes: (id: ProjectID) => Effect.Effect<string[]>
  readonly addSandbox: (id: ProjectID, directory: string) => Effect.Effect<void>
  readonly removeSandbox: (id: ProjectID, directory: string) => Effect.Effect<void>
  readonly connectRemoteProject: (input: {
    host: string
    port: number
    remotePath: string
    auth: "ssh-key" | "password"
    username: string
    secret: string
    privateKey?: string
  }) => Promise<Info>
  readonly disconnectRemoteProject: (input: {
    id: ProjectID
    deleteRemote?: boolean
  }) => Promise<{ remoteDeleted: boolean }>
  /** Push local mirror changes back to the remote (Plan C upload). */
  readonly pushRemote: (input: { id: ProjectID; force?: boolean }) => Promise<{ conflicts: string[]; skipped: string[] }>
  /**
   * Update the SSH credentials (username / password / private key / auth kind)
   * of an existing remote project. The connection identity (host / port /
   * remotePath) and therefore `id`, `worktree`, `credentialRef` are intentionally
   * immutable — only the credential record and optional key file are rewritten,
   * so no mirror / instance / session / KG state is affected.
   */
  readonly updateRemoteCredential: (input: {
    id: ProjectID
    auth: "ssh-key" | "password"
    username?: string
    /** Empty = keep the previously stored secret (password mode) or key (ssh-key mode). */
    secret?: string
    /** Empty = keep the previously stored private key file (ssh-key mode only). */
    privateKey?: string
  }) => Promise<Info>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/Project") {}

type GitResult = { code: number; text: string; stderr: string }

export const layer: Layer.Layer<
  Service,
  never,
  AppFileSystem.Service | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const pathSvc = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const git = Effect.fnUntraced(
      function* (args: string[], opts?: { cwd?: string }) {
        const handle = yield* spawner.spawn(
          ChildProcess.make("git", args, { cwd: opts?.cwd, extendEnv: true, stdin: "ignore" }),
        )
        const [text, stderr] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
          { concurrency: 2 },
        )
        const code = yield* handle.exitCode
        return { code, text, stderr } satisfies GitResult
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed({ code: 1, text: "", stderr: "" } satisfies GitResult)),
    )

    const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
      Effect.sync(() => Database.use(fn))

    const emitUpdated = (data: Info) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          project: data.id,
          payload: { type: Event.Updated.type, properties: data },
        }),
      )

    const fakeVcs = Schema.decodeUnknownSync(Schema.optional(ProjectVcs))(Flag.DUODUO_FAKE_VCS)

    const resolveGitPath = (cwd: string, name: string) => {
      if (!name) return cwd
      name = name.replace(/[\r\n]+$/, "")
      if (!name) return cwd
      name = AppFileSystem.windowsPath(name)
      if (pathSvc.isAbsolute(name)) return pathSvc.normalize(name)
      return pathSvc.resolve(cwd, name)
    }

    const scope = yield* Scope.Scope

    /**
     * Project id recorded in the database for a working directory.
     *
     * `worktree` is the local mirror for Plan C remote projects (see
     * `getByDirectory`), so this resolves both local and remote projects.
     *
     * This replaces the old `<dir>/duoduo` marker file for non-git directories.
     * That file had to live *inside* the directory to survive a rename, which
     * put it in the user's project tree — and, for mirrors, got it pushed back
     * to the remote server (leaking host/port/path). The database record is the
     * same identity, already persisted, and it never touches the directory.
     */
    const dbCachedProjectId = Effect.fnUntraced(function* (directory: string) {
      // A thrown query must NEVER be silently treated as "no row": the caller
      // falls back to ProjectID.make(directory) and the knowledge graph then
      // indexes under that divergent path key while every poller uses the
      // DB-backed id (observed as `C:\...mirror_L3d3...` registry entries).
      // The failure window is real: right after a quick app restart the old
      // instance's sidecars still hold the SQLite WAL while this process runs
      // its first `PRAGMA journal_mode = WAL` / checkpoint, so the very first
      // query can throw. Retry with backoff, log every failure, and only
      // report "no row" when a query actually succeeded and found nothing.
      const lookup = db(
        (d) => d.select().from(ProjectTable).where(eq(ProjectTable.worktree, directory)).get(),
      ).pipe(
        Effect.map((row) => ({ ok: true as const, id: row ? (row.id as ProjectID) : undefined })),
        Effect.catch((error: unknown) => Effect.succeed({ ok: false as const, error })),
      )
      const maxAttempts = 5
      let lastError: unknown
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = yield* lookup
        if (result.ok) {
          if (attempt > 1) log.warn("project id db lookup recovered after retry", { directory, attempt })
          return result.id
        }
        lastError = result.error
        log.warn("project id db lookup failed", { directory, attempt, error: String(result.error) })
        if (attempt < maxAttempts) yield* Effect.sleep("400 millis")
      }
      log.warn("project id db lookup failed after retries — falling back to path-derived id", {
        directory,
        error: String(lastError),
      })
      return undefined
    })

    // P3: Fast project discovery — git probe only, no DB upsert.
    // Used by Instance.boot() to return a usable InstanceContext immediately;
    // DB upsert is deferred to fromDirectory() which runs fire-and-forget.
    const discoverProject = Effect.fn("Project.discoverProject")(function* (directory: string) {
      log.info("discoverProject", { directory })

      type DiscoveryResult = { id: ProjectID; worktree: string; sandbox: string; vcs: Info["vcs"]; name?: string }

      const data: DiscoveryResult = yield* Effect.gen(function* () {
        const dotgitMatches = yield* fs.up({ targets: [".git"], start: directory }).pipe(Effect.orDie)
        const dotgit = dotgitMatches[0]

        if (!dotgit) {
          // Prefer the id recorded in the database (covers remote mirrors too);
          // fall back to deriving one from the path for a brand-new directory.
          // Nothing is written into the directory.
          const id = (yield* dbCachedProjectId(directory)) ?? ProjectID.make(directory)
          return {
            id,
            worktree: directory,
            sandbox: directory,
            vcs: fakeVcs,
            name: path.basename(directory),
          }
        }

        let sandbox = pathSvc.dirname(dotgit)
        const gitBinary = yield* Effect.sync(() => which("git"))
        // Cache is keyed by the git common dir (see writeGitIdCache), so read it
        // there rather than from `dotgit` — for worktrees `dotgit` is a plain
        // file (e.g. `<worktree>/.git`) and never holds the cache.
        let id: ProjectID | undefined

        if (!gitBinary) {
          return {
            id: id ?? ProjectID.global,
            worktree: sandbox,
            sandbox,
            vcs: fakeVcs,
          }
        }

        const commonDir = yield* git(["rev-parse", "--git-common-dir"], { cwd: sandbox })
        if (commonDir.code !== 0) {
          return {
            id: id ?? ProjectID.global,
            worktree: sandbox,
            sandbox,
            vcs: fakeVcs,
          }
        }
        const common = resolveGitPath(sandbox, commonDir.text.trim())
        const bareCheck = yield* git(["config", "--bool", "core.bare"], { cwd: sandbox })
        const isBareRepo = bareCheck.code === 0 && bareCheck.text.trim() === "true"
        const worktree = common === sandbox ? sandbox : isBareRepo ? common : pathSvc.dirname(common)

        if (id == null) {
          id = readGitIdCache(common)
        }

        if (!id) {
          const revList = yield* git(["rev-list", "--max-parents=0", "HEAD"], { cwd: sandbox })
          const roots = revList.text
            .split("\n")
            .filter(Boolean)
            .map((x) => x.trim())
            .toSorted()

          id = roots[0] ? ProjectID.make(roots[0]) : undefined
          if (id) writeGitIdCache(common, id)
        }

        if (!id) {
          return { id: ProjectID.global, worktree: sandbox, sandbox, vcs: "git" as const }
        }

        const topLevel = yield* git(["rev-parse", "--show-toplevel"], { cwd: sandbox })
        if (topLevel.code !== 0) {
          return {
            id,
            worktree: sandbox,
            sandbox,
            vcs: fakeVcs,
          }
        }
        sandbox = resolveGitPath(sandbox, topLevel.text.trim())

        return { id, sandbox, worktree, vcs: "git" as const }
      })

      // Construct a minimal Info sufficient for InstanceContext —
      // downstream code only reads .id, .vcs, and .worktree at boot time.
      const project: Info = {
        id: data.id,
        worktree: data.worktree,
        vcs: data.vcs,
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      }

      return { project, sandbox: data.sandbox }
    })

    const fromDirectory = Effect.fn("Project.fromDirectory")(function* (
      directory: string,
      precomputed?: { id: ProjectID; worktree: string; sandbox: string; vcs: Info["vcs"] },
      opts?: { create?: boolean },
    ) {
      log.info("fromDirectory", { directory, precomputed: !!precomputed })

      // Phase 1: discover git info (skip if precomputed data is provided)
      type DiscoveryResult = { id: ProjectID; worktree: string; sandbox: string; vcs: Info["vcs"]; name?: string }

      const data: DiscoveryResult = precomputed
        ? precomputed
        : yield* Effect.gen(function* () {
            const dotgitMatches = yield* fs.up({ targets: [".git"], start: directory }).pipe(Effect.orDie)
            const dotgit = dotgitMatches[0]

            if (!dotgit) {
              // See discoverProject: the database is the identity source; no
              // marker file is written into the directory.
              const id = (yield* dbCachedProjectId(directory)) ?? ProjectID.make(directory)
              return {
                id,
                worktree: directory,
                sandbox: directory,
                vcs: fakeVcs,
                name: path.basename(directory),
              }
            }

            let sandbox = pathSvc.dirname(dotgit)
            const gitBinary = yield* Effect.sync(() => which("git"))
            // See discoverProject: cache is keyed by the git common dir.
            let id: ProjectID | undefined

            if (!gitBinary) {
              return {
                id: id ?? ProjectID.global,
                worktree: sandbox,
                sandbox,
                vcs: fakeVcs,
              }
            }

            const commonDir = yield* git(["rev-parse", "--git-common-dir"], { cwd: sandbox })
            if (commonDir.code !== 0) {
              return {
                id: id ?? ProjectID.global,
                worktree: sandbox,
                sandbox,
                vcs: fakeVcs,
              }
            }
            const common = resolveGitPath(sandbox, commonDir.text.trim())
            const bareCheck = yield* git(["config", "--bool", "core.bare"], { cwd: sandbox })
            const isBareRepo = bareCheck.code === 0 && bareCheck.text.trim() === "true"
            const worktree = common === sandbox ? sandbox : isBareRepo ? common : pathSvc.dirname(common)

            if (id == null) {
              id = readGitIdCache(common)
            }

            if (!id) {
              const revList = yield* git(["rev-list", "--max-parents=0", "HEAD"], { cwd: sandbox })
              const roots = revList.text
                .split("\n")
                .filter(Boolean)
                .map((x) => x.trim())
                .toSorted()

              id = roots[0] ? ProjectID.make(roots[0]) : undefined
              if (id) writeGitIdCache(common, id)
            }

            if (!id) {
              return { id: ProjectID.global, worktree: sandbox, sandbox, vcs: "git" as const }
            }

            const topLevel = yield* git(["rev-parse", "--show-toplevel"], { cwd: sandbox })
            if (topLevel.code !== 0) {
              return {
                id,
                worktree: sandbox,
                sandbox,
                vcs: fakeVcs,
              }
            }
            sandbox = resolveGitPath(sandbox, topLevel.text.trim())

            return { id, sandbox, worktree, vcs: "git" as const }
          })

      // Phase 2: upsert
      const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, data.id)).get())
      const existing = row
        ? fromRow(row)
        : {
            id: data.id,
            worktree: data.worktree,
            vcs: data.vcs,
            sandboxes: [] as string[],
            time: { created: Date.now(), updated: Date.now() },
          }

      if (Flag.DUODUO_EXPERIMENTAL_ICON_DISCOVERY) yield* discover(existing).pipe(Effect.ignore, Effect.forkIn(scope))

      const result: Info = {
        ...existing,
        worktree: data.worktree,
        vcs: data.vcs,
        time: { ...existing.time, updated: Date.now() },
      }
      if (data.sandbox !== result.worktree && !result.sandboxes.includes(data.sandbox))
        result.sandboxes.push(data.sandbox)
      result.sandboxes = yield* Effect.forEach(
        result.sandboxes,
        (s) =>
          fs.exists(s).pipe(
            Effect.orDie,
            Effect.map((exists) => (exists ? s : undefined)),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((arr) => arr.filter((x): x is string => x !== undefined)))

      // Persist only when the row already exists (routine refresh) or this is an
      // explicit open (opts.create === true). A boot-time discovery for a project
      // whose record was deleted by cleanup must NOT resurrect it — otherwise
      // "清理项目记录" can never remove the sidecar's bound directory.
      if (row !== undefined || opts?.create === true) {
        yield* db((d) =>
          d
            .insert(ProjectTable)
            .values({
              id: result.id,
              worktree: result.worktree,
              vcs: result.vcs ?? null,
              name: result.name,
              icon_url: result.icon?.url,
              icon_url_override: result.icon?.override,
              icon_color: result.icon?.color,
              time_created: result.time.created,
              time_updated: result.time.updated,
              time_initialized: result.time.initialized,
              sandboxes: result.sandboxes,
              commands: result.commands,
              remote: existing.remote ?? null,
              local_mirror: existing.localMirror ?? null,
            })
            .onConflictDoUpdate({
              target: ProjectTable.id,
              set: {
                worktree: result.worktree,
                vcs: result.vcs ?? null,
                name: result.name,
                icon_url: result.icon?.url,
                icon_url_override: result.icon?.override,
                icon_color: result.icon?.color,
                time_updated: result.time.updated,
                time_initialized: result.time.initialized,
                sandboxes: result.sandboxes,
                commands: result.commands,
                remote: existing.remote ?? null,
                local_mirror: existing.localMirror ?? null,
              },
            })
            .run(),
        )

        yield* emitUpdated(result)
      }

      // Migrate legacy "global" sessions to this project's real ID. This is gated by
      // the project having a real id (not global), NOT by the persistence guard above —
      // the two concerns are independent. Re-assigning sessions never resurrects the
      // project row, so it is safe (and necessary) even on a boot-time discovery where
      // we intentionally skip writing the row.
      if (data.id !== ProjectID.global) {
        // Sessions live in the PER-PROJECT DB (`<data dir>/database/<project_id>/duoduo.db`),
        // not the global DB — the DB split moved the `session` table out of the
        // global database (an update there fails with "no such table: session").
        // Re-assign any sessions created under the "global" project ID (before this
        // project obtained a real ID) to the real project ID, in the project's own DB.
        // `withProjectDb` is a no-op when the project DB does not exist yet, which
        // is correct: no DB means no sessions to migrate.
        yield* Effect.sync(() =>
          Database.withProjectDb(data.worktree, (d) =>
            d
              .update(SessionTable)
              .set({ project_id: data.id })
              .where(and(eq(SessionTable.project_id, ProjectID.global), eq(SessionTable.directory, data.worktree)))
              .run(),
          ),
        )
      }
      return { project: result, sandbox: data.sandbox }
    })

    const discover = Effect.fn("Project.discover")(function* (input: Info) {
      if (input.vcs !== "git") return
      if (input.icon?.override) return
      if (input.icon?.url) return

      const matches = yield* fs
        .glob("**/favicon.{ico,png,svg,jpg,jpeg,webp}", {
          cwd: input.worktree,
          absolute: true,
          include: "file",
        })
        .pipe(Effect.orDie)
      const shortest = matches.sort((a, b) => a.length - b.length)[0]
      if (!shortest) return

      const buffer = yield* fs.readFile(shortest).pipe(Effect.orDie)
      const base64 = Buffer.from(buffer).toString("base64")
      const mime = AppFileSystem.mimeType(shortest)
      const url = `data:${mime};base64,${base64}`
      yield* update({ projectID: input.id, icon: { url } })
    })

    const list = Effect.fn("Project.list")(function* () {
      return yield* db((d) => d.select().from(ProjectTable).all().map(fromRow))
    })

    const get = Effect.fn("Project.get")(function* (id: ProjectID) {
      const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
      return row ? fromRow(row) : undefined
    })

    const update = Effect.fn("Project.update")(function* (input: UpdateInput) {
      const result = yield* db((d) =>
        d
          .update(ProjectTable)
          .set({
            name: input.name,
            icon_url: input.icon?.url,
            icon_url_override: input.icon?.override,
            icon_color: input.icon?.color,
            commands: input.commands,
            time_updated: Date.now(),
          })
          .where(eq(ProjectTable.id, input.projectID))
          .returning()
          .get(),
      )
      if (!result) throw new Error(`Project not found: ${input.projectID}`)
      const data = fromRow(result)
      yield* emitUpdated(data)
      return data
    })

    const initGit = Effect.fn("Project.initGit")(function* (input: { directory: string; project: Info }) {
      if (input.project.vcs === "git") return input.project
      if (!(yield* Effect.sync(() => which("git")))) throw new Error("Git is not installed")
      const result = yield* git(["init", "--quiet"], { cwd: input.directory })
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || result.text.trim() || "Failed to initialize git repository")
      }
      // Stage all existing files and create initial commit
      const addResult = yield* git(["add", "-A"], { cwd: input.directory })
      if (addResult.code === 0) {
        const commitResult = yield* git(["commit", "--quiet", "-m", "Initial commit", "--no-gpg-sign"], {
          cwd: input.directory,
        })
        // Ignore commit failure (e.g., empty directory with no files to commit)
        if (commitResult.code !== 0) {
          log.warn("Initial commit skipped: " + (commitResult.stderr.trim() || commitResult.text.trim()))
        }
      }
      const { project } = yield* fromDirectory(input.directory)
      return project
    })

    const setInitialized = Effect.fn("Project.setInitialized")(function* (id: ProjectID) {
      yield* db((d) =>
        d.update(ProjectTable).set({ time_initialized: Date.now() }).where(eq(ProjectTable.id, id)).run(),
      )
    })

    const sandboxes = Effect.fn("Project.sandboxes")(function* (id: ProjectID) {
      const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
      if (!row) return []
      const data = fromRow(row)
      return yield* Effect.forEach(
        data.sandboxes,
        (dir) =>
          fs.isDir(dir).pipe(
            Effect.orDie,
            Effect.map((ok) => (ok ? dir : undefined)),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((arr) => arr.filter((x): x is string => x !== undefined)))
    })

    const addSandbox = Effect.fn("Project.addSandbox")(function* (id: ProjectID, directory: string) {
      const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
      if (!row) throw new Error(`Project not found: ${id}`)
      const sboxes = [...row.sandboxes]
      if (!sboxes.includes(directory)) sboxes.push(directory)
      const result = yield* db((d) =>
        d
          .update(ProjectTable)
          .set({ sandboxes: sboxes, time_updated: Date.now() })
          .where(eq(ProjectTable.id, id))
          .returning()
          .get(),
      )
      if (!result) throw new Error(`Project not found: ${id}`)
      yield* emitUpdated(fromRow(result))
    })

    const removeSandbox = Effect.fn("Project.removeSandbox")(function* (id: ProjectID, directory: string) {
      const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
      if (!row) throw new Error(`Project not found: ${id}`)
      const sboxes = row.sandboxes.filter((s) => s !== directory)
      const result = yield* db((d) =>
        d
          .update(ProjectTable)
          .set({ sandboxes: sboxes, time_updated: Date.now() })
          .where(eq(ProjectTable.id, id))
          .returning()
          .get(),
      )
      if (!result) throw new Error(`Project not found: ${id}`)
      yield* emitUpdated(fromRow(result))
    })

    return Service.of({
      discoverProject,
      fromDirectory,
      discover,
      list,
      get,
      getByDirectory,
      update,
      initGit,
      setInitialized,
      sandboxes,
      addSandbox,
      removeSandbox,
      connectRemoteProject,
      disconnectRemoteProject,
      updateRemoteCredential,
      pushRemote,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(NodePath.layer),
)

export function list() {
  return Database.use((db) =>
    db
      .select()
      .from(ProjectTable)
      .all()
      .map((row) => fromRow(row)),
  )
}

export function get(id: ProjectID): Info | undefined {
  const row = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
  if (!row) return undefined
  return fromRow(row)
}

/**
 * Resolve a project by its local working directory. For Plan C remote projects
 * the directory is the local mirror (`worktree` === `local_mirror`), so matching
 * on `worktree` covers both local and remote projects.
 */
export function getByDirectory(directory: string): Info | undefined {
  const row = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.worktree, directory)).get())
  if (!row) return undefined
  return fromRow(row)
}

export function setInitialized(id: ProjectID) {
  Database.use((db) =>
    db.update(ProjectTable).set({ time_initialized: Date.now() }).where(eq(ProjectTable.id, id)).run(),
  )
}

/**
 * Connect to a remote (SSH/SFTP) directory, mirror it locally, and register it
 * as a project. The local mirror path is stored as `worktree`/`local_mirror`
 * so that opening the project later routes the entire main code path at the
 * mirror — zero divergence from local projects (Plan C).
 *
 * Steps: persist encrypted credentials, compute mirror dir, upsert the project
 * row with `remote` metadata, then pull the remote tree into the mirror.
 * Throws (after rolling back the project row) on connection/pull failure.
 */
export async function connectRemoteProject(input: {
  host: string
  port: number
  remotePath: string
  auth: "ssh-key" | "password"
  username: string
  secret: string
  privateKey?: string
}): Promise<Info> {
  const credentialRef = `${input.host}:${input.port}`
  if (input.auth === "ssh-key" && input.privateKey) {
    if (!existsSync(KEY_DIR)) mkdirSync(KEY_DIR, { recursive: true })
    writeFileSync(path.join(KEY_DIR, `${credentialRef}.key`), input.privateKey, { mode: 0o600 })
  }
  putCredential({
    id: credentialRef,
    auth: input.auth,
    username: input.username,
    secret: input.secret,
  })

  const mirror = mirrorDir(input.host, input.remotePath)
  const id = `remote:${Buffer.from(`${input.host}:${input.port}:${input.remotePath}`).toString("base64url")}` as ProjectID
  const now = Date.now()
  const name =
    input.remotePath.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || input.host

  Database.use((db) => {
    db.insert(ProjectTable)
      .values({
        id,
        worktree: mirror,
        vcs: null,
        name,
        icon_url: null,
        icon_color: null,
        time_created: now,
        time_updated: now,
        sandboxes: [],
        commands: null,
        remote: {
          host: input.host,
          port: input.port,
          remotePath: input.remotePath,
          auth: input.auth,
          credentialRef,
        },
        local_mirror: mirror,
      })
      .onConflictDoUpdate({
        target: ProjectTable.id,
        set: {
          worktree: mirror,
          remote: {
            host: input.host,
            port: input.port,
            remotePath: input.remotePath,
            auth: input.auth,
            credentialRef,
          },
          local_mirror: mirror,
          time_updated: now,
        },
      })
      .run()
  })

  // No marker file is written into the mirror: `discoverProject` /
  // `fromDirectory` resolve this project's id from the database row above
  // (`worktree` === mirror), and any file dropped here would be pushed back to
  // the remote server on the next sync. `pull` creates the mirror directory.

  try {
    await pull({
      host: input.host,
      port: input.port,
      remotePath: input.remotePath,
      credentialRef,
      mirror,
    })
  } catch (err) {
    // Roll back the project row so a failed connect does not leave a dangling
    // remote entry without a usable mirror.
    Database.use((db) => db.delete(ProjectTable).where(eq(ProjectTable.id, id)).run())
    throw err
  }

  const row = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
  if (!row) throw new Error("failed to read back created project")
  return fromRow(row)
}

/**
 * Update only the credentials of an existing remote project. Connection identity
 * (host/port/remotePath) stays fixed, so `id`, `worktree`, `local_mirror`,
 * `credentialRef` and all downstream state (instance, session DB, KG, mirror dir)
 * are untouched. Safe to call on an already-open project.
 */
export async function updateRemoteCredential(input: {
  id: ProjectID
  auth: "ssh-key" | "password"
  username?: string
  /** Empty = keep the previously stored secret (password mode) or key (ssh-key mode). */
  secret?: string
  /** Empty = keep the previously stored private key file (ssh-key mode only). */
  privateKey?: string
}): Promise<Info> {
  const row = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, input.id)).get())
  if (!row || !row.remote) throw new Error(`not a remote project: ${input.id}`)
  // credentialRef is derived from the immutable host:port; never from input.
  const credentialRef = row.remote.credentialRef

  // Empty fields mean "keep the previously stored value" so the user can edit
  // a single field (e.g. only the password) without re-entering everything.
  const prev = getCredential(credentialRef)
  const username = input.username?.trim() ? input.username.trim() : prev?.username ?? ""
  const secret =
    input.secret?.trim() ? input.secret.trim() : prev?.secret ?? ""
  if (input.auth === "ssh-key") {
    // Rewrite the key file only when a new key is supplied; otherwise keep the
    // existing file intact (the fallback secret above already preserves the key).
    if (input.privateKey?.trim()) {
      if (!existsSync(KEY_DIR)) mkdirSync(KEY_DIR, { recursive: true })
      writeFileSync(path.join(KEY_DIR, `${credentialRef}.key`), input.privateKey, { mode: 0o600 })
    }
  } else {
    // Switching from ssh-key to password: drop any leftover key file so no
    // stale credential lingers on disk (resolveSecret only reads it for ssh-key).
    const keyPath = path.join(KEY_DIR, `${credentialRef}.key`)
    if (existsSync(keyPath)) rmSync(keyPath, { force: true })
  }
  putCredential({
    id: credentialRef,
    auth: input.auth,
    username,
    secret,
  })

  const now = Date.now()
  const remote = row.remote
  const updated = Database.use((db) =>
    db
      .update(ProjectTable)
      .set({
        remote: {
          host: remote.host,
          port: remote.port,
          remotePath: remote.remotePath,
          auth: input.auth,
          credentialRef: remote.credentialRef,
        },
        time_updated: now,
      })
      .where(eq(ProjectTable.id, input.id))
      .returning()
      .get(),
  )
  if (!updated) throw new Error(`Project not found: ${input.id}`)
  return fromRow(updated)
}

/**
 * Disconnect a remote (Plan C) project and clean up all local traces.
 *
 * L1 (always, once confirmed by the caller): remove the project row, delete the
 * local mirror directory, and erase the credential (encrypted secret in the DB
 * plus the private-key file on disk). This is a closed-loop "disconnect": the
 * connection vanishes from this machine with no leftover keys/passwords.
 *
 * L2 (opt-in, second independent confirmation): when `deleteRemote` is true,
 * also recursively delete `remotePath` on the remote server via SFTP. This is
 * irreversible and must never be the default — it is gated behind an explicit
 * user choice so a disconnect cannot accidentally wipe remote data.
 *
 * L2 failure does NOT roll back L1: the local disconnect is the primary, safe
 * operation; a remote-delete error is reported separately so the user can retry
 * it (or do it manually) without the local project reappearing.
 */
export async function disconnectRemoteProject(input: {
  id: ProjectID
  deleteRemote?: boolean
}): Promise<{ remoteDeleted: boolean }> {
  const row = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, input.id)).get())
  if (!row || !row.remote) throw new Error(`not a remote project: ${input.id}`)

  const remote = row.remote as Remote
  const mirror = row.local_mirror ?? mirrorDir(remote.host, remote.remotePath)
  const credentialRef = remote.credentialRef

  // L2 first (delete remote content), only when explicitly requested.
  let remoteDeleted = false
  if (input.deleteRemote) {
    await removeRemote({
      host: remote.host,
      port: remote.port,
      remotePath: remote.remotePath,
      credentialRef,
    })
    remoteDeleted = true
  }

  // L1: clean up local traces.
  if (mirror && existsSync(mirror)) {
    rmSync(mirror, { recursive: true, force: true })
  }
  const keyPath = path.join(KEY_DIR, `${credentialRef}.key`)
  if (existsSync(keyPath)) {
    rmSync(keyPath, { force: true })
  }
  deleteCredential(credentialRef)
  Database.use((db) => db.delete(ProjectTable).where(eq(ProjectTable.id, input.id)).run())

  return { remoteDeleted }
}

/** Push local mirror changes back to the remote (Plan C upload). */
export async function pushRemote(input: {
  id: ProjectID
  force?: boolean
}): Promise<{ conflicts: string[]; skipped: string[] }> {
  const row = Database.use((db) =>
    db.select().from(ProjectTable).where(eq(ProjectTable.id, input.id)).get()
  )
  if (!row) throw new Error(`project not found: ${input.id}`)
  if (!row.remote) throw new Error(`not a remote project: ${input.id}`)

  const remote = row.remote as Remote
  const mirror = row.local_mirror ?? mirrorDir(remote.host, remote.remotePath)
  const { conflicts, skipped } = await push({
    host: remote.host,
    port: remote.port,
    remotePath: remote.remotePath,
    credentialRef: remote.credentialRef,
    mirror,
    force: input.force,
  })
  return { conflicts, skipped }
}

/**
 * Pull the remote tree into the local mirror for an already-connected remote
 * (Plan C) project. Reuses the same pull logic as connectRemoteProject so the
 * two paths stay in sync (single source of truth).
 *
 * Returns the relative paths that were NOT pulled because the local copy holds
 * unsynced changes. The caller (route/UI) must surface the list and let the user
 * pick a direction; re-running with `force: true` overwrites local and clears
 * the conflict.
 */
export async function pullRemote(input: {
  id: ProjectID
  force?: boolean
}): Promise<{ conflicts: string[] }> {
  const row = Database.use((db) =>
    db.select().from(ProjectTable).where(eq(ProjectTable.id, input.id)).get()
  )
  if (!row) throw new Error(`project not found: ${input.id}`)
  if (!row.remote) throw new Error(`not a remote project: ${input.id}`)

  const remote = row.remote as Remote
  const mirror = row.local_mirror ?? mirrorDir(remote.host, remote.remotePath)
  const { conflicts } = await pull({
    host: remote.host,
    port: remote.port,
    remotePath: remote.remotePath,
    credentialRef: remote.credentialRef,
    mirror,
    force: input.force,
  })
  return { conflicts }
}

/**
 * Probe SSH reachability for an already-saved remote project (Plan C) without
 * pulling the tree or touching local state. Used by the frontend before opening
 * a recent/sidebar SSH project so a dead server never mounts an empty session.
 *
 * Reuses the single connection entrypoint (getConnection) and the credential
 * resolver (resolveSecret) — no duplicated dial/secret logic. Returns a plain
 * { ok, error? } so no plaintext credential ever leaves the backend. Idempotent
 * and side-effect free: the leased connection is always released in `finally`.
 */
export async function remoteCheck(input: {
  id: ProjectID
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = Database.use((db) =>
    db.select().from(ProjectTable).where(eq(ProjectTable.id, input.id)).get(),
  )
  if (!row) return { ok: false, error: `project not found: ${input.id}` }
  if (!row.remote) return { ok: false, error: `not a remote project: ${input.id}` }

  const remote = row.remote as Remote
  let leased: Awaited<ReturnType<typeof getConnection>> | undefined
  try {
    leased = await getConnection(remote.host, remote.port, resolveSecret(remote.credentialRef))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    leased?.release()
  }
}

// 进程内：记录当前拥有活跃 instance 的项目 worktree。
// 用于"已打开 / 仍在左侧项目列表中"的项目不可被清理的判定。
const openProjectWorktrees = new Set<string>()

export function markProjectOpen(worktree: string): void {
  openProjectWorktrees.add(worktree)
}

export function unmarkProjectOpen(worktree: string): void {
  openProjectWorktrees.delete(worktree)
}

export function isProjectOpen(worktree: string): boolean {
  return openProjectWorktrees.has(worktree)
}

type RemovableRow = { id: ProjectID; worktree: string; time_initialized?: number | null }

function selectRemovableProjects(
  rows: RemovableRow[],
  days: number,
  protectedWorktrees: string[] = [],
  targetWorktrees?: string[],
): RemovableRow[] {
  // days <= 0 表示删除全部（不施加时间阈值）；否则删除 time_initialized 早于阈值的项目
  const threshold = days <= 0 ? Infinity : Date.now() - days * 24 * 60 * 60 * 1000
  // 受保护集合与库中 worktree 都用 AppFileSystem.resolve 归一化（解析符号链接 +
  // Windows 路径/大小写），避免 Mac /tmp↔/private/tmp、Windows 大小写等导致
  // "当前打开的项目"被误判为可删除。
  // 注意：不再依赖进程内易失的 openProjectWorktrees（isProjectOpen），
  // 因为它在桌面多窗口/常驻场景下会累积所有"曾打开过"的项目而无法正确 unmark，
  // 导致历史已关闭的项目被误判为"已打开"而永远无法清理。
  // 当前真正打开的项目由调用方（cleanupCount/cleanup 路由）通过 protectedWorktrees 传入。
  const norm = (p: string) => AppFileSystem.resolve(p)
  const protectedSet = new Set(protectedWorktrees.map(norm))
  // 定向模式：只删除 targetWorktrees 命中的项目（忽略 days 阈值），
  // 用于侧栏"删除项目"这类单项目精确销毁。
  const targetSet = targetWorktrees ? new Set(targetWorktrees.map(norm)) : undefined
  return rows.filter((r) => {
    if (protectedSet.has(norm(r.worktree))) return false
    if (targetSet) return targetSet.has(norm(r.worktree))
    return (r.time_initialized ?? 0) < threshold
  })
}

export async function countProjectsBefore(input: {
  days: number
  protectedWorktrees?: string[]
}): Promise<number> {
  const rows = Database.use((db) => db.select().from(ProjectTable).all())
  return selectRemovableProjects(rows, input.days, input.protectedWorktrees).length
}

export async function destroyProjectsBefore(input: {
  days: number
  protectedWorktrees?: string[]
  /** 定向模式：只销毁这些 worktree 对应的项目（忽略 days 阈值）。
   *  用于侧栏"删除项目"流程的按项目精确销毁。 */
  worktrees?: string[]
}): Promise<{ deleted: number }> {
  const rows = Database.use((db) => db.select().from(ProjectTable).all())
  const removable = selectRemovableProjects(
    rows,
    input.days,
    input.protectedWorktrees,
    input.worktrees,
  )
  let deleted = 0
  for (const r of removable) {
    // 定向模式（侧栏"删除"）保留项目记录：项目仍在"最近项目"列表中，可随时
    // 重新打开（打开时从全新数据开始）；记录本身只是名称/图标/路径等元数据。
    // 批量清理（按 days 阈值）仍删除记录。
    if (!input.worktrees) {
      Database.use((db) => db.delete(ProjectTable).where(eq(ProjectTable.id, r.id)).run())
    }
    // 实例 disposer 只会关闭按实例目录拼写缓存的 DB 客户端；跨项目查询
    // （withProjectDb）可能以 worktree 拼写持有同一份 DB。Windows 上未关闭
    // 的句柄会令目录删除失败，因此销毁前关闭该数据目录下的所有缓存客户端。
    Database.closeProjectClientsMatching(r.worktree)
    // 删除 per-project 数据目录（含 session / message / 记忆），绝不触碰用户 worktree 目录
    try {
      rmSync(projectDataDir(r.worktree), { recursive: true, force: true })
    } catch {
      // 目录不存在或已删除，忽略
    }
    // 影子快照仓同样按项目隔离，删除项目时一并清理（P2-38）：否则
    // `<data>/snapshot/…` 下的孤儿仓与其 refs 会长期占盘，且没有任何 GC 路径
    // 能再次触达它们（registry 里的项目已经不存在）。绝不触碰用户 worktree。
    // 删的是项目快照根目录而不是单个 `<root>/<hash(directory)>`：快照按「打开的
    // 目录」分片，而项目行只存 worktree（git 根），monorepo 子目录项目的
    // directory ≠ worktree，按 worktree 计算会删错路径、真正的仓仍留在盘上。
    try {
      rmSync(snapshotRootDir(r.id), { recursive: true, force: true })
    } catch {
      // 目录不存在或已删除，忽略
    }
    deleted++
  }
  return { deleted }
}
