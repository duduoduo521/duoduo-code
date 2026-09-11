import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { Context, Effect } from "effect"
import z from "zod"
import { Format } from "@/format"
import { TuiRoutes } from "./tui"
import { Instance } from "@/project/instance"
import { Vcs } from "@/project"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Global } from "@/global"
import { InstanceState } from "@/effect"
import { LSP } from "@/lsp"
import { Command } from "@/command"
import { QuestionRoutes } from "./question"
import { PermissionRoutes } from "./permission"
import { Flag } from "@/flag/flag"
import { ExperimentalHttpApiServer } from "./httpapi/server"
import { ProjectRoutes } from "./project"
import { SessionRoutes } from "./session"
import { PtyRoutes } from "./pty"
import { McpRoutes } from "./mcp"
import { FileRoutes } from "./file"
import { ConfigRoutes } from "./config"
import { ExperimentalRoutes } from "./experimental"
import { ProviderRoutes } from "./provider"
import { EventRoutes } from "./event"
import { SyncRoutes } from "./sync"
import { ImRoutes } from "./im"
import { GraphRoutes } from "./graph"
import { SnapshotRoutes } from "./snapshot"
import { InstanceMiddleware } from "./middleware"
import { jsonRequest } from "./trace"

export const InstanceRoutes = (upgrade: UpgradeWebSocket): Hono => {
  const app = new Hono()
  app.use(InstanceMiddleware())

  if (Flag.DUODUO_EXPERIMENTAL_HTTPAPI) {
    const handler = ExperimentalHttpApiServer.webHandler().handler
    const context = Context.empty() as Context.Context<unknown>
    app.get("/question", (c) => handler(c.req.raw, context))
    app.post("/question/:requestID/reply", (c) => handler(c.req.raw, context))
    app.post("/question/:requestID/reject", (c) => handler(c.req.raw, context))
    app.get("/permission", (c) => handler(c.req.raw, context))
    app.post("/permission/:requestID/reply", (c) => handler(c.req.raw, context))
    app.get("/config", (c) => handler(c.req.raw, context))
    app.get("/config/providers", (c) => handler(c.req.raw, context))
    app.get("/provider", (c) => handler(c.req.raw, context))
    app.get("/provider/auth", (c) => handler(c.req.raw, context))
    app.post("/provider/:providerID/oauth/authorize", (c) => handler(c.req.raw, context))
    app.post("/provider/:providerID/oauth/callback", (c) => handler(c.req.raw, context))
    app.get("/project", (c) => handler(c.req.raw, context))
    app.get("/project/current", (c) => handler(c.req.raw, context))
  }

  return app
    .route("/project", ProjectRoutes())
    .route("/pty", PtyRoutes(upgrade))
    .route("/config", ConfigRoutes())
    .route("/experimental", ExperimentalRoutes())
    .route("/session", SessionRoutes())
    .route("/permission", PermissionRoutes())
    .route("/question", QuestionRoutes())
    .route("/provider", ProviderRoutes())
    .route("/sync", SyncRoutes())
    .route("/", FileRoutes())
    .route("/", EventRoutes())
    .route("/mcp", McpRoutes())
    .route("/im", ImRoutes())
    .route("/tui", TuiRoutes())
    .route("/graph", GraphRoutes())
    .route("/snapshot", SnapshotRoutes())
    .post(
      "/instance/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose the current DuoDuoCode instance, releasing all resources.",
        operationId: "instance.dispose",
        responses: {
          200: {
            description: "Instance disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Instance.dispose()
        return c.json(true)
      },
    )
    .get(
      "/path",
      describeRoute({
        summary: "Get paths",
        description: "Retrieve the current working directory and related path information for the DuoDuoCode instance.",
        operationId: "path.get",
        responses: {
          200: {
            description: "Path",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .object({
                      home: z.string(),
                      state: z.string(),
                      config: z.string(),
                      worktree: z.string(),
                      directory: z.string(),
                    })
                    .meta({
                      ref: "Path",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({
          home: Global.Path.home,
          state: Global.Path.state,
          config: Global.Path.config,
          worktree: Instance.worktree,
          directory: Instance.directory,
        })
      },
    )
    .get(
      "/capabilities",
      describeRoute({
        summary: "Get instance capabilities",
        description: "Return directory routing capabilities for this DuoDuoCode instance.",
        operationId: "instance.capabilities",
        responses: {
          200: {
            description: "Instance capabilities",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    fixedDirectory: z.boolean(),
                    directory: z.string(),
                    supportsDirectoryHeader: z.boolean(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const fixedDirectory = process.env.DUODUO_FIXED_DIRECTORY
        return c.json({
          fixedDirectory: !!fixedDirectory,
          directory: fixedDirectory || Instance.directory,
          supportsDirectoryHeader: !fixedDirectory,
        })
      },
    )
    .get(
      "/vcs",
      describeRoute({
        summary: "Get VCS info",
        description: "Retrieve version control system (VCS) information for the current project, such as git branch.",
        operationId: "vcs.get",
        responses: {
          200: {
            description: "VCS info",
            content: {
              "application/json": {
                schema: resolver(Vcs.Info),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("InstanceRoutes.vcs.get", c, function* () {
          const vcs = yield* Vcs.Service
          const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
            concurrency: 2,
          })
          return { branch, default_branch }
        }),
    )
    .get(
      "/vcs/diff",
      describeRoute({
        summary: "Get VCS diff",
        description: "Retrieve the current git diff for the working tree or against the default branch.",
        operationId: "vcs.diff",
        responses: {
          200: {
            description: "VCS diff",
            content: {
              "application/json": {
                schema: resolver(Vcs.FileDiff.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          mode: Vcs.Mode,
        }),
      ),
      async (c) =>
        jsonRequest("InstanceRoutes.vcs.diff", c, function* () {
          const vcs = yield* Vcs.Service
          return yield* vcs.diff(c.req.valid("query").mode)
        }),
    )
    .get(
      "/command",
      describeRoute({
        summary: "List commands",
        description: "Get a list of all available commands in the DuoDuoCode system.",
        operationId: "command.list",
        responses: {
          200: {
            description: "List of commands",
            content: {
              "application/json": {
                schema: resolver(Command.Info.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("InstanceRoutes.command.list", c, function* () {
          const svc = yield* Command.Service
          return yield* svc.list()
        }),
    )
    .get(
      "/agent",
      describeRoute({
        summary: "List agents",
        description: "Get a list of all available AI agents in the DuoDuoCode system.",
        operationId: "app.agents",
        responses: {
          200: {
            description: "List of agents",
            content: {
              "application/json": {
                schema: resolver(Agent.Info.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("InstanceRoutes.agent.list", c, function* () {
          const svc = yield* Agent.Service
          return yield* svc.list()
        }),
    )
    .get(
      "/skill",
      describeRoute({
        summary: "List skills",
        description: "Get a list of all available skills in the DuoDuoCode system.",
        operationId: "app.skills",
        responses: {
          200: {
            description: "List of skills",
            content: {
              "application/json": {
                schema: resolver(Skill.Info.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("InstanceRoutes.skill.list", c, function* () {
          const skill = yield* Skill.Service
          return yield* skill.all()
        }),
    )
    .get(
      "/lsp",
      describeRoute({
        summary: "Get LSP status",
        description: "Get LSP server status",
        operationId: "lsp.status",
        responses: {
          200: {
            description: "LSP server status",
            content: {
              "application/json": {
                schema: resolver(LSP.Status.zod.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("InstanceRoutes.lsp.status", c, function* () {
          const lsp = yield* LSP.Service
          return yield* lsp.status()
        }),
    )
    .post(
      "/lsp/touch",
      describeRoute({
        summary: "Touch an LSP file (warm-up)",
        description:
          "Trigger LSP server spawn/indexing for the project containing the given file. Used for background warm-up so the LSP tool is ready before first use. Safe to call repeatedly (idempotent).",
        operationId: "lsp.touch",
        responses: {
          200: {
            description: "Touch accepted",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean(), scheduled: z.number() })),
              },
            },
          },
        },
      }),
      async (c) => {
        const body = await c.req.json<{ directory?: string }>().catch(() => ({ directory: undefined }))
        const directory = body.directory
        return jsonRequest("InstanceRoutes.lsp.touch", c, function* () {
          const lsp = yield* LSP.Service
          const dir = directory || (yield* InstanceState.context).directory
          // warmDirectory 的同步部分（代表文件收集）很快即可完成，spawn
          // 在其内部 forkDetach；直接等待返回值以把 scheduled 回传给前端
          const scheduled = yield* lsp.warmDirectory(dir)
          return { ok: true as const, scheduled }
        })
      },
    )
    .post(
      "/lsp/retry",
      describeRoute({
        summary: "Retry a failed LSP server",
        description:
          "Clear a server's broken marker and re-attempt spawn/indexing for its project root. Used by the status indicator's retry action.",
        operationId: "lsp.retry",
        responses: {
          200: {
            description: "Retry accepted",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
        },
      }),
      async (c) => {
        const body = await c.req.json<{ root: string; id: string }>().catch(() => ({ root: "", id: "" }))
        if (!body.root || !body.id) return c.json({ ok: false, error: "missing root or id" }, 400)
        const { root, id } = body
        return jsonRequest("InstanceRoutes.lsp.retry", c, function* () {
          const lsp = yield* LSP.Service
          yield* lsp.retry(root, id)
          yield* lsp.warmDirectory(root).pipe(Effect.ignore, Effect.forkDetach)
          return { ok: true as const }
        })
      },
    )
    .get(
      "/formatter",
      describeRoute({
        summary: "Get formatter status",
        description: "Get formatter status",
        operationId: "formatter.status",
        responses: {
          200: {
            description: "Formatter status",
            content: {
              "application/json": {
                schema: resolver(Format.Status.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("InstanceRoutes.formatter.status", c, function* () {
          const svc = yield* Format.Service
          return yield* svc.status()
        }),
    )
}
