// @refresh reload

import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { type Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { handleNotificationClick } from "@/utils/notification-click"
import { logFrontendError, patchConsoleForLogging, getFrontendErrors } from "@/utils/frontend-logger"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"
import { createSignal } from "solid-js"
import { APP_DOMAIN, APP_HOST } from "@/config/domains"
import { trace } from "@/utils/trace"
import { flushCrashTrace } from "@/utils/frontend-logger"

// [TRACE] 临时诊断：主线程阻塞心跳检测。定位「打开项目卡死」。定位后删除。
// 每 100ms 打一次点；间隔远超 100ms 即说明主线程被同步长任务占住，
// 输出阻塞时长与发生时刻（相对页面加载），配合其它 [TRACE] 日志定位卡死点。
;(() => {
  let __last = performance.now()
  let __blocked = 0
  setInterval(() => {
    const now = performance.now()
    const gap = now - __last
    __last = now
    if (gap > 250) {
      __blocked++
      trace(`BLOCKED ${gap.toFixed(0)}ms at +${now.toFixed(0)}ms (#${__blocked})`)
    }
  }, 100)
})()

// [TRACE] 启动时把上次崩溃遗留的 trace 落盘到 $TEMP/duoduo-trace-last.log（配合 utils/trace）。
void flushCrashTrace()

const DEFAULT_SERVER_URL_KEY = "duoduocode.settings.dat:defaultServerUrl"

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const readDefaultServerUrl = () => getStorage(DEFAULT_SERVER_URL_KEY)
const writeDefaultServerUrl = (url: string | null) => setStorage(DEFAULT_SERVER_URL_KEY, url)

const notify: Platform["notify"] = async (title, description, href) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: `${APP_DOMAIN}/favicon-96x96-v3.png`,
  })

  notification.onclick = () => {
    handleNotificationClick(href)
    notification.close()
  }
}

const openLink: Platform["openLink"] = (url) => {
  window.open(url, "_blank")
}

const back: Platform["back"] = () => {
  window.history.back()
}

const forward: Platform["forward"] = () => {
  window.history.forward()
}

const restart: Platform["restart"] = async () => {
  window.location.reload()
}

// ─── Global frontend error capture ───
// Persist uncaught errors to a file (desktop only) so they remain readable
// even when the devtools console can't be opened (e.g. macOS release builds
// where F12 / Cmd+Shift+I won't launch devtools). On macOS the file lands in
// ~/Library/Logs/com.duoduo.desktop/frontend_errors.log.
// We also monkeypatch console.error/warn so that errors swallowed by try/catch
// (the common case in this app) are still captured.

if (typeof window !== "undefined") {
  // Patch console first so every console.error/warn the app emits is persisted.
  patchConsoleForLogging()

  // Dev convenience: in a debug build, expose the in-memory frontend error buffer so
  // it can be copied out without hunting through the log file:
  //   copy(JSON.stringify(window.__duoduoFrontendErrors(), null, 2))
  if (import.meta.env.DEV) {
    ;(window as unknown as Record<string, unknown>).__duoduoFrontendErrors = getFrontendErrors
  }

  // Cmd+Shift+I (macOS) / Ctrl+Shift+I (others) toggles the devtools console.
  // F12 also toggles it (common dev shortcut the user expects). On macOS release
  // builds devtools won't actually open (WKWebView restriction), but the shortcut
  // is harmless and works in debug builds / other platforms.
  window.addEventListener("keydown", (e) => {
    const isToggleCombo = (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "I" || e.key === "i")
    const isF12 = e.key === "F12"
    if (isToggleCombo || isF12) {
      const w = window as unknown as {
        __TAURI__?: { core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } }
      }
      const invoke = w.__TAURI__?.core?.invoke
      if (typeof invoke === "function") {
        e.preventDefault()
        // Silent by design: devtools is a dev-facing toggle; a failure has no
        // user-visible effect worth reporting.
        invoke("toggle_devtools").catch(() => {})
      }
    }
  })

  window.addEventListener("error", (e) => {
    const err = e
    const msg = err.error ? `${err.message}\n${err.error.stack ?? String(err.error)}` : err.message
    logFrontendError("error", msg)
  })
  window.addEventListener("unhandledrejection", (e) => {
    const reason = (e).reason
    const msg = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason)
    logFrontendError("error", `Unhandled rejection: ${msg}`)
  })
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const getCurrentUrl = () => {
  if (location.hostname.includes(APP_HOST)) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_DUODUO_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_DUODUO_SERVER_PORT ?? "4096"}`
  return location.origin
}

const getDefaultUrl = () => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  return getCurrentUrl()
}

const [webVersion] = createSignal(pkg.version)

const platform: Platform = {
  platform: "web",
  version: webVersion,
  openLink,
  back,
  forward,
  restart,
  notify,
  getDefaultServer: async () => {
    const stored = readDefaultServerUrl()
    return stored ? ServerConnection.Key.make(stored) : null
  },
  setDefaultServer: writeDefaultServerUrl,
}

if (root instanceof HTMLElement) {
  // ─── Suppress native/WebView2 default context menu ───
  // In Tauri's WebView2 on Windows, the native context menu (Back, Refresh,
  // Save As, Print, Inspect) can appear before the DOM contextmenu event
  // fully bubbles to SolidJS's delegated handler on document. By calling
  // preventDefault() at the CAPTURE phase, we suppress the native menu as
  // early as possible. This does NOT prevent the Kobalte ContextMenu from
  // working — Kobalte's delegated onContextMenu handler on document still
  // fires during the bubbling phase and opens the custom menu.
  document.addEventListener("contextmenu", (e) => e.preventDefault(), true)

  const server: ServerConnection.Http = { type: "http", http: { url: getCurrentUrl() } }
  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface
            defaultServer={ServerConnection.Key.make(getDefaultUrl())}
            servers={[server]}
            disableHealthCheck
          />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}
