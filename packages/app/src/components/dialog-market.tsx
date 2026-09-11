import { createSignal, createResource, createEffect, onCleanup, Show, For } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSmartLayer } from "@/addons/smart-layer/context"
import { usePlatform } from "@/context/platform"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { Markdown } from "@duoduo-ai/ui/markdown"
import { Button } from "@duoduo-ai/ui/button"
import { IconButton } from "@duoduo-ai/ui/icon-button"
import { TextField } from "@duoduo-ai/ui/text-field"
import { showToast } from "@duoduo-ai/ui/toast"

interface GearEntry {
  name: string
  description: string
  version: string
  kind: "native" | "skill" | "plugin" | "mcp" | "builtin"
  files: string[]
  tags: string[]
  author: string
  homepage: string
  license: string
  activation: string
  installed: boolean
  spec: string
  /** Direct download URL for the install pipeline (skill source_url). */
  download_url?: string | null
}

interface McpConfig {
  kind: string
  command?: string | null
  args: string[]
  url?: string | null
  env: Record<string, string>
  required_env: { name: string; description: string; required: boolean }[]
  description?: string | null
  source_url?: string | null
  license?: string | null
  publisher?: string | null
  /** Long-form markdown intro (marketplace readme, or npm README fallback). */
  readme?: string | null
  /** Cover/logo image URL. */
  logo_url?: string | null
  /** Marketplace category ids. */
  categories?: string[]
}

/** Client-side kind filter chips shown above the unified list. */
const KIND_FILTERS = ["all", "mcp", "skill"] as const
type KindFilter = (typeof KIND_FILTERS)[number]

function specSource(spec: string): string {
  const i = spec.indexOf(":")
  return i >= 0 ? spec.slice(0, i) : spec
}

function specServerId(spec: string): string {
  const i = spec.indexOf(":")
  return i >= 0 ? spec.slice(i + 1) : spec
}

function isMarketplaceMcp(gear: GearEntry): boolean {
  return gear.spec.startsWith("mcp-registry:") || gear.spec.startsWith("modelscope:")
}

/** External detail page for a market entry — ModelScope page when the entry is
 * ModelScope-sourced, otherwise the upstream homepage (registry/github). Used
 * by the click-to-open behavior so users can verify the source (transparency). */
function gearDetailUrl(gear: GearEntry): string | undefined {
  const src = specSource(gear.spec)
  const id = specServerId(gear.spec)
  // ModelScope 来源的条目必须固定跳魔搭官方详情页：homepage/source_url 常常
  // 指向第三方 GitHub 仓库，可能已迁移或删除（用户实测大量 404），不能优先。
  if (src === "modelscope") {
    // ModelScope MCP 广场详情页路径；裸 `/{id}` 会 404。
    return `https://www.modelscope.cn/mcp/servers/${id}`
  }
  if (src === "modelscope-skill") {
    // 技能广场详情页（SSR 实测有效）；裸 `/{id}` 是模型仓库路径，技能会 404。
    return `https://www.modelscope.cn/skills/${id}`
  }
  if (gear.homepage && gear.homepage.trim()) return gear.homepage.trim()
  return undefined
}

/** Inline pill badge (name suffix): small, fully rounded, per-kind color. */
const KIND_BADGE: Record<string, string> = {
  mcp: "bg-surface-brand-hover text-text-on-brand-base",
  skill: "bg-surface-info-weak text-text-on-info-base",
  native: "bg-surface-success-weak text-text-on-success-base",
  builtin: "bg-surface-weak text-text-weaker",
  plugin: "bg-surface-warning-weak text-text-on-warning-base",
}

const KIND_ICON: Record<string, string> = {
  mcp: "🔌",
  skill: "📝",
  plugin: "🧩",
  native: "⚙️",
  builtin: "⚙️",
}

