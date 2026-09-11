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
          } catch {}
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
        }
      })

      // Subscribe to events from the global SDK (per-project sidecar events
      // are still distributed via the global SSE with directory filtering)
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
