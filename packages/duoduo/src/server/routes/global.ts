import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Effect } from "effect"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { GlobalBus } from "@/bus/global"
import { AppRuntime } from "@/effect/app-runtime"
import { AsyncQueue } from "@/util/queue"
import { Instance } from "../../project/instance"
import { Database } from "../../storage"
import { Installation } from "@/installation"
import { InstallationVersion } from "@/installation/version"
import { Log } from "../../util"
import { lazy } from "../../util/lazy"
import { Config } from "../../config"
import { errors } from "../error"

const log = Log.create({ service: "server" })

const MAX_SSE_CONNECTIONS = 100

class AtomicInt {
  private value = 0
  constructor(initial = 0) {
    this.value = initial
  }
  get() {
    return this.value
  }
  increment() {
    return ++this.value
  }
  decrement() {
    return --this.value
  }
}

const sseConnectionCount = new AtomicInt(0)

export const GlobalDisposedEvent = BusEvent.define("global.disposed", z.object({}))

/// Emitted after the global config is updated via `PATCH /global/config` so
/// other clients (e.g. the desktop app, or a Feishu model selection) can
/// reflect the new config without polling. `properties` is the full config.
export const GlobalConfigUpdatedEvent = BusEvent.define(
  "global.config.updated",
  Config.Info.zod,
)

async function streamEvents(c: Context, subscribe: (q: AsyncQueue<string | null>) => () => void) {
  const currentCount = sseConnectionCount.increment()
  if (currentCount > MAX_SSE_CONNECTIONS) {
    sseConnectionCount.decrement()
    log.warn(`SSE connection rejected: max connections (${MAX_SSE_CONNECTIONS}) reached`)
    return c.json({ error: "Too many SSE connections" }, 503)
  }
  log.info(`SSE connection accepted: ${currentCount}/${MAX_SSE_CONNECTIONS}`)

  try {
    // oxlint-disable-next-line await-thenable -- oxlint span misattribution; await target is a valid thenable
    return await streamSSE(c, async (stream) => {
      const q = new AsyncQueue<string | null>()
      let done = false

      q.push(
        JSON.stringify({
          payload: {
            type: "server.connected",
            properties: {},
          },
        }),
      )

      // Send heartbeat every 10s to prevent stalled proxy streams.
      const heartbeat = setInterval(() => {
        q.push(
          JSON.stringify({
            payload: {
              type: "server.heartbeat",
              properties: {},
            },
          }),
        )
      }, 10_000)

      const stop = () => {
        if (done) return
        done = true
        clearInterval(heartbeat)
        unsub()
        q.push(null)
        sseConnectionCount.decrement()
        log.info(`global event disconnected: ${sseConnectionCount.get()}/${MAX_SSE_CONNECTIONS}`)
      }

      const unsub = subscribe(q)

      stream.onAbort(stop)

      try {
        for await (const data of q) {
          if (data === null) return
          await stream.writeSSE({ data })
        }
      } finally {
        stop()
      }
    })
  } catch (err) {
    sseConnectionCount.decrement()
    throw err
  }
}

