import type {
  Config,
  DuoDuoClient,
  Path,
  Project,
  ProviderAuthResponse,
  ProviderListResponse,
  Todo,
} from "@duoduo-ai/sdk/v2/client"
import { showToast } from "@duoduo-ai/ui/toast"
import { getFilename } from "@duoduo-ai/shared/util/path"
import {
  batch,
  createContext,
  createSignal,
  getOwner,
  onCleanup,
  onMount,
  type ParentProps,
  untrack,
  useContext,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import { useGlobalSDK } from "./global-sdk"
import { bootstrapDirectory, bootstrapGlobal, clearProviderRev } from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./global-sync/event-reducer"
import { createRefreshQueue } from "./global-sync/queue"
import { clearSessionPrefetchDirectory } from "./global-sync/session-prefetch"
import { getOrCreateFileTree } from "./global-sync/file-tree-cache"
import { invalidateFromWatcher } from "./file/watcher"
import { loadRootSessionsWithFallback } from "./global-sync/session-load"
import { trimSessions } from "./global-sync/session-trim"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { queryOptions, skipToken, useQueryClient } from "@tanstack/solid-query"

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  session_todo: {
    [sessionID: string]: Todo[]
  }
  provider: ProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

export const loadSessionsQuery = (directory: string) =>
  queryOptions<null>({ queryKey: [directory, "loadSessions"], queryFn: skipToken })

function createGlobalSync() {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  // Focus request emitted by Feishu-originated prompts. GlobalSyncProvider sits
  // OUTSIDE the Router, so it cannot call useNavigate directly — instead it
  // publishes this signal and a small navigator component inside the Router
  // root consumes it (see SessionFocusNavigator in app.tsx).
  const [sessionFocus, setSessionFocus] = createSignal<{ directory: string; sessionID: string }>()
  const owner = getOwner()
  if (!owner) throw new Error("GlobalSync must be created within owner")

  const lastStatusRefresh: Record<string, number> = {}
  const sdkCache = new Map<string, DuoDuoClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    ready: false,
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
    project: [],
    session_todo: {},
    provider: { all: [], connected: [], default: {} },
    provider_auth: {},
    config: {},
    reload: undefined,
  })

  // Abort tracking: sessions marked as aborted until the user sends
  // a new message (which calls clearAborted). event-reducer uses
  // isAborted to filter stale LLM output (text/reasoning parts)
  // that arrive after the user clicks stop.
  const abortedSessions = new Set<string>()
  const markAborted = (sessionID: string) => {
    abortedSessions.add(sessionID)
  }
  const clearAborted = (sessionID: string) => {
    abortedSessions.delete(sessionID)
  }
  const isAborted = (sessionID: string): boolean => {
    return abortedSessions.has(sessionID)
  }
  const queryClient = useQueryClient()

  let bootedAt = 0
  let bootingRoot = false
  let eventFrame: number | undefined
  let eventTimer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
    if (eventTimer !== undefined) clearTimeout(eventTimer)
  })

  const setProjects = (next: Project[] | ((draft: Project[]) => Project[])) => {
    setGlobalStore("project", next)
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => Project[]))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const setSessionTodo = (sessionID: string, todos: Todo[] | undefined) => {
    if (!sessionID) return
    if (!todos) {
      setGlobalStore(
        "session_todo",
        produce((draft) => {
          delete draft[sessionID]
        }),
      )
      return
    }
    setGlobalStore("session_todo", sessionID, reconcile(todos, { key: "content" }))
  }

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    bootstrap,
    bootstrapInstance,
  })

  const children = createChildStoreManager({
    owner,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onDispose: (directory) => {
      queue.clear(directory)
      sessionMeta.delete(directory)
      sdkCache.delete(directory)
      clearProviderRev(directory)
      clearSessionPrefetchDirectory(directory)
    },
    translate: language.t,
  })

  const sdkFor = (directory: string) => {
    const cached = sdkCache.get(directory)
    if (cached) return cached
    const sdk = globalSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(directory, sdk)
    return sdk
  }

  async function loadSessions(directory: string) {
    const pending = sessionLoads.get(directory)
    if (pending) return pending

    children.pin(directory)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(directory)
    if (meta && meta.limit >= store.limit) {
      const next = trimSessions(store.session, {
        limit: store.limit,
        permission: store.permission,
      })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
        cleanupDroppedSessionCaches(store, setStore, next, setSessionTodo)
      }
      children.unpin(directory)
      return
    }

    const limit = Math.max(store.limit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const promise = queryClient
      .fetchQuery({
        ...loadSessionsQuery(directory),
        queryFn: () =>
          loadRootSessionsWithFallback({
            directory,
            limit,
            list: (query) => globalSDK.client.session.list(query),
          })
            .then((x) => {
              const nonArchived = (x.data ?? [])
                .filter((s) => !!s?.id)
                .filter((s) => !s.time?.archived)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const limit = store.limit
              const childSessions = store.session.filter((s) => !!s.parentID)
              const sessions = trimSessions([...nonArchived, ...childSessions], {
                limit,
                permission: store.permission,
              })
              batch(() => {
                setStore(
                  "exhausted",
                  nonArchived.length <= store.limit,
                )
                setStore("session", reconcile(sessions, { key: "id" }))
                cleanupDroppedSessionCaches(store, setStore, sessions, setSessionTodo)
              })
              sessionMeta.set(directory, { limit })
            })
            .catch((err) => {
              console.error("Failed to load sessions", err)
              // Suppress toast during sidecar shutdown (e.g. update-and-restart)
              if ((window as any).__DUODUO_SIDECAR_SHUTTING_DOWN__) return
              const project = getFilename(directory)
              showToast({
                variant: "error",
                title: language.t("toast.session.listFailed.title", { project }),
                description: formatServerError(err, language.t),
              })
            })
            .then(() => null),
      })
      .then(() => {})

    sessionLoads.set(directory, promise)
    void promise.finally(() => {
      sessionLoads.delete(directory)
      children.unpin(directory)
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    if (!directory) return
    const pending = booting.get(directory)
    if (pending) return pending

    children.pin(directory)
    const promise = Promise.resolve().then(async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(directory)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        global: {
          config: globalStore.config,
          path: globalStore.path,
          project: globalStore.project,
          provider: globalStore.provider,
        },
        sdk,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions,
        translate: language.t,
        queryClient,
      })
    })

    booting.set(directory, promise)
    void promise.finally(() => {
      booting.delete(directory)
      children.unpin(directory)
    })
    return promise
  }

  const unsub = globalSDK.event.listen((e) => {
    const directory = e.name
    const event = e.details
    // Feishu-originated prompts auto-switch the desktop to that session so the
    // user (returning to the keyboard) lands on the ongoing conversation.
    const fe = event as { type?: string; properties?: { sessionID?: string; origin?: string } }
    if (fe.type === "session.focus" && fe.properties?.origin === "feishu" && fe.properties.sessionID) {
      setSessionFocus({ directory, sessionID: fe.properties.sessionID })
    }
    const recent = bootingRoot || Date.now() - bootedAt < 1500

    if (event.type === "session.error") {
      const error = event.properties.error
      if (error?.name !== "MessageAbortedError") {
        console.error("[global-sync] session error", {
          scope: directory === "global" ? "global" : "workspace",
          directory: directory === "global" ? undefined : directory,
          project: directory === "global" ? undefined : getFilename(directory),
          sessionID: event.properties.sessionID,
          error,
        })
        // Show a toast so the user sees what happened instead of a silent failure.
        const description =
          typeof error?.data?.message === "string"
            ? error.data.message
            : typeof error?.data === "string"
              ? error.data
              : language.t("session.error")
        showToast({
          variant: "error",
          title: language.t("session.error"),
          description,
        })
      }
    }

    if (directory === "global") {
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (recent) return
          queue.refresh()
        },
        setGlobalProject: setProjects,
      })
      // A Feishu (or other client) model selection persisted to global config
      // via PATCH /global/config. Reflect it locally so the AI dialog's model
      // dropdown updates without a full re-bootstrap. The event type is defined
      // server-side and not yet present in the generated SDK union, so we narrow
      // via a local cast.
      const evt = event as { type?: string; properties?: unknown }
      if (evt.type === "global.config.updated") {
        setGlobalStore("config", evt.properties as Config)
        return
      }
      if (event.type === "server.connected" || event.type === "global.disposed") {
        if (recent) return
        // Drop cached provider data before re-bootstrapping. Without this,
        // bootstrapDirectory's ensureQueryData returns the pre-dispose list and
        // a freshly connected provider (e.g. DeepSeek) never shows up in the
        // project-scoped provider store that feeds Settings and the model
        // picker. Mirrors the invalidation in updateConfig.
        refreshProviderDataSoon()
        const now = Date.now()
        for (const directory of Object.keys(children.children)) {
          queue.push(directory)
          const child = children.children[directory]
          if (!child) continue
          const setStore = child[1]
          const lastStatus = lastStatusRefresh[directory] ?? 0
          if (now - lastStatus > 10_000) {
            lastStatusRefresh[directory] = now
            void sdkFor(directory)
              .session.status()
              .then((x) => setStore("session_status", x.data ?? {}))
              .catch(() => {})
          }
        }
      }
      return
    }

    // State-style events such as `graph.index-status` report the *current*
    // state of a directory and can be emitted by the backend as soon as the
    // instance starts indexing — often *before* the frontend has lazily created
    // that directory's child store. A previously-indexed project whose bincode
    // snapshot re-indexes near-instantly can finish before any child store
    // exists; the generic `if (!existing) return` below would then drop every
    // event and the titlebar KG indicator would never appear. For such events
    // we create the lightweight child store on demand (without forcing a full
    // bootstrap) so the state is captured, then fall through to apply.
    if (!children.children[directory] && event.type === "graph.index-status") {
      children.ensureChild(directory)
    }

    const existing = children.children[directory]
    if (!existing) return
    children.mark(directory)
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: queue.push,
      setSessionTodo,
      vcsCache: children.vcsCache.get(directory),
      isAborted,
      loadLsp: () => {
        void sdkFor(directory)
          .lsp.status()
          .then((x) => {
            setStore("lsp", x.data ?? [])
            setStore("lsp_ready", true)
            // 全部 server 无 error 即终态成功：熄灭 warming（标题栏指示器消失）；
            // 存在 error 时保持 warming，指示器由「starting spinner」切换为「failed」
            if (!(x.data ?? []).some((s) => s.status === "error")) setStore("lsp_warming", false)
          })
      },
      refreshMcp: () => {
        void sdkFor(directory)
          .mcp.status()
          .then((x) => {
            setStore("mcp", x.data ?? {})
            setStore("mcp_ready", true)
          })
      },
    })

    // Update background project file tree caches on watcher events.
    // The active FileProvider handles the foreground project via its own
    // sdk.event.listen; this path ensures non-active projects stay fresh too.
    if (event.type === "file.watcher.updated") {
      const treeEntry = children.fileTreeCache.get(directory) ?? getOrCreateFileTree(directory, sdkFor(directory))
      if (treeEntry) {
        invalidateFromWatcher(event, {
          normalize: treeEntry.pathHelpers.normalize,
          hasFile: () => false,
          isOpen: () => false,
          loadFile: () => {},
          node: treeEntry.store.node,
          isDirLoaded: treeEntry.store.isLoaded,
          refreshDir: (dir: string) => void treeEntry.store.listDir(dir, { force: true }),
          reloadOpenFiles: () => {},
          closeTab: () => {},
          closeTabsUnder: () => {},
        })
      }
    }
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directory)
    }
  })

  async function bootstrap(refreshProviders?: boolean) {
    bootingRoot = true
    try {
      await bootstrapGlobal({
        globalSDK: globalSDK.client,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
        refreshProviders,
      })
      bootedAt = Date.now()
    } finally {
      bootingRoot = false
    }
  }

  onMount(() => {
    makeEventListener(document, "visibilitychange", () => {
      if (document.visibilityState !== "visible") return
      // 切回时刷新所有 workspace 的缓存数据，而非重连 SSE
      for (const directory of Object.keys(children.children)) {
        queue.push(directory)
      }
    })
  })

  onMount(() => {
    if (typeof requestAnimationFrame === "function") {
      eventFrame = requestAnimationFrame(() => {
        eventFrame = undefined
        eventTimer = setTimeout(() => {
          eventTimer = undefined
          void globalSDK.event.start()
        }, 0)
      })
    } else {
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void globalSDK.event.start()
      }, 0)
    }
    void bootstrap()
  })

  const projectApi = {
    loadSessions,
    loadSessionStatus(directory: string) {
      const [, setStore] = children.child(directory, { bootstrap: false })
      const now = Date.now()
      const last = lastStatusRefresh[directory] ?? 0
      if (now - last < 5000) return
      lastStatusRefresh[directory] = now
      void sdkFor(directory)
        .session.status()
        .then((x) => setStore("session_status", x.data ?? {}))
        .catch(() => {})
    },
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  // Reset cached provider data so the next bootstrap re-fetches it.
  // IMPORTANT: do NOT use queryClient.removeQueries for this — it destroys
  // matching queries, and destroying a query that is mid-flight surfaces a
  // CancelledError (a provider fetch is usually in flight when provider state
  // changes: auth.set emits config.updated right before global.dispose, and
  // each event kicks off its own refresh). Setting the cached data to
  // undefined is cancellation-safe and still forces ensureQueryData to fetch.
  function invalidateProviderCaches() {
    queryClient.setQueriesData(
      { predicate: (query) => Array.isArray(query.queryKey) && query.queryKey[1] === "providers" },
      () => undefined,
    )
  }

  // A pre-change fetch that is still in flight can settle *after* the cache
  // clear and write its stale result back into the cache (and the stores).
  // Run one more invalidate + refresh pass after those requests have landed so
  // the final state is guaranteed to be fresh.
  function refreshProviderDataSoon() {
    invalidateProviderCaches()
    setTimeout(() => {
      invalidateProviderCaches()
      queue.refresh()
      for (const directory of Object.keys(children.children)) queue.push(directory)
    }, 500)
  }

  const updateConfig = async (config: Config) => {
    setGlobalStore("reload", "pending")
    // Raise the booting guard BEFORE the HTTP call so the server's async
    // `global.disposed` event (fired by Instance.dispose() inside config.update)
    // is swallowed by the "recent" check in the global event handler. Without
    // this, the disposed event races ahead of bootstrap() — which only sets
    // bootingRoot=true after the HTTP response returns — and walks every open
    // directory with queue.push(), rebuilding the whole workspace store and
    // causing the full-screen white flash on connect. bootstrap() re-asserts
    // and clears this flag, so the normal flow is unchanged.
    bootingRoot = true
    return globalSDK.client.global.config
      .update({ config })
      .then(() => bootstrap(true))
      .then(() => {
        // Invalidate cached provider queries so ensureQueryData will re-fetch.
        // Without this, bootstrapDirectory's ensureQueryData returns stale data
        // because the cached value (null) is still considered valid.
        refreshProviderDataSoon()
        queue.refresh()
        // Push all child directories to the queue so their provider lists get refreshed.
        // The global.disposed event from the server would normally trigger this,
        // but it gets skipped due to the "recent" check right after bootstrap().
        for (const directory of Object.keys(children.children)) {
          queue.push(directory)
        }
        setGlobalStore("reload", undefined)
        queue.refresh()
      })
      .catch((error) => {
        setGlobalStore("reload", undefined)
        throw error
      })
  }

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    peek: children.peek,
    fileTree(directory: string) {
      return getOrCreateFileTree(directory, sdkFor(directory))
    },
    bootstrap,
    updateConfig,
    project: projectApi,
    todo: {
      set: setSessionTodo,
    },
    markAborted,
    clearAborted,
    isAborted,
    /** Pending Feishu-driven focus request; consumed by SessionFocusNavigator. */
    sessionFocus,
    clearSessionFocus: () => setSessionFocus(undefined),
  }
}

const GlobalSyncContext = createContext<ReturnType<typeof createGlobalSync>>()

export function GlobalSyncProvider(props: ParentProps) {
  const value = createGlobalSync()
  return <GlobalSyncContext.Provider value={value}>{props.children}</GlobalSyncContext.Provider>
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext)
  if (!context) throw new Error("useGlobalSync must be used within GlobalSyncProvider")
  return context
}
