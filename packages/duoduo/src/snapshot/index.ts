import { Cause, Duration, Effect, Layer, Schedule, Schema, Semaphore, Context, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { formatPatch, structuredPatch } from "diff"
import { promises as nodefs } from "fs"
import path from "path"
import z from "zod"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { InstanceState } from "@/effect"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { Hash } from "@duoduo-ai/shared/util/hash"
import { Config } from "../config"
import { Global } from "../global"
import { isShellArtifactPath } from "@/util/shell-artifact"

// Module-level, per-shadow-repo serialization locks. Shared across all Snapshot
// Service instances so concurrent callers target the same shadow git repo are
// strictly serialized (see `lock` usage in the Service layer below).
const GITDIR_LOCKS = new Map<string, Semaphore.Semaphore>()

// ── Cross-process lock (P1-30) ────────────────────────────────────────────
//
// The shadow gitdir is ALSO written by the Rust sidecar, so the module-level
// Semaphore above only serializes this process. Both processes use the same
// on-disk protocol: an atomically created lock file (`wx` = O_EXCL) holding
// `<pid>\n<unix_millis>`, deleted on release; a lock whose owner is gone, or
// that is older than LOCK_STALE_MS, is taken over. Mirrors Rust
// `snapshot/lock.rs` — file name, timestamp unit and staleness rule MUST match.
const LOCK_FILE = "duoduo.lock"
const LOCK_STALE_MS = 30_000
const LOCK_POLL_MS = 25

/**
 * Acquire the cross-process gitdir lock, returning a release function.
 *
 * Creates the gitdir when it is missing (the lock is held across `git init`),
 * so callers that branch on the repo already existing must sample that BEFORE
 * locking. Waits while a live owner holds the lock — only a stale lock is taken
 * over — which preserves the serialization guarantee.
 */
async function acquireGitdirFileLock(gitdir: string): Promise<() => Promise<void>> {
  // DIAG (windows-ci snapshot): the Rust run_loop's track() failed 77x in one
  // windows CI run with "not a git repository" — its `gitdir.exists()` sampled
  // TRUE but the dir had no git structure. Log when TS creates the shell dir
  // so the next CI run shows which side materialized it first.
  let diagPreExisted = true
  try {
    await nodefs.stat(gitdir)
  } catch {
    diagPreExisted = false
  }
  if (!diagPreExisted) console.warn(`[snapshot-diag] TS lock created gitdir: ${gitdir}`)
  await nodefs.mkdir(gitdir, { recursive: true })
  const lockPath = path.join(gitdir, LOCK_FILE)
  for (;;) {
    try {
      const handle = await nodefs.open(lockPath, "wx")
      try {
        await handle.writeFile(`${process.pid}\n${Date.now()}\n`)
      } finally {
        await handle.close()
      }
      let released = false
      return () => {
        if (released) return Promise.resolve()
        released = true
        // Awaited by the caller: a completed operation must have released the
        // lock file before it returns (mirrors the Rust side's synchronous
        // Drop); a fire-and-forget unlink races the next observer on Windows.
        return nodefs.unlink(lockPath).catch(() => {})
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      if (await isLockStale(lockPath)) {
        // The holder crashed (dead pid) or abandoned the lock: take it over
        // rather than waiting forever.
        await nodefs.unlink(lockPath).catch(() => {})
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
    }
  }
}

/**
 * True when the lock file names a dead process, is older than the staleness
 * window, or vanished/was unreadable — all of which mean the caller should
 * retry the exclusive create immediately.
 */
async function isLockStale(lockPath: string): Promise<boolean> {
  let raw: string
  try {
    raw = await nodefs.readFile(lockPath, "utf8")
  } catch {
    return true
  }
  const [pidLine, tsLine] = raw.split("\n")
  const pid = Number(pidLine)
  const ts = Number(tsLine)
  if (Number.isFinite(ts) && Date.now() - ts > LOCK_STALE_MS) return true
  if (Number.isInteger(pid) && pid > 0) return !isProcessAlive(pid)
  // Unparseable content: stale rather than a permanent deadlock.
  return true
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = exists but owned by another user; anything else (ESRCH) = gone.
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

// Remove `dir` and any of its now-empty ancestor directories, stopping at
// `root` (the worktree). Used by restore's E1 cleanup so a complete rollback
// also prunes empty post-snapshot directories. Best-effort: failures are
// swallowed (a dir may still hold unrelated untracked content).

/**
 * Windows-safe path segment for a project id used under
 * `<Global.Path.data>/snapshot/<id>/<hash>` and the identical formula in
 * `session/prompt.ts` (the two MUST stay in sync).
 *
 * Non-git projects use the full directory path as the project id, which on
 * Windows contains `:`/`\` — invalid inside a single path component and makes
 * `mkdir` fail with ENOENT. Hash those ids; ids that are already safe (e.g.
 * git root-commit hashes) are used verbatim. POSIX layout is unchanged.
 */
export const projectIdSegment = (id: string): string => (/[*?"<>|:]/.test(id) ? Hash.fast(id) : id)

/**
 * Root of one project's shadow snapshot storage: `<data>/snapshot/<id-segment>/`.
 *
 * Single source of the formula. Each directory the user ever opened under this
 * project gets its own `Hash.fast(directory)` subdir, so project deletion must
 * remove the ROOT — deleting one subdir leaves every other opened directory's
 * repo (and its refs) orphaned forever with no GC path back to it (P2-38).
 */
export const snapshotRootDir = (projectId: string): string =>
  path.join(Global.Path.data, "snapshot", projectIdSegment(projectId))

/**
 * Absolute path of the shadow git repository for one project directory.
 *
 * The Snapshot service and the Rust run_loop must agree on this: Rust writes
 * tree hashes into this repo and TS consumes them later
 * (revert/restore/diff/diffFull).
 */
export const snapshotGitDir = (projectId: string, directory: string): string =>
  path.join(snapshotRootDir(projectId), Hash.fast(directory))
const removeEmptyDirs = (dir: string, root: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    let current = dir
    while (current && current !== root && path.relative(root, current) !== "") {
      let entries: string[]
      try {
        entries = yield* Effect.promise(() => nodefs.readdir(current))
      } catch {
        break
      }
      if (entries.length > 0) break
      // 10-1: `rmdir` (non-recursive) fails atomically if the directory gained
      // an entry between the readdir and the removal — the old recursive rm
      // would have deleted that new file along with the directory.
      try {
        yield* Effect.promise(() => nodefs.rmdir(current))
      } catch {
        break
      }
      current = path.dirname(current)
    }
  })
import { Log } from "../util"
import { DuoduoError } from "@/util/error"
import { withStatics } from "@/util/schema"
import { zod } from "@/util/effect-zod"

export const Patch = Schema.Struct({
  hash: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type Patch = typeof Patch.Type

export const FileDiff = Schema.Struct({
  file: Schema.String,
  patch: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
})
  .annotate({ identifier: "SnapshotFileDiff" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type FileDiff = typeof FileDiff.Type

const log = Log.create({ service: "snapshot" })
// Default file-snapshot retention (days). Overridable per-project via the
// `snapshot_retention_days` config key; the live value is read by
// `retentionDays` so a config change applies on the next hourly cleanup.
const DEFAULT_RETENTION_DAYS = 90
// 10-3/10-5: overridable via `snapshot_max_file_size` / `snapshot_max_total_size`
// (user-controllable settings, read live like retentionDays).
const DEFAULT_MAX_FILE_SIZE = 2 * 1024 * 1024
const DEFAULT_MAX_TOTAL_SIZE = 5 * 1024 * 1024 * 1024
// Monotonic suffix for throwaway git index files, so two concurrent
// `hasUncommitted` calls can never share (and corrupt) the same temp file.
let throwawaySeq = 0
const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
const cfg = ["-c", "core.autocrlf=false", ...core]
const quote = [...cfg, "-c", "core.quotepath=false"]
interface GitResult {
  readonly code: ChildProcessSpawner.ExitCode
  readonly text: string
  readonly stderr: string
}

type State = Omit<Interface, "init">

/** Disk usage of the snapshot repository backing the current instance. */
export interface Stats {
  /** Absolute path of the hidden snapshot git repo (`--git-dir`). */
  readonly gitdir: string
  /** Whether the repo has been initialized yet. */
  readonly exists: boolean
  /** Total bytes occupied by the repo (0 when it does not exist). */
  readonly sizeBytes: number
  /** Default retention used by the hourly background cleanup, in days. */
  readonly defaultPruneDays: number
  /** 10-3: per-file snapshot cap in bytes (configured / default). */
  readonly maxFileSizeBytes: number
  /** 10-5: snapshot-repo disk cap in bytes (configured / default). */
  readonly maxTotalSizeBytes: number
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  /**
   * Run `git gc --prune=<days>.days` on the snapshot repo, dropping unreachable
   * objects older than the cutoff. Defaults to the background retention when
   * `days` is omitted.
   */
  readonly cleanup: (days?: number) => Effect.Effect<void>
  readonly stats: () => Effect.Effect<Stats>
  readonly track: (description?: string) => Effect.Effect<string | undefined>
  readonly markDirty: () => Effect.Effect<void>
  readonly patch: (hash: string) => Effect.Effect<Patch>
  // 10-4: restore/revert report the files they could not roll back so the
  // caller can surface a partial-failure summary instead of it living only
  // in logs.
  readonly restore: (snapshot: string, force?: boolean) => Effect.Effect<{ failed: string[] }, DuoduoError>
  readonly revert: (patches: Patch[], force?: boolean) => Effect.Effect<{ failed: string[] }, DuoduoError>
  readonly diff: (hash: string) => Effect.Effect<string>
  readonly diffFull: (from: string, to: string) => Effect.Effect<FileDiff[], DuoduoError>
  /**
   * S-02 gate helper (B1). Returns true when the worktree has uncommitted
   * changes relative to `baseline` (a snapshot tree/commit hash). It diffs the
   * worktree directly against the baseline tree object, so it is immune to the
   * shadow index being staged by `track()`/`patch()` (the root cause of defect
   * B). Used by `session/revert.ts` before restoring the baseline.
   */
  readonly hasUncommitted: (baseline: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/Snapshot") {}

export const layer: Layer.Layer<
  Service,
  never,
  AppFileSystem.Service | ChildProcessSpawner.ChildProcessSpawner | Config.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const config = yield* Config.Service

    // Per-repo serialization locks are shared at the MODULE level (not per
    // Service instance). Snapshot instances are created per-call (one Service
    // per `Service.of` evaluation), so a lock Map closed over inside the Layer
    // would NOT serialize concurrent operations issued from different
    // instances against the SAME shadow repo — they would race on the shared
    // shadow index (e.g. interleaved `add -A` corrupting `write-tree` output).
    // Keying by gitdir keeps cross-project calls isolated while guaranteeing
    // same-repo calls are strictly serialized.
    const lock = (key: string) => {
      const hit = GITDIR_LOCKS.get(key)
      if (hit) return hit

      const next = Semaphore.makeUnsafe(1)
      GITDIR_LOCKS.set(key, next)
      return next
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("Snapshot.state")(function* (ctx) {
        const state = {
          directory: ctx.directory,
          worktree: ctx.directory,
          gitdir: snapshotGitDir(ctx.project.id, ctx.directory),
          vcs: ctx.project.vcs,
        }

        const args = (cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]

        const enc = new TextEncoder()
        const feed = (list: string[]) => Stream.make(enc.encode(list.join("\0") + "\0"))

        const git = Effect.fnUntraced(
          function* (
            cmd: string[],
            opts?: { cwd?: string; env?: Record<string, string>; stdin?: ChildProcess.CommandInput },
          ) {
            const proc = ChildProcess.make("git", cmd, {
              cwd: opts?.cwd,
              env: opts?.env,
              extendEnv: true,
              stdin: opts?.stdin,
            })
            const handle = yield* spawner.spawn(proc)
            const [text, stderr] = yield* Effect.all(
              [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
              { concurrency: 2 },
            )
            const code = yield* handle.exitCode
            return { code, text, stderr } satisfies GitResult
          },
          Effect.scoped,
          Effect.catch((err) =>
            Effect.succeed({
              code: ChildProcessSpawner.ExitCode(1),
              text: "",
              stderr: err instanceof Error ? err.message : String(err),
            }),
          ),
        )

        const ignore = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return new Set<string>()
          const check = yield* git(
            [
              ...quote,
              "--git-dir",
              path.join(state.worktree, ".git"),
              "--work-tree",
              state.worktree,
              "check-ignore",
              "--no-index",
              "--stdin",
              "-z",
            ],
            {
              cwd: state.directory,
              stdin: feed(files),
            },
          )
          if (check.code !== 0 && check.code !== 1) return new Set<string>()
          return new Set(check.text.split("\0").filter(Boolean))
        })

        const drop = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          yield* git(
            [
              ...cfg,
              ...args(["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]),
            ],
            {
              cwd: state.directory,
              stdin: feed(files),
            },
          )
        })

        const stage = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return true
          const result = yield* git(
            [...cfg, ...args(["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"])],
            {
              cwd: state.directory,
              stdin: feed(files),
            },
          )
          if (result.code === 0) return true
          // A partially-staged index must never reach `write-tree`: the tree
          // would not represent the worktree and a later `restore` would treat
          // unstaged user files as post-snapshot additions and DELETE them
          // (P2-40, same root cause the Rust side already propagates).
          log.error("failed to add snapshot files", {
            exitCode: result.code,
            stderr: result.stderr,
          })
          return false
        })

        const exists = (file: string) => fs.exists(file).pipe(Effect.orDie)
        const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
        const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
        // Order matters: the in-process Semaphore FIRST, then the cross-process
        // lock file. The reverse order can deadlock two threads of THIS process
        // (one holds the file and waits for the semaphore that the other holds
        // while waiting for the file).
        const locked = <A, E, R>(fx: Effect.Effect<A, E, R>) =>
          lock(state.gitdir).withPermits(1)(
            Effect.acquireUseRelease(
              Effect.tryPromise({
                try: () => acquireGitdirFileLock(state.gitdir),
                catch: (err) =>
                  new DuoduoError({
                    message: `snapshot gitdir lock failed: ${String(err)}`,
                    cause: err,
                  }),
              }).pipe(Effect.orDie),
              () => fx,
              (release) => Effect.tryPromise(release).pipe(Effect.orDie),
            ),
          )

        const enabled = Effect.fnUntraced(function* () {
          // S-01: snapshots use a dedicated `--git-dir` (state.gitdir) that is
          // independent of whether the *project* itself is git-managed, so they
          // work for any project — not only git repos. The previous
          // `state.vcs !== "git"` gate wrongly disabled snapshots for non-git
          // projects. We only disable when the user explicitly opts out.
          const cfg = yield* config.get()
          if (cfg.snapshot === false) return false
          return true
        })

        // Live retention window (days). Reads config on every call so changing
        // `snapshot_retention_days` takes effect on the next hourly cleanup
        // without a restart. Falls back to DEFAULT_RETENTION_DAYS when unset
        // or invalid.
        const retentionDays = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          const v = cfg.snapshot_retention_days
          return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_RETENTION_DAYS
        })

        // 10-3: live per-file snapshot cap (bytes). Untracked files larger than
        // this are excluded from snapshots (never snapshotted, never deleted by
        // a rollback). Changing the value only affects NEW judgments — already
        // excluded files stay excluded.
        const maxFileSize = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          const v = cfg.snapshot_max_file_size
          return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_FILE_SIZE
        })

        // 10-5: live snapshot-repo disk cap (bytes).
        const maxTotalSize = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          const v = cfg.snapshot_max_total_size
          return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_TOTAL_SIZE
        })

        // S-02: detect uncommitted worktree changes against the rollback baseline.
        // B1 (root fix for defect B): we must NOT rely on the shadow index
        // (diff-files / ls-files --others), because track()/patch() run `add -A`
        // which stages the very edits we want to protect into that index — so any
        // index-based check sees a clean worktree and never fires. Instead we build
        // a THROWAWAY index (GIT_INDEX_FILE) reflecting the CURRENT worktree, then
        // diff the baseline tree against that throwaway index. The throwaway index
        // is never the persistent shadow index, so it neither pollutes the latter
        // nor is blinded by it, yet it still captures the user's manual edits
        // (modified / deleted / newly created files). `baseline` is the snapshot
        // hash we are about to roll back to (commit or tree; both resolve to a tree).
        const hasUncommitted = Effect.fnUntraced(function* (baseline: string) {
          // P2-42: this used to write a FIXED throwaway index path
          // (`index.hasuncommitted`) inside the shared gitdir, so two
          // concurrent calls — or one racing `track()` — could read/write each
          // other's index and report the wrong answer. The per-call unique
          // name below removes that race.
          //
          // Deliberately NOT taking the gitdir lock: this only touches its own
          // private index (GIT_INDEX_FILE), never the shared shadow index, and
          // it is called from inside `restore()`'s locked block — taking the
          // lock here would self-deadlock.
          const tmpIndex = path.join(state.gitdir, `index.hasuncommitted.${Date.now()}.${throwawaySeq++}`)
          // GIT_INDEX_FILE is an ENV var (not a -c config), so we pass it via env.
          const env = { GIT_INDEX_FILE: tmpIndex }
          // Stage the CURRENT worktree into a throwaway index (never the
          // persistent shadow index, so we neither pollute it nor are blinded
          // by it — the defect B trap).
          const add = yield* git(
            [...quote, `--git-dir`, state.gitdir, `--work-tree`, state.worktree, "add", "-A"],
            { cwd: state.directory, env },
          )
          if (add.code !== 0) {
            yield* fs.remove(tmpIndex).pipe(Effect.catch(() => Effect.void))
            return true
          }
          // Materialize the throwaway index as a tree, then compare the two
          // trees directly with diff-tree (no worktree/index ambiguity).
          const now = yield* git(
            [...quote, `--git-dir`, state.gitdir, `--work-tree`, state.worktree, "write-tree"],
            { cwd: state.directory, env },
          )
          if (now.code !== 0) {
            yield* fs.remove(tmpIndex).pipe(Effect.catch(() => Effect.void))
            return true
          }
          const drift = yield* git(
            [
              ...quote,
              `--git-dir`,
              state.gitdir,
              `--work-tree`,
              state.worktree,
              "diff-tree",
              "--quiet",
              baseline,
              now.text.trim(),
            ],
            { cwd: state.directory, env },
          )
          yield* fs.remove(tmpIndex).pipe(Effect.catch(() => Effect.void))
          return drift.code !== 0
        })

        const excludes = Effect.fnUntraced(function* () {
          const result = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
            cwd: state.worktree,
          })
          const file = result.text.trim()
          if (!file) return
          if (!(yield* exists(file))) return
          return file
        })

        const sync = Effect.fnUntraced(function* (list: string[] = []) {
          const file = yield* excludes()
          const target = path.join(state.gitdir, "info", "exclude")
          // P2-41: MERGE with whatever is already in the snapshot's exclude
          // file instead of overwriting it. The Rust side seeds this file with
          // its default rules (node_modules/, dist/, ...) — overwriting threw
          // those away, so `git add` then staged whole dependency trees and
          // every snapshot became slow and huge.
          const existing = (yield* read(target)).split("\n").map((l) => l.trim()).filter(Boolean)
          const wanted = [
            ...(file ? (yield* read(file)).split("\n").map((l) => l.trim()).filter(Boolean) : []),
            ...list.map((item) => `/${item.replaceAll("\\", "/")}`),
          ].filter(Boolean)
          const merged = [...existing]
          for (const line of wanted) {
            if (!merged.includes(line)) merged.push(line)
          }
          yield* fs.ensureDir(path.join(state.gitdir, "info")).pipe(Effect.orDie)
          yield* fs.writeFileString(target, merged.length ? `${merged.join("\n")}\n` : "").pipe(Effect.orDie)
        })

        const add = Effect.fnUntraced(function* () {
          yield* sync()
          const [diff, other] = yield* Effect.all(
            [
              git([...quote, ...args(["diff-files", "--name-only", "-z", "--", "."])], {
                cwd: state.directory,
              }),
              git([...quote, ...args(["ls-files", "--others", "--exclude-standard", "-z", "--", "."])], {
                cwd: state.directory,
              }),
            ],
            { concurrency: 2 },
          )
          if (diff.code !== 0 || other.code !== 0) {
            log.error("failed to list snapshot files", {
              diffCode: diff.code,
              diffStderr: diff.stderr,
              otherCode: other.code,
              otherStderr: other.stderr,
            })
            return false
          }

          const tracked = diff.text.split("\0").filter(Boolean)
          const untracked = other.text.split("\0").filter(Boolean)
          // Exclude Windows shell redirection artifacts ($null / nul) — never user content.
          const all = Array.from(new Set([...tracked, ...untracked])).filter(
            (item) => !isShellArtifactPath(item),
          )
          if (!all.length) return true

          // Resolve source-repo ignore rules against the exact candidate set.
          // --no-index keeps this pattern-based even when a path is already tracked.
          const ignored = yield* ignore(all)

          // Remove newly-ignored files from snapshot index to prevent re-adding
          if (ignored.size > 0) {
            const ignoredFiles = Array.from(ignored)
            log.info("removing gitignored files from snapshot", { count: ignoredFiles.length })
            yield* drop(ignoredFiles)
          }

          const allow = all.filter((item) => !ignored.has(item))
          if (!allow.length) return true

          const fileSizeCap = yield* maxFileSize()
          const large = new Set(
            (yield* Effect.all(
              allow.map((item) =>
// @effect-diagnostics-next-line unnecessaryPipeChain:off
                fs
                  .stat(path.join(state.directory, item))
                  .pipe(Effect.catch(() => Effect.void))
                  .pipe(
                    Effect.map((stat) => {
                      if (!stat || stat.type !== "File") return
                      const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                      return size > fileSizeCap ? item : undefined
                    }),
                  ),
              ),
              { concurrency: 8 },
            )).filter((item): item is string => Boolean(item)),
          )
          const block = new Set(untracked.filter((item) => large.has(item)))
          yield* sync(Array.from(block))
          // Stage only the allowed candidate paths so snapshot updates stay scoped.
          return yield* stage(allow.filter((item) => !block.has(item)))
        })

        const cleanup = Effect.fnUntraced(function* (days?: number) {
          // A user-supplied retention overrides the background default. Anything
          // non-positive/non-finite falls back to `prune` so a bad input can never
          // widen the cutoff into "delete everything".
          const cutoff =
            typeof days === "number" && Number.isFinite(days) && days > 0
              ? `${Math.floor(days)}.days`
              : `${yield* retentionDays()}.days`
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              if (!(yield* exists(state.gitdir))) return
              const result = yield* git(args(["gc", `--prune=${cutoff}`]), { cwd: state.directory })
              if (result.code !== 0) {
                log.warn("cleanup failed", {
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return
              }
              log.info("cleanup", { prune: cutoff })

              // 10-5: disk-size cap (`snapshot_max_total_size`). The repo pins
              // only the LATEST snapshot with a ref (P2-38) — older snapshots
              // are unreachable commits whose age-based pruning IS the
              // oldest-first lever — so shrink the prune cutoff (≥1 day,
              // halved per round, at most 20 gc rounds per run) until the repo
              // fits. Snapshots pruned this way lose their rollback point.
              const cap = yield* maxTotalSize()
              let size = yield* measure(state.gitdir)
              // 10-3: start from the cutoff this run ACTUALLY used (the
              // caller-supplied `days` when valid, else the configured
              // retention) — initializing from the configured retention made
              // the shrink loop a no-op whenever retention was already 1 day.
              let pruneDays = Math.max(
                1,
                typeof days === "number" && Number.isFinite(days) && days > 0
                  ? Math.floor(days)
                  : yield* retentionDays(),
              )
              let rounds = 0
              while (size > cap && rounds < 20 && pruneDays > 1) {
                pruneDays = Math.max(1, Math.floor(pruneDays / 2))
                const shrunk = yield* git(args(["gc", `--prune=${pruneDays}.days`]), { cwd: state.directory })
                if (shrunk.code !== 0) {
                  log.warn("size-cap cleanup gc failed", { exitCode: shrunk.code, stderr: shrunk.stderr })
                  break
                }
                size = yield* measure(state.gitdir)
                rounds++
              }
              if (size > cap) {
                log.warn("snapshot repo still over size cap after cleanup", { size, cap })
              }
            }),
          )
        })

        // Recursive on-disk size of the snapshot repo. Read-only, so it does not
        // take the gitdir lock and can run while a track() is in flight.
        const measure = (dir: string): Effect.Effect<number> =>
          Effect.promise(async () => {
            let total = 0
            const walk = async (current: string) => {
              const entries = await nodefs.readdir(current, { withFileTypes: true }).catch(() => [])
              for (const entry of entries) {
                const full = path.join(current, entry.name)
                if (entry.isDirectory()) {
                  await walk(full)
                  continue
                }
                if (!entry.isFile()) continue
                const info = await nodefs.stat(full).catch(() => undefined)
                if (info) total += info.size
              }
            }
            await walk(dir)
            return total
          })

        const stats = Effect.fnUntraced(function* () {
          const present = yield* exists(state.gitdir)
          return {
            gitdir: state.gitdir,
            exists: present,
            sizeBytes: present ? yield* measure(state.gitdir) : 0,
            defaultPruneDays: yield* retentionDays(),
            maxFileSizeBytes: yield* maxFileSize(),
            maxTotalSizeBytes: yield* maxTotalSize(),
          } satisfies Stats
        })

        let dirty = true
        const markDirtyEffect = Effect.fnUntraced(function* () {
          dirty = true
        })

        const track = Effect.fnUntraced(function* (description?: string) {
          // Sample existence BEFORE locking: acquiring the cross-process lock
          // creates the gitdir, which would otherwise make `existed` true and
          // skip `git init` on the first track of a project.
          //
          // "Exists" must mean "an initialized repo lives here" — probe for
          // HEAD (the structure `git init` always writes), not the directory:
          // a shell gitdir created by anything else made this sample true,
          // skipped `git init` forever, and broke every snapshot operation.
          // `git init` is idempotent, so re-initializing a shell is safe.
          // MUST stay in sync with crates/agent-executor/src/snapshot/track.rs.
          const existed = yield* exists(path.join(state.gitdir, "HEAD"))
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
              if (!existed) {
                yield* git(["init"], {
                  env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
                })
                yield* git(["--git-dir", state.gitdir, "config", "core.autocrlf", "false"])
                yield* git(["--git-dir", state.gitdir, "config", "core.longpaths", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.symlinks", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.fsmonitor", "false"])
                log.info("initialized")
                // Force first add after init since index is empty
                dirty = true
              }

              if (dirty) {
                const staged = yield* add()
                if (!staged) {
                  // Stage failure: retry on the next track and publish NO hash —
                  // a tree built now would not represent the worktree (P2-40).
                  dirty = true
                  return undefined
                }
                dirty = false
              } else {
                // Safety net: even if dirty flag missed a change (FileWatcher lag,
                // external editors, bash side-effects), git diff-files compares the
                // current worktree against the snapshot index. Non-zero exit means
                // there are unstaged changes — we must add() to capture them.
                // Note: snapshot repo never commits, so HEAD doesn't exist; we use
                // diff-files (worktree vs index) instead of diff-index (vs HEAD).
                const drift = yield* git([...quote, ...args(["diff-files", "--quiet"])], {
                  cwd: state.directory,
                })
                let needAdd = drift.code !== 0
                if (!needAdd) {
                  // Also check for untracked files via ls-files --others, since
                  // diff-files only reports modifications to tracked files.
                  const untracked = yield* git(
                    [...quote, ...args(["ls-files", "--others", "--exclude-standard", "-z", "--", "."])],
                    { cwd: state.directory },
                  )
                  needAdd = untracked.code === 0 && untracked.text.split("\0").filter(Boolean).length > 0
                }
                if (needAdd && !(yield* add())) {
                  dirty = true
                  return undefined
                }
              }

              const result = yield* git(args(["write-tree"]), { cwd: state.directory })
              if (result.code !== 0) {
                log.error("write-tree failed", { exitCode: result.code, stderr: result.stderr })
                return undefined
              }
              const treeHash = result.text.trim()
              // S-05: when an operation description is supplied, wrap the tree in a
              // commit so the snapshot carries a self-describing description + timestamp.
              // All consumers (read-tree/checkout/diff/show) accept a commit-ish, so this
              // is backward compatible with previously-stored tree hashes. When no
              // description is given (background auto-snapshots) we keep the deterministic
              // tree hash to preserve the change-detection invariant (track() called twice
              // with no changes must return the same hash).
              const hash =
                description && description.trim().length > 0
                  ? (
                      yield* git(
                        [
                          ...args([
                            "-c",
                            "user.name=duoduo",
                            "-c",
                            "user.email=duoduo@localhost",
                            "commit-tree",
                            treeHash,
                            "-m",
                            `duoduo snapshot: ${description.trim().slice(0, 200)}`,
                          ]),
                        ],
                        { cwd: state.directory },
                      )
                    ).text.trim()
                  : treeHash
              log.info("tracking", { hash, cwd: state.directory, git: state.gitdir })
              // P2-38: pin the snapshot so `git gc --prune` cannot delete a
              // tree that an active session still references. The ref moves
              // forward on every track, so old snapshots still age out per the
              // retention policy.
              yield* git(args(["update-ref", "refs/duoduo/snapshot-last", hash]), {
                cwd: state.directory,
              })
              return hash
            }),
          )
        })

        const patch = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* add()
              // `-z`: NUL-separated output that git never quotes and that
              // cannot be confused by a newline inside a filename. Splitting on
              // "\n" (the previous behaviour) silently produced two bogus paths
              // for such a name, and the reverter deletes every path missing
              // from the snapshot tree — i.e. it deleted the user's file
              // (P1-28). Mirrors `restore`/`revert`, which already use `-z`.
              const result = yield* git(
                [...quote, ...args(["diff", "--cached", "--no-ext-diff", "--name-only", "-z", hash, "--", "."])],
                {
                  cwd: state.directory,
                },
              )
              if (result.code !== 0) {
                log.warn("failed to get diff", { hash, exitCode: result.code })
                return { hash, files: [] }
              }
              const files = result.text.split("\0").filter(Boolean)

              // Hide ignored-file removals from the user-facing patch output.
              const ignored = yield* ignore(files)

              return {
                hash,
                files: files
                  .filter((item) => !ignored.has(item))
                  .map((x) => path.join(state.worktree, x).replaceAll("\\", "/")),
              }
            }),
          )
        })

        const restore = Effect.fnUntraced(function* (snapshot: string, force = false) {
          // P2-44: snapshot the CURRENT worktree before mutating it. A
          // rollback used to be a one-way door — once the baseline was
          // restored, every post-baseline edit was gone with no way back.
          // The pre-rollback hash is logged so the state remains recoverable
          // through the normal restore path.
          //
          // Deliberately OUTSIDE the gitdir lock: `track()` takes that same
          // lock itself, so calling it inside would self-deadlock.
          const reverse = yield* track(`pre-rollback → ${snapshot.slice(0, 12)}`)
          if (reverse) log.info("reverse snapshot created", { reverse, target: snapshot })

          // 10-4: files that could not be removed during the post-restore
          // cleanup are reported back to the caller instead of vanishing into
          // a swallowed error.
          const failed: string[] = []

          return yield* locked(
            Effect.gen(function* () {
              // S-02: refuse to overwrite uncommitted edits unless forced.
              // Baseline is the snapshot we are about to roll back to.
              if (!force && (yield* hasUncommitted(snapshot))) {
                return yield* Effect.fail(
                  new DuoduoError({
                    message:
                      "Workspace has uncommitted changes; rollback would overwrite them. Commit or stash first, or use the force option.",
                    messageZh:
                      "工作区存在未提交的变更，回滚会覆盖这些手动修改。请先提交或 stash，或使用 force 选项强制回滚。",
                  }),
                )
              }
              log.info("restore", { commit: snapshot })
              const result = yield* git([...core, ...args(["read-tree", snapshot])], { cwd: state.worktree })
              if (result.code === 0) {
                const checkout = yield* git([...core, ...args(["checkout-index", "-a", "-f"])], {
                  cwd: state.worktree,
                })
                if (checkout.code === 0) {
                  // E1: unify restore with revert's "complete rollback" semantics.
                  // After restoring the baseline files, remove any file that did
                  // NOT exist in the snapshot (e.g. created after the snapshot was
                  // taken). We derive the current worktree file set from a THROWAWAY
                  // index (add -A) so we never mutate the persistent shadow index,
                  // then delete the set difference vs the baseline tree. `.git` is
                  // never listed by ls-files, so it is never removed.
                  const tracked = yield* git(
                    [...quote, ...args(["ls-tree", "-r", "-z", "--name-only", snapshot])],
                    { cwd: state.worktree },
                  )
                  if (tracked.code === 0) {
                    // -z keeps paths unescaped: without it git octal-escapes
                    // non-ASCII names, so `keep` would never match the real
                    // names produced by `ls-files -z` below and every
                    // non-ASCII file would be treated as post-snapshot and
                    // deleted.
                    const keep = new Set(tracked.text.split("\0").filter(Boolean))
                    const tmpIndex = path.join(state.gitdir, "index.restore-cleanup")
                    const env = { GIT_INDEX_FILE: tmpIndex }
                    const stageAll = yield* git(
                      [
                        ...quote,
                        "--git-dir",
                        state.gitdir,
                        "--work-tree",
                        state.worktree,
                        "add",
                        "-A",
                      ],
                      { cwd: state.worktree, env },
                    )
                    if (stageAll.code === 0) {
                      const ls = yield* git(
                        [
                          ...quote,
                          "--git-dir",
                          state.gitdir,
                          "--work-tree",
                          state.worktree,
                          "ls-files",
                          "-z",
                        ],
                        { cwd: state.worktree, env },
                      )
                      if (ls.code === 0) {
                        // 10-3 invariant: files excluded from snapshots by the
                        // per-file size cap were never snapshotted — a rollback
                        // must never delete them (they are user data the
                        // snapshot layer deliberately does not track).
                        const fileSizeCap = yield* maxFileSize()
                        const current = ls.text.split("\0").filter(Boolean)
                        const emptyDirs = new Set<string>()
                        for (const f of current) {
                          if (!keep.has(f)) {
                            const abs = path.join(state.worktree, f)
                            const stat = yield* fs.stat(abs).pipe(Effect.catch(() => Effect.void))
                            const size = stat && stat.type === "File" ? (typeof stat.size === "bigint" ? Number(stat.size) : stat.size) : 0
                            if (size > fileSizeCap) continue
                            const removed = yield* fs.remove(abs).pipe(Effect.catch(() => Effect.succeed(false as const)))
                            if (removed === false) failed.push(abs)
                            // Track the now-orphaned parent directory for cleanup,
                            // so a complete rollback also removes empty post-snapshot
                            // directories (not just the files within them).
                            emptyDirs.add(path.dirname(abs))
                          }
                        }
                        // Best-effort: remove directories that became empty after the
                        // file deletions, walking up until we hit the worktree root.
                        for (const dir of emptyDirs) {
                          yield* removeEmptyDirs(dir, state.worktree)
                        }
                      }
                    }
                    yield* fs.remove(tmpIndex).pipe(Effect.catch(() => Effect.void))
                  }
                  return { failed }
                }
                log.error("failed to restore snapshot", {
                  snapshot,
                  exitCode: checkout.code,
                  stderr: checkout.stderr,
                })
                // Fail instead of returning: the caller (SessionRevert) only
                // marks "rolled back" after this succeeds. A silent return made
                // Windows checkouts of locked/read-only files report success
                // while the worktree was untouched (P1-29).
                return yield* Effect.fail(
                  new DuoduoError({
                    message: `Failed to restore snapshot ${snapshot} (git checkout-index exit ${checkout.code}): ${checkout.stderr}`,
                    messageZh: `回滚快照 ${snapshot} 失败（git checkout-index 退出码 ${checkout.code}）：${checkout.stderr}`,
                  }),
                )
              }
              log.error("failed to restore snapshot", {
                snapshot,
                exitCode: result.code,
                stderr: result.stderr,
              })
              return yield* Effect.fail(
                new DuoduoError({
                  message: `Failed to restore snapshot ${snapshot} (git read-tree exit ${result.code}): ${result.stderr}`,
                  messageZh: `回滚快照 ${snapshot} 失败（git read-tree 退出码 ${result.code}）：${result.stderr}`,
                }),
              )
            }),
          )
        })

        const revert = Effect.fnUntraced(function* (patches: Patch[], force = false) {
          // P2-44: capture the pre-revert state so the operation stays
          // reversible (checkout/delete below are otherwise destructive).
          //
          // Deliberately OUTSIDE the gitdir lock: `track()` takes that same
          // lock itself, so calling it inside would self-deadlock.
          const reverse = yield* track("pre-revert")
          if (reverse) log.info("reverse snapshot created", { reverse })

          return yield* locked(
            Effect.gen(function* () {
              // Note: S-02 (refuse to overwrite uncommitted edits) is NOT enforced
              // here. `revert` is always preceded by `restore(session.revert.snapshot)`
              // in SessionRevert (which resets the worktree to the baseline), so any
              // check performed at this point would see a clean worktree and never
              // fire. The gate lives in `session/revert.ts` BEFORE the restore call,
              // using `hasUncommitted(rev.snapshot)` — see B1. `force` is kept for
              // API symmetry / future caller-driven overrides but has no S-02 effect
              // here.
              const ops: { hash: string; file: string; rel: string }[] = []
              const seen = new Set<string>()
              for (const item of patches) {
                for (const file of item.files) {
                  if (seen.has(file)) continue
                  seen.add(file)
                  ops.push({
                    hash: item.hash,
                    file,
                    rel: path.relative(state.worktree, file).replaceAll("\\", "/"),
                  })
                }
              }

              // 10-4: files that could not be reverted (kept as-is) are
              // reported back to the caller instead of only living in logs.
              const failed: string[] = []

              const single = Effect.fnUntraced(function* (op: (typeof ops)[number]) {
                log.info("reverting", { file: op.file, hash: op.hash })
                const result = yield* git([...core, ...args(["checkout", op.hash, "--", op.file])], {
                  cwd: state.worktree,
                })
                if (result.code === 0) return
                const tree = yield* git([...core, ...args(["ls-tree", op.hash, "--", op.rel])], {
                  cwd: state.worktree,
                })
                if (tree.code !== 0) {
                  // ls-tree itself failed (e.g. git not on PATH). This is NOT proof the
                  // file is absent — deleting would be unsafe. Fail-safe: keep the file.
                  log.warn("ls-tree failed; keeping file (fail-safe, not deleting)", {
                    file: op.file,
                    hash: op.hash,
                    stderr: tree.stderr,
                  })
                  failed.push(op.file)
                  return
                }
                if (tree.text.trim()) {
                  log.info("file existed in snapshot but checkout failed, keeping", { file: op.file, hash: op.hash })
                  failed.push(op.file)
                  return
                }
                log.info("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                yield* remove(op.file)
                if (yield* exists(op.file)) failed.push(op.file)
              })

              const clash = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

              for (let i = 0; i < ops.length; ) {
                const first = ops[i]!
                const run = [first]
                let j = i + 1
                // Only batch adjacent files when their paths cannot affect each other.
                while (j < ops.length && run.length < 100) {
                  const next = ops[j]!
                  if (next.hash !== first.hash) break
                  if (run.some((item) => clash(item.rel, next.rel))) break
                  run.push(next)
                  j += 1
                }

                if (run.length === 1) {
                  yield* single(first)
                  i = j
                  continue
                }

                const tree = yield* git(
                  // -z (see restore() above): escaped names would make `have`
                  // miss every non-ASCII file, deleting it instead of reverting.
                  [...quote, ...args(["ls-tree", "-z", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
                  {
                    cwd: state.worktree,
                  },
                )

                if (tree.code !== 0) {
                  log.info("batched ls-tree failed, falling back to single-file revert", {
                    hash: first.hash,
                    files: run.length,
                  })
                  for (const op of run) {
                    yield* single(op)
                  }
                  i = j
                  continue
                }

                const have = new Set(tree.text.split("\0").filter(Boolean))
                const list = run.filter((item) => have.has(item.rel))
                if (list.length) {
                  log.info("reverting", { hash: first.hash, files: list.length })
                  const result = yield* git(
                    [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.file)])],
                    {
                      cwd: state.worktree,
                    },
                  )
                  if (result.code !== 0) {
                    log.info("batched checkout failed, falling back to single-file revert", {
                      hash: first.hash,
                      files: list.length,
                    })
                    for (const op of run) {
                      yield* single(op)
                    }
                    i = j
                    continue
                  }
                }

                for (const op of run) {
                  if (have.has(op.rel)) continue
                  log.info("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                  yield* remove(op.file)
                  // 10-4: same post-delete existence check as `single` — a
                  // swallowed removal failure must surface in the failed[] summary.
                  if (yield* exists(op.file)) failed.push(op.file)
                }

                i = j
              }

              return { failed }
            }),
          )
        })

        const diff = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* add()
              const result = yield* git([...quote, ...args(["diff", "--cached", "--no-ext-diff", hash, "--", "."])], {
                cwd: state.worktree,
              })
              if (result.code !== 0) {
                log.warn("failed to get diff", {
                  hash,
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return ""
              }
              return result.text.trim()
            }),
          )
        })

        const diffFull = Effect.fnUntraced(function* (from: string, to: string) {
          return yield* locked(
            Effect.gen(function* () {
              type Row = {
                file: string
                status: "added" | "deleted" | "modified"
                binary: boolean
                additions: number
                deletions: number
              }

              type Ref = {
                file: string
                side: "before" | "after"
                ref: string
              }

              const show = Effect.fnUntraced(function* (row: Row) {
                if (row.binary) return ["", ""]
                if (row.status === "added") {
                  return [
                    "",
                    yield* git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                  ]
                }
                if (row.status === "deleted") {
                  return [
                    yield* git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(
                      Effect.map((item) => item.text),
                    ),
                    "",
                  ]
                }
                return yield* Effect.all(
                  [
                    git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                    git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                  ],
                  { concurrency: 2 },
                )
              })

              const load = Effect.fnUntraced(
                function* (rows: Row[]) {
                  const refs = rows.flatMap((row) => {
                    if (row.binary) return []
                    if (row.status === "added")
                      return [{ file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref]
                    if (row.status === "deleted") {
                      return [{ file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref]
                    }
                    return [
                      { file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref,
                      { file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref,
                    ]
                  })
                  if (!refs.length) return new Map<string, { before: string; after: string }>()

                  const proc = ChildProcess.make("git", [...cfg, ...args(["cat-file", "--batch"])], {
                    cwd: state.directory,
                    extendEnv: true,
                    stdin: Stream.make(new TextEncoder().encode(refs.map((item) => item.ref).join("\n") + "\n")),
                  })
                  const handle = yield* spawner.spawn(proc)
                  const [out, err] = yield* Effect.all(
                    [Stream.mkUint8Array(handle.stdout), Stream.mkString(Stream.decodeText(handle.stderr))],
                    { concurrency: 2 },
                  )
                  const code = yield* handle.exitCode
                  if (code !== 0) {
                    log.info("git cat-file --batch failed during snapshot diff, falling back to per-file git show", {
                      stderr: err,
                      refs: refs.length,
                    })
                    return
                  }

                  const fail = (msg: string, extra?: Record<string, string>) => {
                    log.info(msg, { ...extra, refs: refs.length })
                    return undefined
                  }

                  const map = new Map<string, { before: string; after: string }>()
                  const dec = new TextDecoder()
                  let i = 0
                  for (const ref of refs) {
                    let end = i
                    while (end < out.length && out[end] !== 10) end += 1
                    if (end >= out.length) {
                      return fail(
                        "git cat-file --batch returned a truncated header during snapshot diff, falling back to per-file git show",
                      )
                    }

                    const head = dec.decode(out.slice(i, end))
                    i = end + 1
                    const hit = map.get(ref.file) ?? { before: "", after: "" }
                    if (head.endsWith(" missing")) {
                      map.set(ref.file, hit)
                      continue
                    }

                    const match = head.match(/^[0-9a-f]+ blob (\d+)$/)
                    if (!match) {
                      return fail(
                        "git cat-file --batch returned an unexpected header during snapshot diff, falling back to per-file git show",
                        { head },
                      )
                    }

                    const size = Number(match[1])
                    if (!Number.isInteger(size) || size < 0 || i + size >= out.length || out[i + size] !== 10) {
                      return fail(
                        "git cat-file --batch returned truncated content during snapshot diff, falling back to per-file git show",
                        { head },
                      )
                    }

                    const text = dec.decode(out.slice(i, i + size))
                    if (ref.side === "before") hit.before = text
                    if (ref.side === "after") hit.after = text
                    map.set(ref.file, hit)
                    i += size + 1
                  }

                  if (i !== out.length) {
                    return fail(
                      "git cat-file --batch returned trailing data during snapshot diff, falling back to per-file git show",
                    )
                  }

                  return map
                },
                Effect.scoped,
                Effect.catch(() =>
// @effect-diagnostics-next-line effectSucceedWithVoid:off
                  Effect.succeed<Map<string, { before: string; after: string }> | undefined>(undefined),
                ),
              )

              const result: FileDiff[] = []
              const status = new Map<string, "added" | "deleted" | "modified">()

              const statuses = yield* git(
                [...quote, ...args(["diff", "--no-ext-diff", "--name-status", "--no-renames", from, to, "--", "."])],
                { cwd: state.directory },
              )
              // A failed `git diff` (typically: the snapshot objects were
              // pruned by the periodic `git gc` — they carry no ref) used to
              // be swallowed and surfaced as `success: true, fileCount: 0` —
              // a false "no changes" answer (P2-43). Fail loudly instead.
              if (statuses.code !== 0) {
                return yield* Effect.fail(
                  new DuoduoError({
                    message: `Failed to diff snapshots ${from}..${to} (git diff --name-status exit ${statuses.code}): ${statuses.stderr}`,
                    messageZh: `计算快照 ${from}..${to} 之间的差异失败（git diff 退出码 ${statuses.code}）：${statuses.stderr}`,
                  }),
                )
              }

              for (const line of statuses.text.trim().split("\n")) {
                if (!line) continue
                const [code, file] = line.split("\t")
                if (!code || !file) continue
                status.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified")
              }

              const numstat = yield* git(
                [...quote, ...args(["diff", "--no-ext-diff", "--no-renames", "--numstat", from, to, "--", "."])],
                {
                  cwd: state.directory,
                },
              )
              if (numstat.code !== 0) {
                return yield* Effect.fail(
                  new DuoduoError({
                    message: `Failed to diff snapshots ${from}..${to} (git diff --numstat exit ${numstat.code}): ${numstat.stderr}`,
                    messageZh: `计算快照 ${from}..${to} 之间的差异失败（git diff 退出码 ${numstat.code}）：${numstat.stderr}`,
                  }),
                )
              }

              const rows = numstat.text
                .trim()
                .split("\n")
                .filter(Boolean)
                .flatMap((line) => {
                  const [adds, dels, file] = line.split("\t")
                  if (!file) return []
                  const binary = adds === "-" && dels === "-"
                  const additions = binary ? 0 : parseInt(adds!)
                  const deletions = binary ? 0 : parseInt(dels!)
                  return [
                    {
                      file,
                      status: status.get(file) ?? "modified",
                      binary,
                      additions: Number.isFinite(additions) ? additions : 0,
                      deletions: Number.isFinite(deletions) ? deletions : 0,
                    } satisfies Row,
                  ]
                })

              // Hide ignored-file removals from the user-facing diff output.
              const ignored = yield* ignore(rows.map((r) => r.file))
              if (ignored.size > 0) {
                const filtered = rows.filter((r) => !ignored.has(r.file))
                rows.length = 0
                rows.push(...filtered)
              }

              const step = 100
              const patch = (file: string, before: string, after: string) =>
                formatPatch(structuredPatch(file, file, before, after, "", "", { context: Number.MAX_SAFE_INTEGER }))

              for (let i = 0; i < rows.length; i += step) {
                const run = rows.slice(i, i + step)
                const text = yield* load(run)

                for (const row of run) {
                  const hit = text?.get(row.file) ?? { before: "", after: "" }
                  const [before, after] = row.binary ? ["", ""] : text ? [hit.before, hit.after] : yield* show(row)
                  result.push({
                    file: row.file,
                    patch: row.binary ? "" : patch(row.file, before ?? "", after ?? ""),
                    additions: row.additions,
                    deletions: row.deletions,
                    status: row.status,
                  })
                }
              }

              return result
            }),
          )
        })

        yield* cleanup().pipe(
          Effect.catchCause((cause) => {
            log.error("cleanup loop failed", { cause: Cause.pretty(cause) })
            return Effect.void
          }),
          Effect.repeat(Schedule.spaced(Duration.hours(1))),
          Effect.delay(Duration.minutes(1)),
          Effect.forkScoped,
        )

        return {
          cleanup,
          stats,
          track,
          markDirty: markDirtyEffect,
          patch,
          restore,
          revert,
          diff,
          diffFull,
          hasUncommitted,
        }
      }),
    )

    return Service.of({
      init: Effect.fn("Snapshot.init")(function* () {
        yield* InstanceState.get(state)
      }),
      cleanup: Effect.fn("Snapshot.cleanup")(function* (days?: number) {
        return yield* InstanceState.useEffect(state, (s) => s.cleanup(days))
      }),
      stats: Effect.fn("Snapshot.stats")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.stats())
      }),
      track: Effect.fn("Snapshot.track")(function* (description?: string) {
        return yield* InstanceState.useEffect(state, (s) => s.track(description))
      }),
      markDirty: Effect.fn("Snapshot.markDirty")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.markDirty())
      }),
      patch: Effect.fn("Snapshot.patch")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.patch(hash))
      }),
      restore: Effect.fn("Snapshot.restore")(function* (snapshot: string, force?: boolean) {
        return yield* InstanceState.useEffect(state, (s) => s.restore(snapshot, force))
      }),
      revert: Effect.fn("Snapshot.revert")(function* (patches: Patch[], force?: boolean) {
        return yield* InstanceState.useEffect(state, (s) => s.revert(patches, force))
      }),
      diff: Effect.fn("Snapshot.diff")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diff(hash))
      }),
      diffFull: Effect.fn("Snapshot.diffFull")(function* (from: string, to: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diffFull(from, to))
      }),
      hasUncommitted: Effect.fn("Snapshot.hasUncommitted")(function* (baseline: string) {
        return yield* InstanceState.useEffect(state, (s) => s.hasUncommitted(baseline))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as Snapshot from "."
