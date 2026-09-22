import { createEffect, createMemo, createSignal, Show, For, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { IconButton } from "@duoduo-ai/ui/icon-button"
import { Icon } from "@duoduo-ai/ui/icon"
import { Button } from "@duoduo-ai/ui/button"
import { Tooltip, TooltipKeybind } from "@duoduo-ai/ui/tooltip"
import { useTheme } from "@duoduo-ai/ui/theme/context"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { getFilename } from "@duoduo-ai/shared/util/path"
import { decode64 } from "@/utils/base64"
import { SmartLayerStatusIndicator } from "@/addons/smart-layer/status-indicator"
import { useSmartLayer } from "@/addons/smart-layer/context"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { UpdateStatusIndicator } from "@/components/update-status-indicator"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { showToast } from "@duoduo-ai/ui/toast"
import { Spinner } from "@duoduo-ai/ui/spinner"
import { applyPath, backPath, forwardPath } from "./titlebar-history"
import { TitlebarMenu } from "./titlebar-menu"
import { syncRemote, remoteSyncStatus } from "@/utils/remote-resync"

// ─── Window Controls (Windows-only) ────────────────────────────────
// Custom minimize/maximize/close buttons that always render.
// Replaces tauri-plugin-decorum overlay which can silently fail.

function WindowControls() {
  // Use the __TAURI__ global object (injected by Tauri at runtime) instead of
  // dynamic import — consistent with drag/maximize logic elsewhere in this file.
  // Dynamic import of @tauri-apps/api/window can fail silently because the
  // module namespace object structure may not expose getCurrentWindow as expected.
  // NOTE: We call currentDesktopWindow() on each action (not at init time) because
  // __TAURI__ may not be available when the component first renders.

  let snapTimer: ReturnType<typeof setTimeout> | undefined

  const handleMaximizeMouseEnter = () => {
    snapTimer = setTimeout(() => {
      // @ts-ignore — Tauri decorum command
      window.__TAURI__?.core?.invoke?.("plugin:decorum|show_snap_overlay")?.catch?.(() => {})
    }, 620) // 620ms matches decorum's original implementation
  }

  const handleMaximizeMouseLeave = () => {
    if (snapTimer) {
      clearTimeout(snapTimer)
      snapTimer = undefined
    }
  }

  const minimize = () => {
    currentDesktopWindow()
      ?.minimize?.()
      .catch(() => undefined)
  }

  const toggleMaximize = () => {
    currentDesktopWindow()
      ?.toggleMaximize?.()
      .catch(() => undefined)
  }

  const close = () => {
    currentDesktopWindow()
      ?.close?.()
      .catch(() => undefined)
  }

  return (
    <div data-slot="window-controls-buttons" class="flex flex-row items-center h-10">
      <button
        data-slot="window-control-minimize"
        class="flex items-center justify-center w-[46px] h-full text-text-weakest hover:text-text-base hover:bg-surface-base-active transition-colors"
        onClick={minimize}
        aria-label="Minimize"
      >
        <Icon name="dash" size="small" />
      </button>
      <button
        data-slot="window-control-maximize"
        class="flex items-center justify-center w-[46px] h-full text-text-weakest hover:text-text-base hover:bg-surface-base-active transition-colors"
        onClick={toggleMaximize}
        onMouseEnter={handleMaximizeMouseEnter}
        onMouseLeave={handleMaximizeMouseLeave}
        aria-label="Maximize"
      >
        <Icon name="expand" size="small" />
      </button>
      <button
        data-slot="window-control-close"
        class="flex items-center justify-center w-[46px] h-full text-text-weakest hover:text-text-base hover:bg-icon-critical-base/10 transition-colors"
        onClick={close}
        aria-label="Close"
      >
        <Icon name="close" size="small" />
      </button>
    </div>
  )
}

type TauriDesktopWindow = {
  startDragging?: () => Promise<void>
  minimize?: () => Promise<void>
  toggleMaximize?: () => Promise<void>
  close?: () => Promise<void>
}

type TauriThemeWindow = {
  setTheme?: (theme?: "light" | "dark" | null) => Promise<void>
}

type TauriApi = {
  window?: {
    getCurrentWindow?: () => TauriDesktopWindow
  }
  webviewWindow?: {
    getCurrentWebviewWindow?: () => TauriThemeWindow
  }
}

const tauriApi = () => (window as unknown as { __TAURI__?: TauriApi }).__TAURI__
const currentDesktopWindow = () => tauriApi()?.window?.getCurrentWindow?.()
const currentThemeWindow = () => tauriApi()?.webviewWindow?.getCurrentWebviewWindow?.()

/// Circular progress indicator shown to the right of the project name in the
/// title bar while the code graph is being indexed. Hovering reveals which
/// project is indexing and the file progress (done/total). The indicator is
/// purely informational — it never blocks or disables user input.
function KGIndexIndicator(props: { projectName: () => string }) {
  const sl = useSmartLayer()
  const language = useLanguage()

  createEffect(() => {
    console.info("[kg] KGIndexIndicator: isKGIndexing changed", {
      isKGIndexing: sl.isKGIndexing,
      isKGReady: sl.isKGReady,
      progress: sl.kgProgress?.progress,
    })
  })

  const progress = () => sl.kgProgress?.progress ?? 0
  const done = () => sl.kgProgress?.filesDone ?? 0
  const total = () => sl.kgProgress?.filesTotal ?? 0

  const radius = 7
  const circumference = 2 * Math.PI * radius
  const dashOffset = () => circumference * (1 - progress() / 100)

  const tooltip = () =>
    language.t("titlebar.kg.indexing", {
      project: props.projectName() || language.t("titlebar.kg.unknownProject"),
      done: done(),
      total: total(),
    })

  return (
    <Tooltip placement="bottom" value={tooltip()}>
      <div
        class="pointer-events-auto flex items-center justify-center ml-2"
        aria-label={tooltip()}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          class="block"
          data-component="progress-circle"
        >
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke="var(--border-weak-base)"
            stroke-width="2"
            class="track"
          />
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke="var(--border-active)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-dasharray={String(circumference)}
            stroke-dashoffset={String(dashOffset())}
            transform="rotate(-90 8 8)"
            class="range"
            style={{ transition: "stroke-dashoffset 0.3s ease" }}
          />
        </svg>
      </div>
    </Tooltip>
  )
}

/// LSP startup indicator shown next to the KG indicator in the title bar.
///
/// The Titlebar renders OUTSIDE the per-directory SyncProvider/SDKProvider
/// (those live inside the /:dir route), so this reads the per-directory store
/// through useGlobalSync + useParams — the same access pattern the KG poll in
/// addons/smart-layer/context.tsx uses (decode64(params.dir)).
///
/// No polling of its own: bootstrap's `POST /lsp/touch` sets `lsp_warming=true`
/// (synchronously, before any spawn-completion event can arrive), and every
/// terminal state arrives via the backend `lsp.updated` SSE event → `loadLsp()`
/// which clears the flag when no server is in the error state. The backend
/// publishes that event on BOTH spawn success and spawn failure, so the
/// indicator cannot get stuck in the spinner state.
///
/// States:
///   lsp_warming && no error entry  → spinner, tooltip "starting"
///   lsp_warming && error entries   → red dot, tooltip lists failed servers,
///                                    click retries every failed server
///   otherwise                      → hidden
function LSPStatusIndicator() {
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const params = useParams()

  const active = createMemo(() => {
    const directory = decode64(params.dir)
    if (!directory) return undefined
    // bootstrap:false — a lightweight store only; never force a project boot
    return globalSync.child(directory, { bootstrap: false })
  })

  const shown = () => !!active() && active()![0].lsp_warming
  const failed = () => (active() ? active()![0].lsp.filter((s) => s.status === "error") : [])

  const tooltip = () =>
    failed().length > 0
      ? language.t("titlebar.lsp.failed", { servers: failed().map((s) => s.name).join(", ") })
      : language.t("titlebar.lsp.starting")

  // Retry every failed server, then fall back to warming (spinner) until the
  // next lsp.updated event reports the terminal state. Mirrors the retry
  // action in the status popover (status-popover-body.tsx).
  const retry = () => {
    const cur = active()
    const directory = decode64(params.dir)
    if (!cur || !directory) return
    const client = globalSDK.createClient({ directory, throwOnError: false })
    for (const item of failed()) {
      void (client.lsp as unknown as { client: { post: (req: unknown) => Promise<unknown> } })
        .client.post({ url: "/lsp/retry", body: { root: item.root, id: item.id } })
        .catch(() => {})
    }
    cur[1]("lsp_ready", false)
    cur[1]("lsp_warming", true)
  }

  return (
    <Show when={shown()}>
      <Tooltip placement="bottom" value={tooltip()}>
        <Show
          when={failed().length > 0}
          fallback={
            <div class="pointer-events-auto flex items-center justify-center ml-2" aria-label={tooltip()}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                class="block animate-spin"
                style={{ "animation-duration": "1.2s" }}
                data-component="lsp-starting-spinner"
              >
                <circle
                  cx="8"
                  cy="8"
                  r="7"
                  fill="none"
                  stroke="var(--border-active)"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-dasharray="10 34"
                />
              </svg>
            </div>
          }
        >
          <button
            type="button"
            class="pointer-events-auto flex items-center justify-center ml-2 cursor-pointer group/lsp-retry"
            aria-label={tooltip()}
            onClick={retry}
          >
            <span
              class="block h-2 w-2 rounded-full bg-icon-critical-base"
              data-component="lsp-failed-dot"
            />
          </button>
        </Show>
      </Tooltip>
    </Show>
  )
}

/// Top-bar sync controls for an already-connected SSH (Plan C) remote project.
/// Renders ONLY when the current directory's project ID is a remote project
/// (`remote:` prefix). Exposes Pull / Push so they are reachable even with no
/// file tab open. Conflict resolution mirrors the file-tab behavior: a 3-choice
/// dialog (local-over-remote / remote-over-local / cancel).
function RemoteSyncControls() {
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const params = useParams()

  const projectID = createMemo(() => {
    const directory = decode64(params.dir)
    if (!directory) return undefined
    const child = globalSync.child(directory, { bootstrap: false })
    const id = child[0].project
    if (!id || !id.startsWith("remote:")) return undefined
    return id
  })

  const isRemote = () => projectID() !== undefined
  // Tooltip is static when idle, but during a sync the disabled button should
  // say what is happening and in which direction.
  const syncTip = (dir: "pull" | "push") =>
    remoteSyncStatus() === dir
      ? language.t(dir === "pull" ? "remote.pulling" : "remote.pushing")
      : language.t(dir === "pull" ? "remote.pull" : "remote.push")
  // `directory` must stay reactive. This component is mounted once for the whole
  // `/:dir` route and is NOT remounted when the directory changes, so a plain
  // snapshot would push/pull whichever project was open at mount time.
  const syncSDK = {
    get directory() {
      return decode64(params.dir) ?? ""
    },
    createClient: globalSDK.createClient,
  }

  return (
    <Show when={isRemote()}>
      <div class="flex items-center gap-1 shrink-0 px-1">
        <Tooltip placement="bottom" value={syncTip("pull")}>
          <Button
            variant="ghost"
            class="titlebar-icon w-8 h-6 p-0 box-border"
            disabled={remoteSyncStatus() !== undefined}
            aria-label={syncTip("pull")}
            onClick={() => void syncRemote("pull", { sdk: syncSDK, language, globalSync, dialog })}
          >
            <Show when={remoteSyncStatus() === "pull"} fallback={<Icon name="arrow-down-to-line" size="small" />}>
              <Spinner class="size-4" style={{ color: "var(--icon-interactive-base)" }} />
            </Show>
          </Button>
        </Tooltip>
        <Tooltip placement="bottom" value={syncTip("push")}>
          <Button
            variant="ghost"
            class="titlebar-icon w-8 h-6 p-0 box-border"
            disabled={remoteSyncStatus() !== undefined}
            aria-label={syncTip("push")}
            onClick={() => void syncRemote("push", { sdk: syncSDK, language, globalSync, dialog })}
          >
            <Show when={remoteSyncStatus() === "push"} fallback={<Icon name="arrow-up" size="small" />}>
              <Spinner class="size-4" style={{ color: "var(--icon-interactive-base)" }} />
            </Show>
          </Button>
        </Tooltip>
      </div>
    </Show>
  )
}

export function Titlebar() {
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()
  const theme = useTheme()
  const sl = useSmartLayer()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()

  // Current project name (mirrors session-header) for the indexing indicator.
  const indexingProjectName = createMemo(() => {
    const directory = decode64(params.dir) ?? ""
    if (directory) {
      const p = layout.projects
        .list()
        .find((x) => x.worktree === directory || x.sandboxes?.includes(directory))
      if (p) return p.name || getFilename(p.worktree)
      return getFilename(directory)
    }
    const p = layout.projects.list()[0]
    return p ? p.name || getFilename(p.worktree) : ""
  })

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  const windows = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const web = createMemo(() => platform.platform === "web")
  const zoom = () => platform.webviewZoom?.() ?? 1
  const minHeight = () => (mac() ? `${40 / zoom()}px` : undefined)

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`

  createEffect(() => {
    const current = path()

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  const canBack = createMemo(() => history.index > 0)
  const canForward = createMemo(() => history.index < history.stack.length - 1)
  const hasProjects = createMemo(() => layout.projects.list().length > 0)
  const nav = createMemo(() => settings.general.showNavigation())

  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  command.register(() => [
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  const getWin = () => {
    if (platform.platform !== "desktop") return
    return currentDesktopWindow()
  }

  createEffect(() => {
    if (platform.platform !== "desktop") return

    const scheme = theme.colorScheme()
    const value = scheme === "system" ? null : scheme

    const win = currentThemeWindow()
    if (!win?.setTheme) return

    void win.setTheme(value).catch(() => undefined)
  })

  const interactive = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false

    const selector =
      "button, a, input, textarea, select, option, [role='button'], [role='menuitem'], [contenteditable='true'], [contenteditable='']"

    return !!target.closest(selector)
  }

  const drag = (e: MouseEvent) => {
    if (platform.platform !== "desktop") return
    if (e.buttons !== 1) return
    if (interactive(e.target)) return

    const win = getWin()
    if (!win?.startDragging) return

    e.preventDefault()
    void win.startDragging().catch(() => undefined)
  }

  const maximize = (e: MouseEvent) => {
    if (platform.platform !== "desktop") return
    if (interactive(e.target)) return

    const win = getWin()
    if (!win?.toggleMaximize) return

    e.preventDefault()
    void win.toggleMaximize().catch(() => undefined)
  }

  return (
    <header
      class="h-10 shrink-0 bg-background-base relative grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center"
      style={{ "min-height": minHeight() }}
      data-tauri-drag-region
      onMouseDown={drag}
      onDblClick={maximize}
    >
      <div
        classList={{
          "flex items-center min-w-0": true,
          "pl-2": !mac(),
        }}
      >
        <Show when={mac()}>
          <div class="h-full shrink-0" style={{ width: `${72 / zoom()}px` }} />
          <div class="w-10 shrink-0 flex items-center justify-center xl:hidden">
            <IconButton
              icon="menu"
              variant="ghost"
              class="titlebar-icon rounded-md"
              // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
              onClick={layout.mobileSidebar.toggle}
              aria-label={language.t("sidebar.menu.toggle")}
              aria-expanded={layout.mobileSidebar.opened()}
            />
          </div>
        </Show>
        <Show when={!mac()}>
          <div class="w-[48px] shrink-0 flex items-center justify-center xl:hidden">
            <IconButton
              icon="menu"
              variant="ghost"
              class="titlebar-icon rounded-md"
              // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
              onClick={layout.mobileSidebar.toggle}
              aria-label={language.t("sidebar.menu.toggle")}
              aria-expanded={layout.mobileSidebar.opened()}
            />
          </div>
        </Show>
        <div class="flex items-center gap-1 shrink-0">
          <TooltipKeybind
            class={web() ? "hidden xl:flex shrink-0 ml-14" : "hidden xl:flex shrink-0 ml-2"}
            placement="bottom"
            title={language.t("command.sidebar.toggle")}
            keybind={command.keybind("sidebar.toggle")}
          >
            <Button
              variant="ghost"
              class="group/sidebar-toggle titlebar-icon w-8 h-6 p-0 box-border"
              // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
              onClick={layout.sidebar.toggle}
              aria-label={language.t("command.sidebar.toggle")}
              aria-expanded={layout.sidebar.opened()}
            >
              <Icon size="small" name={layout.sidebar.opened() ? "sidebar-active" : "sidebar"} />
            </Button>
          </TooltipKeybind>
          <div class="hidden xl:flex items-center shrink-0">
            <TitlebarMenu />
            <div
              class="flex items-center shrink-0"
              classList={{
                "duration-180 ease-out": !layout.sidebar.opened(),
                "duration-180 ease-in": layout.sidebar.opened(),
              }}
            >
              <Show when={hasProjects() && nav()}>
                <div class="flex items-center gap-0 transition-transform">
                  <Tooltip placement="bottom" value={language.t("common.goBack")} openDelay={2000}>
                    <Button
                      variant="ghost"
                      icon="chevron-left"
                      class="titlebar-icon w-6 h-6 p-0 box-border"
                      disabled={!canBack()}
                      onClick={back}
                      aria-label={language.t("common.goBack")}
                    />
                  </Tooltip>
                  <Tooltip placement="bottom" value={language.t("common.goForward")} openDelay={2000}>
                    <Button
                      variant="ghost"
                      icon="chevron-right"
                      class="titlebar-icon w-6 h-6 p-0 box-border"
                      disabled={!canForward()}
                      onClick={forward}
                      aria-label={language.t("common.goForward")}
                    />
                  </Tooltip>
                </div>
              </Show>
              <div id="duoduo-titlebar-left" class="flex items-center gap-3 min-w-0 px-2" />
              {import.meta.env.VITE_DUODUO_CHANNEL && ["beta", "dev"].includes(import.meta.env.VITE_DUODUO_CHANNEL) && (
                <div class="bg-icon-interactive-base text-text-on-brand-base font-medium px-2 rounded-sm uppercase font-mono">
                  {import.meta.env.VITE_DUODUO_CHANNEL.toUpperCase()}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div class="min-w-0 flex items-center justify-center pointer-events-none">
        <div id="duoduo-titlebar-center" class="pointer-events-auto min-w-0 flex justify-center w-fit max-w-full" />
        <Show when={sl.isKGIndexing}>
          <KGIndexIndicator projectName={indexingProjectName} />
        </Show>
        <LSPStatusIndicator />
      </div>

      <div
        classList={{
          "flex items-center min-w-0 justify-end": true,
          "pr-2": !windows(),
        }}
        data-tauri-drag-region
        onMouseDown={drag}
      >
        <TooltipKeybind
          placement="bottom"
          title={language.t("command.project.open")}
          keybind={command.keybind("project.open")}
        >
          <Button
            variant="ghost"
            class="titlebar-icon w-8 h-6 p-0 box-border"
            onClick={() => command.trigger("project.open")}
            aria-label={language.t("command.project.open")}
          >
            <Icon size="small" name="folder-add-left" />
          </Button>
        </TooltipKeybind>
        <SmartLayerStatusIndicator />
        <UpdateStatusIndicator />
        <RemoteSyncControls />
        <div id="duoduo-titlebar-right" class="flex items-center gap-1 shrink-0 justify-end" />
        <Show when={windows()}>
          <div data-slot="window-controls" class="flex flex-row shrink-0">
            <Show when={!tauriApi()} fallback={<WindowControls />}>
              <div class="w-36 shrink-0" />
            </Show>
          </div>
        </Show>
      </div>
    </header>
  )
}
