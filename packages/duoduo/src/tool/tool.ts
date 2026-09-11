import { DuoduoError } from "@/util/error"
import z from "zod"
import { Effect } from "effect"
import type { MessageV2 } from "../session/message-v2"
import type { Permission } from "../permission"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { Agent } from "@/agent/agent"

interface Metadata {
  [key: string]: any
}

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  messages: MessageV2.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void, unknown, unknown>
  ask(input: Omit<Permission.Request, "id" | "sessionID" | "tool">): Effect.Effect<void, unknown, unknown>
}

export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
}

export interface Def<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
  id: string
  description: string
  parameters: Parameters
  execute(args: z.infer<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>, unknown, unknown>
  formatValidationError?(error: z.ZodError): string
}
export type DefWithoutID<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> = Omit<
  Def<Parameters, M>,
  "id"
>

export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
  id: string
  init: () => Effect.Effect<DefWithoutID<Parameters, M>>
}

type Init<Parameters extends z.ZodType, M extends Metadata> =
  | (Omit<Def<Parameters, M>, "id" | "execute"> & {
      execute(args: z.infer<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>, any, any>
    })
  | (() => Effect.Effect<
      Omit<Def<Parameters, M>, "id" | "execute"> & {
        execute(args: z.infer<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>, any, any>
      },
      any,
      any
    >)

export type InferParameters<T> =
  T extends Info<infer P, any> ? z.infer<P> : T extends Effect.Effect<Info<infer P, any>, any, any> ? z.infer<P> : never
export type InferMetadata<T> =
  T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

export type InferDef<T> =
  T extends Info<infer P, infer M>
    ? Def<P, M>
    : T extends Effect.Effect<Info<infer P, infer M>, any, any>
      ? Def<P, M>
      : never

function wrap<Parameters extends z.ZodType, Result extends Metadata>(
  id: string,
  init: Init<Parameters, Result>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
) {
  return () =>
    Effect.gen(function* () {
      const toolInfo = typeof init === "function" ? { ...(yield* init()) } : { ...init }
      // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
      const execute = toolInfo.execute as (
        args: z.infer<Parameters>,
        ctx: Context,
      ) => Effect.Effect<ExecuteResult<Result>, any, any>
      toolInfo.execute = (args, ctx): Effect.Effect<ExecuteResult<Result>> => {
        const attrs = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }
        return Effect.gen(function* () {
          yield* Effect.try({
            try: () => toolInfo.parameters.parse(args),
            catch: (error) => {
              if (error instanceof z.ZodError && toolInfo.formatValidationError) {
                return new DuoduoError({ message: String(toolInfo.formatValidationError(error)), cause: error })
              }
              return new DuoduoError({ message: String(`The ${id} tool was called with invalid arguments: ${error}.\nPlease rewrite the input so it satisfies the expected schema.`), messageZh: String(`调用 ${id} 工具时参数无效：${error}。\n请重写输入以符合预期的 schema。`), cause: error })
            },
          })
          const start = Date.now()
          const result = yield* execute(args, ctx).pipe(
            Effect.tap((r) =>
              Effect.logInfo("tool.execute", {
                name: id,
                duration: Date.now() - start,
                status: "success",
                sessionID: ctx.sessionID,
              }),
            ),
            Effect.tapError((e) =>
              Effect.logError("tool.execute", {
                name: id,
                duration: Date.now() - start,
                status: "error",
                error: e instanceof Error ? e.message : String(e),
                sessionID: ctx.sessionID,
              }),
            ),
          )
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(result.output, {}, agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }).pipe(Effect.orDie, Effect.withSpan("Tool.execute", { attributes: attrs })) as Effect.Effect<
          ExecuteResult<Result>
        >
      }
      return toolInfo as DefWithoutID<Parameters, Result>
    })
}

export function define<Parameters extends z.ZodType, Result extends Metadata, R, ID extends string = string>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & { id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* init as Effect.Effect<Init<Parameters, Result>>
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      return { id, init: wrap(id, resolved, truncate, agents) } as unknown as Info<Parameters, Result>
    }),
    { id },
  )
}

export function init<P extends z.ZodType, M extends Metadata>(info: Info<P, M>): Effect.Effect<Def<P, M>> {
  return Effect.gen(function* () {
    const init = yield* info.init()
    return {
      ...init,
      id: info.id,
    }
  })
}
