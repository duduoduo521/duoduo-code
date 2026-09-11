import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import * as Session from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "../provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "../util"
import { Log } from "../util"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Config } from "@/config"
import { NotFoundError } from "@/storage"
import { ModelID, ProviderID } from "@/provider/schema"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import { InstanceState } from "@/effect"
import {
  isOverflow as overflow,
  effectiveUsable,
  extractContextWindowFromError,
  persistDiscoveredContextWindow,
  resolveContextWindow,
} from "./overflow"
import { makeRuntime } from "@/effect/run-service"
import { fn } from "@/util/fn"

const log = Log.create({ service: "session.compaction" })

export const Event = {
  Compacted: BusEvent.define(
    "session.compacted",
    z.object({
      sessionID: SessionID.zod,
    }),
  ),
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = Number.MAX_SAFE_INTEGER
const SUMMARY_TEMPLATE = `Output exactly this Markdown structure and keep the section order unchanged:
---
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
---

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

function summaryText(message: MessageV2.WithParts) {
  const text = message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: MessageV2.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function buildPrompt(input: { previousSummary?: string; context: string[] }) {
  const anchor = input.previousSummary
    ? [
        "Update the anchored summary below using the conversation history above.",
        "Preserve still-true details, remove stale details, and merge in the new facts.",
        "<previous-summary>",
        input.previousSummary,
        "</previous-summary>",
      ].join("\n")
    : "Create a new anchored summary from the conversation history above."
  return [anchor, SUMMARY_TEMPLATE, ...input.context].join("\n\n")
}

function preserveRecentBudget(input: { cfg: Config.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(
      MAX_PRESERVE_RECENT_TOKENS,
      Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(effectiveUsable(input) * 0.25)),
    )
  )
}

function turns(messages: MessageV2.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i]!.end = result[i + 1]!.start
  }
  return result
}

function splitTurn(input: {
  messages: MessageV2.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: MessageV2.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean, unknown, unknown>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void, unknown, unknown>
  readonly process: (input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop", unknown, unknown>
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderID; modelID: ModelID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void, unknown, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/SessionCompaction") {}

export const layer: Layer.Layer<
  Service,
  never,
  Bus.Service | Config.Service | Session.Service | Agent.Service | SessionProcessor.Service | Provider.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({ cfg: yield* config.get(), tokens: input.tokens, model: input.model })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: MessageV2.WithParts[]
      model: Provider.Model
    }) {
      // Fast path: count characters directly from parts, skipping the
      // expensive toModelMessagesEffect + JSON.stringify pipeline.
      // This is safe because Token.estimate is only used to decide whether
      // to trigger compaction — over-estimation is safe (triggers earlier),
      // and we have 41.5% headroom from the hard context limit.
      return Token.estimateFromParts(input.messages.flatMap((m) => m.parts))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: MessageV2.WithParts[]
      cfg: Config.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]!
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) log.info("tail fallback", { budget, size, total })
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      log.info("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: MessageV2.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]!
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]!
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      log.info("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        log.info("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: MessageV2.User
            parts: MessageV2.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]!
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      let model: Provider.Model
      if (agent.model) {
        model = yield* provider.getModel(agent.model.providerID, agent.model.modelID)
      } else {
        model = yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
        if (input.overflow) {
          const modelCtx = resolveContextWindow(model)
          const allProviders = yield* provider.list()
          let bestModel: Provider.Model | undefined
          let bestCtx = modelCtx
          for (const p of Object.values(allProviders)) {
            for (const m of Object.values(p.models)) {
              const ctx = resolveContextWindow(m)
              if (ctx > bestCtx) {
                bestCtx = ctx
                bestModel = m
              }
            }
          }
          if (bestModel) {
            log.info("compaction overflow: switching to larger model", {
              from: model.id,
              to: bestModel.id,
              contextWindow: bestCtx,
            })
            model = bestModel
          }
        }
      }
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const nextPrompt = buildPrompt({ previousSummary, context: [] })
      // Shallow clone — avoids structuredClone deep-copy cost.
      // Each message object is new (top-level properties can be safely modified)
      // and the parts array is new (parts can be added/removed), but individual
      // part objects remain shared references. This is safe because:
      //   1. `selected.head` is a local slice from a fresh DB query, not shared
      //      with any other concurrent operation.
      //   2. Plugins only need to read/transform messages for this compaction pass;
      //      they do not mutate part internals that persist beyond this scope.
      //   3. Follows the same pattern as session.ts updatePart shallow clone.
      const msgs = selected.head.map((msg) => ({ ...msg, parts: [...msg.parts] }))
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const ctx = yield* InstanceState.context
      const msg: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)

      // Roll back the placeholder summary assistant when compaction is
      // interrupted (user cancellation) before it produces a real summary. The
      // message is persisted above — before processor setup — so the UI can
      // render it, but an abort after that point leaves an empty/partial
      // summary orphaned.
      const result = yield* Effect.gen(function* () {
        const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          ...modelMessages,
          {
            role: "user",
            content: [{ type: "text", text: nextPrompt }],
          },
        ],
        model,
      })

      if (result === "compact") {
        // Compaction itself overflowed. Before giving up, try to extract
        // the context window from the error so future attempts can use it
        // for proactive overflow detection (isEstimatedOverflow).
        const errorObj = processor.message.error
        // Extract error text from the structured error object. The ContextOverflowError
        // variant has data.message and data.responseBody, but other variants may not.
        // Stringify the full object as a fallback to catch any pattern.
// @effect-diagnostics-next-line preferSchemaOverJson:off
        const errText = errorObj ? JSON.stringify(errorObj) : ""
        const extracted = extractContextWindowFromError(errText)
        if (extracted !== undefined && model.limit.context === 0) {
          log.info("compaction overflow: discovered context window", { contextWindow: extracted, model: model.id })
          persistDiscoveredContextWindow(model, extracted)
        }

        // Auto-truncation: when compaction fails due to overflow, progressively
        // truncate oldest messages until the remaining messages fit within the
        // target model's effective context. This prevents the user from being
        // stuck with an unusable session after switching to a smaller model.
        const effectiveLimit = effectiveUsable({ cfg, model })
        if (effectiveLimit > 0 && messages.length > 2) {
          // Estimate total token size of current messages
          let truncMessages = [...messages]
          let estimatedSize = yield* estimate({ messages: truncMessages, model })
          // Remove oldest user-assistant pairs until we fit within the effective limit
          while (estimatedSize > effectiveLimit && truncMessages.length > 2) {
            // Find the first user message that is not a compaction marker
            const firstUserIdx = truncMessages.findIndex(
              (m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"),
            )
            if (firstUserIdx === -1) break
            // Remove the user message and its following assistant message (if any)
            const removeCount =
              firstUserIdx + 1 < truncMessages.length && truncMessages[firstUserIdx + 1]!.info.role === "assistant"
                ? 2
                : 1
            log.info("compaction overflow: truncating oldest messages", {
              removedIndex: firstUserIdx,
              removedCount: removeCount,
              remainingMessages: truncMessages.length - removeCount,
            })
            truncMessages = truncMessages.slice(removeCount)
            estimatedSize = yield* estimate({ messages: truncMessages, model })
          }

          if (estimatedSize <= effectiveLimit) {
            log.info("compaction overflow: auto-truncation succeeded", {
              originalCount: messages.length,
              truncatedCount: truncMessages.length,
              estimatedTokens: estimatedSize,
              effectiveLimit,
            })
            // Replace the messages with the truncated set and mark the compaction
            // as a summary so filterCompacted filters out the pre-truncation messages.
            const truncSelected = yield* select({ messages: truncMessages, cfg, model })
            // Update the processor message with a truncation summary
            const truncPart = processor.message
            truncPart.summary = true
            truncPart.tokens.input = estimatedSize
            if (truncSelected.tail_start_id) {
              // Update compaction part tail_start_id if applicable
              if (compactionPart && compactionPart.tail_start_id !== truncSelected.tail_start_id) {
                yield* session.updatePart({
                  ...compactionPart,
                  tail_start_id: truncSelected.tail_start_id,
                })
              }
            }
            yield* session.updateMessage(truncPart)
            return "continue"
          }
          log.info("compaction overflow: auto-truncation failed - still exceeds limit after truncation", {
            remainingMessages: truncMessages.length,
            estimatedTokens: estimatedSize,
            effectiveLimit,
          })
        }

        processor.message.error = new MessageV2.ContextOverflowError({
          message: "当前会话过大，建议：①切换到更大上下文模型 ②开启新会话 ③删除早期对话",
        }).toObject()
        processor.message.finish = "error"
        // Even though the compaction summary may be incomplete, mark it as a
        // summary so that filterCompacted can filter out the pre-compaction
        // messages. Without this, the uncompactable context would be re-sent
        // to the LLM, causing an infinite retry loop.
        // The trade-off: some information may be lost, but this is better
        // than the guaranteed failure of re-sending an oversized context.
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          if (true) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
      return result
      }).pipe(
        Effect.onExit((exit) => {
          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) {
            return session.removeMessage({ sessionID: input.sessionID, messageID: msg.id })
          }
          return Effect.void
        }),
      )
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
  ),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  return runPromise((svc) => svc.isOverflow(input))
}

export async function prune(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.prune(input))
}

export const create = fn(
  z.object({
    sessionID: SessionID.zod,
    agent: z.string(),
    model: z.object({ providerID: ProviderID.zod, modelID: ModelID.zod }),
    auto: z.boolean(),
    overflow: z.boolean().optional(),
  }),
  (input) => runPromise((svc) => svc.create(input)),
)

export * as SessionCompaction from "./compaction"
