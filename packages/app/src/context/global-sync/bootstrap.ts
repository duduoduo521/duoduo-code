import type {
  Config,
  DuoDuoClient,
  Path,
  PermissionRequest,
  Project,
  ProviderAuthResponse,
  ProviderListResponse,
  QuestionRequest,
  Session,
  Todo,
} from "@duoduo-ai/sdk/v2/client"
import { showToast } from "@duoduo-ai/ui/toast"
import { getFilename } from "@duoduo-ai/shared/util/path"
import { retry } from "@duoduo-ai/shared/util/retry"
import { batch } from "solid-js"
import { reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { State, VcsCache } from "./types"
import { cmp, normalizeAgentList, normalizeProviderList } from "./utils"
import { formatServerError } from "@/utils/server-errors"
import { QueryClient, queryOptions, skipToken } from "@tanstack/solid-query"

// Build a fully-detailed, copy-pasteable string for an error so the user can copy
// the complete diagnostic (message + stack) from the toast instead of the truncated
// on-screen text. Used as the toast `copyText` and therefore also lands in the
// frontend error log file.
function errorDetail(e: unknown): string {
  if (e instanceof Error) return e.stack || `${e.name}: ${e.message}`
  if (typeof e === "string") return e
  try {
    return JSON.stringify(e, null, 2)
  } catch {
    return String(e)
  }
}

type GlobalStore = {
  ready: boolean
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

function waitForPaint() {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, 50)
    if (typeof requestAnimationFrame !== "function") return
    requestAnimationFrame(() => {
      setTimeout(() => {
        clearTimeout(timer)
        finish()
      }, 0)
    })
  })
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => item.reason)
}

const providerRev = new Map<string, number>()

export function clearProviderRev(directory: string) {
  providerRev.delete(directory)
}

function runAll(list: Array<() => Promise<unknown>>) {
  return Promise.allSettled(list.map((item) => item()))
}

export async function bootstrapGlobal(input: {
  globalSDK: DuoDuoClient
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
  refreshProviders?: boolean
}) {
  // Run all bootstrap API calls in parallel — the inline splash overlay covers the
  // viewport so there is no visual benefit to yielding for paint between fast/slow.
  // Previously: fast → waitForPaint(50ms+) → slow → ready. Now: all at once → ready.
  const all = [
    () =>
      retry(() =>
        input.globalSDK.global.config.get().then((x) => {
          input.setGlobalStore("config", x.data!)
        }),
      ),
    () =>
      input.queryClient.fetchQuery({
        ...loadProvidersQuery(null),
        queryFn: () =>
          retry(() =>
            input.globalSDK.provider
              .list(input.refreshProviders ? { refresh: "true" } : undefined)
              .then((x) => {
                input.setGlobalStore("provider", normalizeProviderList(x.data!))
                return null
              }),
          ),
      }),
    () =>
      retry(() =>
        input.globalSDK.path.get().then((x) => {
          input.setGlobalStore("path", x.data!)
        }),
      ),
    () =>
      retry(() =>
        input.globalSDK.project.list().then((x) => {
          const projects = (x.data ?? [])
            .filter((p) => !!p?.id)
            .filter((p) => !!p.worktree && !p.worktree.includes("duoduo-test"))
            .slice()
            .sort((a, b) => cmp(a.id, b.id))
          input.setGlobalStore("project", projects)
        }),
      ),
  ]
  await runAll(all)
  input.setGlobalStore("ready", true)
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

function projectID(directory: string, projects: Project[]) {
  // 精确匹配：worktree 或被 sandbox 直接包含
  const exact = projects.find(
    (project) => project.worktree === directory || project.sandboxes?.includes(directory),
  )
  if (exact) return exact.id

  // 子目录匹配：IDE 打开的目录可能是某 project.worktree 的子目录。
  // 例如 git 仓库根在 D:/duoduo-ide-zed，而 IDE 实际打开的是其内部的
  // D:/duoduo-ide-zed/duoduo-ai-ide 子目录。后端 discoverProject 会把
  // worktree 提升到仓库根，导致前端的精确匹配失败、sync.project 解析为
  // undefined，进而审查面板激活失败、内容空白。这里允许目录为 worktree
  // 的后代时同样匹配到该 project。
  const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "")
  const dir = normalize(directory)
  const parent = projects.find((project) => {
    const wt = normalize(project.worktree ?? "")
    return wt.length > 0 && (dir === wt || dir.startsWith(wt + "/"))
  })
  return parent?.id
}

