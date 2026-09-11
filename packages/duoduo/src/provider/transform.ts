import type { ModelMessage } from "ai"
import { mergeDeep, unique } from "remeda"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { JSONSchema } from "zod/v4/core"
import type * as Provider from "./provider"
import type * as ModelsDev from "./models"
import { iife } from "@/util/iife"
import { Flag } from "@/flag/flag"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

export const OUTPUT_TOKEN_MAX = Flag.DUODUO_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

// Maps npm package to the key the AI SDK expects for providerOptions.
// After OPT-6/15 every provider is served through `@ai-sdk/openai-compatible`
// (or the `custom` OpenAI-compatible base_url path), so no provider-specific
// remap is required — providerOptions stay keyed by the model's providerID.
function sdkKey(_npm: string): undefined {
  return undefined
}

function normalizeMessages(
  msgs: ModelMessage[],
  model: Provider.Model,
  _options: Record<string, unknown>,
): ModelMessage[] {
  if (model.api.id.includes("claude")) {
    const scrub = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_")
    msgs = msgs.map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((part) => {
            if (part.type === "tool-call" || part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          }),
        }
      }
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((part) => {
            if (part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          }),
        }
      }
      return msg
    })
  }
  if (
    model.providerID === "mistral" ||
    model.api.id.toLowerCase().includes("mistral") ||
    model.api.id.toLocaleLowerCase().includes("devstral")
  ) {
    const scrub = (id: string) => {
      return id
        .replace(/[^a-zA-Z0-9]/g, "") // Remove non-alphanumeric characters
        .substring(0, 9) // Take first 9 characters
        .padEnd(9, "0") // Pad with zeros if less than 9 characters
    }
    const result: ModelMessage[] = []
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      const nextMsg = msgs[i + 1]

      if (msg!.role === "assistant" && Array.isArray(msg!.content)) {
        msg!.content = msg!.content.map((part) => {
          if (part.type === "tool-call" || part.type === "tool-result") {
            return { ...part, toolCallId: scrub(part.toolCallId) }
          }
          return part
        })
      }
      if (msg!.role === "tool" && Array.isArray(msg!.content)) {
        msg!.content = msg!.content.map((part) => {
          if (part.type === "tool-result") {
            return { ...part, toolCallId: scrub(part.toolCallId) }
          }
          return part
        })
      }
      result.push(msg!)

      // Fix message sequence: tool messages cannot be followed by user messages
      if (msg!.role === "tool" && nextMsg?.role === "user") {
        result.push({
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Done.",
            },
          ],
        })
      }
    }
    return result
  }

  if (typeof model.capabilities.interleaved === "object" && model.capabilities.interleaved.field) {
    const field = model.capabilities.interleaved.field
    return msgs.map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
        const reasoningText = reasoningParts.map((part: any) => part.text).join("")

        // Filter out reasoning parts from content
        const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

        // Include reasoning_content | reasoning_details directly on the message for all assistant messages
        if (reasoningText) {
          return {
            ...msg,
            content: filteredContent,
            providerOptions: {
              ...msg.providerOptions,
              openaiCompatible: {
                ...msg.providerOptions?.openaiCompatible,
                [field]: reasoningText,
              },
            },
          }
        }

        return {
          ...msg,
          content: filteredContent,
        }
      }

      return msg
    })
  }

  return msgs
}

/**
 * A message explicitly opted out of cache_control marking via
 * `providerOptions.duoduo.noCache` (e.g. the daily "Today's date" system
 * message from llm.ts). Two reasons to skip it:
 *  1. Anthropic-family APIs allow max 4 cache breakpoints. Stable system
 *     blocks + last-2 messages already use the budget; a 5th marker on the
 *     date message would exceed the limit.
 *  2. Its content changes every day — caching it is pointless by design.
 */
function isNoCache(msg: ModelMessage): boolean {
  return (msg.providerOptions as Record<string, any> | undefined)?.["duoduo"]?.noCache === true
}

