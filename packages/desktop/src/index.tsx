// @refresh reload

import {
  ACCEPTED_FILE_EXTENSIONS,
  filePickerFilters,
  AppBaseProviders,
  AppInterface,
  handleNotificationClick,
  type Locale,
  type Platform,
  PlatformProvider,
  ServerConnection,
  useCommand,
} from "@duoduo-ai/app"
import type { AsyncStorage } from "@solid-primitives/storage"
import { convertFileSrc } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { readImage } from "@tauri-apps/plugin-clipboard-manager"
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link"
import { open, save } from "@tauri-apps/plugin-dialog"
import { fetch as tauriFetch } from "@tauri-apps/plugin-http"
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification"
import { type as ostype } from "@tauri-apps/plugin-os"
import { relaunch } from "@tauri-apps/plugin-process"
import { open as shellOpen } from "@tauri-apps/plugin-shell"
import { Store } from "@tauri-apps/plugin-store"
import { UPDATER_ENABLED, check as checkForUpdate } from "./updater"
import { type Update } from "@tauri-apps/plugin-updater"
import { createResource, createSignal, createMemo, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import { getVersion } from "@tauri-apps/api/app"
import { initI18n, t } from "@/i18n/core"
import { webviewZoom } from "./webview-zoom"
import "./styles.css"
import { Channel } from "@tauri-apps/api/core"
import { commands, events, type InitStep } from "./bindings"
import { createMenu } from "./menu"

// UTF-8 safe base64 encode, compatible with Rust's base64::engine::general_purpose::STANDARD.encode
function b64Encode(str: string): string {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16))))
}

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

// ─── CSP canary ────────────────────────────────────────────────────────────
// Field-tested (2026-09-23, WebView2 153.0.4234.48): on some launches the
// WebView2 runtime enforces a rogue `default-src 'self'` Content-Security-
// Policy on the document even though the response header and the injected
// <meta> CSP both carry the full policy (with style-src 'unsafe-inline' and
// the ipc: / 127.0.0.1:* connect origins). Under that rogue policy every
// inline <style> is dropped from the CSSOM and ALL Tauri IPC + sidecar
// fetches are refused. Verified: `location.reload()` does NOT clear it (the
// state is sticky for the webview session — reloading just flashes), and the
// page cannot even call `relaunch()` because IPC itself is dead.
//
// Therefore: detect here, DON'T render a non-functional app, keep the styled
// splash (external splash.css works under any such policy) visible, and let
// the Rust-side watchdog (lib.rs, FRONTEND_ALIVE) relaunch the app. A fresh
// process is the only proven cure.
const CSP_BLOCKED = (() => {
  if (import.meta.env.DEV) return false
  try {
    const probe = document.createElement("style")
    probe.textContent = "#__duoduo_csp_canary__{position:fixed}"
    document.head.appendChild(probe)
    const el = document.createElement("div")
    el.id = "__duoduo_csp_canary__"
    ;(document.body ?? document.documentElement).appendChild(el)
    const applied = getComputedStyle(el).position === "fixed"
    probe.remove()
    el.remove()
    return !applied
  } catch {
    return false
  }
})()
if (CSP_BLOCKED) {
  console.error(
    "[csp-heal] inline styles blocked by runtime CSP — holding splash; desktop watchdog will relaunch the app",
  )
}

void initI18n()

// Update state shared between checkUpdate / updateAndRestart / UpdateStatusIndicator
type UpdateStatus = "none" | "checking" | "downloading" | "downloaded" | "error"
let currentUpdate: Update | null = null
const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus>("none")
const [updateVersion, setUpdateVersion] = createSignal<string | undefined>(undefined)

const deepLinkEvent = "duoduo:deep-link"

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__DUODUO__ ??= {}
  const pending = window.__DUODUO__.deepLinks ?? []
  window.__DUODUO__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = async () => {
  const startUrls = await getCurrent().catch(() => null)
  if (startUrls?.length) emitDeepLinks(startUrls)
  await onOpenUrl((urls) => emitDeepLinks(urls)).catch(() => undefined)
}

