import { Hono } from "hono"
import { stream } from "hono/streaming"
import { describeRoute, validator, resolver } from "hono-openapi"
import { SessionID, MessageID, PartID } from "@/session/schema"
import z from "zod"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { Command } from "@/command"
import { Log } from "@/util"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { Bus } from "@/bus"
import { NamedError } from "@duoduo-ai/shared/util/error"
import { jsonRequest, runRequest } from "./trace"
import { AppRuntime } from "@/effect/app-runtime"
import { Instance } from "@/project/instance"
import { createSmartLayerClients } from "@/smart-layer"

const log = Log.create({ service: "server" })

export const SessionRoutes = lazy(() =>
  new Hono()
    .patch(
      "/cascade-qa",
      describeRoute({
        summary: "Update cascade QA setting globally",
        description:
          "Update the cascade quality assurance setting for all sessions in real-time, taking effect on the next loop step.",
        operationId: "session.updateCascadeQAGlobal",
        responses: {
          200: {
            description: "Cascade QA setting updated",
            content: {
              "application/json": {
                schema: resolver(z.object({ cascadeQA: z.boolean() })),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ cascadeQA: z.boolean() })),
      async (c) =>
        jsonRequest("SessionRoutes.updateCascadeQAGlobal", c, function* () {
          const body = c.req.valid("json")
          SessionPrompt.setCascadeQAGlobal(body.cascadeQA)
          return { cascadeQA: body.cascadeQA }
        }),
    )
    .get(
      "/",
      describeRoute({
        summary: "List sessions",
        description: "Get a list of all DuoDuoCode sessions, sorted by most recently updated.",
        operationId: "session.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional().meta({ description: "Filter sessions by project directory" }),
          roots: z.coerce.boolean().optional().meta({ description: "Only return root sessions (no parentID)" }),
          start: z.coerce
            .number()
            .optional()
            .meta({ description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)" }),
          search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
          limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const sessions: Session.Info[] = []
        // oxlint-disable-next-line await-thenable -- oxlint span misattribution; await target is a valid thenable
        for await (const session of Session.list({
          directory: query.directory,
          roots: query.roots,
          start: query.start,
          search: query.search,
          limit: query.limit,
        })) {
          sessions.push(session)
        }
        return c.json(sessions)
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Get session status",
        description: "Retrieve the current status of all sessions, including active, idle, and completed states.",
        operationId: "session.status",
        responses: {
          200: {
            description: "Get session status",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), SessionStatus.Info)),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) =>
        jsonRequest("SessionRoutes.status", c, function* () {
          const svc = yield* SessionStatus.Service
          return Object.fromEntries(yield* svc.list())
        }),
    )
    .get(
      "/:sessionID",
      describeRoute({
        summary: "Get session",
        description: "Retrieve detailed information about a specific DuoDuoCode session.",
        tags: ["Session"],
        operationId: "session.get",
        responses: {
          200: {
            description: "Get session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.GetInput,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        return jsonRequest("SessionRoutes.get", c, function* () {
          const session = yield* Session.Service
          return yield* session.get(sessionID)
        })
      },
    )
    .get(
      "/:sessionID/children",
      describeRoute({
        summary: "Get session children",
        tags: ["Session"],
        description: "Retrieve all child sessions that were forked from the specified parent session.",
        operationId: "session.children",
        responses: {
          200: {
            description: "List of children",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.ChildrenInput,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        return jsonRequest("SessionRoutes.children", c, function* () {
          const session = yield* Session.Service
          return yield* session.children(sessionID)
        })
      },
    )
    .get(
      "/:sessionID/todo",
      describeRoute({
        summary: "Get session todos",
        description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
        operationId: "session.todo",
        responses: {
          200: {
            description: "Todo list",
            content: {
              "application/json": {
                schema: resolver(Todo.Info.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        return jsonRequest("SessionRoutes.todo", c, function* () {
          const todo = yield* Todo.Service
          return yield* todo.get(sessionID)
        })
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create session",
        description: "Create a new DuoDuoCode session for interacting with AI assistants and managing conversations.",
        operationId: "session.create",
        responses: {
          ...errors(400),
          200: {
            description: "Successfully created session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
        },
      }),
      validator("json", Session.CreateInput),
      async (c) =>
        jsonRequest("SessionRoutes.create", c, function* () {
          const body = c.req.valid("json") ?? {}
          const svc = yield* Session.Service
          return yield* svc.create(body)
        }),
    )
    .delete(
      "/:sessionID",
      describeRoute({
        summary: "Delete session",
        description: "Delete a session and permanently remove all associated data, including messages and history.",
        operationId: "session.delete",
        responses: {
          200: {
            description: "Successfully deleted session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.RemoveInput,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.delete", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const svc = yield* Session.Service
          yield* svc.remove(sessionID)
          return true
        }),
    )
    .patch(
      "/:sessionID",
      describeRoute({
        summary: "Update session",
        description: "Update properties of an existing session, such as title or other metadata.",
        operationId: "session.update",
        responses: {
          200: {
            description: "Successfully updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          title: z.string().optional(),
          permission: Permission.Ruleset.zod.optional(),
          time: z
            .object({
              archived: z.number().optional(),
            })
            .optional(),
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.update", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const updates = c.req.valid("json")
          const session = yield* Session.Service
          const current = yield* session.get(sessionID)

          if (updates.title !== undefined) {
            yield* session.setTitle({ sessionID, title: updates.title })
          }
          if (updates.permission !== undefined) {
            yield* session.setPermission({
              sessionID,
              permission: Permission.merge(current.permission ?? [], updates.permission),
            })
          }
          if (updates.time?.archived !== undefined) {
            yield* session.setArchived({ sessionID, time: updates.time.archived })
          }

          return yield* session.get(sessionID)
        }),
    )
    // Deprecated: use the normal `/init` command flow instead.
    .post(
      "/:sessionID/init",
      describeRoute({
        summary: "Initialize session",
        description:
          "Analyze the current application and create an AGENTS.md file with project-specific agent configurations.",
        operationId: "session.init",
        deprecated: true,
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          modelID: ModelID.zod,
          providerID: ProviderID.zod,
          messageID: MessageID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.init", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const svc = yield* SessionPrompt.Service
          yield* svc.command({
            sessionID,
            messageID: body.messageID,
            model: body.providerID + "/" + body.modelID,
            command: Command.Default.INIT,
            arguments: "",
          })
          return true
        }),
    )
    .post(
      "/:sessionID/fork",
      describeRoute({
        summary: "Fork session",
        description: "Create a new session by forking an existing session at a specific message point.",
        operationId: "session.fork",
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.ForkInput.shape.sessionID,
        }),
      ),
      validator("json", Session.ForkInput.omit({ sessionID: true })),
      async (c) =>
        jsonRequest("SessionRoutes.fork", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const svc = yield* Session.Service
          return yield* svc.fork({ ...body, sessionID })
        }),
    )
    .post(
      "/:sessionID/abort",
      describeRoute({
        summary: "Abort session",
        description: "Abort an active session and stop any ongoing AI processing or command execution.",
        operationId: "session.abort",
        responses: {
          200: {
            description: "Aborted session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.abort", c, function* () {
          const rootID = c.req.valid("param").sessionID
          const svc = yield* SessionPrompt.Service
          const sessions = yield* Session.Service

          // Collect the full set of sessions to cancel: the target plus ALL its
          // descendants (sub-sessions spawned via the `task` tool, which records
          // `parentID`). This ensures aborting the PARENT also stops every
          // delegated explore/codegen child — the original "stop works first
          // time, but not during explore" bug: the parent was cancelled while its
          // child run_loop kept running because it owns an independent Rust
          // run_loop token that the parent's cancel never touched.
          //
          // Revised: we NO LONGER walk UP to ancestors. The previous up-walk made
          // stopping a sub-agent card (onHaltSubSession) silently kill the parent
          // build session's run_loop too — a mid-reply "LLM streaming request
          // cancelled" from the user's point of view. Down-only is the correct
          // semantics: stopping a session stops it and everything it spawned;
          // stopping a child leaves the parent in charge of handling the child's
          // interrupted tool result.
          const visited = new Set<SessionID>([rootID])
          const subtree: SessionID[] = [rootID]
          const stack: SessionID[] = [rootID]
          while (stack.length > 0) {
            const id = stack.pop()!
            const kids = yield* sessions.children(id)
            for (const k of kids) {
              if (!visited.has(k.id)) {
                visited.add(k.id)
                subtree.push(k.id)
                stack.push(k.id)
              }
            }
          }

          // Stop the TS poll loops for the whole subtree.
          for (const id of subtree) {
            yield* svc.cancel(id)
          }

          const smartLayer = createSmartLayerClients()
          if (smartLayer) {
            for (const id of subtree) {
              // Release the project task lock so new prompts can run
              yield* Effect.promise(() =>
                smartLayer.client
                  .post("/task/release", {
                    projectPath: Instance.directory,
                    taskId: id,
                    state: "cancelled",
                  })
                  .catch((e) => log.error("abort: /task/release failed", { sessionID: id, error: String(e) })),
              )
              // Cancel the Rust runLoop's CancellationToken so the
              // background tokio::spawn task stops promptly instead of
              // continuing to completion after the TS poll loop exits.
              // Failures must be visible (never silently swallowed) so an
              // unstoppable background task is diagnosable via the logs.
              yield* Effect.promise(() =>
                smartLayer.agent
                  .cancelRunLoop(id)
                  .catch((e) => log.error("abort: cancelRunLoop failed", { sessionID: id, error: String(e) })),
              )
            }
          } else {
            // The background runLoop is always started through the smart layer, so its
            // URL must have been discoverable. If it isn't here, the background tokio
            // task cannot be cancelled and will keep running — record this instead of
            // silently ignoring it.
            log.error(
              "abort: smartLayer unavailable — cannot cancel Rust runLoop; background tasks may keep running",
              { sessionID: rootID },
            )
          }
          return true
        }),
    )
    .get(
      "/:sessionID/diff",
      describeRoute({
        summary: "Get message diff",
        description: "Get the file changes (diff) that resulted from a specific user message in the session.",
        operationId: "session.diff",
        responses: {
          200: {
            description: "Successfully retrieved diff",
            content: {
              "application/json": {
                schema: resolver(Snapshot.FileDiff.zod.array()),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionSummary.DiffInput.shape.sessionID,
        }),
      ),
      validator(
        "query",
        z.object({
          messageID: SessionSummary.DiffInput.shape.messageID,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.diff", c, function* () {
          const query = c.req.valid("query")
          const params = c.req.valid("param")
          const summary = yield* SessionSummary.Service
          return yield* summary.diff({
            sessionID: params.sessionID,
            messageID: query.messageID,
          })
        }),
    )
    .post(
      "/:sessionID/summarize",
      describeRoute({
        summary: "Summarize session",
        description: "Generate a concise summary of the session using AI compaction to preserve key information.",
        operationId: "session.summarize",
        responses: {
          200: {
            description: "Summarized session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          providerID: ProviderID.zod,
          modelID: ModelID.zod,
          auto: z.boolean().optional().default(false),
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.summarize", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const compact = yield* SessionCompaction.Service
          const prompt = yield* SessionPrompt.Service
          const agent = yield* Agent.Service

          yield* revert.cleanup(yield* session.get(sessionID))
          const msgs = yield* session.messages({ sessionID })
          const defaultAgent = yield* agent.defaultAgent()
          let currentAgent = defaultAgent
          for (let i = msgs.length - 1; i >= 0; i--) {
            const info = msgs[i]!.info
            if (info.role === "user") {
              currentAgent = info.agent || defaultAgent
              break
            }
          }

          yield* compact.create({
            sessionID,
            agent: currentAgent,
            model: {
              providerID: body.providerID,
              modelID: body.modelID,
            },
            auto: body.auto,
          })
          yield* prompt.runAgentTurn({ sessionID })
          return true
        }),
    )
    .get(
      "/:sessionID/message",
      describeRoute({
        summary: "Get session messages",
        description: "Retrieve all messages in a session, including user prompts and AI responses.",
        operationId: "session.messages",
        responses: {
          200: {
            description: "List of messages",
            content: {
              "application/json": {
                schema: resolver(MessageV2.WithParts.zod.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "query",
        z
          .object({
            limit: z.coerce
              .number()
              .int()
              .min(0)
              .optional()
              .meta({ description: "Maximum number of messages to return" }),
            before: z
              .string()
              .optional()
              .meta({ description: "Opaque cursor for loading older messages" })
              .refine(
                (value) => {
                  if (!value) return true
                  try {
                    MessageV2.cursor.decode(value)
                    return true
                  } catch {
                    return false
                  }
                },
                { message: "Invalid cursor" },
              ),
          })
          .refine((value) => !value.before || value.limit !== undefined, {
            message: "before requires limit",
            path: ["before"],
          }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const sessionID = c.req.valid("param").sessionID
        if (query.limit === undefined || query.limit === 0) {
          const messages = await runRequest(
            "SessionRoutes.messages",
            c,
            Effect.gen(function* () {
              const session = yield* Session.Service
              yield* session.get(sessionID)
              return yield* session.messages({ sessionID })
            }),
          )
          return c.json(messages)
        }

        // oxlint-disable-next-line await-thenable -- oxlint span misattribution; await target is a valid thenable
        const page = await MessageV2.page({
          sessionID,
          limit: query.limit,
          before: query.before,
        })
        if (page.cursor) {
          const url = new URL(c.req.url)
          url.searchParams.set("limit", query.limit.toString())
          url.searchParams.set("before", page.cursor)
          c.header("Access-Control-Expose-Headers", "Link, X-Next-Cursor")
          c.header("Link", `<${url.toString()}>; rel="next"`)
          c.header("X-Next-Cursor", page.cursor)
        }
        return c.json(page.items)
      },
    )
    .get(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Get message",
        description: "Retrieve a specific message from a session by its message ID.",
        operationId: "session.message",
        responses: {
          200: {
            description: "Message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Info.zod,
                    parts: MessageV2.Part.zod.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        // oxlint-disable-next-line await-thenable -- oxlint span misattribution; await target is a valid thenable
        const message = await MessageV2.get({
          sessionID: params.sessionID,
          messageID: params.messageID,
        })
        return c.json(message)
      },
    )
    .delete(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Delete message",
        description:
          "Permanently delete a specific message (and all of its parts) from a session. This does not revert any file changes that may have been made while processing the message.",
        operationId: "session.deleteMessage",
        responses: {
          200: {
            description: "Successfully deleted message",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.deleteMessage", c, function* () {
          const params = c.req.valid("param")
          const state = yield* SessionRunState.Service
          const session = yield* Session.Service
          yield* state.assertNotBusy(params.sessionID)
          yield* session.removeMessage({
            sessionID: params.sessionID,
            messageID: params.messageID,
          })
          return true
        }),
    )
    .delete(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Delete a part from a message",
        operationId: "part.delete",
        responses: {
          200: {
            description: "Successfully deleted part",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
          partID: PartID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.deletePart", c, function* () {
          const params = c.req.valid("param")
          const svc = yield* Session.Service
          yield* svc.removePart({
            sessionID: params.sessionID,
            messageID: params.messageID,
            partID: params.partID,
          })
          return true
        }),
    )
    .patch(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Update a part in a message",
        operationId: "part.update",
        responses: {
          200: {
            description: "Successfully updated part",
            content: {
              "application/json": {
                schema: resolver(MessageV2.Part.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          messageID: MessageID.zod,
          partID: PartID.zod,
        }),
      ),
      validator("json", MessageV2.Part.zod),
      async (c) => {
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        if (body.id !== params.partID || body.messageID !== params.messageID || body.sessionID !== params.sessionID) {
          throw new Error(
            `Part mismatch: body.id='${body.id}' vs partID='${params.partID}', body.messageID='${body.messageID}' vs messageID='${params.messageID}', body.sessionID='${body.sessionID}' vs sessionID='${params.sessionID}'`,
          )
        }
        return jsonRequest("SessionRoutes.updatePart", c, function* () {
          const svc = yield* Session.Service
          return yield* svc.updatePart(body)
        })
      },
    )
    .post(
      "/:sessionID/message",
      describeRoute({
        summary: "Send message",
        description: "Create and send a new message to a session, streaming the AI response.",
        operationId: "session.prompt",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant.zod,
                    parts: MessageV2.Part.zod.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.PromptInput.omit({ sessionID: true })),
      async (c) => {
        c.status(200)
        c.header("Content-Type", "application/json")
        return stream(c, async (stream) => {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const msg = await runRequest(
            "SessionRoutes.prompt",
            c,
            SessionPrompt.Service.use((svc) =>
              svc.prompt({ ...body, sessionID } as unknown as SessionPrompt.PromptInput),
            ),
          )
          void stream.write(JSON.stringify(msg))
        })
      },
    )
    .post(
      "/:sessionID/prompt_async",
      describeRoute({
        summary: "Send async message",
        description:
          "Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.",
        operationId: "session.prompt_async",
        responses: {
          204: {
            description: "Prompt accepted",
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.PromptInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const promptT0 = Date.now()
        process.stderr.write(`[TRACE-route] ⓪ prompt_async received, sessionID=${sessionID}\n`)
        const smartLayer = createSmartLayerClients()
        const taskId = sessionID
        if (smartLayer) {
          const acquire = await smartLayer.client.post<{ success: boolean; error?: string }>("/task/acquire", {
            projectPath: Instance.directory,
            taskId,
            source: "ide",
            sessionId: sessionID,
            // Fail-fast: if the project already has a running task, return 409
            // immediately instead of queuing/blocking this prompt.
            timeout: 0,
            summary:
              typeof body.parts?.find((p: any) => p.type === "text")?.text === "string"
                ? (body.parts.find((p: any) => p.type === "text") as any).text.slice(0, 120)
                : undefined,
          })
          process.stderr.write(`[PERF] ${Date.now() - promptT0}ms: task/acquire done\n`)
          if (!acquire.success) {
            return c.json(
              new NamedError.Unknown({ message: acquire.error ?? "Project task queue acquire failed" }).toObject(),
              409,
            )
          }
        }
        // Cancel any in-progress LLM processing before sending the new prompt.
        // Without this, ensureRunning() in the Runner will queue the new prompt
        // behind the current one, causing the old task to complete before the
        // new question is addressed — the user expects the new question to take
        // priority immediately after sending it.
        void AppRuntime.runPromise(SessionRunState.Service.use((svc) => svc.cancel(sessionID))).catch((err) => {
          log.error("failed to cancel session before prompt_async", { sessionID, error: err })
        })
        void runRequest(
          "SessionRoutes.prompt_async",
          c,
          SessionPrompt.Service.use((svc) =>
            svc.prompt({ ...body, sessionID } as unknown as SessionPrompt.PromptInput),
          ),
        ).catch((err) => {
          process.stderr.write(
            `[TRACE-route] ✗ prompt_async caught error: typeof=${typeof err}, isErr=${err instanceof Error}, val=${String(err)}, keys=${typeof err === "object" && err !== null ? Object.keys(err).join(",") : "N/A"}\n`,
          )
          log.error("prompt_async failed", { sessionID, error: err })
          if (smartLayer) {
            void smartLayer.client
              .post("/task/release", {
                projectPath: Instance.directory,
                taskId,
                state: "failed",
              })
              .catch((releaseErr) => {
                log.error("failed to release project task after prompt_async failure", { sessionID, error: releaseErr })
              })
          }
          // Preserve NamedError structure when the error already contains
          // proper name + data (e.g. from prompt.ts wrapping). Without this,
          // NamedError instances lose their inner data.message because
          // Error.message is set to the class name ("UnknownError") rather
          // than the wrapped descriptive message.
          const errorObj =
            typeof err === "object" && err !== null && typeof (err).toObject === "function"
              ? (err).toObject()
              : new NamedError.Unknown({ message: err instanceof Error ? err.message : String(err) }).toObject()
          process.stderr.write(`[TRACE-route] ✗ publishing session.error: errorObj=${JSON.stringify(errorObj)}\n`)
          void Bus.publish(Session.Event.Error, {
            sessionID,
            error: errorObj,
          })
          // Ensure the session status is reset to idle so the frontend
          // clears its optimistic busy state. Without this, the UI
          // gets stuck showing the stop button indefinitely.
          // Use SessionRunState.cancel which sets status to idle and
          // cleans up the runner entry.
          void AppRuntime.runPromise(SessionRunState.Service.use((svc) => svc.cancel(sessionID))).catch((cancelErr) => {
            log.error("failed to cancel session after prompt_async failure", { sessionID, error: cancelErr })
          })
        })

        return c.body(null, 204)
      },
    )
    .post(
      "/:sessionID/command",
      describeRoute({
        summary: "Send command",
        description: "Send a new command to a session for execution by the AI assistant.",
        operationId: "session.command",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant.zod,
                    parts: MessageV2.Part.zod.array(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.CommandInput.omit({ sessionID: true })),
      async (c) =>
        jsonRequest("SessionRoutes.command", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const svc = yield* SessionPrompt.Service
          return yield* svc.command({ ...body, sessionID })
        }),
    )
    .post(
      "/:sessionID/shell",
      describeRoute({
        summary: "Run shell command",
        description: "Execute a shell command within the session context and return the AI's response.",
        operationId: "session.shell",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(MessageV2.WithParts.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.ShellInput.omit({ sessionID: true })),
      async (c) =>
        jsonRequest("SessionRoutes.shell", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const svc = yield* SessionPrompt.Service
          return yield* svc.shell({ ...body, sessionID })
        }),
    )
    .post(
      "/:sessionID/revert",
      describeRoute({
        summary: "Revert message",
        description: "Revert a specific message in a session, undoing its effects and restoring the previous state.",
        operationId: "session.revert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionRevert.RevertInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        log.info("revert", c.req.valid("json"))
        return jsonRequest("SessionRoutes.revert", c, function* () {
          const svc = yield* SessionRevert.Service
          return yield* svc.revert({
            sessionID,
            ...c.req.valid("json"),
          })
        })
      },
    )
    .post(
      "/:sessionID/unrevert",
      describeRoute({
        summary: "Restore reverted messages",
        description: "Restore all previously reverted messages in a session.",
        operationId: "session.unrevert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("SessionRoutes.unrevert", c, function* () {
          const sessionID = c.req.valid("param").sessionID
          const svc = yield* SessionRevert.Service
          return yield* svc.unrevert({ sessionID })
        }),
    )
    .post(
      "/:sessionID/permissions/:permissionID",
      describeRoute({
        summary: "Respond to permission",
        deprecated: true,
        description: "Approve or deny a permission request from the AI assistant.",
        operationId: "permission.respond",
        responses: {
          200: {
            description: "Permission processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          permissionID: PermissionID.zod,
        }),
      ),
      validator("json", z.object({ response: Permission.Reply.zod })),
      async (c) =>
        jsonRequest("SessionRoutes.permissionRespond", c, function* () {
          const params = c.req.valid("param")
          const svc = yield* Permission.Service
          yield* svc.reply({
            requestID: params.permissionID,
            reply: c.req.valid("json").response,
          })
          return true
        }),
    )
    .patch(
      "/:sessionID/cascade-qa",
      describeRoute({
        summary: "Update cascade QA setting",
        description:
          "Update the cascade quality assurance setting for a session in real-time, taking effect on the next loop step.",
        operationId: "session.updateCascadeQA",
        responses: {
          200: {
            description: "Cascade QA setting updated",
            content: {
              "application/json": {
                schema: resolver(z.object({ cascadeQA: z.boolean() })),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", z.object({ cascadeQA: z.boolean() })),
      async (c) =>
        jsonRequest("SessionRoutes.updateCascadeQA", c, function* () {
          const params = c.req.valid("param")
          const body = c.req.valid("json")
          SessionPrompt.setCascadeQA(params.sessionID, body.cascadeQA)
          return { cascadeQA: body.cascadeQA }
        }),
    ),
)