function applyCaching(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  // Cache all system messages (stable per session: AGENTS.md, tool definitions, etc.)
  // plus the last 2 non-system messages for conversation continuity.
  // Only the first 2 system messages were cached previously, but all system
  // messages are stable and cacheable — marking more for cache improves
  // hit rate without any correctness risk.
  const system = msgs.filter((msg) => msg.role === "system" && !isNoCache(msg))
  const final = msgs.filter((msg) => msg.role !== "system").slice(-2)

  const providerOptions = {
    openaiCompatible: {
      cache_control: { type: "ephemeral" },
    },
  }

  for (const msg of unique([...system, ...final])) {
    const shouldUseContentOptions = Array.isArray(msg.content) && msg.content.length > 0

    if (shouldUseContentOptions) {
      const lastContent = msg.content[msg.content.length - 1]
      if (
        lastContent &&
        typeof lastContent === "object" &&
        lastContent.type !== "tool-approval-request" &&
        lastContent.type !== "tool-approval-response"
      ) {
        lastContent.providerOptions = mergeDeep(lastContent.providerOptions ?? {}, providerOptions)
        // Also set cache_control at the message top-level so the Rust
        // (OpenAI-format) path forwards it to the provider — providerOptions
        // is dropped when deserialised into Rust's LlmMessage.
        ;(lastContent as unknown as Record<string, unknown>).cache_control = { type: "ephemeral" }
        continue
      }
    }

    msg.providerOptions = mergeDeep(msg.providerOptions ?? {}, providerOptions)
    ;(msg as unknown as Record<string, unknown>).cache_control = { type: "ephemeral" }
  }

  return msgs
}

function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  return msgs.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

    const filtered = msg.content.map((part) => {
      if (part.type !== "file" && part.type !== "image") return part

      // Check for empty base64 image data
      if (part.type === "image") {
        // oxlint-disable-next-line no-base-to-string -- part.image is a string data URL for image parts
        const imageStr = String(part.image)
        if (imageStr.startsWith("data:")) {
          const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
          if (match && (!match[2] || match[2].length === 0)) {
            return {
              type: "text" as const,
              text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
            }
          }
        }
      }

      // oxlint-disable-next-line no-base-to-string -- part.image is a string data URL for image parts
      const mime = part.type === "image" ? String(part.image).split(";")[0]!.replace("data:", "") : part.mediaType
      const filename = part.type === "file" ? part.filename : undefined
      const modality = mimeToModality(mime)
      if (!modality) return part
      if (model.capabilities.input[modality]) return part

      const name = filename ? `"${filename}"` : modality
      return {
        type: "text" as const,
        text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
      }
    })

    return { ...msg, content: filtered }
  })
}

export function message(msgs: ModelMessage[], model: Provider.Model, options: Record<string, unknown>) {
  msgs = unsupportedParts(msgs, model)
  msgs = normalizeMessages(msgs, model, options)
  if (
    model.api.id.includes("anthropic") ||
    model.api.id.includes("claude") ||
    model.id.includes("anthropic") ||
    model.id.includes("claude") ||
    // Provider/model reported prompt-caching support (auto-detected on add).
    model.capabilities?.promptCaching
  ) {
    msgs = applyCaching(msgs, model)
  }

  // Remap providerOptions keys from stored providerID to expected SDK key
  const key = sdkKey(model.api.npm)
  if (key && key !== model.providerID) {
    const remap = (opts: Record<string, any> | undefined) => {
      if (!opts) return opts
      if (!(model.providerID in opts)) return opts
      const result = { ...opts }
      result[key] = result[model.providerID]
      delete result[model.providerID]
      return result
    }

    msgs = msgs.map((msg) => {
      if (!Array.isArray(msg.content)) return { ...msg, providerOptions: remap(msg.providerOptions) }
      return {
        ...msg,
        providerOptions: remap(msg.providerOptions),
        content: msg.content.map((part) => {
          if (part.type === "tool-approval-request" || part.type === "tool-approval-response") {
            return { ...part }
          }
          return { ...part, providerOptions: remap(part.providerOptions) }
        }),
      } as typeof msg
    })
  }

  return msgs
}