function mergeSession(setStore: SetStoreFunction<State>, session: Session) {
  setStore("session", (list) => {
    const next = list.slice()
    const idx = next.findIndex((item) => item.id >= session.id)
    if (idx === -1) return [...next, session]
    if (next[idx]?.id === session.id) {
      next[idx] = session
      return next
    }
    next.splice(idx, 0, session)
    return next
  })
}

function warmSessions(input: {
  ids: string[]
  store: Store<State>
  setStore: SetStoreFunction<State>
  sdk: DuoDuoClient
}) {
  const known = new Set(input.store.session.map((item) => item.id))
  const ids = [...new Set(input.ids)].filter((id) => !!id && !known.has(id))
  if (ids.length === 0) return Promise.resolve()
  return Promise.all(
    ids.map((sessionID) =>
      retry(() => input.sdk.session.get({ sessionID })).then((x) => {
        const session = x.data
        if (!session?.id) return
        mergeSession(input.setStore, session)
      }),
    ),
  ).then(() => undefined)
}

export const loadProvidersQuery = (directory: string | null) =>
  queryOptions<null>({ queryKey: [directory, "providers"], queryFn: skipToken })

export const loadAgentsQuery = (
  directory: string | null,
  sdk?: DuoDuoClient,
  transform?: (x: Awaited<ReturnType<DuoDuoClient["app"]["agents"]>>) => void,
) =>
  queryOptions<null>({
    queryKey: [directory, "agents"],
    queryFn:
      sdk && transform
        ? () =>
            retry(() =>
              sdk.app
                .agents()
                .then(transform)
                .then(() => null),
            )
        : skipToken,
  })

export const loadPathQuery = (
  directory: string | null,
  sdk?: DuoDuoClient,
  transform?: (x: Awaited<ReturnType<DuoDuoClient["path"]["get"]>>) => void,
) =>
  queryOptions<Path>({
    queryKey: [directory, "path"],
    queryFn:
      sdk && transform
        ? () =>
            retry(() =>
              sdk.path.get().then(async (x) => {
                transform(x)
                return x.data!
              }),
            )
        : skipToken,
  })

