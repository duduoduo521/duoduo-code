import { Cause, Effect, Layer, Context, ManagedRuntime } from "effect"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { mkdir, readdir } from "fs/promises"
import { createHash } from "crypto"
import path from "path"
import z from "zod"
import { GlobalBus } from "@/bus/global"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect"
import { AppFileSystem, clearRealpathCache } from "@duoduo-ai/shared/filesystem"
import { File } from "@/file"
import { Flag } from "@/flag/flag"
import { Git } from "@/git"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { lazy } from "@/util/lazy"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { createSmartLayerClients } from "@/smart-layer"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import { Config } from "../config"
import { FileIgnore } from "./ignore"
import { Protected } from "./protected"
import { Log } from "../util"

declare const DUODUO_LIBC: string | undefined

const log = Log.create({ service: "file.watcher" })
const SUBSCRIBE_TIMEOUT_MS = 10_000

// Extensions that should trigger KG incremental sync. P2-9 (6-1): MUST stay
// identical to the Rust full-index whitelist `SUPPORTED_EXTENSIONS` in
// crates/knowledge-graph-store/src/indexer.rs — any extension the full index
// knows about but this set omits would go stale in the graph after every
// incremental edit until the next full re-index.
const KG_SOURCE_EXTENSIONS = new Set([
  "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "c", "h",
  "cpp", "cc", "cxx", "hpp", "hh", "hxx", "cs", "rb", "php", "swift", "kt",
  "kts", "scala", "lua", "zig",
  // OPT-17 扩展：标记/契约/脚本语言（正则兜底）
  "html", "htm", "css", "scss", "less", "sql", "sh", "bash",
  // OPT-17 扩展：需 tree-sitter grammar 的语言
  "dart", "ex", "exs", "vue", "svelte", "proto", "graphql", "gql",
])

export const Event = {
  Updated: BusEvent.define(
    "file.watcher.updated",
    z.object({
      file: z.string(),
      event: z.union([z.literal("add"), z.literal("change"), z.literal("unlink")]),
    }),
  ),
  Unavailable: BusEvent.define(
    "file.watcher.unavailable",
    z.object({
      reason: z.string(),
    }),
  ),
}

const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
  try {
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${DUODUO_LIBC || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  } catch (error) {
    log.error("failed to load watcher binding", { error })
    // hasNativeBinding() 会在模块作用域被调用（如测试文件决定 skip 时），此时没有
    // Instance 上下文，访问 Instance.* 会抛 "No context found for instance" 并炸掉
    // 整个模块加载。降级为静默放弃通知——上下文可用时 watcher init 仍会正常工作。
    try {
      GlobalBus.emit("event", {
        directory: Instance.directory,
        project: Instance.project.id,
        workspace: WorkspaceContext.workspaceID,
        payload: {
          type: Event.Unavailable.type,
          properties: { reason: "native_binding_failed" },
        },
      })
    } catch {
      // 无 Instance 上下文（模块作用域探测）——无处通知，忽略
    }
    return
  }
})

function getBackend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
}

// Interval between polling passes when the OS-native backend is unusable.
const POLL_INTERVAL_MS = 4_000

function protecteds(dir: string) {
  return Protected.paths().filter((item) => {
    const rel = path.relative(dir, item)
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
  })
}

