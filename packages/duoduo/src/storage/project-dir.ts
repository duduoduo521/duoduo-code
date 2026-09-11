import fs from "fs"
import path from "path"
import { Global } from "../global"

/** Probe-result cache keyed by the probed directory (at most one probe each). */
const probeCache = new Map<string, boolean>()

/**
 * Platform approximation, used only when the filesystem itself cannot answer:
 * Windows and macOS ship case-insensitive filesystems by default, Linux is
 * case-sensitive.
 */
const caseInsensitiveByPlatform = () => process.platform === "win32" || process.platform === "darwin"

/**
 * Determine — by asking the filesystem, not by platform guess — whether the
 * filesystem hosting `dir` treats paths case-insensitively.
 *
 * The probe is READ-ONLY: it resolves `dir` and a sibling spelled with the
 * case of the last path component flipped, then compares the two real paths.
 * Equal ⇒ the filesystem ignored the case change; the flipped name not
 * resolving at all ⇒ it did not. Same idea git uses for `core.ignoreCase`, but
 * without writing anything — creating a probe file inside the user's project
 * woke every file watcher with a file that no longer existed, needed write
 * access to the project, and left a stray `duoduo_fs_probe_*` file in the
 * repository if the process died between create and delete.
 *
 * Must stay in sync with the Rust `duo_utils::path::probe_case_insensitive`.
 */
function volumeIsCaseInsensitive(dir: string): boolean {
  const cached = probeCache.get(dir)
  if (cached !== undefined) return cached
  const result = probeCaseInsensitive(dir)
  probeCache.set(dir, result)
  return result
}

function probeCaseInsensitive(dir: string): boolean {
  const name = path.basename(dir)
  const parent = path.dirname(dir)
  // A filesystem root (`/`, `C:\`) has no name to flip.
  if (!name || !parent || parent === dir) return caseInsensitiveByPlatform()
  const flipped = name.replace(/[a-zA-Z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
  // No ASCII letter to flip (e.g. "123", "我的项目"): nothing to compare.
  if (flipped === name) return caseInsensitiveByPlatform()
  const canonical = (p: string) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return undefined
    }
  }
  const a = canonical(dir)
  const b = canonical(path.join(parent, flipped))
  // `dir` resolves but the flipped spelling does not ⇒ case-sensitive.
  if (a !== undefined && b === undefined) return false
  // `dir` itself cannot be resolved (missing, no permission): unknown.
  if (a === undefined || b === undefined) return caseInsensitiveByPlatform()
  return a === b
}

/**
 * Encode a project (or worktree) path into a stable, filesystem-safe, unique
 * directory name used to isolate per-project data under
 * `<Global.Path.data>/database/<id>/`.
 *
 * Project identity follows the **physical filesystem**, not the OS: paths
 * resolving to the same directory are one project, distinct directories are
 * distinct projects. The algorithm MUST stay in sync with the Rust
 * `duo_utils::path::project_id` (see `crates/duo-utils/src/path.rs`):
 *   1. Resolve to an absolute path.
 *   2. Normalize separators to `/` and strip a trailing slash.
 *   3. If the filesystem hosting the path is case-insensitive, lowercase it.
 *   4. Base64url-encode the UTF-8 bytes (URL-safe, no padding).
 *
 * The encoding is injective, so distinct normalized paths map to distinct ids.
 */
export function projectId(projectPath: string): string {
  const abs = path.resolve(projectPath).replace(/\\/g, "/").replace(/\/+$/, "")
  const norm = volumeIsCaseInsensitive(path.resolve(projectPath)) ? abs.toLowerCase() : abs
  return Buffer.from(norm, "utf-8").toString("base64url")
}

/** Directories already ensured to exist in this process (avoid repeated syscalls). */
const ensured = new Set<string>()

/**
 * Per-project data directory: `<Global.Path.data>/database/<projectId(projectPath)>/`.
 *
 * All project-scoped state (SQLite DB, memory/patterns/style files, DNA rules,
 * task/summary/blackboard dirs, gear config, plans, ...) lives here instead of
 * inside the project directory, keeping the project tree clean.
 *
 * The directory is created lazily on first resolution so that callers can
 * write files into it directly (config .gitignore, tui.json, plans, ...)
 * without each having to mkdir first.
 */
export function projectDataDir(projectPath: string): string {
  const dir = path.join(Global.Path.data, "database", projectId(projectPath))
  if (!ensured.has(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      ensured.add(dir)
    } catch {
      // best-effort; writers surface their own errors if the dir is unusable
    }
  }
  return dir
}

