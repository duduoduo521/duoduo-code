import { generateSpecs } from "hono-openapi"
import { Hono } from "hono"
import { Effect } from "effect"
import { adapter } from "#hono"
import { lazy } from "@/util/lazy"
import { Log } from "@/util"
import { Flag } from "@/flag/flag"
import { WorkspaceID } from "@/control-plane/schema"
import { MDNS } from "./mdns"
import { AuthMiddleware, CompressionMiddleware, CorsMiddleware, ErrorMiddleware, LoggerMiddleware } from "./middleware"
import { FenceMiddleware } from "./fence"
import { initProjectors } from "./projectors"
import { InstanceRoutes } from "./routes/instance"
import { ControlPlaneRoutes } from "./routes/control"
import { UIRoutes } from "./routes/ui"
import { GlobalRoutes } from "./routes/global"
import { WorkspaceRouterMiddleware } from "./workspace"
import { InstanceMiddleware } from "./routes/instance/middleware"
import { WorkspaceRoutes } from "./routes/control/workspace"
import { ensureBundleResources } from "@/lsp/bundle-resources"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

initProjectors()

const log = Log.create({ service: "server" })

export type Listener = {
  hostname: string
  port: number
  url: URL
  stop: (close?: boolean) => Promise<void>
}

export const Default = lazy(() => create({}))

function create(opts: { cors?: string[] }) {
  const app = new Hono()
    .onError(ErrorMiddleware)
    .use(AuthMiddleware)
    .use(LoggerMiddleware)
    .use(CompressionMiddleware)
    .use(CorsMiddleware(opts))
    .route("/global", GlobalRoutes())

  const runtime = adapter.create(app)

  if (Flag.DUODUO_WORKSPACE_ID) {
    return {
      app: app
        .use(InstanceMiddleware(Flag.DUODUO_WORKSPACE_ID ? WorkspaceID.make(Flag.DUODUO_WORKSPACE_ID) : undefined))
        .use(FenceMiddleware)
        .route("/", InstanceRoutes(runtime.upgradeWebSocket)),
      runtime,
    }
  }

  return {
    app: app
      .route("/", ControlPlaneRoutes())
      .route(
        "/",
        new Hono()
          .use(InstanceMiddleware())
          .route("/experimental/workspace", WorkspaceRoutes())
          .use(WorkspaceRouterMiddleware(runtime.upgradeWebSocket)),
      )
      .route("/", InstanceRoutes(runtime.upgradeWebSocket))
      .route("/", UIRoutes()),
    runtime,
  }
}

export async function openapi() {
  // Build a fresh app with all routes registered directly so
  // hono-openapi can see describeRoute metadata (`.route()` wraps
  // handlers when the sub-app has a custom errorHandler, which
  // strips the metadata symbol).
  const { app } = create({})
  const result = await generateSpecs(app, {
    documentation: {
      info: {
        title: "duoduo",
        version: "1.0.0",
        description: "duoduo api",
      },
      openapi: "3.1.1",
    },
  })
  return result
}

export let url: URL

export async function listen(opts: {
  port: number
  hostname: string
  mdns?: boolean
  mdnsDomain?: string
  cors?: string[]
}): Promise<Listener> {
  const built = create(opts)

  // Bind the port FIRST so /global/health is answerable immediately.
  // AppRuntime warmup is moved to the BACKGROUND (问题3): it memoizes the
  // 5 base services but no longer blocks the listener. The first request
  // either reuses the memoized layer or races the background build, which
  // the shared memo map collapses into a single construction (see doc R1/R2).
  const server = await built.runtime.listen(opts)

  // 第四节-B：首启搬运预置 LSP 二进制 + Node 到运行时目录（零侵入，fire-and-forget）。
  // 与 AppRuntime warmup 平行，不阻塞监听；不进入 warmup（LSP 被刻意排除于启动提速之外）。
  void ensureBundleResources().catch((err) =>
    log.warn("ensureBundleResources failed; LSP will fall back to PATH/download", { error: err }),
  )

  // AppRuntime warmup (background, fire-and-forget, NON-blocking).
  //
  // 每个本地服务通过「共享 AppRuntime」逐个构建（真实请求复用同一 memoMap 里已构建的
  // 子层，首请求即快），并在两次构建之间 `setTimeout(0)` **让出事件循环**——保证预热
  // 进行期间 /health 与首个真实 bootstrap 请求能立即被应答，而不是被一次多秒的整层构建
  // 同步占满事件循环（之前「打开项目卡死」的根因）。重服务（Session/Provider/Project）
  // 子图最大，放到最后构建：前面轻服务已 memoized、splash 的 /health 检查已能先通过，
  // 重服务在后台延迟构建，不阻塞启动链路。MCP/LSP/Command 刻意排除（会拉起外部进程），
  // 保持惰性，首次使用时再在后台构建。
  void (async () => {
    const warmStart = Date.now()
    const stamp = (msg: string) =>
      process.stdout.write(`[warmup] ${((Date.now() - warmStart) / 1000).toFixed(2)}s ${msg}\n`)
    try {
      const { AppRuntime } = await import("@/effect/app-runtime")
      const { Global } = await import("../global")
      const { Config } = await import("@/config")
      const { Bus } = await import("@/bus")
      const { Vcs, Project } = await import("@/project")
      const { Snapshot } = await import("@/snapshot")
      const { Session } = await import("@/session")
      const { SessionStatus } = await import("@/session/status")
      const { Provider } = await import("@/provider")
      const { Permission } = await import("@/permission")
      const { Question } = await import("@/question")
      // 轻服务优先（构建快），重服务（Project/Session/Provider 子图最大）最后构建。
      const services: Array<[string, unknown]> = [
        ["Global", Global],
        ["Config", Config],
        ["Bus", Bus],
        ["Vcs", Vcs],
        ["Snapshot", Snapshot],
        ["Permission", Permission],
        ["Question", Question],
        ["SessionStatus", SessionStatus],
        ["Project", Project],
        ["Session", Session],
        ["Provider", Provider],
      ]
      // 让 listen() 先把 /health 等路由注册完，再开始构建。
      await new Promise((r) => setTimeout(r, 0))
      for (const [name, mod] of services) {
        const t0 = Date.now()
        const svc = (mod as {
          Service: { use: <A, E, R>(fn: () => Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> }
        }).Service
        await AppRuntime.runPromise(svc.use(() => Effect.void))
        const dt = Date.now() - t0
        stamp(`built ${name} ${dt}ms${dt > 500 ? "  <-- SLOW" : ""}`)
        // 让出事件循环：/health 与首个真实请求可在下一轮构建前被应答。
        await new Promise((r) => setTimeout(r, 0))
      }
      stamp(`complete total ${Date.now() - warmStart}ms`)
    } catch (err) {
      stamp(`FAILED ${(err as Error)?.message ?? err}`)
    }
  })()

  const next = new URL("http://localhost")
  next.hostname = opts.hostname
  next.port = String(server.port)
  url = next

  const mdns =
    opts.mdns &&
    server.port &&
    opts.hostname !== "127.0.0.1" &&
    opts.hostname !== "localhost" &&
    opts.hostname !== "::1"
  if (mdns) {
    MDNS.publish(server.port, opts.mdnsDomain)
  } else if (opts.mdns) {
    log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
  }

  let closing: Promise<void> | undefined
  return {
    hostname: opts.hostname,
    port: server.port,
    url: next,
    stop(close?: boolean) {
      closing ??= (async () => {
        if (mdns) MDNS.unpublish()
        await server.stop(close)
      })()
      return closing
    },
  }
}

export * as Server from "./server"
