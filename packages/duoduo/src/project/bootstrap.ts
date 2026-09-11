import { DuoduoError } from "@/util/error"
import { Format } from "../format"
import { LSP } from "../lsp"
import { File } from "../file"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Log } from "@/util"
import { FileWatcher } from "@/file/watcher"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { Config } from "@/config"
import { GraphIndexStatus } from "./graph-index-status"
import { createSmartLayerClients, type GraphClient } from "@/smart-layer"
import { cleanupOrphanProjectData } from "@/storage/project-dir"
import { registerDisposer, registerInstanceCanceller } from "@/effect/instance-registry"

const GRAPH_INDEX_POLL_INTERVAL = "1 seconds"
const GRAPH_INDEX_MAX_POLLS = 600

/** Bounded retry for acquiring the smart-layer graph client.
 *  A sidecar spawned before the duo-smart-layer sidecar finished booting has
 *  neither DUO_SMART_LAYER_URL nor (for a few seconds) the discovery file, so
 *  the first acquisition can legitimately return null. Retrying covers that
 *  window without delaying anything: this runs inside a detached fiber and
 *  every sleep stays interruptible (instance cancellation aborts it). */
const GRAPH_CLIENT_RETRY_MAX = 15
const GRAPH_CLIENT_RETRY_INTERVAL = "1 seconds"

const acquireGraphClient = (
  onRetry: (attempt: number) => void,
): Effect.Effect<ReturnType<typeof createSmartLayerClients>> =>
  Effect.gen(function* () {
    for (let attempt = 1; attempt <= GRAPH_CLIENT_RETRY_MAX; attempt++) {
      const clients = createSmartLayerClients()
      if (clients?.graph) {
        if (attempt > 1) Log.Default.info("smart-layer graph client acquired after retry", { attempt })
        return clients
      }
      if (attempt === 1) onRetry(attempt)
      yield* Effect.sleep(GRAPH_CLIENT_RETRY_INTERVAL)
    }
    return null
  })

/** Extract the status discriminant from an index-status payload.
 *  Accepts both `{ status: "ready" }` and `{ status: { status: "ready" } }`
 *  (the async endpoints nest the IndexStatus under a `status` key). */
const readIndexStatus = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== "object" || !("status" in payload)) return undefined
  const s = (payload as { status: unknown }).status
  if (typeof s === "string") return s
  if (s && typeof s === "object" && "status" in s) {
    const inner = (s as { status: unknown }).status
    if (typeof inner === "string") return inner
  }
  return undefined
}

const startGraphIndexing = Effect.gen(function* () {
  const directory = Instance.directory
  // The backend derives the graph's project identity from this directory, so
  // passing it is what makes indexing, status polling and queries address the
  // same project. Callers never compose a project id.
  Log.Default.debug("startGraphIndexing enter", {
    directory,
    smartLayerUrl: process.env.DUO_SMART_LAYER_URL ? "SET" : "MISSING",
  })

  const graphIndexOpt = yield* Effect.serviceOption(GraphIndexStatus.Service)
  if (graphIndexOpt._tag === "None") return
  const graphIndex = graphIndexOpt.value

  const clients = yield* acquireGraphClient((attempt) =>
    Log.Default.warn("startGraphIndexing: smart-layer graph client unavailable, retrying", {
      directory,
      attempt,
      smartLayerUrl: process.env.DUO_SMART_LAYER_URL ? "SET" : "MISSING",
    }),
  )
  if (!clients?.graph) {
    Log.Default.warn("startGraphIndexing: smart-layer graph client unavailable after retries, marking failed", {
      directory,
    })
    yield* graphIndex.set({ type: "failed", error: "smart-layer sidecar unavailable" })
    return
  }

  // NOTE: Do NOT set graphIndex to "indexing" before the HTTP call returns.
  // indexProjectAsync can take 20-30s (load_fresh_bincode_snapshot), and the
  // project may turn out to be fully indexed already. Marking it "indexing"
  // up front would close the KG gate (hiding the graph_query tool) for the
  // whole call even when there is nothing to index. The status is only set
  // once the response — or the poll loop — reports the real state.

  const asyncResult = yield* Effect.tryPromise({
    try: () =>
      clients.graph.indexProjectAsync(directory).then((result) => {
        Log.Default.debug("indexProjectAsync response", { directory, status: result.status })
        return result
      }),
    catch: (err) => {
      Log.Default.warn("graph indexProjectAsync failed", { directory, error: String(err) })
      return new DuoduoError({ message: "graph indexProjectAsync failed", messageZh: "graph indexProjectAsync 失败", cause: err })
    },
  }).pipe(
    Effect.catch((err: unknown) =>
      Effect.gen(function* () {
        Log.Default.warn("graph indexProjectAsync failed", { directory, error: err })
        yield* graphIndex.set({ type: "failed", error: String(err) })
        return null
      }),
    ),
  )

  // `indexProjectAsync` reports the authoritative starting state: "ready" when a
  // fresh snapshot was loaded (nothing to index), otherwise "indexing".
  // Publish a terminal "ready" straight away so the KG gate (which hides the
  // graph_query tool while not ready) opens without waiting a poll interval.
  // Polling still runs afterwards and is what drives progress + completion; it
  // exits on its first tick when the project is already indexed.
  const initialStatus = readIndexStatus(asyncResult)
  if (initialStatus === "ready") {
    yield* graphIndex.set({ type: "ready" })
  } else if (initialStatus === "indexing") {
    // A real (re)index is starting. Broadcast "indexing" immediately so the
    // titlebar progress icon lights up the instant indexing begins — without
    // waiting for pollGraphIndexStatus's first 1s sleep, which previously let
    // the indicator stay hidden for the whole auto-index. This mirrors
    // startForceReindex, which sets "indexing" up front for the same reason.
    // We only do this when the server actually reports "indexing" (not "ready"),
    // so an already-indexed project is never flipped to "indexing" and the KG
    // gate is never briefly closed for a project that had nothing to index.
    yield* graphIndex.set({ type: "indexing" })
  }

  // Poll until indexing completes (shared between initial index and reindex)
  yield* pollGraphIndexStatus(clients.graph, graphIndex, directory)
}).pipe(
  Effect.catchCause((cause) =>
    Effect.gen(function* () {
      Log.Default.warn("graph indexing failed", { cause: String(cause) })
      const opt = yield* Effect.serviceOption(GraphIndexStatus.Service)
      if (opt._tag === "Some") {
// @effect-diagnostics-next-line catchUnfailableEffect:off
        yield* opt.value.set({ type: "failed", error: String(cause) }).pipe(Effect.catch(() => Effect.void))
      }
    }),
  ),
)