export const GlobalRoutes = lazy(() =>
  new Hono()
    .get(
      "/health",
      describeRoute({
        summary: "Get health",
        description: "Get health information about the DuoDuoCode server.",
        operationId: "global.health",
        responses: {
          200: {
            description: "Health information",
            content: {
              "application/json": {
                schema: resolver(z.object({ healthy: z.literal(true), version: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ healthy: true, version: InstallationVersion })
      },
    )
    .get(
      "/event",
      describeRoute({
        summary: "Get global events",
        description: "Subscribe to global events from the DuoDuoCode system using server-sent events.",
        operationId: "global.event",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      directory: z.string(),
                      project: z.string().optional(),
                      workspace: z.string().optional(),
                      payload: z.union([...BusEvent.payloads(), ...SyncEvent.payloads()]),
                    })
                    .meta({
                      ref: "GlobalEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("global event connected")
        c.header("Cache-Control", "no-cache, no-transform")
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")

        return streamEvents(c, (q) => {
          async function handler(event: any) {
            q.push(JSON.stringify(event))
          }
          GlobalBus.on("event", handler)
          return () => GlobalBus.off("event", handler)
        })
      },
    )
    .get(
      "/config",
      describeRoute({
        summary: "Get global configuration",
        description: "Retrieve the current global DuoDuoCode configuration settings and preferences.",
        operationId: "global.config.get",
        responses: {
          200: {
            description: "Get global config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal())))
      },
    )
    .patch(
      "/config",
      describeRoute({
        summary: "Update global configuration",
        description: "Update global DuoDuoCode configuration settings and preferences.",
        operationId: "global.config.update",
        responses: {
          200: {
            description: "Successfully updated global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info.zod),
      async (c) => {
        const config = c.req.valid("json")
        const next = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.updateGlobal(config)))
        // Broadcast the change so subscribers (desktop, Feishu) stay in sync.
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: GlobalConfigUpdatedEvent.type,
            properties: next,
          },
        })
        return c.json(next)
      },
    )
    .post(
      "/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose all DuoDuoCode instances, releasing all resources.",
        operationId: "global.dispose",
        responses: {
          200: {
            description: "Global disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Instance.disposeAll()
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: GlobalDisposedEvent.type,
            properties: {},
          },
        })
        return c.json(true)
      },
    )
    .post(
      "/shutdown",
      describeRoute({
        summary: "Graceful shutdown",
        description: "Gracefully shut down the DuoDuoCode server: dispose all instances, then exit the process.",
        operationId: "global.shutdown",
        responses: {
          200: {
            description: "Shutdown acknowledged",
            content: {
              "application/json": {
                schema: resolver(z.object({ status: z.literal("shutting_down") })),
              },
            },
          },
        },
      }),
      async (c) => {
        // Acknowledge the shutdown request immediately. Returning 200 right
        // away prevents the desktop supervisor's reqwest (2s timeout) from
        // reporting "Failed to send shutdown signal" and force-killing this
        // process before cleanup completes.
        c.header("Connection", "close")

        // Hard self-exit guarantee: no matter how long (or whether) the
        // cleanup below finishes, the process always exits. This is the
        // backstop for cases where no external supervisor will force-kill us
        // (e.g. /global/shutdown invoked directly).
        const hardExit = setTimeout(() => {
          log.warn("Graceful shutdown cleanup timed out — forcing process.exit(0)")
          process.exit(0)
        }, 5000)

        // Run the actual cleanup asynchronously, after the response is sent.
        void (async () => {
          try {
            await Instance.disposeAll()
            GlobalBus.emit("event", {
              directory: "global",
              payload: {
                type: GlobalDisposedEvent.type,
                properties: {},
              },
            })
            // Close the database connection with WAL checkpoint to ensure
            // all data is flushed before process.exit. Without this, the OS
            // may not flush WAL data on process termination.
            Database.close()
            log.info("Graceful shutdown via /global/shutdown — exiting process")
          } catch (error) {
            log.error("Error during graceful shutdown cleanup", { error })
          } finally {
            clearTimeout(hardExit)
            process.exit(0)
          }
        })()

        return c.json({ status: "shutting_down" as const })
      },
    )
    .post(
      "/upgrade",
      describeRoute({
        summary: "Upgrade duoduo",
        description: "Upgrade duoduo to the specified version or latest if not specified.",
        operationId: "global.upgrade",
        responses: {
          200: {
            description: "Upgrade result",
            content: {
              "application/json": {
                schema: resolver(
                  z.union([
                    z.object({
                      success: z.literal(true),
                      version: z.string(),
                    }),
                    z.object({
                      success: z.literal(false),
                      error: z.string(),
                    }),
                  ]),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          target: z.string().optional(),
        }),
      ),
      async (c) => {
        const result = await AppRuntime.runPromise(
          Installation.Service.use((svc) =>
            Effect.gen(function* () {
              const method = yield* svc.method()
              if (method === "unknown") {
                return { success: false as const, status: 400 as const, error: "Unknown installation method" }
              }

              const target = c.req.valid("json").target || (yield* svc.latest(method))
              const result = yield* Effect.catch(
                svc.upgrade(method, target).pipe(Effect.as({ success: true as const, version: target })),
                (err) =>
                  Effect.succeed({
                    success: false as const,
                    status: 500 as const,
                    error: err instanceof Error ? err.message : String(err),
                  }),
              )
              if (!result.success) return result
              return { ...result, status: 200 as const }
            }),
          ),
        )
        if (!result.success) {
          return c.json({ success: false, error: result.error }, result.status)
        }
        const target = result.version
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: Installation.Event.Updated.type,
            properties: { version: target },
          },
        })
        return c.json({ success: true, version: target })
      },
    ),
)