export const hasNativeBinding = () => !!watcher()

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/FileWatcher") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const git = yield* Git.Service

    const state = yield* InstanceState.make(
      Effect.fn("FileWatcher.state")(
        function* () {
          if (yield* Flag.DUODUO_EXPERIMENTAL_DISABLE_FILEWATCHER) return

          log.info("init", { directory: Instance.directory })

          const backend = getBackend()
          if (!backend) {
            log.error("watcher backend not supported", { directory: Instance.directory, platform: process.platform })
            return
          }

          const w = watcher()
          if (!w) return

          log.info("watcher backend", { directory: Instance.directory, platform: process.platform, backend })

          const subs: ParcelWatcher.AsyncSubscription[] = []
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => Promise.allSettled(subs.map((sub) => sub.unsubscribe()))),
          )

          // Debounce file watcher events: collect within a window, then batch publish
          let debounceTimer: ReturnType<typeof setTimeout> | undefined
          let pendingEvents: Array<{ file: string; event: "add" | "change" | "unlink" }> = []

          // Build a single ManagedRuntime for File.Service so that watcher events
          // don't reconstruct the entire dependency tree on every callback.
          const fileRuntime = ManagedRuntime.make(File.defaultLayer)
          yield* Effect.addFinalizer(() => Effect.promise(() => fileRuntime.dispose()))

          const flushEvents = () => {
            debounceTimer = undefined
            // Deduplicate: same file keeps the latest event type
            const merged = new Map<string, "add" | "change" | "unlink">()
            for (const evt of pendingEvents) {
              merged.set(evt.file, evt.event)
            }
            // Snapshot Instance context outside the loop so GlobalBus.emit
            // does not depend on ALS/Effect context inside the setTimeout callback.
            const dir = Instance.directory
            const projectId = Instance.project.id
            const workspace = WorkspaceContext.workspaceID
            for (const [file, event] of merged) {
              GlobalBus.emit("event", {
                directory: dir,
                project: projectId,
                workspace,
                payload: {
                  type: Event.Updated.type,
                  properties: { file, event },
                },
              })
              // P1: Invalidate realpathSync cache when paths may have changed.
              // "unlink" could be a directory removal; "add" could be a new dir.
              // Regular file content "change" doesn't affect path resolution.
              if (event === "unlink" || event === "add") {
                clearRealpathCache()
              }
              // P4: Invalidate gitignore cache when .gitignore/.ignore changes
              if (file.endsWith(".gitignore") || file.endsWith(".ignore")) {
                void fileRuntime
                  .runPromise(
                    Effect.gen(function* () {
                      const fileSvc = yield* File.Service
                      yield* InstanceState.invalidate(fileSvc.gitignoreState)
                    }),
                  )
                  .catch(() => {})
              }
              // P5: Mark diff cache entry as dirty on file change
              // so next readDiff call re-computes the diff via git spawn.
              if (event === "change" || event === "unlink") {
                const rel = path.relative(Instance.directory, file)
                if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
                  void fileRuntime
                    .runPromise(
                      Effect.gen(function* () {
                        const fileSvc = yield* File.Service
                        fileSvc.invalidateDiffCache(rel)
                      }),
                    )
                    .catch(() => {})
                }
              }
              // P5-2: Invalidate all diff cache entries when git HEAD changes
              // (e.g. after commit, rebase, reset) because the "original" content
              // stored in diffCache refers to the old HEAD.
              if (file.endsWith(".git/HEAD") || file.endsWith("HEAD")) {
                const rel = path.relative(Instance.directory, file)
                if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
                  void fileRuntime
                    .runPromise(
                      Effect.gen(function* () {
                        const fileSvc = yield* File.Service
                        fileSvc.invalidateDiffCache() // mark ALL entries dirty
                      }),
                    )
                    .catch(() => {})
                }
              }
              // Incremental scan cache update (P7 optimization):
              // When files are added/unlinked, update the cached file list
              // so subsequent File.search calls hit the in-memory cache
              // without needing a full ripgrep scan.
              if (event === "add" || event === "unlink") {
                const rel = path.relative(Instance.directory, file)
                if (rel.startsWith("..") || path.isAbsolute(rel)) continue // ignore outside-project files
                void fileRuntime
                  .runPromise(
                    Effect.gen(function* () {
                      const fileSvc = yield* File.Service
                      const state = yield* InstanceState.get(fileSvc.state)
                      if (event === "add") {
                        if (!state.fileSet.has(rel)) {
                          state.cache.files.push(rel)
                          state.fileSet.add(rel)
                          // Add all parent directories
                          let current = rel
                          while (true) {
                            const dir = path.dirname(current)
                            if (dir === "." || dir === current) break
                            current = dir
                            const dirKey = dir + "/"
                            if (!state.dirSet.has(dirKey)) {
                              state.cache.dirs.push(dirKey)
                              state.dirSet.add(dirKey)
                            }
                          }
                        }
                      } else if (event === "unlink") {
                        if (state.fileSet.has(rel)) {
                          state.fileSet.delete(rel)
                          state.cache.files = state.cache.files.filter((f) => f !== rel)
                          // P7-1: Prune empty directory entries after file removal.
                          // Walk up from the deleted file's parent dirs and remove
                          // any dir entry that no longer has descendant files/subdirs.
                          let current = rel
                          while (true) {
                            const dir = path.dirname(current)
                            if (dir === "." || dir === current) break
                            const prefix = dir + "/"
                            const hasDescendants =
                              state.cache.files.some((f) => f.startsWith(prefix)) ||
                              state.cache.dirs.some((d) => d.startsWith(prefix) && d !== prefix)
                            if (!hasDescendants) {
                              state.cache.dirs = state.cache.dirs.filter((d) => d !== prefix)
                              state.dirSet.delete(prefix)
                            }
                            current = dir
                          }
                        }
                      }
                    }),
                  )
                  .catch(() => {}) // silently ignore — full scan will correct any drift
              }
            }

            // ── KG incremental sync ────────────────────────────────────────────
            // Collect source-code file changes and schedule a debounced KG update.
            const kgFiles = Array.from(merged.entries()).filter(([file]) => {
              const ext = path.extname(file).slice(1)
              return KG_SOURCE_EXTENSIONS.has(ext)
            })
            if (kgFiles.length > 0) {
              scheduleKGUpdate(kgFiles)
            }

            pendingEvents = []
          }

          const cb: ParcelWatcher.SubscribeCallback = Instance.bind((err, evts) => {
            if (err) return
            for (const evt of evts) {
              let event: "add" | "change" | "unlink" | undefined
              if (evt.type === "create") event = "add"
              if (evt.type === "update") event = "change"
              if (evt.type === "delete") event = "unlink"
              if (event) {
                pendingEvents.push({ file: evt.path, event })
                if (!debounceTimer) {
                  debounceTimer = setTimeout(flushEvents, 100)
                }
              }
            }
          })

          const cfg = yield* config.get()
          const cfgIgnores = cfg.watcher?.ignore ?? []
          const pollEnabled = cfg.watcher?.poll === true
          const pollInterval = cfg.watcher?.pollInterval ?? POLL_INTERVAL_MS

          // Polling path for directories the OS-native backend cannot observe.
          // FSEvents / inotify / ReadDirectoryChangesW are all driven by *local
          // kernel* notifications, so changes made on the far side of a network
          // or FUSE mount (SSHFS, NFS, SMB, WSL) never generate an event
          // locally — the subscription "succeeds" but stays silent forever.
          //
          // `@parcel/watcher`'s own `brute-force` backend already implements a
          // snapshot/diff scan that works on any filesystem, so we reuse it and
          // feed its events through the exact same `cb` used by the native path.
          const poll = (dir: string, ignore: string[]) =>
            Effect.gen(function* () {
              const snapshot = path.join(
                Global.Path.cache,
                "watcher-snapshot",
                `${Instance.project.id}-${createHash("sha256").update(dir).digest("hex").slice(0, 16)}`,
              )
              const opts = { ignore, backend: "brute-force" as const }

              yield* Effect.promise(() =>
                mkdir(path.dirname(snapshot), { recursive: true })
                  .then(() => w.writeSnapshot(dir, snapshot, opts))
                  .catch(() => undefined),
              )

              const tick = Effect.promise(async () => {
                try {
                  const events = await w.getEventsSince(dir, snapshot, opts)
                  // Re-baseline first: if `cb` throws we still don't replay the
                  // same events forever.
                  await w.writeSnapshot(dir, snapshot, opts)
                  if (events.length > 0) cb(null, events)
                } catch (error) {
                  // Mount temporarily unreachable — keep polling, it may return.
                  log.warn("poll pass failed", { dir, error: String(error) })
                }
              })

              // forkScoped ties the loop to the service scope, so the existing
              // finalizer teardown also stops polling.
              yield* Effect.forkScoped(tick.pipe(Effect.delay(pollInterval), Effect.forever))
              log.info("watching via polling", { dir, interval: pollInterval })
            })

          const pollFailed = (dir: string) => (cause: Cause.Cause<unknown>) => {
            log.error("polling failed", { dir, cause: Cause.pretty(cause) })
            GlobalBus.emit("event", {
              directory: Instance.directory,
              project: Instance.project.id,
              workspace: WorkspaceContext.workspaceID,
              payload: {
                type: Event.Unavailable.type,
                properties: { reason: "watch_failed" },
              },
            })
            return Effect.void
          }

          const subscribe = (dir: string, ignore: string[]) => {
            // Opt-in polling: `subscribe` SUCCEEDS on a network/FUSE mount and
            // then silently never fires, so an error-triggered fallback alone
            // cannot cover that case. Users on such mounts set `watcher.poll`.
            if (pollEnabled) return poll(dir, ignore).pipe(Effect.catchCause(pollFailed(dir)))

            const pending = w.subscribe(dir, cb, { ignore, backend })
            return Effect.gen(function* () {
              const sub = yield* Effect.promise(() => pending)
              subs.push(sub)
            }).pipe(
              Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
              Effect.catchCause((cause) => {
                log.error("failed to subscribe", { dir, cause: Cause.pretty(cause) })
                pending.then((s) => s.unsubscribe()).catch(() => {})
                // The native backend outright rejected this directory. Degrade
                // to polling rather than watching nothing at all.
                return poll(dir, ignore).pipe(Effect.catchCause(pollFailed(dir)))
              }),
            )
          }

          if (yield* Flag.DUODUO_EXPERIMENTAL_FILEWATCHER) {
            yield* subscribe(Instance.directory, [
              ...FileIgnore.PATTERNS,
              ...cfgIgnores,
              ...protecteds(Instance.directory),
            ])
          } else {
            // P2-9 (6-3): KG incremental sync rides on these file events.
            // With the experimental native watcher off, fall back to the
            // stable polling path so event delivery (and KG updates) continue
            // instead of silently stopping.
            yield* poll(Instance.directory, [
              ...FileIgnore.PATTERNS,
              ...cfgIgnores,
              ...protecteds(Instance.directory),
            ]).pipe(Effect.catchCause(pollFailed(Instance.directory)))
          }

          if (Instance.project.vcs === "git") {
            const result = yield* git.run(["rev-parse", "--git-dir"], {
              cwd: Instance.project.worktree,
            })
            const vcsDir =
              result.exitCode === 0 ? path.resolve(Instance.project.worktree, result.text().trim()) : undefined
            if (vcsDir && !cfgIgnores.includes(".git") && !cfgIgnores.includes(vcsDir)) {
              const ignore = (yield* Effect.promise(() => readdir(vcsDir).catch(() => []))).filter(
                (entry) => entry !== "HEAD",
              )
              yield* subscribe(vcsDir, ignore)
            }
          }
        },
        Effect.catchCause((cause) => {
          log.error("failed to init watcher service", { cause: Cause.pretty(cause) })
          return Effect.void
        }),
      ),
    )

    return Service.of({
      init: Effect.fn("FileWatcher.init")(function* () {
        yield* InstanceState.get(state)
      }),
    })
  }),
)