export function temperature(model: Provider.Model) {
  if (model.temperature !== undefined) return model.temperature
  const id = model.id.toLowerCase()
  if (id.includes("qwen")) return 0.55
  if (id.includes("claude")) return undefined
  if (id.includes("gemini")) return 1.0
  if (id.includes("glm-4.6")) return 1.0
  if (id.includes("glm-4.7")) return 1.0
  if (id.includes("minimax-m2")) return 1.0
  if (id.includes("kimi-k2")) {
    // kimi-k2-thinking & kimi-k2.5 && kimi-k2p5 && kimi-k2-5
    if (["thinking", "k2.", "k2p", "k2-5"].some((s) => id.includes(s))) {
      return 1.0
    }
    return 0.6
  }
  return undefined
}

export function topP(model: Provider.Model) {
  if (model.topP !== undefined) return model.topP
  const id = model.id.toLowerCase()
  if (id.includes("qwen")) return 1
  if (["minimax-m2", "gemini", "kimi-k2.5", "kimi-k2p5", "kimi-k2-5"].some((s) => id.includes(s))) {
    return 0.95
  }
  return undefined
}

export function topK(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("minimax-m2")) {
    if (["m2.", "m25", "m21"].some((s) => id.includes(s))) return 40
    return 20
  }
  if (id.includes("gemini")) return 64
  return undefined
}

const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]

export function variants(model: Provider.Model): Record<string, Record<string, any>> {
  if (!model.capabilities.reasoning) return {}

  const id = model.id.toLowerCase()
  // see: https://docs.x.ai/docs/guides/reasoning#control-how-hard-the-model-thinks
  if (id.includes("grok-3-mini")) {
    return {
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    }
  }
  if (id.includes("grok")) return {}

  return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
}

export function options(input: {
  model: Provider.Model
  sessionID: string
  providerOptions?: Record<string, any>
}): Record<string, any> {
  const result: Record<string, any> = {}

  if (
    ["zai", "zhipuai"].some((id) => input.model.providerID.includes(id)) &&
    input.model.api.npm === "@ai-sdk/openai-compatible"
  ) {
    result["thinking"] = {
      type: "enabled",
      clear_thinking: false,
    }
  }

  if (input.providerOptions?.setCacheKey || input.model.capabilities?.promptCaching) {
    // Stable per-model routing key (NOT sessionID): OpenAI's prompt_cache_key
    // only routes requests to a cache shard — the actual hit is decided by the
    // byte-identical prompt prefix. A sessionID key isolates every session
    // into its own shard, forfeiting cross-session reuse of the (identical)
    // system-prompt prefix and dying with the session. A model-scoped constant
    // maximizes prefix sharing and is immune to session/date churn.
    result["promptCacheKey"] = stableCacheKey(input.model)
  }

  const modelId = input.model.api.id.toLowerCase()

  // Enable thinking for reasoning models on alibaba-cn (DashScope).
  // DashScope's OpenAI-compatible API requires `enable_thinking: true` in the request body
  // to return reasoning_content. Without it, models like kimi-k2.5, qwen-plus, qwen3, qwq,
  // deepseek-r1, etc. never output thinking/reasoning tokens.
  // Note: kimi-k2-thinking is excluded as it returns reasoning_content by default.
  if (
    input.model.providerID === "alibaba-cn" &&
    input.model.capabilities.reasoning &&
    input.model.api.npm === "@ai-sdk/openai-compatible" &&
    !modelId.includes("kimi-k2-thinking")
  ) {
    result["enable_thinking"] = true
  }

  if (input.model.api.id.includes("gpt-5") && !input.model.api.id.includes("gpt-5-chat")) {
    if (!input.model.api.id.includes("gpt-5-pro")) {
      result["reasoningEffort"] = "medium"
    }

    // Only set textVerbosity for non-chat gpt-5.x models
    // Chat models (e.g. gpt-5.2-chat-latest) only support "medium" verbosity
    if (
      input.model.api.id.includes("gpt-5.") &&
      !input.model.api.id.includes("codex") &&
      !input.model.api.id.includes("-chat")
    ) {
      result["textVerbosity"] = "low"
    }

  }

  if (input.model.providerID === "venice") {
    result["promptCacheKey"] = stableCacheKey(input.model)
  }

  return result
}

