import type { AssistantMessage, Message } from "@duoduo-ai/sdk/v2/client"
import type { TokenBreakdown } from "./session-context-breakdown"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
  }
}

type Context = {
  message: AssistantMessage
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  contextTokens: number
  total: number
  sessionTotal: number
  usage: number | null
  breakdown: TokenBreakdown | undefined
  cacheHitRate: number | undefined
  tokensPerSecond: number | null
}

type Metrics = {
  context: Context | undefined
}

const tokenTotal = (msg: AssistantMessage) => {
  return msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
}

const lastAssistantWithTokens = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role !== "assistant") continue
    if (tokenTotal(msg) <= 0) continue
    return msg
  }
}

/** Extract model context limit from an assistant error message body.
 *  Patterns:
 *    - "Range of input length should be [1, 202745]" (Xunfei v1)
 *    - "input token limit is 202752" (Xunfei v2)
 *    - "maximum context length is 128000 tokens" (OpenAI)
 *    - "This model's maximum context length is 128000 tokens"
 *  Returns the extracted number, or undefined if nothing matches. */
const extractLimitFromAssistantErrors = (messages: Message[]): number | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role !== "assistant") continue
    const error = (msg).error as { data?: { message?: string } } | undefined
    const text = error?.data?.message
    if (!text) continue
    const m1 = text.match(/range of input length should be \[1,\s*(\d+)\]/i)
    if (m1) return Number.parseInt(m1[1]!, 10)
    const m2 = text.match(/input token limit is (\d+)/i)
    if (m2) return Number.parseInt(m2[1]!, 10)
    const m3 = text.match(/maximum context length is (\d+)/i)
    if (m3) return Number.parseInt(m3[1]!, 10)
    const m4 = text.match(/model's maximum context length is (\d+)/i)
    if (m4) return Number.parseInt(m4[1]!, 10)
  }
  return undefined
}

const build = (messages: Message[] = [], providers: Provider[] = []): Metrics => {
  const sessionTotal = messages.filter((msg) => msg.role === "assistant").reduce((sum, msg) => sum + tokenTotal(msg), 0)
  const message = lastAssistantWithTokens(messages)
  if (!message) return { context: undefined }

  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const limit = model?.limit.context || extractLimitFromAssistantErrors(messages) || undefined
  const total = tokenTotal(message)
  const contextTokens =
    message.tokens.input + message.tokens.cache.read + message.tokens.cache.write

  // The SDK's token type no longer declares `breakdown` / `cacheHitRate`, but the
  // Rust backend may still report them at runtime. Read them safely as optional extras.
  const tokenMeta = message.tokens as {
    breakdown?: TokenBreakdown
    cacheHitRate?: number
  }

  // Real generation speed of the last completed reply. Backend writes
  // `time.completed` only when generation finishes (streaming messages have it
  // unset and zero tokens), so this is null during streaming or for empty output.
  const t = message.time
  const out = message.tokens.output
  const secs = t.completed ? (t.completed - t.created) / 1000 : 0
  const tokensPerSecond = t.completed && out > 0 && secs > 0 ? out / secs : null

  return {
    context: {
      message,
      provider,
      model,
      providerLabel: provider?.name ?? message.providerID,
      modelLabel: model?.name ?? message.modelID,
      limit,
      input: message.tokens.input,
      output: message.tokens.output,
      reasoning: message.tokens.reasoning,
      cacheRead: message.tokens.cache.read,
      cacheWrite: message.tokens.cache.write,
      contextTokens,
      total,
      sessionTotal,
      usage: limit ? Math.round((contextTokens / limit) * 100) : null,
      breakdown: tokenMeta.breakdown,
      cacheHitRate: tokenMeta.cacheHitRate,
      tokensPerSecond,
    },
  }
}

export function getSessionContextMetrics(messages: Message[] = [], providers: Provider[] = []) {
  return build(messages, providers)
}