// ─── Orphan cleanup: absence ledger ──────────────────────────────────────────
// `fs.existsSync` cannot distinguish "the user deleted this folder" from "the
// filesystem hosting it is temporarily unreachable" (network share, SSHFS/NFS
// mount, unplugged external disk, an unmounted Windows drive letter). Both
// simply return `false`.
//
// Deleting immediately on the first `false` is therefore destructive: a brief
// network hiccup while opening ANY OTHER project would permanently wipe the
// unreachable project's sessions, messages and todos.
//
// Instead we record *when* a project path was first observed missing and only
// reclaim the directory once it has been continuously absent for a sustained
// period AND across several independent observations. A transient outage never
// accumulates enough evidence; a genuinely deleted folder is still cleaned up,
// just later. Any single sighting of the path resets the ledger entry.
//
// This keeps the cleanup fully local: no `statfs`, no mount-table parsing and
// no liveness probing — those either block indefinitely on a dead mount or
// behave differently on each OS.

/** Minimum wall-clock time a path must stay missing before its data is removed. */
const ORPHAN_GRACE_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

/** Minimum number of separate cleanup runs that must all observe the path missing. */
const ORPHAN_MIN_SIGHTINGS = 5

/** Ledger file: `<Global.Path.state>/orphan-projects.json`. */
function ledgerPath(): string {
  return path.join(Global.Path.state, "orphan-projects.json")
}

interface OrphanRecord {
  /** Epoch ms when the path was first observed missing. */
  since: number
  /** How many cleanup runs have observed it missing. */
  count: number
}

type Ledger = Record<string, OrphanRecord>

function readLedger(): Ledger {
  try {
    const raw = fs.readFileSync(ledgerPath(), "utf-8")
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Ledger = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue
      const { since, count } = value as { since?: unknown; count?: unknown }
      // Reject non-finite / negative values so a corrupt file can never make an
      // entry look older (and therefore more deletable) than it really is.
      if (typeof since !== "number" || !Number.isFinite(since) || since <= 0) continue
      if (typeof count !== "number" || !Number.isFinite(count) || count < 0) continue
      out[id] = { since, count }
    }
    return out
  } catch {
    // Missing or corrupt ledger — start over. Starting over is safe: it only
    // delays deletion, never causes one.
    return {}
  }
}

function writeLedger(ledger: Ledger): void {
  const file = ledgerPath()
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.orphan-projects.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2))
    // Atomic replace on all three platforms: POSIX rename(2) is atomic, and
    // Win32 MoveFileEx (which libuv uses, with REPLACE_EXISTING) overwrites an
    // existing destination rather than failing as plain rename would.
    fs.renameSync(tmp, file)
  } catch {
    // Best-effort: if the ledger cannot be persisted we simply re-observe next
    // run. Never let bookkeeping failure break project startup.
    try {
      fs.rmSync(tmp, { force: true })
    } catch {}
  }
}

/**
 * Reclaim per-project data directories under `<Global.Path.data>/database/`
 * whose encoded project path has been gone long enough to be considered
 * permanently deleted.
 *
 * Called when a project is opened so that deleting a project folder eventually
 * also removes its personal-dir data (the id is a reversible base64url encoding
 * of the normalized project path, see `projectId`).
 *
 * Safe against temporarily unreachable filesystems — see the note above.
 */
export function cleanupOrphanProjectData(): void {
  const base = path.join(Global.Path.data, "database")
  let entries: string[]
  try {
    entries = fs.readdirSync(base)
  } catch {
    return
  }

  const ledger = readLedger()
  const next: Ledger = {}
  const now = Date.now()
  let changed = false

  for (const id of entries) {
    const dir = path.join(base, id)
    let stat: fs.Stats
    try {
      stat = fs.statSync(dir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    let projectPath: string
    try {
      projectPath = Buffer.from(id, "base64url").toString("utf-8")
    } catch {
      continue
    }

    let present: boolean
    try {
      present = fs.existsSync(path.resolve(projectPath))
    } catch {
      // An error here means we could not determine the answer. Treat it as
      // "present" so we never delete on inconclusive evidence.
      present = true
    }

    if (present) {
      // Any sighting clears prior suspicion.
      if (ledger[id]) changed = true
      continue
    }

    const prior = ledger[id]
    // `since` is clamped to `now` so a clock jumped backwards (or a ledger
    // written by a machine ahead of this one) can't fast-track a deletion.
    const since = prior ? Math.min(prior.since, now) : now
    const count = (prior?.count ?? 0) + 1

    if (now - since >= ORPHAN_GRACE_MS && count >= ORPHAN_MIN_SIGHTINGS) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
        changed = true
        continue // drop from ledger — the directory is gone
      } catch {
        // Removal failed; keep the record so we retry next time.
      }
    }

    next[id] = { since, count }
    if (!prior || prior.since !== since || prior.count !== count) changed = true
  }

  // Drop ledger entries whose data directory no longer exists at all.
  for (const id of Object.keys(ledger)) {
    if (!(id in next)) changed = true
  }

  if (changed) writeLedger(next)
}