/** Poll /graph/index-status and broadcast via SSE until indexing completes. */
const pollGraphIndexStatus = (graph: GraphClient, graphIndex: GraphIndexStatus.Interface, directory: string) =>
  Effect.gen(function* () {
    // Deliberately no unconditional "indexing" write here. Opening an
    // already-indexed project would otherwise flip the status back from "ready"
    // to "indexing" for a full poll interval, and the KG gate would strip the
    // graph_query tool from any prompt built during that window. The loop below
    // publishes "indexing" as soon as the server actually reports it.
    for (let i = 0; i < GRAPH_INDEX_MAX_POLLS; i++) {
      yield* Effect.sleep(GRAPH_INDEX_POLL_INTERVAL)
      const status = yield* Effect.tryPromise({
        try: () => graph.getIndexStatus(directory),
        catch: () => new DuoduoError({ message: "graph getIndexStatus failed", messageZh: "graph getIndexStatus 失败", cause: undefined }),
      }).pipe(Effect.catch(() => Effect.succeed(null)))

      if (status && typeof status === "object" && "status" in status) {
        const s = (status as { status: string }).status
        if (s === "ready") {
          yield* graphIndex.set({ type: "ready" })
          return
        }
        if (s === "failed") {
          const reason =
            "reason" in status && typeof (status as { reason: unknown }).reason === "string"
              ? (status as { reason: string }).reason
              : "Indexing failed on server side"
          yield* graphIndex.set({ type: "failed", error: reason })
          return
        }
        if (s === "idle") {
          // idle means Rust never started indexing (e.g. the indexProjectAsync
          // HTTP request failed or hasn't arrived yet). Continue polling
          // instead of giving up — the request may arrive shortly, and the
          // poll loop has its own 600-iteration timeout.
          continue
        }
        if (s === "indexing") {
          const progress =
            "progress" in status && typeof (status as { progress: unknown }).progress === "number"
              ? (status as { progress: number }).progress
              : undefined
          const filesDone =
            "files_done" in status && typeof (status as { files_done: unknown }).files_done === "number"
              ? (status as { files_done: number }).files_done
              : undefined
          const filesTotal =
            "files_total" in status && typeof (status as { files_total: unknown }).files_total === "number"
              ? (status as { files_total: number }).files_total
              : undefined
          yield* graphIndex.set({
            type: "indexing",
            ...(progress !== undefined ? { progress } : {}),
            ...(filesDone !== undefined ? { filesDone } : {}),
            ...(filesTotal !== undefined ? { filesTotal } : {}),
          })
          continue
        }
      }
    }
    yield* graphIndex.set({
      type: "failed",
      error: "Indexing timed out after 10 minutes",
    })
  })

