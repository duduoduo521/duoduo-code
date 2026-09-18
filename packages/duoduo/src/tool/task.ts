import { DuoduoError } from "@/util/error"
import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "../config"
import { getCascadeQA } from "@/session/cascade-qa-registry"
import { NotFoundError } from "@/storage"
import { Cause, Effect } from "effect"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"], unknown, unknown>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts, unknown, unknown>
}

const id = "task"

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  // [P-04] Resource cap: wall-clock limit for the sub-agent run. Without it a
  // runaway sub-task can only be stopped by cancelling the whole parent run.
  max_duration_minutes: z
    .number()
    .int()
    .min(1)
    .max(120)
    .describe(
      "Maximum number of minutes the sub-task may run before it is cancelled (1-120). When omitted, no wall-clock limit is applied. Partial progress stays in the sub-session and can be resumed via task_id.",
    )
    .optional(),
})

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("TaskTool.execute")(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
      const cfg = yield* config.get()

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
        return yield* Effect.fail(new DuoduoError({ message: String(`Unknown agent type: ${params.subagent_type} is not a valid agent type`), messageZh: String(`未知的智能体类型：${params.subagent_type} 不是有效的类型`), cause: undefined }))
      }

      // Guard with ?. + ?? false: some agents (e.g. user-defined or built-in
      // without explicit permission rules) have permission === undefined.
      // Without this, .some() throws "undefined is not an object" and the
      // whole task tool fails — which previously stayed hidden because the
      // LLM never called task before the system-prompt fix (修改 1).
      const canTask = next.permission?.some((rule) => rule.permission === id) ?? false
      const canTodo = next.permission?.some((rule) => rule.permission === "todowrite") ?? false

      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(
            // P1-9: only "not found" may be swallowed (→ falls through to
            // create below). Any other failure (DB transient, etc.) must not
            // silently degrade into creating a brand-new session — that turned
            // a recoverable resume into silent data forking.
            Effect.catchCause((c) => {
              const err = Cause.squash(c)
              if (NotFoundError.isInstance(err)) return Effect.void
              return Effect.die(err)
            }),
          )
        : undefined

      // P1-9: a resumable task session must belong to THIS parent session.
      // Without this check, a hallucinated or injected task_id resumes and
      // writes into any other session the model can name.
      if (session && session.parentID !== ctx.sessionID) {
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
        return yield* Effect.fail(
          new DuoduoError({
            message: `task_id ${params.task_id} does not belong to this session`,
            messageZh: `task_id ${params.task_id} 不属于当前会话`,
            cause: undefined,
          }),
        )
      }
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          permission: [
            ...(canTodo
              ? []
              : [
                  {
                    permission: "todowrite" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(canTask
              ? []
              : [
                  {
                    permission: id,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
        }))

      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
      if (msg.info.role !== "assistant") return yield* Effect.fail(new DuoduoError({ message: "Not an assistant message", messageZh: "不是助手消息", cause: undefined }))

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      yield* ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: nextSession.id,
          model,
        },
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
      if (!ops) return yield* Effect.fail(new DuoduoError({ message: "TaskTool requires promptOps in ctx.extra", messageZh: "TaskTool 需要 ctx.extra 中的 promptOps", cause: undefined }))

      const messageID = MessageID.ascending()

      function cancel() {
        ops.cancel(nextSession.id)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", cancel)
        }),
        () =>
          Effect.gen(function* () {
            const parts = yield* ops.resolvePromptParts(params.prompt)
            const promptID = typeof ctx.extra?.promptID === "string" ? ctx.extra.promptID : undefined
            const promptEffect = ops.prompt({
              messageID,
              sessionID: nextSession.id,
              ...(promptID ? { promptID, blackboardOwner: false } : {}),
              model: {
                modelID: model.modelID,
                providerID: model.providerID,
              },
              agent: next.name,
              // [P0-2] Sub-sessions inherit the parent's cascade QA state so
              // "per-session 级联" also covers batch task writes (global
              // default is read inside getCascadeQA when the parent has no
              // explicit per-session override — behavior identical to
              // "inherit global").
              cascadeQA: getCascadeQA(ctx.sessionID),
              tools: {
                ...(canTodo ? {} : { todowrite: false }),
                ...(canTask ? {} : { task: false }),
                ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
              },
              parts,
            })

            // [P-04] Enforce the optional wall-clock cap: race the sub-agent
            // prompt against a timer. On timeout, cancel the sub-session (its
            // partial progress is already persisted) and report a resumable
            // result instead of running unbounded.
            const TIMED_OUT = "__task_max_duration_exceeded__" as const
            const result = params.max_duration_minutes
              ? yield* Effect.raceFirst(
                  promptEffect,
                  Effect.sleep(`${params.max_duration_minutes} minutes`).pipe(Effect.map(() => TIMED_OUT)),
                )
              : yield* promptEffect

            if (result === TIMED_OUT) {
              yield* Effect.sync(() => ops.cancel(nextSession.id))
              return {
                title: params.description,
                metadata: {
                  sessionId: nextSession.id,
                  model,
                },
                output: [
                  `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
                  "",
                  "<task_result>",
                  `Sub-task cancelled: exceeded max_duration_minutes=${params.max_duration_minutes}. Partial progress is saved in the sub-session; pass task_id to resume.`,
                  "</task_result>",
                ].join("\n"),
              }
            }

            return {
              title: params.description,
              metadata: {
                sessionId: nextSession.id,
                model,
              },
              output: [
                `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
                "",
                "<task_result>",
                result.parts.findLast((item) => item.type === "text")?.text ?? "",
                "</task_result>",
              ].join("\n"),
            }
          }),
        () =>
          Effect.sync(() => {
            ctx.abort.removeEventListener("abort", cancel)
          }),
      )
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
