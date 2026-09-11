import { Cause, Deferred, Effect, Layer, Context, Scope } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config"
import { FileWatcher } from "@/file/watcher"
import { Permission } from "@/permission"
import { Snapshot } from "@/snapshot"
import * as Session from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow, extractContextWindowFromError, persistDiscoveredContextWindow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider"
import { isOverflowErrorText } from "@/provider/error"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { Log } from "@/util"
import { isRecord } from "@/util/record"

const log = Log.create({ service: "session.processor" })

// AI SDK v6's fullStream union type doesn't declare providerMetadata/providerExecuted
// on some event variants, but these fields exist at runtime. This helper safely
// accesses them without changing runtime behavior (all call sites already have
// if-guards or optional chaining).
function providerMeta(value: Record<string, unknown>): Record<string, unknown> | undefined {
  return (value as { providerMetadata?: Record<string, unknown> }).providerMetadata
}
function providerExecuted(value: Record<string, unknown>): boolean {
  return (value as { providerExecuted?: boolean }).providerExecuted === true
}

export type Result = "compact" | "stop" | "continue"

export type Event = LLM.Event

export interface Handle {
  readonly message: MessageV2.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
  ) => Effect.Effect<MessageV2.ToolPart | undefined, unknown, unknown>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: MessageV2.FilePart[]
    },
  ) => Effect.Effect<void, unknown, unknown>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result, unknown, unknown>
}

type Input = {
  assistantMessage: MessageV2.Assistant
  sessionID: SessionID
  model: Provider.Model
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle, unknown, unknown>
}

type ToolCall = {
  partID: MessageV2.ToolPart["id"]
  messageID: MessageV2.ToolPart["messageID"]
  sessionID: MessageV2.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: MessageV2.TextPart | undefined
  reasoningMap: Record<string, MessageV2.ReasoningPart>
  deltaBuffer: string
  deltaFlushTimer: ReturnType<typeof setTimeout> | undefined
  reasoningBufferMap: Record<string, { buffer: string; timer: ReturnType<typeof setTimeout> | undefined }>
}

type StreamEvent = Event