/** Force a full reindex. Same polling + SSE broadcast as initial index. */
export const startForceReindex = (projectPath: string) => Effect.gen(function* () {
  const directory = projectPath

  const graphIndexOpt = yield* Effect.serviceOption(GraphIndexStatus.Service)
  if (graphIndexOpt._tag === "None") return
  const graphIndex = graphIndexOpt.value

  const clients = yield* acquireGraphClient((attempt) =>
    Log.Default.warn("startForceReindex: smart-layer graph client unavailable, retrying", {
      directory,
      attempt,
      smartLayerUrl: process.env.DUO_SMART_LAYER_URL ? "SET" : "MISSING",
    }),
  )
  if (!clients?.graph) {
    Log.Default.warn("startForceReindex: smart-layer graph client unavailable after retries, marking failed", {
      directory,
    })
    yield* graphIndex.set({ type: "failed", error: "smart-layer sidecar unavailable" })
    return
  }

  // Broadcast "indexing" immediately so the frontend starts showing
  // progress before the forceReindexAsync call returns
  yield* graphIndex.set({ type: "indexing" })

  yield* Effect.tryPromise({
    try: () => clients.graph.forceReindexAsync(directory),
    catch: (err) => {
      Log.Default.warn("graph forceReindexAsync failed", { directory, error: String(err) })
      return new DuoduoError({ message: "graph forceReindexAsync failed", messageZh: "graph forceReindexAsync 失败", cause: err })
    },
  }).pipe(
    Effect.catch((err: unknown) =>
// @effect-diagnostics-next-line unnecessaryEffectGen:off
      Effect.gen(function* () {
        yield* graphIndex.set({ type: "failed", error: String(err) })
      }),
    ),
  )

  yield* pollGraphIndexStatus(clients.graph, graphIndex, directory)
}).pipe(
  Effect.catchCause((cause) =>
    Effect.gen(function* () {
      Log.Default.warn("graph force reindex failed", { cause: String(cause) })
      const opt = yield* Effect.serviceOption(GraphIndexStatus.Service)
      if (opt._tag === "Some") {
// @effect-diagnostics-next-line catchUnfailableEffect:off
        yield* opt.value.set({ type: "failed", error: String(cause) }).pipe(Effect.catch(() => Effect.void))
      }
    }),
  ),
)

export const InstanceBootstrap = Effect.gen(function* () {
  Log.Default.info("InstanceBootstrap enter", { dir: Instance.directory, projectId: Instance.project.id })
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  // 标记该项目已打开，供"清理项目记录"时跳过左侧列表/已打开的项目
  Project.markProjectOpen(Instance.project.worktree)
  // Clean up personal-dir data for projects whose folder no longer exists,
  // so deleting a project also removes its <data>/database/<id> directory.
  cleanupOrphanProjectData()
  // everything depends on config so eager load it for nice traces
  yield* Config.Service.use((svc) => svc.get())
  const directory = Instance.directory
  const [, indexingFiber] = yield* Effect.all([
    Effect.all(
      [
        LSP.Service,
        Format.Service,
        File.Service,
        FileWatcher.Service,
        Vcs.Service,
        Snapshot.Service,
      ].map((s) => Effect.forkDetach(s.use((i) => i.init()))),
    ),
    Effect.forkDetach(startGraphIndexing),
  ]).pipe(Effect.withSpan("InstanceBootstrap.init"))

  // A detached fiber survives this scope on purpose (indexing must outlive
  // bootstrap), which also means disposing the instance would NOT stop it.
  // Register a canceller so closing the project actually interrupts indexing
  // instead of letting a full pass run to completion — and, since the pass ends
  // by writing a snapshot, potentially re-create an index the user just cleared.
  const unregister = registerInstanceCanceller(directory, async () => {
    await Effect.runPromise(Fiber.interrupt(indexingFiber)).catch(() => undefined)
  })
  // Drop the registration once indexing finishes on its own, so the map does
  // not accumulate cancellers for fibers that already completed.
  yield* Effect.forkDetach(
    Fiber.await(indexingFiber).pipe(Effect.map(() => unregister())),
  )

  yield* Bus.Service.use((svc) =>
    svc.subscribeCallback(Command.Event.Executed, async (payload) => {
      if (payload.properties.name === Command.Default.INIT) {
        Project.setInitialized(Instance.project.id)
      }
    }),
  )
  // 关闭时取消"已打开"标记；捕获 worktree 避免 dispose 时已变化
  const bootWorktree = Instance.project.worktree
  registerDisposer(async () => {
    Project.unmarkProjectOpen(bootWorktree)
  })
}).pipe(Effect.withSpan("InstanceBootstrap"))

// ─── KG Disposer ──────────────────────────────────────────────────────
// When a project instance is disposed (closed, switched, or shutdown),
// clear the in-memory KG data for that project to free memory.
// Bincode cache files are preserved on disk so that next time the project
// is opened, the snapshot can be loaded incrementally instead of full-index.
registerDisposer(async (directory: string) => {
  const clients = createSmartLayerClients()
  if (!clients?.graph) return
  try {
    // Clear in-memory graph data to free memory, but preserve the bincode
    // cache on disk so that next time the project is opened, the snapshot
    // can be loaded incrementally instead of requiring a full reindex.
    await clients.graph.clearProjectMemory(directory)
  } catch (e) {
    Log.Default.warn("KG dispose cleanup failed", { directory, error: String(e) })
  }
})
