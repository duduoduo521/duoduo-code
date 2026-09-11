import { Duration, Effect, Layer, Context, Stream, Scope, Schedule } from "effect"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { FileWatcher } from "@/file/watcher"
import { Git } from "@/git"
import { Log } from "@/util"
import z from "zod"

const log = Log.create({ service: "vcs" })

const count = (text: string) => {
  if (!text) return 0
  if (!text.endsWith("\n")) return text.split("\n").length
  return text.slice(0, -1).split("\n").length
}

const work = Effect.fnUntraced(function* (fs: AppFileSystem.Interface, cwd: string, file: string) {
  const full = path.join(cwd, file)
  if (!(yield* fs.exists(full).pipe(Effect.orDie))) return ""
  const buf = yield* fs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
  if (Buffer.from(buf).includes(0)) return ""
  return Buffer.from(buf).toString("utf8")
})

const nums = (list: Git.Stat[]) =>
  new Map(list.map((item) => [item.file, { additions: item.additions, deletions: item.deletions }] as const))

const merge = (...lists: Git.Item[][]) => {
  const out = new Map<string, Git.Item>()
  lists.flat().forEach((item) => {
    if (!out.has(item.file)) out.set(item.file, item)
  })
  return [...out.values()]
}

/** Parse git diff --patch output into a map of filename -> raw patch text.
 *  Splits on "\ndiff --git " blocks and extracts the filename from the
 *  "--- a/<path>" header, which is reliable even with special characters
 *  (we configure core.quotepath=false). */
function parseGitDiffOutput(output: string): Map<string, string> {
  const result = new Map<string, string>()
  const trimmed = output.trim()
  if (!trimmed) return result

  const sections = trimmed.split(/\n(?=diff --git )/)
  for (const section of sections) {
    const fileMatch = section.match(/^--- a\/(.*)$/m)
    if (!fileMatch) continue
    const file = fileMatch[1]
    if (file) result.set(file, section)
  }
  return result
}

/** Strip git-specific diff headers (diff --git, index) and normalize a/ b/
 *  prefixes to match the output of formatPatch(structuredPatch(...)). */
function cleanGitDiffHeaders(gitDiff: string, fileName: string): string {
  return gitDiff
    .split("\n")
    .filter((line) => !line.startsWith("diff --git ") && !line.startsWith("index "))
    .map((line) => {
      if (line.startsWith("--- a/")) return "--- " + fileName
      if (line.startsWith("+++ b/") || line === "+++ /dev/null") return "+++ " + fileName
      return line
    })
    .join("\n")
}

const files = Effect.fnUntraced(function* (
  fs: AppFileSystem.Interface,
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  list: Git.Item[],
  map: Map<string, { additions: number; deletions: number }>,
) {
  const patch = (file: string, before: string, after: string) =>
    formatPatch(structuredPatch(file, file, before, after, "", "", { context: Number.MAX_SAFE_INTEGER }))

  // P1: Batch modified/deleted files into a single git diff call
  // instead of spawning git show per file (N spawns → 1 spawn).
  const added: Git.Item[] = []
  const existing: Git.Item[] = []
  for (const item of list) {
    if (item.status === "added") {
      added.push(item)
    } else {
      existing.push(item)
    }
  }

  // Get patches for all modified/deleted files in one git invocation
  let diffPatches = new Map<string, string>()
  if (ref && existing.length > 0) {
    const diffResult = yield* git.run(
      ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "diff", "--no-renames", "-U999999", ref, "--", "."],
      { cwd },
    )
    if (diffResult.exitCode === 0) {
      diffPatches = parseGitDiffOutput(diffResult.text())
    }
  }

  const results: FileDiff[] = []

  // Safety check: if git diff parsing missed >30% of expected files,
  // the output format may have changed.  Fall back to proven
  // per-file structuredPatch to guarantee 100% correct output.
  const batchOk = ref && existing.length > 0 && diffPatches.size >= existing.length * 0.7

  // Process modified/deleted files from the batch git diff output
  for (const item of existing) {
    const patchText = batchOk ? diffPatches.get(item.file) : undefined
    const stat = map.get(item.file)
    if (patchText) {
      results.push({
        file: item.file,
        patch: cleanGitDiffHeaders(patchText, item.file),
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        status: item.status,
      })
    } else {
      // Fallback: batch disabled (safety), binary file, or parsing gap.
      // Process via proven structuredPatch path for 100% correct output.
      added.push(item)
    }
  }

  // Process added (new/untracked) and fallback files.
  // Uses the original structuredPatch + git.show path — output is
  // 100% identical to the pre-optimization code.
  //
  // base (git prefix) is always computed when ref exists — it is
  // needed for any per-file git.show call, whether triggered by
  // the batchOk safety fallback OR by individual files missed by
  // the batch git diff output.
  const base = ref ? yield* git.prefix(cwd) : ""
  const addedResults = yield* Effect.forEach(
    added,
    (item) =>
      Effect.gen(function* () {
        // A file needs git.show when it was NOT originally "added"
        // (i.e. it was modified/deleted and reached here because
        // the batch missed it or batchOk was false).
        const needsShow = item.status !== "added" && ref
        const before = needsShow ? yield* git.show(cwd, ref, item.file, base) : ""
        const after = item.status === "deleted" ? "" : yield* work(fs, cwd, item.file)
        const stat = map.get(item.file)
        return {
          file: item.file,
          patch: patch(item.file, before, after),
          additions: stat?.additions ?? (item.status === "added" ? count(after) : 0),
          deletions: stat?.deletions ?? (item.status === "deleted" ? count(before) : 0),
          status: item.status as FileDiff["status"],
        } satisfies FileDiff
      }),
    { concurrency: 8 },
  )

  results.push(...addedResults)
  return results.toSorted((a, b) => a.file.localeCompare(b.file))
})