const createPlatform = (): Platform => {
  const os = (() => {
    const type = ostype()
    if (type === "macos" || type === "windows" || type === "linux") return type
    return undefined
  })()

  const wslHome = async () => {
    if (os !== "windows" || !window.__DUODUO__?.wsl) return undefined
    return commands.wslPath("~", "windows").catch(() => undefined)
  }

  const handleWslPicker = async <T extends string | string[]>(result: T | null): Promise<T | null> => {
    if (!result || !window.__DUODUO__?.wsl) return result
    if (Array.isArray(result)) {
      return Promise.all(result.map((path) => commands.wslPath(path, "linux").catch(() => path))) as any
    }
    return commands.wslPath(result, "linux").catch(() => result) as any
  }

  const [version, setVersion] = createSignal<string | undefined>(undefined)
  void getVersion().then((v) => setVersion(v))

  return {
    platform: "desktop",
    os,
    version,

    async openDirectoryPickerDialog(opts) {
      const defaultPath = await wslHome()
      const result = await open({
        directory: true,
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFolder"),
        defaultPath,
      })
      return await handleWslPicker(result)
    },

    async openFilePickerDialog(opts) {
      const result = await open({
        directory: false,
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFile"),
        filters: filePickerFilters(opts?.extensions ?? ACCEPTED_FILE_EXTENSIONS),
      })
      return handleWslPicker(result)
    },

    async saveFilePickerDialog(opts) {
      const result = await save({
        title: opts?.title ?? t("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
      return handleWslPicker(result)
    },

    openLink(url: string) {
      void shellOpen(url).catch(() => undefined)
    },
    async openPath(path: string, app?: string) {
      await commands.openPath(path, app ?? null)
    },

    back() {
      window.history.back()
    },

    forward() {
      window.history.forward()
    },

    storage: (() => {
      type StoreLike = {
        get(key: string): Promise<string | null | undefined>
        set(key: string, value: string): Promise<unknown>
        delete(key: string): Promise<unknown>
        clear(): Promise<unknown>
        keys(): Promise<string[]>
        length(): Promise<number>
      }

      const WRITE_DEBOUNCE_MS = 250

      const storeCache = new Map<string, Promise<StoreLike>>()
      const apiCache = new Map<string, AsyncStorage & { flush: () => Promise<void> }>()
      const memoryCache = new Map<string, StoreLike>()

      const flushAll = async () => {
        const apis = Array.from(apiCache.values())
        await Promise.all(apis.map((api) => api.flush().catch(() => undefined)))
      }

      if ("addEventListener" in globalThis) {
        const handleVisibility = () => {
          if (document.visibilityState !== "hidden") return
          void flushAll()
        }

        window.addEventListener("pagehide", () => void flushAll())
        document.addEventListener("visibilitychange", handleVisibility)
      }

      const createMemoryStore = () => {
        const data = new Map<string, string>()
        const store: StoreLike = {
          get: async (key) => data.get(key),
          set: async (key, value) => {
            data.set(key, value)
          },
          delete: async (key) => {
            data.delete(key)
          },
          clear: async () => {
            data.clear()
          },
          keys: async () => Array.from(data.keys()),
          length: async () => data.size,
        }
        return store
      }

      const getStore = (name: string) => {
        const cached = storeCache.get(name)
        if (cached) return cached

        const store = Store.load(name).catch(() => {
          const cached = memoryCache.get(name)
          if (cached) return cached

          const memory = createMemoryStore()
          memoryCache.set(name, memory)
          return memory
        })

        storeCache.set(name, store)
        return store
      }

      const createStorage = (name: string) => {
        const pending = new Map<string, string | null>()
        let timer: ReturnType<typeof setTimeout> | undefined
        let flushing: Promise<void> | undefined

        const flush = async () => {
          if (flushing) return flushing

          flushing = (async () => {
            const store = await getStore(name)
            while (pending.size > 0) {
              const batch = Array.from(pending.entries())
              pending.clear()
              for (const [key, value] of batch) {
                if (value === null) {
                  await store.delete(key).catch(() => undefined)
                } else {
                  await store.set(key, value).catch(() => undefined)
                }
              }
            }
          })().finally(() => {
            flushing = undefined
          })

          return flushing
        }

        const schedule = () => {
          if (timer) return
          timer = setTimeout(() => {
            timer = undefined
            void flush()
          }, WRITE_DEBOUNCE_MS)
        }

        const api: AsyncStorage & { flush: () => Promise<void> } = {
          flush,
          getItem: async (key: string) => {
            const next = pending.get(key)
            if (next !== undefined) return next

            const store = await getStore(name)
            const value = await store.get(key).catch(() => null)
            if (value === undefined) return null
            return value
          },
          setItem: async (key: string, value: string) => {
            pending.set(key, value)
            schedule()
          },
          removeItem: async (key: string) => {
            pending.set(key, null)
            schedule()
          },
          clear: async () => {
            pending.clear()
            const store = await getStore(name)
            await store.clear().catch(() => undefined)
          },
          key: async (index: number) => {
            const store = await getStore(name)
            return (await store.keys().catch(() => []))[index]
          },
          getLength: async () => {
            const store = await getStore(name)
            return await store.length().catch(() => 0)
          },
          get length() {
            return api.getLength()
          },
        }

        return api
      }

      return (name = "default.dat") => {
        const cached = apiCache.get(name)
        if (cached) return cached

        const api = createStorage(name)
        apiCache.set(name, api)
        return api
      }
    })(),

    updateStatus,
    updateVersion,

    checkUpdate: async () => {
      if (!UPDATER_ENABLED) return { updateAvailable: false }
      if (updateStatus() === "downloading" || updateStatus() === "checking") {
        return { updateAvailable: !!currentUpdate, version: updateVersion() }
      }
      setUpdateStatus("checking")
      let next
      try {
        next = await checkForUpdate()
      } catch {
        setUpdateStatus("none")
        return { updateAvailable: false }
      }
      if (!next) {
        setUpdateStatus("none")
        return { updateAvailable: false }
      }
      currentUpdate = next
      setUpdateVersion(next.version)
      setUpdateStatus("downloading")
      // Start download (non-blocking)
      void next
        .download()
        .then(() => {
          setUpdateStatus("downloaded")
        })
        .catch(() => {
          setUpdateStatus("error")
        })
      return { updateAvailable: true, version: next.version }
    },

    updateAndRestart: async () => {
      if (!UPDATER_ENABLED || !currentUpdate) return
      try {
        await (Store as any)?.flushAll?.()
      } catch {}
      // If download is still in progress, wait for it
      if (updateStatus() === "downloading") {
        // Poll until download completes or errors
        await new Promise<void>((resolve) => {
          const unsub = setInterval(() => {
            const s = updateStatus()
            if (s === "downloaded" || s === "error" || s === "none") {
              clearInterval(unsub)
              resolve()
            }
          }, 500)
        })
      }
      if (updateStatus() !== "downloaded") return
      try {
        // Signal frontend to suppress expected API errors during shutdown
        ;(window as any).__DUODUO_SIDECAR_SHUTTING_DOWN__ = true
        await commands.killSidecar().catch(() => undefined)
        await currentUpdate.install()
        // Windows: install() exits the process, code below won't execute
        // macOS/Linux: install() returns normally, relaunch to apply update
        await relaunch()
      } catch (e) {
        console.error("[updater] install failed", e)
        setUpdateStatus("error")
      }
    },

    // Kept for backward compatibility (error page uses it)
    update: async () => {
      if (!UPDATER_ENABLED || !currentUpdate) return
      try {
        await (Store as any)?.flushAll?.()
      } catch {}
      if (updateStatus() === "downloading") {
        await new Promise<void>((resolve) => {
          const unsub = setInterval(() => {
            const s = updateStatus()
            if (s === "downloaded" || s === "error" || s === "none") {
              clearInterval(unsub)
              resolve()
            }
          }, 500)
        })
      }
      if (updateStatus() !== "downloaded") return
      try {
        ;(window as any).__DUODUO_SIDECAR_SHUTTING_DOWN__ = true
        await commands.killSidecar().catch(() => undefined)
        await currentUpdate.install()
        await relaunch()
      } catch (e) {
        console.error("[updater] install failed", e)
        setUpdateStatus("error")
      }
    },

    restart: async () => {
      ;(window as any).__DUODUO_SIDECAR_SHUTTING_DOWN__ = true
      await commands.killSidecar().catch(() => undefined)
      await relaunch()
    },

    notify: async (title, description, href) => {
      const granted = await isPermissionGranted().catch(() => false)
      const permission = granted ? "granted" : await requestPermission().catch(() => "denied")
      if (permission !== "granted") return

      const win = getCurrentWindow()
      const focused = await win.isFocused().catch(() => document.hasFocus())
      if (focused) return

      await Promise.resolve()
        .then(() => {
          const notification = new Notification(title, {
            body: description ?? "",
            icon: convertFileSrc("favicon-96x96-v3.png"),
          })
          notification.onclick = () => {
            const win = getCurrentWindow()
            void win.show().catch(() => undefined)
            void win.unminimize().catch(() => undefined)
            // setFocus is unreliable on Linux Wayland; show+unminimize are sufficient
            void win.setFocus().catch(() => undefined)
            handleNotificationClick(href)
            notification.close()
          }
        })
        .catch(() => undefined)
    },

    fetch: (input, init) => {
      if (input instanceof Request) {
        return tauriFetch(input)
      } else {
        return tauriFetch(input, init)
      }
    },

    getWslEnabled: async () => {
      const next = await commands.getWslConfig().catch(() => null)
      if (next) return next.enabled
      return window.__DUODUO__!.wsl ?? false
    },

    setWslEnabled: async (enabled) => {
      await commands.setWslConfig({ enabled })
    },

    getDefaultServer: async () => {
      const url = await commands.getDefaultServerUrl().catch(() => null)
      if (!url) return null
      return ServerConnection.Key.make(url)
    },

    setDefaultServer: async (url: string | null) => {
      await commands.setDefaultServerUrl(url)
    },

    getDisplayBackend: async () => {
      const result = await commands.getDisplayBackend().catch(() => null)
      return result
    },

    setDisplayBackend: async (backend) => {
      await commands.setDisplayBackend(backend)
    },

    parseMarkdown: (markdown: string) => commands.parseMarkdownCommand(markdown),

    listSystemFonts: () => commands.listSystemFonts(),

    webviewZoom,

    async readClipboardImage() {
      const image = await readImage().catch(() => null)
      if (!image) return null
      const bytes = await image.rgba().catch(() => null)
      if (!bytes || bytes.length === 0) return null
      const size = await image.size().catch(() => null)
      if (!size) return null
      const canvas = document.createElement("canvas")
      canvas.width = size.width
      canvas.height = size.height
      const ctx = canvas.getContext("2d")
      if (!ctx) return null
      const imageData = ctx.createImageData(size.width, size.height)
      imageData.data.set(bytes)
      ctx.putImageData(imageData, 0, 0)
      return new Promise<File | null>((resolve) => {
        canvas.toBlob((blob) => {
          if (!blob) return resolve(null)
          resolve(
            new File([blob], `pasted-image-${Date.now()}.png`, {
              type: "image/png",
            }),
          )
        }, "image/png")
      })
    },

    async getProjectSidecar(directory: string) {
      if (typeof commands.startProjectSidecar === "function") {
        const data = await commands.startProjectSidecar(directory)
        // Fetch auth header from Rust (password never crosses the IPC boundary)
        const authHeader = await commands.getSidecarAuthHeader(directory)
        return {
          type: "sidecar" as const,
          variant: "base" as const,
          http: { url: data.url },
          directory: data.directory,
          port: data.port,
          _authHeader: authHeader ?? undefined,
        }
      }
      throw new Error("Multi-project sidecar not available")
    },

    async stopProjectSidecar(directory: string) {
      if (typeof commands.stopProjectSidecar === "function") {
        await commands.stopProjectSidecar(directory)
      }
    },

    /**
     * Smart layer sidecar configuration.
     *
     * The Rust backend spawns the duo-smart-layer sidecar on a random port
     * and exposes the URL/credentials via the `get_smart_layer_config` Tauri
     * command. We use a reactive getter so the SmartLayer context always
     * reads the latest configuration, even when the sidecar starts after
     * the platform object is created.
     *
     * Falls back to VITE_SMART_LAYER_* env vars (for web-only dev mode).
     */
    smartLayer: (() => {
      // Signal stores only non-sensitive public config (url, username).
      // Password is never exposed to the frontend — use getSmartLayerAuthHeader()
      // to obtain a pre-computed Authorization header from Rust.
      const [config, setConfig] = createSignal<
        | {
            url: string
            username?: string
            hasPassword: boolean
          }
        | undefined
      >(undefined)

      // Closure-scoped credential — not reactive, not globally accessible.
      // No longer stores the password; instead, the auth header is fetched
      // on demand from Rust via getSmartLayerAuthHeader().
      let cachedAuthHeader: string | undefined

      const setupSmartLayer = () => {
        let resolved = false
        let pollTimer: ReturnType<typeof setInterval> | undefined
        let unlisten: (() => void) | undefined

        // Apply a discovered config and tear down every other resolution path.
        // IMPORTANT: the auth header MUST be fetched BEFORE setConfig() triggers
        // the SmartLayer context's `api` memo. The memo captures
        // `getAuthHeader()` at creation time; if cachedAuthHeader is still
        // undefined the SmartLayerApi instance is created without credentials
        // and never picks them up (cachedAuthHeader is a plain closure var,
        // not a signal — the memo won't re-run when it's set later).
        const apply = async (
          result: { url: string; username: string; has_password: boolean } | null,
        ) => {
          if (resolved || !result) return
          resolved = true
          if (pollTimer) {
            clearInterval(pollTimer)
            pollTimer = undefined
          }
          if (unlisten) {
            try {
              unlisten()
            } catch {}
            unlisten = undefined
          }
          // Fetch auth header from Rust BEFORE publishing the config signal
          // (password never crosses IPC — only the pre-computed Basic header).
          // finalize_smart_layer sets url and password under two separate
          // lock acquisitions; a poll that lands in between would get a
          // config without a password and — because the auth header is then
          // frozen into the api client — 401 forever. Bounded retry closes
          // that window.
          for (let attempt = 0; attempt < 10; attempt++) {
            try {
              cachedAuthHeader = (await commands.getSmartLayerAuthHeader()) ?? undefined
            } catch {}
            if (cachedAuthHeader || !result.has_password) break
            await new Promise((resolve) => setTimeout(resolve, 200))
          }
          console.info("[smart-layer] Config resolved:", result.url)
          setConfig({
            url: result.url,
            username: result.username ?? undefined,
            hasPassword: result.has_password,
          })
        }

        // 1. Immediate one-shot — the sidecar may already be ready (common in
        //    dev, or whenever the webview finishes loading after the sidecar
        //    has already started).
        try {
          commands.getSmartLayerConfig().then((r) => {
            if (r) void apply(r)
          }).catch(() => {})
        } catch {}

        // 2. Event path — Rust emits `smart-layer-ready-data` once the sidecar
        //    passes its health check. Tauri events are fire-and-forget and are
        //    NOT replayed, so if the sidecar is ready before the webview
        //    registers this listener the event is silently missed. The poll
        //    fallback below covers exactly that race.
        try {
          void events.smartLayerReadyData
            .listen((e: { payload: { url: string; username: string; has_password: boolean } }) => {
              void apply(e.payload)
            })
            .then((u) => {
              unlisten = u
            })
        } catch (e) {
          console.warn("[smart-layer] Failed to listen for ready event:", e)
        }

        // 3. Polling fallback — the only path robust to BOTH the event race
        //    (event emitted before listen registered) AND the sidecar starting
        //    after the app boots. Polls getSmartLayerConfig() until it returns a
        //    config or the attempt cap is reached. Once the sidecar is ready the
        //    managed state is populated and the next poll picks it up within
        //    ~1.5s, so sl.api becomes available quickly instead of hanging.
        const maxAttempts = 200 // ~5 min at 1.5s cadence
        let attempts = 0
        pollTimer = setInterval(() => {
          if (resolved) return
          if (attempts++ >= maxAttempts) {
            if (pollTimer) clearInterval(pollTimer)
            pollTimer = undefined
            console.warn(
              "[smart-layer] Gave up resolving smart-layer config after polling; smart-layer features disabled",
            )
            return
          }
          try {
            commands.getSmartLayerConfig().then((r) => {
              if (r) void apply(r)
            }).catch(() => {})
          } catch {}
        }, 1500)
      }
      void setupSmartLayer()

      // Return a reactive getter that provides url/username via signal,
      // plus a getAuthHeader() method that returns the cached auth header
      // from Rust — without ever exposing the plaintext password to subscribers.
      const getter = () => {
        const live = config()
        if (live) {
          return {
            url: live.url,
            username: live.username,
            /** Return cached Basic Auth header from Rust.
             *  Returns undefined if no credentials are available. */
            getAuthHeader: (): string | undefined => {
              return cachedAuthHeader
            },
          }
        }
        // Only use VITE env fallback in web-only dev mode (no Tauri sidecar).
        // When VITE_SMART_LAYER_PORT is explicitly set, we're in web dev mode.
        // Do NOT fallback to a dummy port (12345) — that only causes
        // meaningless failed health check requests and misleading error messages.
        const fallbackPort = import.meta.env.VITE_SMART_LAYER_PORT
        if (!fallbackPort) return undefined
        const baseHost = import.meta.env.VITE_SMART_LAYER_HOST ?? "127.0.0.1"
        const fallbackUser = import.meta.env.VITE_SMART_LAYER_USERNAME ?? undefined
        const fallbackPass = import.meta.env.VITE_SMART_LAYER_PASSWORD ?? undefined
        return {
          url: `http://${baseHost}:${fallbackPort}`,
          username: fallbackUser,
          getAuthHeader: (): string | undefined => {
            if (fallbackUser && fallbackPass) return `Basic ${btoa(`${fallbackUser}:${fallbackPass}`)}`
            return undefined
          },
        }
      }

      return getter
    })(),
  } as Platform
}

let menuTrigger = null as null | ((id: string) => void)
void createMenu((id) => {
  menuTrigger?.(id)
})
void listenForDeepLinks()

// Suppress native/WebView2 default context menu (Back, Refresh, Save As, Print, Inspect).
// In Tauri's WebView2 on Windows, the native context menu can appear before
// the DOM contextmenu event fully bubbles to SolidJS's delegated handler.
// Calling preventDefault() at the CAPTURE phase suppresses the native menu
// as early as possible. Kobalte's ContextMenu still works because its
// delegated onContextMenu handler fires during the bubbling phase on document.
document.addEventListener("contextmenu", (e) => e.preventDefault(), true)

if (CSP_BLOCKED) {
  // Rogue-CSP launch: every Tauri IPC call is refused, so the app would mount
  // non-functional. Hold the styled splash (splash.css works under any policy
  // that lets the document load) and let the Rust watchdog relaunch the app.
} else {
  render(() => {
  const platform = createPlatform()
  const loadLocale = () => initI18n()

  // Track initialization step for loading progress display
  const [initStep, setInitStep] = createSignal<InitStep | null>(null)
  const initPhase = createMemo(() => initStep()?.phase)
  const initChannel = new Channel<InitStep>()
  initChannel.onmessage = (next) => setInitStep(next)

  // Fetch sidecar credentials from Rust (available immediately, before health check)
  // Rust's awaitInitialization already performs a health check with 30s timeout
  // and only resolves once the sidecar is confirmed healthy.
  const [sidecar] = createResource(() => commands.awaitInitialization(initChannel as any))

  const [defaultServer] = createResource(() =>
    platform.getDefaultServer?.().then((url) => {
      if (url) return ServerConnection.key({ type: "http", http: { url } })
    }),
  )
  const [locale] = createResource(loadLocale)

  // Loading status text that progresses with initialization
  const loadingStatus = createMemo(() => {
    if (initPhase() === "done") return t("desktop.loading.status.done")
    if (initPhase() === "sqlite_waiting") return t("desktop.loading.status.migrating")
    return t("desktop.loading.status.initial")
  })

  // Build the sidecar server connection once credentials arrive
  const servers = () => {
    const data = sidecar()
    if (!data) return []
    const http = {
      url: data.url,
      username: data.username ?? undefined,
      password: data.password ?? undefined,
    }
    const server: ServerConnection.Sidecar = {
      displayName: t("desktop.server.local"),
      type: "sidecar",
      variant: "base",
      http,
    }
    return [server] as ServerConnection.Any[]
  }

  // Whether the server is a local sidecar (vs. remote HTTP).
  // For local sidecar, Rust already performed health check before resolving
  // awaitInitialization, so ConnectionGate's redundant re-check can be skipped.
  const isLocalSidecar = createMemo(() => {
    const data = sidecar()
    if (!data) return true // not yet resolved, assume local
    return !defaultServer.latest // no remote server configured → using sidecar
  })

  function handleClick(e: MouseEvent) {
    const link = (e.target as HTMLElement).closest("a.external-link") as HTMLAnchorElement | null
    if (link?.href) {
      e.preventDefault()
      platform.openLink(link.href)
    }
  }

  function Inner() {
    const cmd = useCommand()
    menuTrigger = (id) => cmd.trigger(id)
    return null
  }

  onMount(() => {
    document.addEventListener("click", handleClick)
    onCleanup(() => {
      document.removeEventListener("click", handleClick)
    })
  })

  // The inline HTML splash (position:fixed, z-index:99999) covers the entire
  // viewport. We only remove it once the editor UI is actually rendered in the DOM.
  //
  // Strategy: bootstrapDirectory dispatches __duoduo_bootstrap_complete__ when the
  // data is loaded (status="complete"). But data-ready ≠ DOM-rendered, so we then
  // poll for key UI elements (session-prompt-dock = AI composer) to actually appear
  // in the DOM before removing the splash overlay.
  // Wait until the entry stylesheet is actually applied before handing off the
  // screen from the inline splash to the editor UI. This eliminates the
  // first-paint flash where the editor (incl. the home logo) renders unstyled
  // because the asynchronously-injected CSS file hasn't finished loading yet.
  //
  //  - dev:  styles.css is injected synchronously as a <style> by the Vite dev
  //          server, so it's always ready by the time the editor mounts -> no wait.
  //  - prod: the build inlines the entry CSS into dist/index.html
  //          (scripts/inline-entry-css.ts), so styles are present at parse
  //          time; Vite's preload helper still injects an async <link> for
  //          the same file, and this wait covers the unlikely case where that
  //          link stalls while the inline copy somehow isn't applied.
  // Hand the screen over only once the entry styles are demonstrably applied.
  //
  // Tailwind's preflight sets `margin: 0` on every element while the UA
  // default for <body> is 8px, so the computed body margin is a reliable,
  // framework-free indicator that the stylesheet is live. Deliberately NOT
  // polling <link> elements any more: the build inlines the CSS into
  // dist/index.html (scripts/inline-entry-css.ts), so when Vite's async
  // <link> stalls (WebView2 cache quirks on rapid relaunch), styles are
  // already applied and holding the splash hostage is pure harm — that
  // state was observed in the field as an unstyled corner splash.
  const waitForEntryCss = (): Promise<void> =>
    new Promise((resolve) => {
      if (import.meta.env.DEV) return resolve()
      const start = Date.now()
      const tick = () => {
        const stylesApplied = getComputedStyle(document.body).marginLeft === '0px'
        // 10s hard cap, well under the 30s failsafe below.
        if (stylesApplied || Date.now() - start > 10_000) {
          resolve()
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })

  // Field diagnostics: snapshot the style-related state at splash-handoff
  // time into a rolling localStorage history (persists across launches).
  // If the splash ever misrenders again, open devtools (F12 — the `devtools`
  // feature is enabled in release) and run:
  //   JSON.parse(localStorage.getItem("__duoduo_splash_hist__"))
  // The record tells exactly which layer failed:
  //   - splashPosition "static" instead of "fixed" -> the splash CSS did not
  //     apply; combined with headSplashCss/bodySplashCss presence this
  //     separates "element removed" from "inline styles blocked".
  //   - bodyMarginLeft "8px" -> the entry stylesheet was not applied at all.
  //   - cssLinks[].ready false -> Vite's async <link> stalled.
  const recordSplashDiagnostics = () => {
    try {
      const links = Array.from(document.querySelectorAll('link')).filter(
        (l) => l.rel === 'stylesheet' && (l.href || '').endsWith('.css'),
      )
      const splash = document.getElementById('__duoduo_splash__')
      const sheetReady = (l: HTMLLinkElement) => {
        try {
          return !!l.sheet
        } catch {
          return false
        }
      }
      const record = {
        at: new Date().toISOString(),
        splashPosition: splash ? getComputedStyle(splash).position : 'removed',
        bodyMarginLeft: getComputedStyle(document.body).marginLeft,
        headSplashCss: !!document.querySelector('style[data-splash-redundant]'),
        bodySplashCss: !!document.querySelector('#__duoduo_splash__ > style'),
        styleCount: document.querySelectorAll('style').length,
        cssLinks: links.map((l) => ({
          file: (l.href || '').split('/').pop(),
          ready: sheetReady(l),
        })),
      }
      const key = '__duoduo_splash_hist__'
      const history = JSON.parse(localStorage.getItem(key) || '[]')
      history.push(record)
      localStorage.setItem(key, JSON.stringify(history.slice(-20)))
    } catch {
      // Diagnostics must never break the handoff.
    }
  }

  const removeInlineSplash = () => {
    const splash = document.getElementById("__duoduo_splash__")
    if (splash) {
      recordSplashDiagnostics()
      splash.remove()
    }
  }

  const pollForEditorUI = () => {
    // session-prompt-dock = AI dialog composer, always present in session view
    // filetree = file tree panel. Either one appearing means the editor UI has rendered.
    // logo = home screen logo, so the splash is also removed promptly when the
    // app starts without a project (no bootstrap event fires in that case).
    const composer = document.querySelector('[data-component="session-prompt-dock"]')
    const filetree = document.querySelector('[data-scope="filetree"]')
    const logo = document.querySelector('[data-component="logo"], [data-component="logo-splash"]')
    if (composer || filetree || logo) {
      // Editor DOM is present, but don't hand off the screen until the entry CSS
      // is actually applied — otherwise the unstyled editor flashes (logo
      // full-screen) on first paint. dev needs no wait (CSS is already inline).
      void waitForEntryCss().then(removeInlineSplash)
    } else {
      requestAnimationFrame(pollForEditorUI)
    }
  }

  // Start DOM polling when bootstrap data is ready
  document.addEventListener("__duoduo_bootstrap_complete__", () => {
    requestAnimationFrame(pollForEditorUI)
  })
  // Also poll right after mount: the bootstrap event above only fires when a
  // project directory is opened, so without this the splash would linger on
  // the project-less home screen until the 30s failsafe removes it.
  requestAnimationFrame(pollForEditorUI)
  // Safety net: force remove after 30s
  setTimeout(removeInlineSplash, 30000)

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale={locale.latest}>
        <Show when={!defaultServer.loading && !sidecar.loading && !locale.loading} fallback={null}>
          {(_) => {
            return (
              <AppInterface
                defaultServer={defaultServer.latest ?? ServerConnection.Key.make("sidecar")}
                servers={servers()}
                disableHealthCheck={isLocalSidecar()}
              >
                <Inner />
              </AppInterface>
            )
          }}
        </Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
  }, root!)
}
