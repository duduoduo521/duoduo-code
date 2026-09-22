import type { Event } from "@duoduo-ai/sdk/v2/client"
import { createSimpleContext } from "@duoduo-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { type Accessor, createEffect, createMemo, onCleanup } from "solid-js"
import { createSdkForServer } from "@/utils/server"
import { useGlobalSDK } from "./global-sdk"
import { useLanguage } from "./language"

type SDKEventMap = {
  [key in Event["type"]]: Extract<Event, { type: key }>
}

interface ProjectSidecarInfo {
  directory: string
  url: string
  port: number
  has_password: boolean
}

// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: { directory: Accessor<string> }) => {
    const globalSDK = useGlobalSDK()
    const language = useLanguage()

    const directory = createMemo(props.directory)

    // Per-project sidecar state: null = not attempted/failed, info+authHeader = running
    let projectSidecar: ProjectSidecarInfo | null = null
    let projectSidecarAuthHeader: string | null = null

    // Attempt to start a per-project sidecar for this directory.
    // Falls back to global SDK on failure or non-Tauri environments.
    const tryStartProjectSidecar = async (
      dir: string,
    ): Promise<{ info: ProjectSidecarInfo; authHeader: string } | null> => {
      try {
        // @ts-ignore — Tauri invoke via __TAURI__ global
        const info: ProjectSidecarInfo = await window.__TAURI__?.core?.invoke?.("start_project_sidecar", {
          directory: dir,
        })
        if (info?.url && info?.port) {
          // Fetch auth header from Rust (password never crosses IPC)
          try {
            // @ts-ignore — Tauri invoke via __TAURI__ global
            const authHeader: string | null = await window.__TAURI__?.core?.invoke?.("get_sidecar_auth_header", {
              directory: dir,
            })
            if (authHeader) {
              return { info, authHeader }
            }
          } catch {
            // Silent by design: fall through and use the sidecar without an
            // auth header (password-protected sidecars return one; unprotected
            // ones do not need it).
          }
          // Still return info even if auth header fetch failed
          return { info, authHeader: "" }
        }
      } catch (e) {
        // Per-project sidecar not available — fall back to global SDK
      }
      return null
    }

    // Create a per-project SDK client from sidecar info
    // Password never crosses the IPC boundary — we fetch the auth
    // header from Rust and pass it directly to the SDK.
    const createProjectClient = (info: ProjectSidecarInfo, authHeader: string) => {
      return createSdkForServer({
        server: {
          url: info.url,
        },
        headers: {
          Authorization: authHeader,
        },
        throwOnError: true,
      })
    }

    // ── Per-project sidecar event bridge ─────────────────────────────────
    // The per-project sidecar publishes every Bus event (session.status,
    // message.part.delta/updated, session.updated, ...) to its OWN process.
    // The global event stream (base sidecar /global/event) never sees them,
    // so without this bridge the UI is event-blind while the project sidecar
    // serves the session: no live streaming, no busy/idle transitions — the
    // resent turn freezes (no "thinking" indicator, send button never flips
    // to stop). Subscribe to the project sidecar's own /global/event and
    // forward each event into the shared global emitter, where the existing
    // directory-scoped reducers already know how to apply it.
    const startProjectEventBridge = (info: ProjectSidecarInfo, authHeader: string, signal: AbortSignal) => {
      const eventSdk = createSdkForServer({
        server: { url: info.url },
        headers: authHeader ? { Authorization: authHeader } : undefined,
        signal,
      })
      void (async () => {
        while (!signal.aborted) {
          try {
            const events = await eventSdk.global.event({ signal })
            for await (const event of events.stream) {
              if (signal.aborted) return
              globalSDK.event.emit(event.directory ?? info.directory, event.payload as Event)
            }
          } catch {
            // Stream error (sidecar restarting) — fall through and reconnect.
          }
          if (signal.aborted) return
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      })()
    }

    const client = createMemo(() => {
      const dir = directory()
      if (projectSidecar && projectSidecar.directory === dir && projectSidecarAuthHeader) {
        return createProjectClient(projectSidecar, projectSidecarAuthHeader)
      }
      return globalSDK.createClient({
        directory: dir,
        throwOnError: true,
      })
    })

    const emitter = createGlobalEmitter<SDKEventMap>()

    // When directory changes, try to start a per-project sidecar
    createEffect(() => {
      const dir = directory()
      projectSidecar = null
      projectSidecarAuthHeader = null

      const streamAbort = new AbortController()
      onCleanup(() => streamAbort.abort())

      void tryStartProjectSidecar(dir).then((result) => {
        if (result && directory() === dir) {
          projectSidecar = result.info
          projectSidecarAuthHeader = result.authHeader
          // Start monitoring the per-project sidecar for auto-restart on crash
          try {
            // @ts-ignore — Tauri invoke via __TAURI__ global
            window.__TAURI__?.core?.invoke?.("monitor_project_sidecar", { directory: dir })
          } catch {
            // Monitoring not available — sidecar won't auto-restart
          }
          startProjectEventBridge(result.info, result.authHeader, streamAbort.signal)
        }
      })

      // Subscribe to events from the global SDK (base sidecar SSE). Events
      // emitted by the per-project sidecar reach the UI through
      // startProjectEventBridge above.
      const unsub = globalSDK.event.on(dir, (event) => {
        emitter.emit(event.type, event)
      })
      onCleanup(unsub)
    })

    return {
      get directory() {
        return directory()
      },
      get client() {
        return client()
      },
      event: emitter,
      get url() {
        return projectSidecar ? projectSidecar.url : globalSDK.url
      },
      createClient(opts: Parameters<typeof globalSDK.createClient>[0]) {
        return globalSDK.createClient(opts)
      },
    }
  },
})