/**
 * Deterministic, session-independent prompt-cache routing key.
 * Scoped per model so different models never share a cache shard, while all
 * sessions of the same model do — the provider matches the actual prefix
 * bytes, so a broader key can only improve hit rate, never corrupt results.
 */
export function stableCacheKey(model: Provider.Model): string {
  return `duoduo:${model.providerID}/${model.api.id}`
}

export function smallOptions(model: Provider.Model) {
  if (model.providerID === "venice") {
    return { veniceParameters: { disableThinking: true } }
  }

  return {}
}

export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
  const key = sdkKey(model.api.npm) ?? model.providerID
  return { [key]: options }
}

export function maxOutputTokens(model: Provider.Model): number {
  // Send the user-configured output limit verbatim — do NOT silently cap it to
  // OUTPUT_TOKEN_MAX (a model may legitimately allow 128K output). When unset
  // (0), fall back to OUTPUT_TOKEN_MAX as the default. OUTPUT_TOKEN_MAX still
  // acts as a hard ceiling so an absurd configured value can't break the API.
  const configured = model.limit.output
  if (configured > 0) return Math.min(configured, OUTPUT_TOKEN_MAX)
  return OUTPUT_TOKEN_MAX
}

export function schema(model: Provider.Model, schema: JSONSchema.BaseSchema | JSONSchema7): JSONSchema7 {
  // Convert integer enums to string enums for Google/Gemini
  if (model.providerID === "google" || model.api.id.includes("gemini")) {
    const isPlainObject = (node: unknown): node is Record<string, any> =>
      typeof node === "object" && node !== null && !Array.isArray(node)
    const hasCombiner = (node: unknown) =>
      isPlainObject(node) && (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf))
    const hasSchemaIntent = (node: unknown) => {
      if (!isPlainObject(node)) return false
      if (hasCombiner(node)) return true
      return [
        "type",
        "properties",
        "items",
        "prefixItems",
        "enum",
        "const",
        "$ref",
        "additionalProperties",
        "patternProperties",
        "required",
        "not",
        "if",
        "then",
        "else",
      ].some((key) => key in node)
    }

    const sanitizeGemini = (obj: any): any => {
      if (obj === null || typeof obj !== "object") {
        return obj
      }

      if (Array.isArray(obj)) {
        return obj.map(sanitizeGemini)
      }

      const result: any = {}
      for (const [key, value] of Object.entries(obj)) {
        if (key === "enum" && Array.isArray(value)) {
          // Convert all enum values to strings
          result[key] = value.map((v) => String(v))
          // If we have integer type with enum, change type to string
          if (result.type === "integer" || result.type === "number") {
            result.type = "string"
          }
        } else if (typeof value === "object" && value !== null) {
          result[key] = sanitizeGemini(value)
        } else {
          result[key] = value
        }
      }

      // Filter required array to only include fields that exist in properties
      if (result.type === "object" && result.properties && Array.isArray(result.required)) {
        result.required = result.required.filter((field: any) => field in result.properties)
      }

      if (result.type === "array" && !hasCombiner(result)) {
        if (result.items == null) {
          result.items = {}
        }
        // Ensure items has a type only when it's still schema-empty.
        if (isPlainObject(result.items) && !hasSchemaIntent(result.items)) {
          result.items.type = "string"
        }
      }

      // Remove properties/required from non-object types (Gemini rejects these)
      if (result.type && result.type !== "object" && !hasCombiner(result)) {
        delete result.properties
        delete result.required
      }

      return result
    }

    schema = sanitizeGemini(schema)
  }

  return schema as JSONSchema7
}