export function DialogMarket(props: {}) {
  const { t } = useLanguage()
  const sl = useSmartLayer()
  const platform = usePlatform()

  const [kindFilter, setKindFilter] = createSignal<KindFilter>("all")
  const [searchQuery, setSearchQuery] = createSignal("")
  const PAGE_SIZE = 12

  // ── On-demand (infinite-scroll) paging with a per-page cache ──
  const pageCache = new Map<string, Map<number, GearEntry[]>>()
  const pageMeta = new Map<string, { total: number; has_more: boolean }>()

  function cacheKey(): string {
    return `${kindFilter()}|${searchQuery()}`
  }

  const [items, setItems] = createSignal<GearEntry[]>([])
  const [loadedPages, setLoadedPages] = createSignal(0)
  const [total, setTotal] = createSignal(0)
  const [hasMore, setHasMore] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [installing, setInstalling] = createSignal<string | null>(null)
  const [installedNames, setInstalledNames] = createSignal<Set<string>>(new Set())
  const [error, setError] = createSignal<string | null>(null)
  const [marketLoadError, setMarketLoadError] = createSignal<string | null>(null)
  const [sourceError, setSourceError] = createSignal<string | null>(null)
  /** Next-page failures are shown inline at the list bottom, NOT as the big
   * top banner (a failed "load more" must not look like a source outage). */
  const [loadMoreError, setLoadMoreError] = createSignal<string | null>(null)
  const [configLoadError, setConfigLoadError] = createSignal<string | null>(null)

  // ── Compliance dialog state ──
  const [pendingGear, setPendingGear] = createSignal<GearEntry | null>(null)
  // ── Local-command confirmation state (skill installs via `git clone`) ──
  const [pendingCmdGear, setPendingCmdGear] = createSignal<GearEntry | null>(null)
  const [envInputs, setEnvInputs] = createSignal<Record<string, string>>({})
  const [agreed, setAgreed] = createSignal(false)
  const [installErr, setInstallErr] = createSignal<string | null>(null)

  // ── Detail panel state (click a card to open an in-app detail view) ──
  const [selectedGear, setSelectedGear] = createSignal<GearEntry | null>(null)

  // ── Unified gear API helpers ──

  /// Wait (up to `timeoutMs`) for the smart-layer API client to become
  /// available. The duo-smart-layer sidecar boots on a RANDOM port and may
  /// start *after* the webview, so `sl.api` is briefly `null` on first load.
  async function resolveSmartLayerApi(timeoutMs: number) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (sl.api) return sl.api
      await new Promise((r) => setTimeout(r, 150))
    }
    return sl.api
  }

  async function gearGet<T>(path: string, timeoutMs?: number): Promise<T> {
    const api = await resolveSmartLayerApi(8000)
    if (api) return api.get<T>(path, timeoutMs)
    // Last-resort relative fetch (Vite dev proxy).
    const resp = await fetch(path, {
      signal: timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    const ct = resp.headers.get("content-type") ?? ""
    if (!resp.ok || !ct.includes("application/json")) {
      throw new Error(
        resp.ok
          ? t("gearStore.fetchError")
          : `HTTP ${resp.status}`,
      )
    }
    return resp.json() as Promise<T>
  }

  async function gearPost<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const api = sl.api
    if (api) return api.post<T>(path, body, timeoutMs)
    const resp = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    if (!resp.ok) {
      const err = await resp.text()
      throw new Error(err || `HTTP ${resp.status}`)
    }
    return resp.json() as Promise<T>
  }

  interface GearMarketIndex {
    gears: GearEntry[]
    total: number
    page: number
    page_size: number
    has_more: boolean
    degraded?: boolean
    message?: string
  }

  const [configRefresh, setConfigRefresh] = createSignal(false)

  const [configRes, configActions] = createResource(pendingGear, async (gear) => {
    if (!gear) return null
    setConfigLoadError(null)
    const refresh = configRefresh()
    setConfigRefresh(false)
    const sourceId = specSource(gear.spec)
    const serverId = specServerId(gear.spec)
    try {
      return await gearGet<McpConfig>(
        `/gears/mcp/config?source=${encodeURIComponent(sourceId)}&server_id=${encodeURIComponent(serverId)}${
          refresh ? "&refresh=true" : ""
        }`,
      )
    } catch (e: unknown) {
      setConfigLoadError(e instanceof Error ? e.message : String(e))
      return null
    }
  })

  // 详情视图按需拉取描述：市场列表项的 description 可能为空，故在打开卡片时
  // 拉取服务的完整配置（含更丰富的 `description`）。仅 MCP 有配置接口，
  // skill 等回退到列表自带的 description。
  const [detailRes] = createResource(selectedGear, async (gear) => {
    if (!gear || gear.kind !== "mcp") return null
    const sourceId = specSource(gear.spec)
    const serverId = specServerId(gear.spec)
    try {
      return await gearGet<McpConfig>(
        `/gears/mcp/config?source=${encodeURIComponent(sourceId)}&server_id=${encodeURIComponent(serverId)}`,
      )
    } catch {
      return null
    }
  })

  async function fetchMarketPage(
    query: string,
    kind: string,
    page: number,
    refresh: boolean,
  ): Promise<GearMarketIndex> {
    const params = new URLSearchParams()
    if (query) params.set("url", query)
    if (kind && kind !== "all") params.set("kind", kind)
    params.set("page", String(page))
    params.set("page_size", String(PAGE_SIZE))
    if (refresh) params.set("refresh", "true")
    return gearGet<GearMarketIndex>(`/gears/market?${params}`)
  }

  /** Load page 1 for the current key, resetting the visible list. */
  async function loadInitial(refresh = false) {
    const key = cacheKey()
    setLoading(true)
    setMarketLoadError(null)
    setLoadMoreError(null)
    let done = false
    const watchdog = setTimeout(() => {
      if (done) return
      done = true
      try {
        setLoading(false)
        setMarketLoadError(t("gearStore.fetchTimeout"))
      } catch {
        try { setLoading(false) } catch {}
      }
    }, 15000)
    try {
      const data = await fetchMarketPage(searchQuery(), kindFilter(), 1, refresh)
      if (done) return
      clearTimeout(watchdog)
      const pm = pageCache.get(key) ?? new Map<number, GearEntry[]>()
      pm.set(1, data.gears)
      pageCache.set(key, pm)
      pageMeta.set(key, { total: data.total, has_more: data.has_more })
      if (data.degraded && data.gears.length === 0) {
        // Upstream fully failed for this page and returned nothing. Prefer the
        // last successfully-cached results so the user still sees content with a
        // "连接失败，显示缓存" banner, instead of a blank list.
        const restored = restoreFromCache(key)
        if (!restored) setItems([])
        if (!restored) {
          setLoadedPages(1)
          setTotal(data.total)
          setHasMore(data.has_more)
        }
      } else {
        setItems(data.gears)
        setLoadedPages(1)
        setTotal(data.total)
        setHasMore(data.has_more)
      }
      setSourceError(data.degraded ? (data.message ?? t("market.degraded")) : null)
    } catch (e: unknown) {
      if (done) return
      clearTimeout(watchdog)
      // Network/transport error (e.g. backend unreachable). Fall back to the
      // cached results for this key so the user still sees previously loaded
      // gears; the error banner keeps a retry action.
      setMarketLoadError(e instanceof Error ? e.message : String(e))
      if (!restoreFromCache(key)) {
        setItems([])
        setLoadedPages(0)
        setHasMore(false)
      }
    } finally {
      clearTimeout(watchdog)
      if (!done) setLoading(false)
    }
  }

  /**
   * Re-populate the visible list from the in-memory page cache for `key` (the
   * result of `cacheKey()`). Returns true if any cached pages existed. When the
   * upstream is unreachable we keep showing the last known-good results instead
   * of blanking the list.
   */
  function restoreFromCache(key: string): boolean {
    const pm = pageCache.get(key)
    if (!pm || pm.size === 0) return false
    const pages = Array.from(pm.keys()).sort((a, b) => a - b)
    const all: GearEntry[] = []
    for (const p of pages) {
      const arr = pm.get(p)
      if (arr) all.push(...arr)
    }
    const meta = pageMeta.get(key)
    setItems(all)
    setLoadedPages(pages.length)
    setTotal(meta?.total ?? all.length)
    setHasMore(meta?.has_more ?? false)
    return true
  }

  /** Load the next page, reusing the cache when the page was already fetched. */
  async function loadMore() {
    if (loadingMore() || !hasMore()) return
    const key = cacheKey()
    const next = loadedPages() + 1
    const cached = pageCache.get(key)?.get(next)
    if (cached) {
      setItems((prev) => [...prev, ...cached])
      setLoadedPages(next)
      setHasMore(pageMeta.get(key)?.has_more ?? false)
      return
    }
    setLoadingMore(true)
    setLoadMoreError(null)
    let done = false
    const watchdog = setTimeout(() => {
      if (done) return
      done = true
      try {
        setLoadingMore(false)
        setLoadMoreError(t("gearStore.fetchTimeout"))
      } catch {
        try { setLoadingMore(false) } catch {}
      }
    }, 15000)
    try {
      const data = await fetchMarketPage(searchQuery(), kindFilter(), next, false)
      if (done) return
      clearTimeout(watchdog)
      if (data.degraded && data.gears.length === 0) {
        // Next-page fetch fully failed: keep the already-loaded pages intact,
        // do NOT advance `loadedPages` (so a retry re-requests the same page)
        // and surface only a small inline hint — never the top "数据源连接
        // 失败" banner, which would wrongly suggest the whole market is down.
        setLoadMoreError(data.message ?? t("market.degraded"))
        return
      }
      const pm = pageCache.get(key) ?? new Map<number, GearEntry[]>()
      pm.set(next, data.gears)
      pageCache.set(key, pm)
      pageMeta.set(key, { total: data.total, has_more: data.has_more })
      setItems((prev) => [...prev, ...data.gears])
      setLoadedPages(next)
      setHasMore(data.has_more)
    } catch (e: unknown) {
      if (done) return
      clearTimeout(watchdog)
      setLoadMoreError(e instanceof Error ? e.message : String(e))
    } finally {
      clearTimeout(watchdog)
      if (!done) setLoadingMore(false)
    }
  }

  /** Refresh button: drop the cached pages for this key and reload page 1. */
  function handleRefresh() {
    const key = cacheKey()
    pageCache.delete(key)
    pageMeta.delete(key)
    void loadInitial(true)
  }

  // Debounced reload whenever the query or kind filter changes (resets paging).
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    searchQuery()
    kindFilter()
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => void loadInitial(false), 300)
  })
  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer)
  })

  /** Whether a market entry can be auto-installed via the download pipeline. */
  function canInstall(gear: GearEntry): boolean {
    if (gear.kind === "skill") return !!gear.download_url
    return true
  }

  /** Activation-tier badge: progressive (auto/on-demand) vs command (manual), etc. */
  function tierInfo(gear: GearEntry): { label: string; cls: string } | null {
    const a = (gear.activation || "").toLowerCase()
    switch (a) {
      case "progressive":
        return {
          label: t("dialog.gear.tier.progressive"),
          cls: "bg-sky-50 text-sky-600 dark:bg-sky-950/30 dark:text-sky-400",
        }
      case "command":
        return { label: t("dialog.gear.tier.command"), cls: "bg-surface-weak text-text-weaker" }
      case "auto":
        return {
          label: t("dialog.gear.tier.auto"),
          cls: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/30 dark:text-emerald-400",
        }
      case "global":
        return {
          label: t("dialog.gear.tier.global"),
          cls: "bg-violet-50 text-violet-600 dark:bg-violet-950/30 dark:text-violet-400",
        }
      default:
        return null
    }
  }

  /** The exact local command a skill install will run in the background, or
   * null when the install is pure HTTP (GitHub raw fetch / MCP import). The
   * backend clones non-GitHub skill sources via `git clone --depth 1 <url>.git`
   * (see agent-executor `install_modelscope_skill`); mirror that here so the
   * confirmation dialog shows the real command. */
  function localInstallCommand(gear: GearEntry): string | null {
    if (gear.kind !== "skill") return null
    const url = (gear.download_url ?? "").trim().replace(/\/+$/, "")
    if (!url || url.includes("github.com")) return null
    return `git clone --depth 1 ${url.endsWith(".git") ? url : `${url}.git`}`
  }

  /** Humanize raw transport/backend errors (e.g. "SmartLayer 500: market gear
   * install: 克隆技能仓库失败: ...") into a short actionable message; unknown
   * errors pass through unchanged. */
  function friendlyInstallError(msg: string): string {
    if (
      /SmartLayer 5\d\d/.test(msg) ||
      msg.includes("克隆技能仓库失败") ||
      msg.includes("未能从源码仓库获取技能文件") ||
      msg.includes("执行 git clone 失败") ||
      msg.includes("下载返回状态")
    ) {
      return t("market.installRemoteError")
    }
    return msg
  }

  async function handleInstall(gear: GearEntry) {
    if (isMarketplaceMcp(gear)) {
      setEnvInputs({})
      setAgreed(false)
      setInstallErr(null)
      setPendingGear(gear)
      return
    }
    // Skill installs from non-GitHub sources run a local `git clone`; show the
    // exact command and ask for confirmation before executing anything.
    if (localInstallCommand(gear)) {
      setPendingCmdGear(gear)
      return
    }
    await performInstall(gear)
  }

  async function performInstall(gear: GearEntry) {
    const name = gear.spec
    setInstalling(name)
    setError(null)
    try {
      await gearPost(
        "/gears/install",
        {
          name,
          // Honor the tier the marketplace declared for this entry (e.g.
          // `progressive`/"auto" badges) instead of silently forcing `command`.
          activation: gear.activation || "command",
          downloadUrl: gear.download_url ?? undefined,
          version: gear.version || undefined,
          displayName: gear.name ?? undefined,
        },
        300000,
      )
      setInstalledNames((prev) => new Set([...prev, name]))
      showToast({ variant: "success", title: t("gearStore.installedOk") })
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e)
      // Friendly in-page banner only (rendered in both list and detail views);
      // no duplicate raw toast leaking "SmartLayer 500: ..." internals.
      setError(friendlyInstallError(raw))
    } finally {
      setInstalling(null)
    }
  }

  async function confirmMcpInstall() {
    const gear = pendingGear()
    const cfg = configRes()
    if (!gear || !cfg) return
    const inputs = envInputs()
    const missing = (cfg.required_env ?? []).filter((e) => e.required && !inputs[e.name]?.trim())
    if (missing.length > 0) {
      setInstallErr(t("market.compliance.secretRequiredHint"))
      return
    }
    setInstalling(gear.spec)
    setInstallErr(null)
    try {
      await gearPost("/gears/mcp/import", {
        source: specSource(gear.spec),
        server_id: specServerId(gear.spec),
        display_name: gear.name ?? undefined,
        env: inputs,
      })
      setInstalledNames((prev) => new Set([...prev, gear.spec]))
      showToast({ variant: "success", title: t("gearStore.installedOk") })
      setPendingGear(null)
      setAgreed(false)
      setEnvInputs({})
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      // Inline error inside the compliance dialog is enough; no raw toast.
      setInstallErr(friendlyInstallError(msg))
    } finally {
      setInstalling(null)
    }
  }

  function isInstalled(name: string) {
    return installedNames().has(name)
  }

  /** Installed state: trust the backend's authoritative `installed` flag (so it
   * agrees with Settings → Smart Market) but also keep the optimistic in-session
   * set for instant feedback right after a successful install. */
  function isInstalledGear(gear: GearEntry) {
    return gear.installed || installedNames().has(gear.spec)
  }

  return (
    <>
    <Dialog
      title={t("gearStore.dialog.title")}
      size="large"
      class="relative"
      // Dialog already renders a default close button, so only supply an extra
      // action (the back button) when a gear detail is open. Passing a close
      // button here would duplicate the default one.
      action={
        selectedGear() ? (
          <button
            type="button"
            class="flex size-7 items-center justify-center rounded-md text-16 text-text-base hover:bg-surface-raised-base"
            aria-label={t("common.goBack")}
            onClick={() => setSelectedGear(null)}
          >
            ←
          </button>
        ) : undefined
      }
    >
      <div class="relative flex flex-col h-full min-h-0">
        <Show when={!selectedGear()}>
        {/* Header: search + kind filter chips + refresh */}
        <div class="flex flex-col gap-3 px-5 pt-4 pb-3 border-b border-surface-raised-base shrink-0">
          <TextField
            class="w-full"
            value={searchQuery()}
            onChange={setSearchQuery}
            placeholder={t("gearStore.search")}
            type="text"
          />
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-1 rounded-lg bg-surface-raised-base p-0.5 w-fit">
              <For each={KIND_FILTERS}>
                {(kind) => (
                  <button
                    type="button"
                    class={`px-3 py-1 rounded-md text-12-medium transition-all ${
                      kindFilter() === kind
                        ? "bg-surface-base text-text-strong shadow-sm"
                        : "text-text-weak hover:text-text-base"
                    }`}
                    onClick={() => setKindFilter(kind)}
                  >
                    {t(`gearStore.filter.${kind}`)}
                  </button>
                )}
              </For>
            </div>
            <Button
              size="small"
              variant="secondary"
              disabled={loading()}
              onClick={handleRefresh}
            >
              {t("gearStore.refresh")}
            </Button>
          </div>
        </div>

        {/* Body */}
        <div class="px-5 py-3 flex-1 min-h-0 flex flex-col">
          {/* Disclaimer */}
          <p class="text-11-regular text-text-weaker mb-3">{t("market.disclaimer")}</p>

          {/* Error (closable) */}
          <Show when={error()}>
            <div class="mb-3 flex items-center justify-between gap-2 rounded-lg border-border-critical-base bg-surface-critical-weak px-3 py-2">
              <span class="text-12-regular text-text-on-critical-base">{error()}</span>
              <button
                type="button"
                class="shrink-0 text-12 leading-4 text-text-on-critical-weak hover:text-text-on-critical-base"
                aria-label={t("ui.common.close")}
                onClick={() => setError(null)}
              >
                ✕
              </button>
            </div>
          </Show>

          {/* Load error with retry (closable) */}
          <Show when={!loading() && marketLoadError()}>
            <div class="mb-3 flex items-center justify-between gap-2 rounded-lg border-border-critical-base bg-surface-critical-weak px-3 py-2.5">
              <span class="text-12-regular text-text-on-critical-base">{t("gearStore.fetchError")}{marketLoadError() ? `：${marketLoadError()}` : ""}</span>
              <div class="flex items-center gap-2 shrink-0">
                <Button size="small" variant="secondary" onClick={() => void loadInitial(false)}>
                  {t("common.retry")}
                </Button>
                <button
                  type="button"
                  class="text-12 leading-4 text-text-on-critical-weak hover:text-text-on-critical-base"
                  aria-label={t("ui.common.close")}
                  onClick={() => setMarketLoadError(null)}
                >
                  ✕
                </button>
              </div>
            </div>
          </Show>

          {/* Upstream degraded banner — red (error styling) and closable */}
          <Show when={!loading() && sourceError()}>
            <div class="mb-3 flex items-center justify-between gap-2 rounded-lg border-border-critical-base bg-surface-critical-weak px-3 py-2.5">
              <span class="text-12-regular text-text-on-critical-base">
                {t("market.degraded")}
                {sourceError() ? `：${sourceError()}` : ""}
              </span>
              <div class="flex items-center gap-2 shrink-0">
                <Button size="small" variant="secondary" onClick={() => void loadInitial(true)}>
                  {t("common.retry")}
                </Button>
                <button
                  type="button"
                  class="text-12 leading-4 text-text-on-critical-weak hover:text-text-on-critical-base"
                  aria-label={t("ui.common.close")}
                  onClick={() => setSourceError(null)}
                >
                  ✕
                </button>
              </div>
            </div>
          </Show>

          {/* Loading skeleton */}
          <Show when={loading()}>
            <div class="flex flex-col gap-2">
              <For each={[1, 2, 3, 4]}>
                {() => (
                  <div class="flex items-center gap-3 rounded-xl border border-surface-raised-base bg-surface-base px-3.5 py-3 animate-pulse">
                    <div class="size-9 rounded-lg bg-surface-raised-base shrink-0" />
                    <div class="flex-1 space-y-1.5">
                      <div class="h-3.5 w-1/3 rounded bg-surface-raised-base" />
                      <div class="h-3 w-2/3 rounded bg-surface-raised-base" />
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>

          {/* Empty state — only when there is genuinely no data and no error */}
          <Show when={!loading() && !marketLoadError() && !sourceError() && items().length === 0}>
            <div class="flex flex-col items-center gap-2 py-10 text-center">
              <span class="text-24">📦</span>
              <span class="text-13-regular text-text-weak">{t("gearStore.empty")}</span>
            </div>
          </Show>

          {/* Market list with infinite scroll — shows cached results even while an
              error/degraded banner is visible, so a failed refresh never blanks it */}
          <Show when={!loading() && items().length > 0}>
            <div
              class="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto pr-1 -mr-1 pb-3"
              onScroll={(e) => {
                const el = e.currentTarget as HTMLDivElement
                if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
                  void loadMore()
                }
              }}
            >
              <For each={items()}>
                {(gear) => (
                  <div class="group flex items-center gap-3 rounded-xl border border-surface-raised-base bg-surface-base px-3.5 py-3 transition-colors hover:bg-surface-raised-base/40">
                    {/* Icon */}
                    <div class="flex size-9 items-center justify-center rounded-lg bg-surface-raised-base text-15 shrink-0 select-none">
                      {KIND_ICON[gear.kind] ?? "⚙️"}
                    </div>

                    {/* Info */}
                    <div
                      class="flex flex-col gap-px min-w-0 flex-1 cursor-pointer"
                      onClick={() => setSelectedGear(gear)}
                      title={t("market.openDetail")}
                    >
                      {/* Name row */}
                      <div class="flex items-center gap-1.5 min-w-0">
                        <span class="text-13-medium text-text-strong truncate">{gear.name}</span>
                        <Show when={gear.kind !== "builtin"}>
                          <span
                            class={`shrink-0 rounded-full px-1.5 py-px text-10-medium leading-4 ${KIND_BADGE[gear.kind] ?? KIND_BADGE.native}`}
                          >
                            {t(`gearStore.filter.${gear.kind}`)}
                          </span>
                        </Show>
                        <Show when={tierInfo(gear)}>
                          {(info) => (
                            <span
                              class={`shrink-0 rounded-full px-1.5 py-px text-10-medium leading-4 ${info().cls}`}
                              title={t("dialog.gear.activation.hint")}
                            >
                              {info().label}
                            </span>
                          )}
                        </Show>
                        <Show when={gearDetailUrl(gear)}>
                          <span class="shrink-0 text-10-regular text-text-weaker opacity-0 group-hover:opacity-100 transition-opacity">↗</span>
                        </Show>
                      </div>
                      {/* Description */}
                      <Show when={gear.description}>
                        <span class="text-12-regular text-text-weak line-clamp-1">
                          {gear.description}
                        </span>
                      </Show>
                      {/* Meta row */}
                      <div class="flex items-center gap-1.5 text-11-regular text-text-weaker">
                        <Show when={gear.author}>
                          <span class="truncate max-w-[140px]">{gear.author}</span>
                        </Show>
                        <Show when={gear.version}>
                          <span class="shrink-0">v{gear.version}</span>
                        </Show>
                        <Show when={gear.tags?.length > 0}>
                          <span class="shrink-0 text-text-weaker/60">·</span>
                          <span class="truncate">{gear.tags.slice(0, 3).join(" · ")}</span>
                        </Show>
                      </div>
                    </div>

                    {/* Install button — fixed-width wrapper keeps「安装/安装中/已安装」
                        identical in size so the right edge stays aligned */}
                    <div class="w-[76px] shrink-0">
                      <Button
                        class="w-full"
                        size="small"
                        variant={isInstalledGear(gear) ? "secondary" : "primary"}
                        disabled={
                          installing() === gear.spec ||
                          isInstalledGear(gear) ||
                          !canInstall(gear)
                        }
                        onClick={() => handleInstall(gear)}
                      >
                        {isInstalledGear(gear)
                          ? t("gearStore.installed")
                          : installing() === gear.spec
                            ? t("gearStore.installing")
                            : canInstall(gear)
                              ? t("gearStore.install")
                              : t("gearStore.unsupported")}
                      </Button>
                    </div>
                  </div>
                )}
              </For>

              {/* Infinite-scroll affordances */}
              <Show when={loadingMore()}>
                <div class="flex items-center justify-center gap-2 py-3 text-11-regular text-text-weaker">
                  <span class="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  {t("market.loadingMore")}
                </div>
              </Show>
              {/* Next-page failure: small inline hint with retry, never the top banner */}
              <Show when={!loadingMore() && loadMoreError()}>
                <div class="flex items-center justify-center gap-2 py-2.5 text-11-regular text-text-on-critical-base">
                  <span>{t("market.loadMoreFailed")}</span>
                  <button
                    type="button"
                    class="underline hover:opacity-80"
                    onClick={() => {
                      setLoadMoreError(null)
                      void loadMore()
                    }}
                  >
                    {t("common.retry")}
                  </button>
                  <button
                    type="button"
                    class="text-text-on-critical-weak hover:text-text-on-critical-base"
                    aria-label={t("ui.common.close")}
                    onClick={() => setLoadMoreError(null)}
                  >
                    ✕
                  </button>
                </div>
              </Show>
              <Show when={!hasMore() && items().length > 0}>
                <div class="py-3 text-center text-11-regular text-text-weaker">
                  {t("market.noMore")}
                </div>
              </Show>
            </div>
          </Show>

          {/* Attribution / compliance footer */}
          <p class="mt-3 border-t border-surface-raised-base pt-2 text-11-regular text-text-weaker">
            {t("gearStore.sources")}
          </p>
        </div>
        </Show>

        {/* In-app detail view, shown when a market card is clicked. */}
        <Show when={selectedGear()}>
          {(() => {
            const gear = selectedGear()!
            return (
              <div class="flex flex-col h-full min-h-0">
                <div class="flex items-center gap-2 px-5 pt-4 pb-3 border-b border-surface-raised-base shrink-0">
                  <button
                    type="button"
                    class="flex size-7 items-center justify-center rounded-md text-16 text-text-base hover:bg-surface-raised-base"
                    onClick={() => setSelectedGear(null)}
                    aria-label="返回"
                  >
                    ←
                  </button>
                  <span class="text-14-medium text-text-strong">智械详情</span>
                </div>

                <div class="px-5 py-4 flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto">
                  <div class="flex items-start gap-3">
                    <Show when={detailRes()?.logo_url} fallback={
                      <div class="flex size-11 items-center justify-center rounded-lg bg-surface-raised-base text-20 shrink-0 select-none">
                        {KIND_ICON[gear.kind] ?? "⚙️"}
                      </div>
                    }>
                      <img src={detailRes()!.logo_url!} class="size-11 rounded-lg object-cover shrink-0 bg-surface-raised-base" alt={gear.name} />
                    </Show>
                    <div class="flex flex-col gap-1 min-w-0 flex-1">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-15-medium text-text-strong">{gear.name}</span>
                        <span class={`rounded-full px-1.5 py-px text-10-medium leading-4 ${KIND_BADGE[gear.kind] ?? KIND_BADGE.native}`}>
                          {t(`gearStore.filter.${gear.kind}`)}
                        </span>
                      </div>
                      <Show when={gear.spec}>
                        <span class="text-11-regular text-text-weaker font-mono truncate">{specServerId(gear.spec)}</span>
                      </Show>
                      <div class="flex items-center gap-2 text-11-regular text-text-weaker flex-wrap">
                        <Show when={gear.author}><span>{gear.author}</span></Show>
                        <Show when={gear.version}><span>v{gear.version}</span></Show>
                      </div>
                    </div>
                  </div>

                  <Show
                    when={detailRes()?.readme ?? detailRes()?.description ?? gear.description}
                    fallback={
                      <div class="text-13-regular text-text-weaker rounded-lg border border-dashed border-surface-raised-base px-3 py-4">
                        {t("market.detail.noDescription")}
                        <Show when={detailRes()?.source_url}>
                          {" "}
                          <a class="text-accent hover:underline" href={detailRes()!.source_url!} target="_blank" rel="noopener noreferrer">
                            {t("market.detail.viewSource")}
                          </a>
                        </Show>
                      </div>
                    }
                  >
                    {(content) => (
                      <div class="text-13-regular text-text-base [&_a]:text-accent [&_a]:underline [&_pre]:bg-surface-raised-base [&_pre]:p-2 [&_pre]:rounded [&_code]:bg-surface-raised-base [&_code]:rounded [&_code]:px-1">
                        <Markdown text={content()} />
                      </div>
                    )}
                  </Show>

                  <Show when={gear.tags?.length}>
                    <div class="flex flex-wrap gap-1">
                      <For each={gear.tags}>
                        {(tag) => (
                          <span class="text-11-regular text-text-weaker bg-surface-raised-base rounded px-1.5 py-0.5">{tag}</span>
                        )}
                      </For>
                    </div>
                  </Show>

                  <Show when={detailRes()?.categories?.length}>
                    <div class="flex flex-wrap gap-1">
                      <For each={detailRes()!.categories!}>
                        {(c) => (
                          <span class="text-11-regular text-text-weaker border border-surface-raised-base rounded px-1.5 py-0.5">{c}</span>
                        )}
                      </For>
                    </div>
                  </Show>

                  {/* Install error (visible when installing from the detail view) */}
                  <Show when={error()}>
                    <div class="flex items-center justify-between gap-2 rounded-lg border-border-critical-base bg-surface-critical-weak px-3 py-2">
                      <span class="text-12-regular text-text-on-critical-base">{error()}</span>
                      <button
                        type="button"
                        class="shrink-0 text-12 leading-4 text-text-on-critical-weak hover:text-text-on-critical-base"
                        aria-label={t("ui.common.close")}
                        onClick={() => setError(null)}
                      >
                        ✕
                      </button>
                    </div>
                  </Show>

                  <div class="flex items-center gap-2">
                    <Button
                      class="min-w-[76px]"
                      size="small"
                      variant={isInstalledGear(gear) ? "secondary" : "primary"}
                      disabled={
                        installing() === gear.spec ||
                        isInstalledGear(gear) ||
                        !canInstall(gear)
                      }
                      onClick={(e: MouseEvent) => {
                        e.stopPropagation()
                        handleInstall(gear)
                      }}
                    >
                      {isInstalledGear(gear)
                        ? t("gearStore.installed")
                        : installing() === gear.spec
                          ? t("gearStore.installing")
                          : canInstall(gear)
                            ? t("gearStore.install")
                            : t("gearStore.unsupported")}
                    </Button>
                    <Show when={gearDetailUrl(gear)}>
                      <Button
                        size="small"
                        variant="secondary"
                        onClick={(e: MouseEvent) => {
                          e.stopPropagation()
                          const url = gearDetailUrl(gear)
                          if (url) platform.openLink(url)
                        }}
                      >
                        {gearDetailUrl(gear)?.includes("modelscope.cn")
                          ? "在 ModelScope 查看 ↗"
                          : "查看来源 ↗"}
                      </Button>
                    </Show>
                  </div>

                  <Show when={gear.files?.length}>
                    <div class="flex flex-col gap-1">
                      <span class="text-11-regular text-text-weaker">文件</span>
                      <For each={gear.files}>
                        {(f) => <span class="text-12-regular text-text-base font-mono truncate">{f}</span>}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>
            )
          })()}
        </Show>
      </div>

      {/* Service confirmation (compliance) rendered as an inline overlay so it
          sits above the market list without spawning a second Kobalte layer.
          A second top-level Dialog would share the market dialog's Kobalte
          Root; clicking the list behind it triggered an outside-dismiss that
          closed both dialogs at once. */}
      <Show when={pendingGear()}>
        <div
          class="absolute inset-0 z-30 flex items-stretch justify-center"
          style={{ "background-color": "hsl(from var(--background-base) h s l / 0.35)", "backdrop-filter": "blur(8px)", "-webkit-backdrop-filter": "blur(8px)" }}
          onClick={() => {
            setPendingGear(null)
            setAgreed(false)
            setEnvInputs({})
          }}
        >
          <div
            class="my-auto mx-4 flex max-h-full w-full max-w-[520px] flex-col overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--border-weak-base)] bg-[var(--surface-raised-stronger-non-alpha)] shadow-[var(--shadow-lg-border-base)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="flex items-center justify-between border-b border-surface-raised-base px-4 py-3">
              <span class="text-14-medium text-text-strong">{t("market.compliance.title")}</span>
              <IconButton
                icon="close"
                variant="ghost"
                aria-label={t("ui.common.close")}
                onClick={() => {
                  setPendingGear(null)
                  setAgreed(false)
                  setEnvInputs({})
                }}
              />
            </div>
            <div class="flex flex-col gap-3 overflow-y-auto p-4">
              <span class="text-11-regular text-text-weaker">{t("market.compliance.sourceHint")}</span>
              <Button
                size="small"
                variant="secondary"
                class="self-start"
                disabled={configRes.loading}
                onClick={() => {
                  setConfigRefresh(true)
                  configActions.refetch()
                }}
              >
                {t("market.compliance.revalidate")}
              </Button>
              <Show when={configRes.loading}>
                <div class="flex items-center justify-center gap-2 py-4 text-12-regular text-text-weaker">
                  <span class="size-4 animate-spin inline-block rounded-full border-2 border-current border-t-transparent" />
                  {t("market.compliance.loading")}
                </div>
              </Show>
              <Show when={!configRes.loading && configLoadError()}>
                <div class="rounded-lg border-border-critical-base bg-surface-critical-weak px-3 py-2 text-12-regular text-text-on-critical-base">
                  {t("market.compliance.fetchError", { msg: configLoadError() ?? "" })}
                </div>
              </Show>
              <Show when={!configRes.loading && !configLoadError() && configRes()}>
                {(cfg) => (
                  <>
                    <div class="space-y-1.5 rounded-lg border border-surface-raised-base bg-surface-raised-base/30 p-3.5 text-12-regular text-text-base">
                      <div class="flex items-center gap-2">
                        <span class="size-1.5 shrink-0 rounded-full bg-surface-warning-strong" />
                        {t("market.compliance.thirdParty")}
                      </div>
                      <div class="flex items-center gap-2">
                        <span class="size-1.5 shrink-0 rounded-full bg-surface-warning-strong" />
                        {t("market.compliance.asIs")}
                      </div>
                      <div class="flex items-center gap-2">
                        <span class="size-1.5 shrink-0 rounded-full bg-surface-warning-strong" />
                        {cfg().kind === "sse"
                          ? t("market.compliance.transportSse")
                          : t("market.compliance.transportStdio")}
                      </div>
                      <Show when={cfg().kind !== "sse" && cfg().command}>
                        <div class="flex items-start gap-2">
                          <span class="mt-1.5 size-1.5 shrink-0 rounded-full bg-surface-warning-strong" />
                          <span class="min-w-0">
                            {t("market.compliance.localCommand")}
                            <code class="break-all font-mono text-11-regular">
                              {[cfg().command, ...(cfg().args ?? [])].join(" ")}
                            </code>
                          </span>
                        </div>
                      </Show>
                      <Show when={cfg().source_url}>
                        <div class="flex items-center gap-2">
                          <span class="size-1.5 shrink-0 rounded-full bg-surface-warning-strong" />
                          <span class="truncate">{t("market.compliance.source")}{cfg().source_url}</span>
                        </div>
                      </Show>
                      <div class="flex items-center gap-2">
                        <span class="size-1.5 shrink-0 rounded-full bg-surface-warning-strong" />
                        {t("market.compliance.license")}
                        {cfg().license ? cfg().license : t("market.compliance.licenseUnknown")}
                      </div>
                    </div>

                    <Show when={(cfg().required_env ?? []).length > 0}>
                      <div class="space-y-2.5">
                        <div class="text-12-medium text-text-base">{t("market.compliance.secrets")}</div>
                        <For each={cfg().required_env ?? []}>
                          {(ev) => (
                            <div class="flex flex-col gap-1">
                              <div class="flex items-center gap-1.5 text-12-regular text-text-base">
                                <span class="font-mono text-11-medium">{ev.name}</span>
                                <span
                                  class={`text-10-medium rounded-full px-1.5 py-px ${
                                    ev.required ? "bg-surface-critical-weak text-text-on-critical-base" : "bg-surface-weak text-text-weaker"
                                  }`}
                                >
                                  {ev.required
                                    ? t("market.compliance.secretRequired")
                                    : t("market.compliance.secretOptional")}
                                </span>
                              </div>
                              <Show when={ev.description}>
                                <div class="text-11-regular text-text-weaker">{ev.description}</div>
                              </Show>
                              <TextField
                                class="w-full"
                                value={envInputs()[ev.name] ?? ""}
                                onChange={(v: string) => setEnvInputs({ ...envInputs(), [ev.name]: v })}
                                placeholder={ev.name}
                              />
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>

                    <label class="flex cursor-pointer items-center gap-2.5 rounded-lg border border-surface-raised-base p-3 text-12-regular text-text-base transition-colors hover:bg-surface-raised-base/30">
                      <input
                        type="checkbox"
                        class="size-4 shrink-0 accent-current"
                        checked={agreed()}
                        onChange={(e: Event) =>
                          setAgreed((e.currentTarget as HTMLInputElement).checked)
                        }
                      />
                      <span>{t("market.compliance.confirm")}</span>
                    </label>

                    <Show when={installErr()}>
                      <div class="text-12-regular text-text-on-critical-base">{installErr()}</div>
                    </Show>

                    <div class="flex justify-end gap-2 pt-1">
                      <Button
                        size="small"
                        variant="secondary"
                        onClick={() => {
                          setPendingGear(null)
                          setAgreed(false)
                          setEnvInputs({})
                        }}
                      >
                        {t("settings.gear.cancel")}
                      </Button>
                      <Button
                        size="small"
                        variant="primary"
                        disabled={!agreed() || installing() === pendingGear()?.spec}
                        onClick={confirmMcpInstall}
                      >
                        {installing() === pendingGear()?.spec
                          ? t("gearStore.installing")
                          : t("market.compliance.install")}
                      </Button>
                    </div>
                  </>
                )}
              </Show>
            </div>
          </div>
        </div>
      </Show>

      {/* Local-command confirmation rendered inline as an overlay above the list. */}
      <Show when={pendingCmdGear()}>
        <div
          class="absolute inset-0 z-30 flex items-stretch justify-center"
          style={{ "background-color": "hsl(from var(--background-base) h s l / 0.35)", "backdrop-filter": "blur(8px)", "-webkit-backdrop-filter": "blur(8px)" }}
          onClick={() => {
            setPendingCmdGear(null)
            setSelectedGear(null)
          }}
        >
          <div
            class="my-auto mx-4 flex max-h-full w-full max-w-[520px] flex-col overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--border-weak-base)] bg-[var(--surface-raised-stronger-non-alpha)] shadow-[var(--shadow-lg-border-base)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="flex items-center justify-between border-b border-surface-raised-base px-4 py-3">
              <span class="text-14-medium text-text-strong">{t("market.cmdConfirm.title")}</span>
              <IconButton
                icon="close"
                variant="ghost"
                aria-label={t("ui.common.close")}
                onClick={() => {
                  setPendingCmdGear(null)
                  setSelectedGear(null)
                }}
              />
            </div>
            <div class="flex flex-col gap-3 overflow-y-auto p-4">
              <p class="text-12-regular text-text-base">
                {t("market.cmdConfirm.desc", { name: pendingCmdGear()!.name })}
              </p>
              <pre class="break-all whitespace-pre-wrap rounded-lg bg-surface-raised-base px-3 py-2 font-mono text-11-regular text-text-strong">
                {localInstallCommand(pendingCmdGear()!) ?? ""}
              </pre>
              <p class="text-11-regular text-text-weaker">{t("market.cmdConfirm.note")}</p>
              <div class="flex justify-end gap-2 pt-1">
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() => {
                    setPendingCmdGear(null)
                    setSelectedGear(null)
                  }}
                >
                  {t("settings.gear.cancel")}
                </Button>
                <Button
                  size="small"
                  variant="primary"
                  onClick={() => {
                    const gear = pendingCmdGear()
                    setPendingCmdGear(null)
                    if (gear) void performInstall(gear)
                  }}
                >
                  {t("market.cmdConfirm.run")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </Dialog>
    </>
  )
}