export class Service extends Context.Service<Service, Interface>()("@duoduocode/SessionProcessor") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Session.Service
  | Config.Service
  | Bus.Service
  | Snapshot.Service
  | Agent.Service
  | LLM.Service
  | Permission.Service
  | SessionSummary.Service
  | SessionStatus.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const snapshot = yield* Snapshot.Service
    const llm = yield* LLM.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track("session created")

      // Subscribe to FileWatcher to mark snapshot dirty on any file change.
      // This enables the fast-path in snapshot.track() (skip git add when no
      // changes). A safety net (git diff-files) catches missed events, so
      // missing/lagged subscriptions never cause data loss — only perf regress.
      yield* bus.subscribe(FileWatcher.Event.Updated).pipe(
        Stream.runForEach(() => snapshot.markDirty()),
        Effect.forkIn(scope),
      )
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        reasoningMap: {},
        deltaBuffer: "",
        deltaFlushTimer: undefined as ReturnType<typeof setTimeout> | undefined,
        reasoningBufferMap: {},
      }
      let aborted = false
      const slog = log.clone().tag("session.id", input.sessionID).tag("messageID", input.assistantMessage.id)

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done)
          yield* Deferred.succeed(done, undefined).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Deferred.succeed failed", { toolCallID, cause: String(cause) }),
            ),
          )
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: MessageV2.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof Permission.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = true
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "start":
            yield* status.set(ctx.sessionID, { type: "busy" })
            return

          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: providerMeta(value),
            }
            yield* session.updatePart(ctx.reasoningMap[value.id]!)
            return

          case "reasoning-delta":
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id]!.text += value.text
            if (providerMeta(value)) ctx.reasoningMap[value.id]!.metadata = providerMeta(value)
            // Buffer reasoning delta for batch flush — reduces UI update frequency
            const rBuf = ctx.reasoningBufferMap[value.id] ?? { buffer: "", timer: undefined }
            rBuf.buffer += value.text
            if (!rBuf.timer) {
              const reasoningId = value.id
              rBuf.timer = setTimeout(() => {
                const buffered = rBuf.buffer
                rBuf.buffer = ""
                rBuf.timer = undefined
                if (buffered && reasoningId in ctx.reasoningMap) {
                  session
                    .updatePartDelta({
                      sessionID: ctx.reasoningMap[reasoningId]!.sessionID,
                      messageID: ctx.reasoningMap[reasoningId]!.messageID,
                      partID: ctx.reasoningMap[reasoningId]!.id,
                      field: "text",
                      delta: buffered,
                    })
                    .pipe(Effect.runCallback)
                }
              }, 16) // ~1 frame at 60fps, same as text-delta
            }
            ctx.reasoningBufferMap[value.id] = rBuf
            return

          case "reasoning-end":
            if (!(value.id in ctx.reasoningMap)) return
            // Flush any remaining buffered reasoning delta before finalizing
            const rBufEnd = ctx.reasoningBufferMap[value.id]
            if (rBufEnd) {
              if (rBufEnd.timer) {
                clearTimeout(rBufEnd.timer)
                rBufEnd.timer = undefined
              }
              if (rBufEnd.buffer) {
                const buffered = rBufEnd.buffer
                rBufEnd.buffer = ""
                yield* session.updatePartDelta({
                  sessionID: ctx.reasoningMap[value.id]!.sessionID,
                  messageID: ctx.reasoningMap[value.id]!.messageID,
                  partID: ctx.reasoningMap[value.id]!.id,
                  field: "text",
                  delta: buffered,
                })
              }
              delete ctx.reasoningBufferMap[value.id]
            }
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.reasoningMap[value.id]!.text = ctx.reasoningMap[value.id]!.text
            ctx.reasoningMap[value.id]!.time = { ...ctx.reasoningMap[value.id]!.time, end: Date.now() }
            if (providerMeta(value)) ctx.reasoningMap[value.id]!.metadata = providerMeta(value)
            yield* session.updatePart(ctx.reasoningMap[value.id]!)
            delete ctx.reasoningMap[value.id]
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            const part = yield* session.updatePart({
              id: ctx.toolcalls[value.id]?.partID ?? PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "tool",
              tool: value.toolName,
              callID: value.id,
              state: { status: "pending", input: {}, raw: "" },
              metadata: providerExecuted(value) ? { providerExecuted: true } : undefined,
            } satisfies MessageV2.ToolPart)
            ctx.toolcalls[value.id] = {
              done: yield* Deferred.make<void>(),
              partID: part.id,
              messageID: part.messageID,
              sessionID: part.sessionID,
            }
            return

          case "tool-input-delta":
            return

          case "tool-input-end":
            return

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            yield* updateToolCall(value.toolCallId, (match) => ({
              ...match,
              tool: value.toolName,
              state: {
                ...match.state,
                status: "running",
                input: (value.input ?? {}) as Record<string, unknown>,
                time: { start: Date.now(), end: 0 },
              },
              metadata: match.metadata?.providerExecuted
                ? { ...providerMeta(value), providerExecuted: true }
                : providerMeta(value),
            }))
            return
          }

          case "tool-result": {
            yield* completeToolCall(value.toolCallId, value.output as { title: string; metadata: Record<string, any>; output: string; attachments?: MessageV2.FilePart[] })
            return
          }

          case "tool-error": {
            yield* failToolCall(value.toolCallId, value.error)
            return
          }

          case "error":
            // 后端在工具（webfetch/shell 等）执行失败时，常以 SSE `error` 事件下发。
            // 直接 throw 会中断整个会话（"莫名其妙中止"）。当有进行中的工具调用时，
            // 将其标记为失败（tool-error），让 LLM 收到结果并继续；无进行中工具才上抛。
            if (Object.keys(ctx.toolcalls).length > 0) {
              for (const id of Object.keys(ctx.toolcalls)) {
                yield* failToolCall(id, value.error)
              }
              return
            }
            throw value.error

          case "start-step":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "finish-step": {
            const tokens = Session.getTokens({
              usage: (value.usage ?? {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
                outputTokenDetails: { reasoningTokens: 0 },
              }) as any,
              metadata: providerMeta(value) as any,
            })
            ctx.assistantMessage.finish = value.finishReason
            ctx.assistantMessage.tokens = tokens
            // 真实结束时间：在发布 tokens 的同一 message.updated 中带出，
            // 确保前端一定收到（cleanup 的 updateMessage 不一定能传播到前端）。
            if (!ctx.assistantMessage.time.completed) {
              ctx.assistantMessage.time.completed = Date.now()
            }
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.finishReason,
              snapshot: yield* snapshot.track("pre-edit snapshot"),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(
                Effect.catchCause((cause) => Effect.logWarning("summary.summarize failed", { cause: String(cause) })),
                Effect.forkIn(scope),
              )
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: providerMeta(value),
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (providerMeta(value)) ctx.currentText.metadata = providerMeta(value)
            // Buffer delta for batch flush — reduces UI update frequency
            ctx.deltaBuffer += value.text
            if (!ctx.deltaFlushTimer) {
              ctx.deltaFlushTimer = setTimeout(() => {
                const buffered = ctx.deltaBuffer
                ctx.deltaBuffer = ""
                ctx.deltaFlushTimer = undefined
                if (buffered && ctx.currentText) {
                  session
                    .updatePartDelta({
                      sessionID: ctx.currentText.sessionID,
                      messageID: ctx.currentText.messageID,
                      partID: ctx.currentText.id,
                      field: "text",
                      delta: buffered,
                    })
                    .pipe(Effect.runCallback)
                }
              }, 16) // ~1 frame at 60fps
            }
            return

          case "text-end":
            if (!ctx.currentText) return
            // Flush any remaining buffered delta before finalizing
            if (ctx.deltaFlushTimer) {
              clearTimeout(ctx.deltaFlushTimer)
              ctx.deltaFlushTimer = undefined
            }
            if (ctx.deltaBuffer) {
              const buffered = ctx.deltaBuffer
              ctx.deltaBuffer = ""
              yield* session.updatePartDelta({
                sessionID: ctx.currentText.sessionID,
                messageID: ctx.currentText.messageID,
                partID: ctx.currentText.id,
                field: "text",
                delta: buffered,
              })
            }
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (providerMeta(value)) ctx.currentText.metadata = providerMeta(value)
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return

          case "finish":
            return

          default:
            slog.info("unhandled", { event: (value as { type: string }).type, value })
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        // Flush any remaining buffered delta
        if (ctx.deltaFlushTimer) {
          clearTimeout(ctx.deltaFlushTimer)
          ctx.deltaFlushTimer = undefined
        }
        if (ctx.deltaBuffer && ctx.currentText) {
          const buffered = ctx.deltaBuffer
          ctx.deltaBuffer = ""
          yield* session.updatePartDelta({
            sessionID: ctx.currentText.sessionID,
            messageID: ctx.currentText.messageID,
            partID: ctx.currentText.id,
            field: "text",
            delta: buffered,
          })
        }
        // Flush any remaining buffered reasoning delta
        for (const [reasoningId, rBuf] of Object.entries(ctx.reasoningBufferMap)) {
          if (rBuf.timer) {
            clearTimeout(rBuf.timer)
            rBuf.timer = undefined
          }
          if (rBuf.buffer && reasoningId in ctx.reasoningMap) {
            const buffered = rBuf.buffer
            rBuf.buffer = ""
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[reasoningId]!.sessionID,
              messageID: ctx.reasoningMap[reasoningId]!.messageID,
              partID: ctx.reasoningMap[reasoningId]!.id,
              field: "text",
              delta: buffered,
            })
          }
        }
        ctx.reasoningBufferMap = {}
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) =>
            Deferred.await(call.done).pipe(
              Effect.timeout("250 millis"),
              Effect.catchCause((cause) => Effect.logWarning("tool call cleanup timeout", { cause: String(cause) })),
            ),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const generateProgressGist = Effect.fn("SessionProcessor.generateProgressGist")(function* () {
        const parts = MessageV2.parts(ctx.assistantMessage.id)
        const completedTools = parts.filter(
          (p): p is Extract<MessageV2.Part, { type: "tool" }> =>
            p.type === "tool" &&
            "state" in p &&
            typeof p.state === "object" &&
            p.state !== null &&
            (p.state as any).status === "completed",
        )
        if (completedTools.length === 0) return

        const lines = ["<progress-summary>", "Before interruption, the agent completed:"]
        for (const tool of completedTools) {
          const name = (tool as any).name ?? (tool as any).tool ?? "unknown"
          const input = typeof (tool as any).state?.input === "string" ? (tool as any).state.input : "{}"
          const output = typeof (tool as any).state?.output === "string" ? (tool as any).state.output.slice(0, 300) : ""
          lines.push(`- Tool: ${name}(${input.slice(0, 100)})`)
          if (output) lines.push(`  Result: ${output}`)
        }
        lines.push("</progress-summary>")

        const gistPart: MessageV2.TextPart = {
          id: PartID.ascending(),
          sessionID: ctx.assistantMessage.sessionID,
          messageID: ctx.assistantMessage.id,
          type: "text",
          text: lines.join("\n"),
          synthetic: true,
          ignored: false,
          time: { start: Date.now() },
        }
        yield* session.updatePart(gistPart)
        slog.info("progress gist generated", { toolCount: completedTools.length })
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        slog.error("process", { error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined })
        const error = parse(e)
        if (MessageV2.ContextOverflowError.isInstance(error)) {
          // When model.limit.context is 0 (unconfigured), the overflow error
          // often contains the actual context window limit (e.g. Xunfei:
          // "Range of input length should be [1, 202745]"). Extract and cache
          // it so subsequent proactive overflow checks (isEstimatedOverflow)
          // can trigger compaction before sending, instead of discovering
          // the limit only after a failed API call.
          const errorText = [error.data?.message as string | undefined, error.data?.responseBody]
            .filter(Boolean)
            .join(" ")
          const extracted = extractContextWindowFromError(errorText)
          if (extracted !== undefined && ctx.model.limit.context === 0) {
            slog.info("discovered context window from overflow error", {
              contextWindow: extracted,
              model: ctx.model.id,
            })
            persistDiscoveredContextWindow(ctx.model, extracted)
          }
          // Persist the error on the assistant message so that:
          //   1. The UI can display the error card with the retry button.
          //   2. The runLoop can detect a ContextOverflowError on the next
          //      iteration and trigger compaction before re-sending
          //      (avoids wasting an API call).
          ctx.assistantMessage.error = error
          ctx.assistantMessage.finish = "error"
          ctx.needsCompaction = true
          yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        // When the error was NOT classified as ContextOverflowError (e.g.
        // APICallError.isInstance fails due to Symbol marker loss across
        // Effect propagation), the overflow detection may have missed it.
        // Still try to extract and cache the context window from the error
        // message — without it, resolveContextWindow returns 0, compaction
        // budget becomes 0, and the compaction agent itself overflows,
        // causing the conversation to end silently.
        const nonOverflowErrorText = [
          (error as any)?.data?.message as string | undefined,
          (error as any)?.data?.responseBody as string | undefined,
        ]
          .filter(Boolean)
          .join(" ")
        const nonOverflowExtracted = extractContextWindowFromError(nonOverflowErrorText)
        const hasOverflowKeywords = isOverflowErrorText(nonOverflowErrorText)
        if (nonOverflowExtracted !== undefined && ctx.model.limit.context === 0) {
          slog.info("discovered context window from non-overflow error", {
            contextWindow: nonOverflowExtracted,
            model: ctx.model.id,
          })
          persistDiscoveredContextWindow(ctx.model, nonOverflowExtracted)
        }
        // Trigger compaction automatically even when the error wasn't classified
        // as ContextOverflowError. The error message clearly indicates overflow
        // (e.g. "Range of input length should be [1, 202745]"), so compressing
        // context is the right response — don't wait for the user to click retry.
        if (hasOverflowKeywords) {
          ctx.needsCompaction = true
        }
        // Generate a progress gist so the LLM knows what was completed
        // before the interruption when the user clicks "continue".
        yield* generateProgressGist().pipe(
          Effect.catchCause((cause) => Effect.logWarning("generateProgressGist failed", { cause: String(cause) })),
        )

        ctx.assistantMessage.error = error
        ctx.assistantMessage.finish = "error"
        yield* bus.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        slog.info("process")
        ctx.needsCompaction = false

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            const stream = llm.stream(streamInput)

            yield* stream.pipe(
              Stream.tap((event) => handleEvent(event)),
              Stream.takeUntil(() => ctx.needsCompaction),
              Stream.runDrain,
            )
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.retry(
              SessionRetry.policy({
                parse,
                set: (info) =>
                  status.set(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    message: info.message,
                    next: info.next,
                  }),
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        updateToolCall,
        completeToolCall,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
  ),
)

export * as SessionProcessor from "./processor"