const track = Effect.fnUntraced(function* (
  fs: AppFileSystem.Interface,
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
) {
  if (!ref) return yield* files(fs, git, cwd, ref, yield* git.status(cwd), new Map())
  const [list, stats] = yield* Effect.all([git.status(cwd), git.stats(cwd, ref)], { concurrency: 2 })
  return yield* files(fs, git, cwd, ref, list, nums(stats))
})

const compare = Effect.fnUntraced(function* (
  fs: AppFileSystem.Interface,
  git: Git.Interface,
  cwd: string,
  ref: string,
) {
  const [list, stats, extra] = yield* Effect.all([git.diff(cwd, ref), git.stats(cwd, ref), git.status(cwd)], {
    concurrency: 3,
  })
  return yield* files(
    fs,
    git,
    cwd,
    ref,
    merge(
      list,
      extra.filter((item) => item.code === "??"),
    ),
    nums(stats),
  )
})

export const Mode = z.enum(["git", "branch"])
export type Mode = z.infer<typeof Mode>

export const Event = {
  BranchUpdated: BusEvent.define(
    "vcs.branch.updated",
    z.object({
      branch: z.string().optional(),
    }),
  ),
}

export const Info = z
  .object({
    branch: z.string().optional(),
    default_branch: z.string().optional(),
  })
  .meta({
    ref: "VcsInfo",
  })
export type Info = z.infer<typeof Info>

export const FileDiff = z
  .object({
    file: z.string(),
    patch: z.string(),
    additions: z.number(),
    deletions: z.number(),
    status: z.enum(["added", "deleted", "modified"]).optional(),
  })
  .meta({
    ref: "VcsFileDiff",
  })
export type FileDiff = z.infer<typeof FileDiff>

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly branch: () => Effect.Effect<string | undefined>
  readonly defaultBranch: () => Effect.Effect<string | undefined>
  readonly diff: (mode: Mode) => Effect.Effect<FileDiff[]>
}

interface State {
  current: string | undefined
  root: Git.Base | undefined
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/Vcs") {}

export const layer: Layer.Layer<Service, never, AppFileSystem.Service | Git.Service | Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const git = yield* Git.Service
    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope

    const state = yield* InstanceState.make<State>(
      Effect.fn("Vcs.state")(function* (ctx) {
        if (ctx.project.vcs !== "git") {
          return { current: undefined, root: undefined }
        }

        const get = Effect.fnUntraced(function* () {
          return yield* git.branch(ctx.directory)
        })
        const [current, root] = yield* Effect.all([git.branch(ctx.directory), git.defaultBranch(ctx.directory)], {
          concurrency: 2,
        })
        const value = { current, root }
        log.info("initialized", { branch: value.current, default_branch: value.root?.name })

        const refreshBranch = Effect.fnUntraced(function* () {
          const next = yield* get()
          if (next !== value.current) {
            log.info("branch changed", { from: value.current, to: next })
            value.current = next
            diffCache.clear()
            yield* bus.publish(Event.BranchUpdated, { branch: next })
          }
        })

        yield* bus.subscribe(FileWatcher.Event.Updated).pipe(
          Stream.filter((evt) => evt.properties.file.endsWith("HEAD")),
          Stream.runForEach(() => refreshBranch()),
          Effect.forkScoped,
        )

        // Some file watcher backends ignore `.git/HEAD`, so keep an Effect-scoped
        // poller as the reliable path. It runs inside the project runtime context,
        // unlike callbacks from node fs timers/watchers.
        yield* refreshBranch().pipe(Effect.repeat(Schedule.spaced(Duration.millis(3000))), Effect.forkScoped)

        return value
      }),
    )

    // VCS diff cache: avoid redundant git spawns within TTL window
    interface CacheEntry {
      data: FileDiff[]
      timestamp: number
    }
    const diffCache = new Map<string, CacheEntry>()
    const DIFF_CACHE_TTL_MS = 10000

    return Service.of({
      init: Effect.fn("Vcs.init")(function* () {
        yield* InstanceState.get(state).pipe(Effect.forkIn(scope))
      }),
      branch: Effect.fn("Vcs.branch")(function* () {
        return yield* InstanceState.use(state, (x) => x.current)
      }),
      defaultBranch: Effect.fn("Vcs.defaultBranch")(function* () {
        return yield* InstanceState.use(state, (x) => x.root?.name)
      }),
      diff: Effect.fn("Vcs.diff")(function* (mode: Mode) {
        const value = yield* InstanceState.get(state)
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []

        // Check cache
        const cacheKey = `${ctx.directory}:${mode}:${value.current ?? ""}:${value.root?.name ?? ""}`
        const cached = diffCache.get(cacheKey)
        if (cached && Date.now() - cached.timestamp < DIFF_CACHE_TTL_MS) {
          return cached.data
        }

        let result: FileDiff[]
        if (mode === "git") {
          result = yield* track(fs, git, ctx.directory, (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined)
        } else {
          if (!value.root) return []
          if (value.current && value.current === value.root.name) return []
          const ref = yield* git.mergeBase(ctx.directory, value.root.ref)
          if (!ref) return []
          result = yield* compare(fs, git, ctx.directory, ref)
        }

        // Update cache
        diffCache.set(cacheKey, { data: result, timestamp: Date.now() })
        return result
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Git.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Bus.layer),
)
