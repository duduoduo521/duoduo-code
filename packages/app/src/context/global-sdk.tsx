import type { Event } from "@duoduo-ai/sdk/v2/client"
import { createSimpleContext } from "@duoduo-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { makeEventListener } from "@solid-primitives/event-listener"
import { batch, onCleanup, onMount } from "solid-js"
import z from "zod"
import { createSdkForServer } from "@/utils/server"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { useServer } from "./server"

const abortError = z.object({
  name: z.literal("AbortError"),
})

// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext({
  name: "GlobalSDK",
  init: () => {
    const language = useLanguage()
    const server = useServer()
    const platform = usePlatform()
    const abort = new AbortController()

    const eventFetch = (() => {
      if (!platform.fetch || !server.current) return
      try {
        const url = new URL(server.current.http.url)
        const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
        if (url.protocol === "http:" && !loopback) return platform.fetch
      } catch {
        return
      }
    })()

    const currentServer = server.current
    if (!currentServer) throw new Error(language.t("error.globalSDK.noServerAvailable"))

    const eventSdk = createSdkForServer({
      signal: abort.signal,
      fetch: eventFetch,
      server: currentServer.http,
    })
    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()

    type Queued = { directory: string; payload: Event }
    const FLUSH_FRAME_MS = 16
    const STREAM_YIELD_MS = 8
    const RECONNECT_INITIAL_DELAY_MS = 250
    const RECONNECT_MAX_DELAY_MS = 30_000
    const RECONNECT_BACKOFF_FACTOR = 2
    const MAX_RECONNECT_ATTEMPTS = 5

    // Flag to prevent duplicate restart_sidecar calls
    let restarting = false

    let queue: Queued[] = []
    let buffer: Queued[] = []
    const coalesced = new Map<string, number>()
    const staleDeltas = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0

    const deltaKey = (directory: string, messageID: string, partID: string) => `${directory}:${messageID}:${partID}`

    const key = (directory: string, payload: Event) => {
      if (payload.type === "session.status") return `session.status:${directory}:${payload.properties.sessionID}`
      if (payload.type === "lsp.updated") return `lsp.updated:${directory}`
      if (payload.type === "message.part.updated") {
        const part = payload.properties.part
        return `message.part.updated:${directory}:${part.messageID}:${part.id}`
      }
    }

    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = undefined

      if (queue.length === 0) return

      const events = queue
      const skip = staleDeltas.size > 0 ? new Set(staleDeltas) : undefined
      queue = buffer
      buffer = events
      queue.length = 0
      coalesced.clear()
      staleDeltas.clear()

      last = Date.now()
      batch(() => {
        for (const event of events) {
          if (skip && event.payload.type === "message.part.delta") {
            const props = event.payload.properties
            if (skip.has(deltaKey(event.directory, props.messageID, props.partID))) continue
          }
          emitter.emit(event.directory, event.payload)
        }
      })

      buffer.length = 0
    }

    const schedule = () => {
      if (timer) return
      const elapsed = Date.now() - last
      timer = setTimeout(flush, Math.max(0, FLUSH_FRAME_MS - elapsed))
    }

    let streamErrorLogged = false
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const aborted = (error: unknown) => abortError.safeParse(error).success

    let attempt: AbortController | undefined
    let run: Promise<void> | undefined
    let started = false
    const HEARTBEAT_TIMEOUT_MS = 45_000
    let lastEventAt = Date.now()
    let heartbeat: ReturnType<typeof setTimeout> | undefined
    const resetHeartbeat = () => {
      lastEventAt = Date.now()
      if (heartbeat) clearTimeout(heartbeat)
      heartbeat = setTimeout(() => {
        attempt?.abort()
      }, HEARTBEAT_TIMEOUT_MS)
    }
    const clearHeartbeat = () => {
      if (!heartbeat) return
      clearTimeout(heartbeat)
      heartbeat = undefined
    }

    const start = () => {
      if (started) return run
      started = true
      run = (async () => {
        let reconnectAttempts = 0
        // oxlint-disable-next-line no-unmodified-loop-condition -- `started` is set to false by stop() which also aborts; both flags are checked to allow graceful exit
        while (!abort.signal.aborted && started) {
          attempt = new AbortController()
          lastEventAt = Date.now()
          const onAbort = () => {
            attempt?.abort()
          }
          abort.signal.addEventListener("abort", onAbort)
          try {
            const events = await eventSdk.global.event({
              signal: attempt.signal,
              onSseError: (error) => {
                if (aborted(error)) return
                if (streamErrorLogged) return
                streamErrorLogged = true
                console.error("[global-sdk] event stream error", {
                  url: currentServer.http.url,
                  fetch: eventFetch ? "platform" : "webview",
                  error,
                })
              },
            })
            let yielded = Date.now()
            resetHeartbeat()
            for await (const event of events.stream) {
              resetHeartbeat()
              reconnectAttempts = 0
              streamErrorLogged = false
              const directory = event.directory ?? "global"
              if (event.payload.type === "sync") {
                continue
              }

              const payload = event.payload as Event

              const k = key(directory, payload)
              if (k) {
                const i = coalesced.get(k)
                if (i !== undefined) {
                  queue[i] = { directory, payload }
                  if (payload.type === "message.part.updated") {
                    const part = payload.properties.part
                    staleDeltas.add(deltaKey(directory, part.messageID, part.id))
                  }
                  continue
                }
                coalesced.set(k, queue.length)
              }
              queue.push({ directory, payload })
              schedule()

              if (Date.now() - yielded < STREAM_YIELD_MS) continue
              yielded = Date.now()
              await wait(0)
            }
          } catch (error) {
            if (!aborted(error) && !streamErrorLogged) {
              streamErrorLogged = true
              console.error("[global-sdk] event stream failed", {
                url: currentServer.http.url,
                fetch: eventFetch ? "platform" : "webview",
                error,
              })
            }
          } finally {
            abort.signal.removeEventListener("abort", onAbort)
            attempt = undefined
            clearHeartbeat()
          }

          if (abort.signal.aborted || !started) return

          // If sidecar appears dead (reconnect attempts exceeded), try to restart it
          if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS && !restarting) {
            restarting = true
            try {
              console.warn("[global-sdk] SSE reconnect failed", reconnectAttempts, "times, calling restart_sidecar")
              // @ts-ignore — Tauri invoke via __TAURI__ global (app package has no @tauri-apps/api dep)
              await window.__TAURI__?.core?.invoke?.("restart_sidecar")
              // Restart succeeded — reset and continue reconnecting to the new sidecar
              reconnectAttempts = 0
              restarting = false
              continue
            } catch (e) {
              console.error("[global-sdk] restart_sidecar failed", e)
              restarting = false
              // Continue exponential backoff — supervisor will also attempt restarts
            }
          }

          // If the network is confirmed down, wait for it to come back before retrying
          if (typeof navigator !== "undefined" && !navigator.onLine) {
            await new Promise<void>((resolve) => {
              const onOnline = () => {
                window.removeEventListener("online", onOnline)
                resolve()
              }
              window.addEventListener("online", onOnline, { once: true })
            })
          }

          const delay = Math.min(
            RECONNECT_INITIAL_DELAY_MS * Math.pow(RECONNECT_BACKOFF_FACTOR, reconnectAttempts),
            RECONNECT_MAX_DELAY_MS,
          )
          // Add jitter: random value between delay/2 and delay
          const jitteredDelay = delay * (0.5 + Math.random() * 0.5)
          await wait(jitteredDelay)
          reconnectAttempts++
        }
      })().finally(() => {
        run = undefined
        flush()
      })
      return run
    }

    const stop = () => {
      started = false
      attempt?.abort()
      clearHeartbeat()
    }

    onMount(() => {
      makeEventListener(document, "visibilitychange", () => {
        if (document.visibilityState !== "visible") return
        if (!started) return
        // 切回前台时，如果距上次事件超过心跳超时阈值，主动 abort 让重连机制立即触发
        // 原因：WebView2 在后台可能冻结 JS 执行，恢复后心跳超时逻辑可能已失效
        const elapsed = Date.now() - lastEventAt
        if (elapsed > HEARTBEAT_TIMEOUT_MS) {
          attempt?.abort()
        }
      })

      // Listen for sidecar restart failure events from the Rust supervisor
      // @ts-ignore — Tauri event listener via __TAURI__ global
      window.__TAURI__?.event?.listen?.("sidecar-restart-failed", (event: any) => {
        console.error("[global-sdk] Sidecar restart failed:", event?.payload)
      })
    })

    onCleanup(() => {
      stop()
      abort.abort()
      flush()
    })

    const sdk = createSdkForServer({
      server: server.current.http,
      fetch: platform.fetch,
      throwOnError: true,
    })

    return {
      url: currentServer.http.url,
      client: sdk,
      event: {
        on: emitter.on.bind(emitter),
        listen: emitter.listen.bind(emitter),
        emit: emitter.emit.bind(emitter),
        start,
      },
      createClient(opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">) {
        const s = server.current
        if (!s) throw new Error(language.t("error.globalSDK.serverNotAvailable"))
        return createSdkForServer({
          server: s.http,
          fetch: platform.fetch,
          ...opts,
        })
      },
    }
  },
})