// ─── KG Incremental Sync ──────────────────────────────────────────
// Debounced (500ms) batch sync of file changes into the knowledge graph.
// Failures are caught and logged — they never block the FileWatcher main path.
let kgUpdateTimer: ReturnType<typeof setTimeout> | undefined
let kgPendingUpdates: Map<string, "add" | "change" | "unlink"> = new Map() // file → event type
/** Consecutive flushes that found no smart-layer client. Bounded so a
 *  permanently absent smart-layer cannot retry forever. */
let kgFlushRetries = 0
const KG_FLUSH_MAX_RETRIES = 30 // 30 × 2s ≈ 60s of sidecar-startup cover

function scheduleKGUpdate(files: Array<[string, "add" | "change" | "unlink"]>) {
  for (const [file, event] of files) {
    kgPendingUpdates.set(file, event)
  }
  if (!kgUpdateTimer) {
    kgUpdateTimer = setTimeout(flushKGUpdates, 500)
  }
}

async function flushKGUpdates() {
  kgUpdateTimer = undefined
  const updates = Array.from(kgPendingUpdates.entries())
  kgPendingUpdates.clear()

  const clients = createSmartLayerClients()
  if (!clients?.graph) {
    // Smart-layer not discoverable yet (e.g. this sidecar was spawned before
    // the duo-smart-layer sidecar finished booting). Keep the updates pending
    // and retry instead of silently dropping them — dropping would leave the
    // graph stale while the on-disk snapshot hash already covers the files.
    if (kgFlushRetries >= KG_FLUSH_MAX_RETRIES) {
      kgFlushRetries = 0
      log.warn("KG incremental sync dropped after retry budget exhausted", { count: updates.length })
      return
    }
    kgFlushRetries++
    for (const [file, event] of updates) {
      kgPendingUpdates.set(file, event)
    }
    if (!kgUpdateTimer) {
      kgUpdateTimer = setTimeout(flushKGUpdates, 2000)
    }
    return
  }
  kgFlushRetries = 0

  // If KG is currently indexing, keep incremental updates pending and retry.
  // Dropping them is unsafe: a file can change after it was parsed but before
  // the full-index snapshot hash is collected, which would make the cache look
  // fresh while the graph still contains stale entities.
  try {
    const status = await clients.graph.getIndexStatus(Instance.directory)
    if (
      status &&
      typeof status === "object" &&
      "status" in status &&
      (status as { status: unknown }).status === "indexing"
    ) {
      for (const [file, event] of updates) {
        kgPendingUpdates.set(file, event)
      }
      if (!kgUpdateTimer) {
        kgUpdateTimer = setTimeout(flushKGUpdates, 2000)
      }
      return
    }
  } catch {
    // Can't check status — proceed anyway (best-effort)
  }

  // Process updates in parallel batches (10 concurrent) to avoid serial
  // bottleneck when many files change at once (e.g. git checkout).
  const batchSize = 10
  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize)
    await Promise.allSettled(
      batch.map(async ([file, event]) => {
        try {
          const relPath = path.relative(Instance.directory, file)
          if (relPath.startsWith("..") || path.isAbsolute(relPath)) return
          if (event === "unlink") {
            await clients.graph.removeFile(relPath, Instance.directory)
          } else {
            // add or change — read content and incrementally update the graph
            const content = await import("fs/promises").then((fs) => fs.readFile(file, "utf-8"))
            const language = LANGUAGE_EXTENSIONS[path.extname(file)] ?? "plaintext"
            await clients.graph.updateFile(relPath, content, language, Instance.directory)
          }
        } catch (e) {
          log.warn("KG incremental update failed", { file, error: String(e) })
        }
      }),
    )
  }
}

export const defaultLayer = layer.pipe(Layer.provide(Git.defaultLayer), Layer.provide(Config.defaultLayer))

export * as FileWatcher from "./watcher"