export async function bootstrapDirectory(input: {
  directory: string
  sdk: DuoDuoClient
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: Config
    path: Path
    project: Project[]
    provider: ProviderListResponse
  }
  queryClient: QueryClient
  refreshProviders?: boolean
}) {
  const loading = input.store.status !== "complete"
  const seededProject = projectID(input.directory, input.global.project)
  const seededPath = input.global.path.directory === input.directory ? input.global.path : undefined
  if (seededProject) input.setStore("project", seededProject)
  if (seededPath) input.setStore("path", seededPath)
  if (input.store.provider.all.length === 0 && input.global.provider.all.length > 0) {
    input.setStore("provider", input.global.provider)
  }
  if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
    input.setStore("config", input.global.config)
  }
  if (loading || input.store.provider.all.length === 0) {
    input.setStore("provider_ready", false)
  }
  input.setStore("mcp_ready", false)
  input.setStore("mcp", {})
  input.setStore("lsp_ready", false)
  input.setStore("lsp_warming", false)
  input.setStore("lsp", [])
  if (loading) input.setStore("status", "partial")

  const rev = (providerRev.get(input.directory) ?? 0) + 1
  providerRev.set(input.directory, rev)
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  ;(async () => {
    // Split bootstrap into a CRITICAL path (needed for the editor UI to appear)
    // and a BACKGROUND path (slow endpoints that spawn external processes). The
    // splash overlay is removed as soon as the critical path settles, so a slow
    // mcp/lsp/vcs/command/permission/question endpoint no longer holds the UI for
    // several seconds ("启动几秒卡死").
    const critical = [
      () => Promise.resolve(input.loadSessions(input.directory)),
      () =>
        input.queryClient.ensureQueryData(
          loadAgentsQuery(input.directory, input.sdk, (x) => input.setStore("agent", normalizeAgentList(x.data))),
        ),
      () => retry(() => input.sdk.config.get().then((x) => input.setStore("config", x.data!))),
      () => retry(() => input.sdk.session.status().then((x) => input.setStore("session_status", x.data!))),
      !seededProject &&
        (() => retry(() => input.sdk.project.current()).then((x) => input.setStore("project", x.data!.id))),
      !seededPath &&
        (() =>
          input.queryClient.ensureQueryData(
            loadPathQuery(input.directory, input.sdk, (x) => {
              const next = projectID(x.data?.directory ?? input.directory, input.global.project)
              if (next) input.setStore("project", next)
            }),
          )),
      // NOTE: this deliberately does NOT go through queryClient.ensureQueryData.
      // ensureQueryData dedupes to an in-flight query, while the rev guard
      // above drops that same query's result the moment a newer bootstrap
      // starts — combining both means a slow (>500ms) provider.list resolves
      // into the void and the child provider store never updates. Calling the
      // SDK directly lets every bootstrap round issue its own request; the rev
      // guard keeps only the newest one.
      () =>
        retry(() => input.sdk.provider.list(input.refreshProviders ? { refresh: "true" } : undefined))
          .then((x) => {
            if (providerRev.get(input.directory) !== rev) return
            input.setStore("provider", normalizeProviderList(x.data!))
            input.setStore("provider_ready", true)
          })
          .catch((err) => {
            if (providerRev.get(input.directory) !== rev) console.error("Failed to refresh provider list", err)
            // Suppress toast during sidecar shutdown (e.g. update-and-restart)
            if ((window as any).__DUODUO_SIDECAR_SHUTTING_DOWN__) return
            const project = getFilename(input.directory)
            showToast({
              variant: "error",
              title: input.translate("toast.project.reloadFailed.title", { project }),
              description: formatServerError(err, input.translate),
              copyText: errorDetail(err),
            })
          })
          .then(() => null),
    ].filter(Boolean) as (() => Promise<any>)[]

    const background = [
      () =>
        retry(() =>
          input.sdk.vcs.get().then((x) => {
            const next = x.data ?? input.store.vcs
            input.setStore("vcs", next)
            if (next) input.vcsCache.setStore("value", next)
          }),
        ),
      () => retry(() => input.sdk.command.list().then((x) => input.setStore("command", x.data ?? []))),
      () =>
        retry(() =>
          input.sdk.permission.list().then((x) => {
            const ids = (x.data ?? []).map((perm) => perm?.sessionID).filter((id): id is string => !!id)
            const grouped = groupBySession(
              (x.data ?? []).filter((perm): perm is PermissionRequest => !!perm?.id && !!perm.sessionID),
            )
            return warmSessions({ ids, store: input.store, setStore: input.setStore, sdk: input.sdk }).then(() =>
              batch(() => {
                for (const sessionID of Object.keys(input.store.permission)) {
                  if (grouped[sessionID]) continue
                  input.setStore("permission", sessionID, [])
                }
                for (const [sessionID, permissions] of Object.entries(grouped)) {
                  input.setStore(
                    "permission",
                    sessionID,
                    reconcile(
                      permissions.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id)),
                      { key: "id" },
                    ),
                  )
                }
              }),
            )
          }),
        ),
      () =>
        retry(() =>
          input.sdk.question.list().then((x) => {
            const ids = (x.data ?? []).map((question) => question?.sessionID).filter((id): id is string => !!id)
            const grouped = groupBySession((x.data ?? []).filter((q): q is QuestionRequest => !!q?.id && !!q.sessionID))
            return warmSessions({ ids, store: input.store, setStore: input.setStore, sdk: input.sdk }).then(() =>
              batch(() => {
                for (const sessionID of Object.keys(input.store.question)) {
                  if (grouped[sessionID]) continue
                  input.setStore("question", sessionID, [])
                }
                for (const [sessionID, questions] of Object.entries(grouped)) {
                  input.setStore(
                    "question",
                    sessionID,
                    reconcile(
                      questions.filter((q) => !!q?.id).sort((a, b) => cmp(a.id, b.id)),
                      { key: "id" },
                    ),
                  )
                }
              }),
            )
          }),
        ),
      () =>
        retry(() =>
          input.sdk.mcp.status().then((x) => {
            input.setStore("mcp", x.data!)
            input.setStore("mcp_ready", true)
          }),
        ),
      () => {
        // LSP 预热：同步先置 warming（保证早于任何 spawn 完成事件到达，
        // 否则事件先清除态而 touch 响应后置 true 会让 spinner 永转），
        // 响应回传 scheduled=0（项目无已知语言）或请求失败时再清除
        input.setStore("lsp_warming", true)
        return (input.sdk.lsp as any).client
          .post({
            url: "/lsp/touch",
            body: { directory: input.directory },
          })
          .then((res: unknown) => {
            const scheduled = (res as { data?: { scheduled?: number }; scheduled?: number })?.data?.scheduled
            if (scheduled === 0) input.setStore("lsp_warming", false)
          })
          .catch(() => {
            input.setStore("lsp_warming", false)
          })
      },
    ].filter(Boolean) as (() => Promise<any>)[]

    // Skip waitForPaint during initial load — the inline splash overlay covers
    // the viewport so yielding for paint is unnecessary. On reload (loading=false)
    // we still yield to avoid blocking the UI.
    if (!loading) await waitForPaint()
    const critErrs = errors(await runAll(critical))
    // Reveal the editor UI as soon as the critical data is ready. Do NOT wait for
    // the slow background endpoints (mcp/lsp/vcs/command/permission/question) —
    // those can spawn external processes and used to hold the splash for seconds.
    if (loading) {
      if (critErrs.length === 0) input.setStore("status", "complete")
      // The splash overlay polls for the actual DOM elements to appear before
      // removing itself, so the user never sees a blank gap.
      document.dispatchEvent(new CustomEvent("__duoduo_bootstrap_complete__"))
    }
    if (critErrs.length > 0) {
      console.error("Failed to finish critical bootstrap", critErrs[0])
      // Suppress toast during sidecar shutdown (e.g. update-and-restart)
      if ((window as any).__DUODUO_SIDECAR_SHUTTING_DOWN__) return
      const project = getFilename(input.directory)
      showToast({
        variant: "error",
        title: input.translate("toast.project.reloadFailed.title", { project }),
        description: formatServerError(critErrs[0], input.translate),
        copyText: errorDetail(critErrs[0]),
      })
      return
    }

    // Warm slow endpoints in the background; failures are non-fatal and the
    // corresponding UI sections already render loading/empty states.
    const bgErrs = errors(await runAll(background))
    if (bgErrs.length > 0) {
      console.error("Failed to finish background bootstrap", bgErrs[0])
      if ((window as any).__DUODUO_SIDECAR_SHUTTING_DOWN__) return
      const project = getFilename(input.directory)
      showToast({
        variant: "error",
        title: input.translate("toast.project.reloadFailed.title", { project }),
        description: formatServerError(bgErrs[0], input.translate),
        copyText: errorDetail(bgErrs[0]),
      })
    }
  })()
}
