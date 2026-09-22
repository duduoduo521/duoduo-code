/**
 * Smart Layer Context - provides reactive access to the duo-smart-layer sidecar.
 *
 * Uses the same createSimpleContext pattern as SDK context.
 * When the smart layer is unavailable (desktop without sidecar, or web platform),
 * the context degrades gracefully with a "disconnected" status.
 *
 * Usage:
 *   const sl = useSmartLayer()
 *   sl.status // => "connected" | "disconnected" | "checking"
 *   sl.memory.search("auth bug") // => Promise<MemoryEntry[]>
 */

import { createSimpleContext } from "@duoduo-ai/ui/context"
import { showToast } from "@duoduo-ai/ui/toast"
import { createMemo, createSignal, createEffect, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { usePlatform } from "../../context/platform"
import { useGlobalSync } from "../../context/global-sync"
import { useGlobalSDK } from "../../context/global-sdk"
import { errorMessage } from "@/context/file/error-message"
import { decode64 } from "@/utils/base64"
import { getFilename } from "@duoduo-ai/shared/util/path"
import { setGearApi } from "../../context/gear-store"
import type {
  SmartLayerConnectionStatus,
  MemoryEntry,
  QualityReport,
  ClarificationResult,
  KGIndexStatus,
  GraphStatsDetail,
  RecentFile,
} from "./types"

import { SmartLayerApi } from "./api"
export { SmartLayerApi }
export type { SmartLayerApiConfig } from "./api"


// ─── Context Definition ───

// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const { use: useSmartLayer, provider: SmartLayerProvider } = createSimpleContext({
  name: "SmartLayer",
  gate: false,
  init: () => {
    const platform = usePlatform()
    const globalSDK = useGlobalSDK()
    const params = useParams()

    // Used only for error toasts; guarded so a missing LanguageProvider can
    // never break the whole smart-layer context.
    let language: ReturnType<typeof useLanguage> | undefined
    try {
      language = useLanguage()
    } catch {
      language = undefined
    }

    const [status, setStatus] = createSignal<SmartLayerConnectionStatus>("checking")
    const [version, setVersion] = createSignal<string | null>(null)
    const [lastError, setLastError] = createSignal<string | null>(null)

    const resolveSmartLayerConfig = ():
      | { url: string; username?: string; getAuthHeader?: () => string | undefined }
      | undefined => {
      const sl = platform.smartLayer
      if (!sl) return undefined
      if (typeof sl === "function") return sl()
      return sl
    }

    const api = createMemo(() => {
      const sl = resolveSmartLayerConfig()
      if (!sl) return null
      return new SmartLayerApi({
        url: sl.url,
        username: sl.username,
        authHeader: sl.getAuthHeader?.(),
      })
    })

    // Keep the module-level gear store in sync so its fetch helpers use the
    // smart-layer client (full URL + auth) in desktop mode.
    createEffect(() => {
      setGearApi(api())
    })

    // Adaptive health check interval: 30s when connected, 10s when disconnected
    let healthTimer: ReturnType<typeof setTimeout> | undefined
    let checkInProgress = false

    const scheduleNextCheck = () => {
      if (healthTimer) clearTimeout(healthTimer)
      const interval = status() === "connected" ? 30000 : 10000
      healthTimer = setTimeout(() => {
        void checkHealth()
          .then(scheduleNextCheck)
          .catch(() => scheduleNextCheck()) // ensure the chain never breaks
      }, interval)
    }

    const checkHealth = async () => {
      if (checkInProgress) return
      checkInProgress = true
      try {
        const client = api()
        if (!client) {
          console.debug("[smart-layer] checkHealth: no API client available (config not received yet)")
          setStatus("disconnected")
          return
        }
        const result = await client.health()
        console.info("[smart-layer] Health check passed:", result)
        setVersion(result.version)
        console.log("[KG] smart-layer connected")
        setStatus("connected")
        setLastError(null)
      } catch (e) {
        console.warn("[smart-layer] Health check failed:", e)
        setStatus("disconnected")
        setLastError("Smart layer unreachable")
      } finally {
        checkInProgress = false
      }
    }

    // Start health checking
    void checkHealth().then(scheduleNextCheck)
    onCleanup(() => {
      if (healthTimer) clearTimeout(healthTimer)
    })

    const connected = createMemo(() => status() === "connected")

    // ─── Knowledge Graph Index Status ────────────────────────────────────
    // SINGLE source of truth, identical to the graph kanban
    // (components/dialog-graph.tsx): poll GET /graph/index-status and judge by
    // `status === "indexing"`. Same endpoint, same directory scoping and same
    // fields as the kanban — so whenever the kanban progress bar appears, the
    // titlebar indicator shows, by construction.
    //
    // The former SSE `graph.index-status` watcher was removed: it competed
    // with this poll for the same signals (out-of-order updates could clear a
    // freshly-published `indexing` state), and its latency gain (≤ one poll
    // interval) is imperceptible for a seconds-scale indexing progress.
    // Polling also covers what SSE cannot: SSE never replays history, so a
    // project that is *already* indexed when opened would never see its
    // terminal `ready` event.

    const [kgStatus, setKgStatus] = createSignal<KGIndexStatus | null>(null)
    const onIndexCompleteCallbacks: Array<() => void> = []

    const applyKGStatus = (status: KGIndexStatus | null | undefined) => {
      // Called once per poll tick — log only real state transitions so an idle
      // app does not emit a console line every second forever.
      const prevStatus = kgStatus()?.status
      if (status?.status && status.status !== prevStatus) {
        console.info("[kg] applyKGStatus", { status: status.status, prev: prevStatus })
      }
      // "idle" and "no status at all" carry no information: Rust returns Idle
      // for any project_id it has never seen (indexer.rs status_of ->
      // unwrap_or(IndexStatus::Idle)). That is indistinguishable from "not
      // indexing", and treating it as a real state could clear an `indexing`
      // state that a previous poll (with a still-resolving project id) had
      // just published, making the titlebar indicator and the kanban progress
      // bar flicker off. Ignore them and keep the last known state.
      if (!status || status.status === "idle") return
      const wasIndexing = kgStatus()?.status === "indexing"
      setKgStatus(status)
      if (wasIndexing && (status.status === "ready" || status.status === "failed")) {
        for (const cb of onIndexCompleteCallbacks) {
          try { cb() } catch (e) { console.warn("[smart-layer] onIndexComplete callback error:", e) }
        }
      }
    }

    // GlobalSync is used by the poll tick's fallback project-id resolution.
    // It throws outside a GlobalSyncProvider, in which case the consumer
    // degrades gracefully.
    let globalSync: ReturnType<typeof useGlobalSync> | undefined
    try {
      globalSync = useGlobalSync()
    } catch {
      globalSync = undefined
    }

    /** Directory of the active project route, or undefined outside a project. */
    const activeDirectory = (): string | undefined => decode64(params.dir) || undefined

    // KG index status poll — the single data source for the titlebar indicator
    // (and, via onIndexComplete/applyKGStatus, for anything reacting to index
    // completion). Polling pulls the *current* truth on demand, covering the
    // case SSE cannot: a project opened *already* indexed whose terminal
    // `ready` event fired before any listener existed. Interval and judgement
    // (`status === "indexing"`) match the graph kanban's own polling
    // (components/dialog-graph.tsx) so the two UIs cannot disagree.
    createEffect(() => {
      // No `connected()` gate here, matching the graph kanban's own polling
      // (components/dialog-graph.tsx): the health probe can report
      // "disconnected" while the /graph/* endpoints are still reachable
      // (slow /health, sidecar restart, freshly booted project), which kept
      // the titlebar indicator dead even though the kanban progress bar
      // worked. The tick resolves api() per-call and swallows transient
      // errors, so an unconditional poll is safe.
      let stopped = false
      let timer: ReturnType<typeof setTimeout> | undefined
      // Adaptive polling: 1s while indexing drives the progress bar; 30s once
      // idle/ready/failed. The former fixed 1s interval fired a request AND a
      // console.info line every second forever — even while the app sat idle
      // in the background for hours. With DevTools open those console entries
      // accumulate unboundedly (each retains its argument objects, blocking
      // GC), which made the renderer look like a memory leak and feel
      // progressively more sluggish after long idle periods. Chained
      // setTimeout (vs setInterval) also guarantees a slow request can never
      // overlap the next tick.
      const INDEXING_POLL_MS = 1000
      const IDLE_POLL_MS = 30_000
      const schedule = (ms: number) => {
        if (stopped) return
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(tick, ms)
      }
      const tick = () => {
        timer = undefined
        if (stopped) return
        const client = api()
        if (!client) return schedule(IDLE_POLL_MS)
        // Resolve the directory fresh on every tick: a brand-new project only
        // becomes addressable once its instance has booted.
        const directory = activeDirectory()
        if (!directory) return schedule(IDLE_POLL_MS)
        // Scoped by directory — the backend derives the index key from it, so
        // there is no client-side key that could drift from the backend's.
        void client
          .getIndexStatus(directory)
          .then((status) => {
            if (stopped) return
            applyKGStatus(status)
          })
          .catch((e) => {
            console.warn("[kg] poll tick: error", { directory, error: String(e) })
            // transient error (e.g. sidecar restart) — next tick retries
          })
          .finally(() => {
            // Idle-poll whenever the last known state is not actively
            // indexing: ready/failed states are stable, and the fast 1s cadence
            // buys nothing while the titlebar indicator is not moving.
            if (stopped) return
            schedule(kgStatus()?.status === "indexing" ? INDEXING_POLL_MS : IDLE_POLL_MS)
          })
      }

      void tick()
      onCleanup(() => {
        stopped = true
        if (timer !== undefined) clearTimeout(timer)
      })
    })

    // Reset KG state on disconnect — but only on an actual true→false
    // transition. The health probe can flap (slow /health on a busy sidecar)
    // while the /graph/* endpoints stay perfectly reachable, and re-clearing
    // the state on every flap would repeatedly stomp the polling result that
    // keeps the titlebar indicator alive.
    let wasConnected = false
    createEffect(() => {
      const now = connected()
      const dropped = wasConnected && !now
      wasConnected = now
      if (!dropped) return
      setKgStatus(null)
    })

    /** Cancel ongoing KG indexing via API. */
    const cancelKGIndex = async () => {
      const client = api()
      if (!client) return
      try {
        await client.cancelIndex()
      } catch (e) {
        console.warn("[smart-layer] cancelIndex failed:", e)
      }
    }

    /** Trigger a full reindex via the Node.js middleware.
     *  The middleware polls the Rust backend and broadcasts progress via SSE,
     *  same as the initial index. No client-side polling needed. */
    const reindexProject = async (projectPath: string) => {
      // Mark as indexing so the UI shows progress (input is NOT disabled - users can chat during indexing)
      setKgStatus({ status: "indexing", progress: 0 })
      try {
        // Route through the middleware's `/graph/reindex` (NOT the Rust
        // `/graph/force-reindex-async` directly). The middleware triggers
        // bootstrap's `startForceReindex`, which polls the Rust backend and
        // broadcasts progress via SSE — that is what drives the `sl` KG
        // status (kgIndexing/kgReady). Hitting Rust directly left the UI
        // frozen on "indexing" forever, so the reindex button appeared dead.
        await globalSDK.client.graph.reindex({ projectPath }, { throwOnError: true })
      } catch (e) {
        // A transport-level rejection (auth 401, instance route 404/500…)
        // previously vanished into a console.warn and the button appeared
        // dead. Surface it.
        console.warn("[smart-layer] Force reindex failed:", e)
        showToast({
          variant: "error",
          title: language?.t("graphKanban.indexStatus.reindexFailed") ?? "Reindex failed",
          description: errorMessage(e, language?.t("common.requestFailed") ?? "Request failed"),
        })
      }
    }

    /** Register a callback to be invoked when KG indexing completes.
     *  Returns an unsubscribe function that removes the callback. */
    const onIndexComplete = (callback: () => void): (() => void) => {
      onIndexCompleteCallbacks.push(callback)
      return () => {
        const idx = onIndexCompleteCallbacks.indexOf(callback)
        if (idx >= 0) onIndexCompleteCallbacks.splice(idx, 1)
      }
    }

    return {
      get status() {
        return status()
      },
      get connected() {
        return connected()
      },
      get version() {
        return version()
      },
      get lastError() {
        return lastError()
      },
      get api() {
        return api()
      },
      /** Force a health check now */
      checkHealth,
      /** Force a full reindex of a project (clears existing data first) */
      reindexProject,
      /** Resolve the backend-authoritative knowledge graph project id for a
       *  directory. This is the only correct key for /graph/index-status and
       *  related per-project endpoints; deriving it client-side does not match
       *  the key the backend indexes under. Cached per directory. */
      /** Resolve the knowledge graph project id without any network call, so
       *  callers on the project-close path never boot an instance (which would
       *  start a full index) just to learn the id. */
      /** Register a callback to be invoked when KG indexing completes */
      onIndexComplete,
      /** True while the KG is being indexed — same field and judgement the
       *  graph kanban polls (dialog-graph.tsx `status?.status === "indexing"`) */
      get isKGIndexing() {
        return kgStatus()?.status === "indexing"
      },
      /** True when the KG index is ready for queries */
      get isKGReady() {
        return kgStatus()?.status === "ready"
      },
      /** KG indexing progress info (null when not indexing) */
      get kgProgress() {
        const s = kgStatus()
        return s?.status === "indexing"
          ? { progress: s.progress, filesDone: s.files_done, filesTotal: s.files_total }
          : null
      },
      /** Cancel ongoing KG indexing */
      cancelKGIndex,
    }
  },
})
