import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import type { ProviderID } from "./schema"

const OVERFLOW_PATTERNS = [
  /prompt is too long/i, // Anthropic
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions + Responses API message text)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter, DeepSeek, vLLM
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding, Moonshot
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /request entity too large/i, // HTTP 413
  /context length is only \d+ tokens/i, // vLLM
  /input length.*exceeds.*context length/i, // vLLM
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /too large for model with \d+ maximum context length/i, // Mistral
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /range of input length should be/i, // Xunfei Spark (e.g. "Range of input length should be [1, 202745]")
  /invalidparameter.*range of input/i, // Xunfei Spark combined InvalidParameter + overflow
  /input token limit/i, // Xunfei Spark v2 (e.g. "input token limit is 202752")
]

export function isOverflowErrorText(text: string): boolean {
  return OVERFLOW_PATTERNS.some((p) => p.test(text))
}

function isOpenAiErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  // openai sometimes returns 404 for models that are actually available
  return status === 404 || e.isRetryable
}

// Providers not reliably handled in this function:
// - z.ai: can accept overflow silently (needs token-count/context-window checks)
function isOverflow(message: string) {
  if (OVERFLOW_PATTERNS.some((p) => p.test(message))) return true

  // Providers/status patterns handled outside of regex list:
  // - Cerebras: often returns "400 (no body)" / "413 (no body)"
  // - Mistral: often returns "400 (no body)" / "413 (no body)"
  return /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)
}

function message(providerID: ProviderID, e: APICallError) {
  return iife(() => {
    const msg = e.message
    if (msg === "") {
      if (e.responseBody) return e.responseBody
      if (e.statusCode) {
        const err = STATUS_CODES[e.statusCode]
        if (err) return err
      }
      return "Unknown error"
    }

    if (!e.responseBody) return msg

    // Always attempt to extract structured error info from responseBody,
    // merging it with msg when it provides new information.
    try {
      const body = JSON.parse(e.responseBody)
      // try to extract common error message fields
      // Priority: body.error.message > body.message > body.error (if string)
      const errMsg = body.error?.message ?? body.message ?? (typeof body.error === "string" ? body.error : undefined)
      if (errMsg && typeof errMsg === "string" && !msg.includes(errMsg)) {
        return `${msg}: ${errMsg}`
      }
      // msg already contains the extracted message, or no extractable message —
      // return msg as-is to avoid redundancy
      return msg
    } catch {}

    // If responseBody is HTML (e.g. from a gateway or proxy error page),
    // provide a human-readable message instead of dumping raw markup
    if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
      if (e.statusCode === 401) {
        return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `duoduo auth login <your provider URL>` to re-authenticate."
      }
      if (e.statusCode === 403) {
        return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
      }
      return msg
    }

    // responseBody is non-JSON, non-HTML — append for visibility only if msg is uninformative
    const standardStatus = e.statusCode ? STATUS_CODES[e.statusCode] : undefined
    if (standardStatus && msg === String(e.statusCode)) {
      return `${standardStatus}: ${e.responseBody}`
    }
    return msg
  }).trim()
}

function json(input: unknown) {
  if (typeof input === "string") {
    try {
      const result = JSON.parse(input)
      if (result && typeof result === "object") return result
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof input === "object" && input !== null) {
    return input
  }
  return undefined
}

export type ParsedStreamError =
  | {
      type: "context_overflow"
      message: string
      responseBody: string
    }
  | {
      type: "api_error"
      message: string
      isRetryable: false
      responseBody: string
    }
  | {
      type: "quota_exceeded"
      message: string
      isRetryable: true
      responseBody: string
      retryAfterMs?: number
    }

export function parseStreamError(input: unknown): ParsedStreamError | undefined {
  const body = json(input)
  if (!body) return

  const responseBody = JSON.stringify(body)
  if (body.type !== "error") return

  switch (body?.error?.code) {
    case "context_length_exceeded":
      return {
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody,
      }
    case "insufficient_quota":
      // Quota errors ARE retryable — they reset on time windows (e.g. per-minute quotas).
      // Previously classified as non-retryable, which prevented automatic retries
      // for providers like Xunfei that return quota errors on transient limits.
      return {
        type: "quota_exceeded",
        message: "Quota exceeded — will retry after cooldown. Check your plan and billing details.",
        isRetryable: true,
        responseBody,
        retryAfterMs: 5000,
      }
    case "usage_not_included":
      return {
        type: "api_error",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        isRetryable: false,
        responseBody,
      }
    case "invalid_prompt":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Invalid prompt.",
        isRetryable: false,
        responseBody,
      }
    // Xunfei-specific error codes: 11210 = NotEnoughCvError (token/quota exceeded)
    // 10010 = RecvFromEngineError (Engine Busy — transient, retryable)
    // 10012 = EngineInternalError — dual semantics:
    //   * When combined with "InvalidParameter" / "Range of input length" -> context overflow (non-retryable)
    //   * When standalone -> engine internal error (transient, retryable)
    // We must check for overflow keywords BEFORE classifying as quota_exceeded.
    case "11210":
    case "NotEnoughCvError":
    case "10010":
    case "10050":
      return {
        type: "quota_exceeded",
        message: "Token quota temporarily exceeded — will retry after cooldown.",
        isRetryable: true,
        responseBody,
        retryAfterMs: 10000,
      }
    case "10012": {
      // Xunfei 10012 can be context overflow OR engine internal error.
      // Check the error message for overflow keywords first.
      const errMsg = typeof body?.error?.message === "string" ? body?.error?.message : ""
      if (isOverflowErrorText(errMsg)) {
        return {
          type: "context_overflow",
          message: "Input exceeds context window of this model",
          responseBody,
        }
      }
      // Otherwise it's a genuine engine internal error — retryable
      return {
        type: "quota_exceeded",
        message: "Engine internal error — will retry after cooldown.",
        isRetryable: true,
        responseBody,
        retryAfterMs: 10000,
      }
    }
  }

  // Catch Xunfei NotEnoughCvError embedded in error.message
  // Pattern: "NotEnoughCvError:`mcXXXXX``astron-code-latest`tokens.total..."
  // Also catches: "EngineInternalError:The system is busy, please try again later."
  // Also catches: "RecvFromEngineError:Engine Busy" (code 10010)
  // IMPORTANT: When 10012 / EngineInternalError appears WITH overflow keywords
  // (e.g. "InvalidParameter: Range of input length should be [1, 202745]"),
  // it must be classified as context_overflow, not quota_exceeded.
  const errorMsg = typeof body?.error?.message === "string" ? body?.error?.message : ""
  const errorMsgLower = errorMsg.toLowerCase()
  // Check for context overflow keywords FIRST — before quota patterns.
  // Xunfei 10012 + InvalidParameter = context overflow, not quota error.
  const isEmbeddedOverflow = isOverflowErrorText(errorMsg)
  if (isEmbeddedOverflow) {
    return {
      type: "context_overflow",
      message: "Input exceeds context window of this model",
      responseBody,
    }
  }
  if (
    errorMsg.includes("NotEnoughCv") ||
    errorMsg.includes("11210") ||
    errorMsg.includes("tokens.total") ||
    errorMsg.includes("business.total") ||
    errorMsg.includes("10010") ||
    errorMsg.includes("10012") ||
    errorMsgLower.includes("engineinternalerror") ||
    errorMsgLower.includes("recvfromengineerror") ||
    errorMsgLower.includes("engine busy") ||
    errorMsgLower.includes("system is busy") ||
    errorMsgLower.includes("try again later")
  ) {
    return {
      type: "quota_exceeded",
      message: "Provider is temporarily busy — will retry after cooldown.",
      isRetryable: true,
      responseBody,
      retryAfterMs: 10000,
    }
  }
}

export type ParsedAPICallError =
  | {
      type: "context_overflow"
      message: string
      responseBody?: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
    }
  | {
      type: "quota_exceeded"
      message: string
      statusCode?: number
      isRetryable: true
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
      retryAfterMs?: number
    }

export function parseAPICallError(input: { providerID: ProviderID; error: APICallError }): ParsedAPICallError {
  const m = message(input.providerID, input.error)
  const body = json(input.error.responseBody)
  const overflowByPattern = isOverflow(m)
  const overflowByStatus = input.error.statusCode === 413
  const overflowByCode = body?.error?.code === "context_length_exceeded"
  if (overflowByPattern || overflowByStatus || overflowByCode) {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  // Detect quota/token exhaustion errors — these are retryable with backoff
  // Xunfei NotEnoughCvError (code 11210), Xunfei RecvFromEngineError (code 10010, Engine Busy),
  // Xunfei EngineInternalError (code 10012) — BUT 10012 + InvalidParameter = context overflow.
  // OpenAI insufficient_quota, and other quota/busy patterns that indicate
  // transient limits (not permanent auth failures).
  // IMPORTANT: Check for overflow keywords in the response body BEFORE
  // classifying as quota_exceeded. Xunfei 10012 with "InvalidParameter" /
  // "Range of input length" is a context overflow, not a quota error.
  const bodyMsg = typeof body?.error?.message === "string" ? body.error.message : ""
  const bodyMsgLower = bodyMsg.toLowerCase()
  const isBodyOverflow = isOverflowErrorText(bodyMsg)
  if (isBodyOverflow) {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  const statusCode = input.error.statusCode
  const isQuotaError =
    statusCode === 429 ||
    body?.error?.code === "11210" ||
    body?.error?.code === "NotEnoughCvError" ||
    body?.error?.code === "10010" ||
    body?.error?.code === "10012" ||
    body?.error?.code === "10050" ||
    body?.error?.code === "insufficient_quota" ||
    (typeof body?.error?.message === "string" &&
      (body.error.message.includes("NotEnoughCv") ||
        body.error.message.includes("11210") ||
        body.error.message.includes("10010") ||
        body.error.message.includes("10012") ||
        body.error.message.includes("10050") ||
        body.error.message.includes("EngineInternalError") ||
        body.error.message.toLowerCase().includes("recvfromengineerror") ||
        body.error.message.toLowerCase().includes("engine busy") ||
        body.error.message.toLowerCase().includes("system is busy") ||
        body.error.message.toLowerCase().includes("try again later") ||
        body.error.message.includes("tokens.total") ||
        body.error.message.includes("business.total")))

  if (isQuotaError) {
    // Extract retry-after hint from headers or body
    let retryAfterMs: number | undefined
    const headers = input.error.responseHeaders
    if (headers) {
      const retryAfterMsHeader = headers["retry-after-ms"]
      if (retryAfterMsHeader) {
        const parsed = Number.parseFloat(retryAfterMsHeader)
        if (!Number.isNaN(parsed)) retryAfterMs = parsed
      }
      const retryAfterHeader = headers["retry-after"]
      if (retryAfterHeader && !retryAfterMs) {
        const parsedSeconds = Number.parseFloat(retryAfterHeader)
        if (!Number.isNaN(parsedSeconds)) retryAfterMs = Math.ceil(parsedSeconds * 1000)
      }
    }
    if (!retryAfterMs) retryAfterMs = 5000 // default backoff

    return {
      type: "quota_exceeded",
      message: m,
      statusCode,
      isRetryable: true,
      responseHeaders: input.error.responseHeaders,
      responseBody: input.error.responseBody,
      metadata: input.error.url ? { url: input.error.url } : undefined,
      retryAfterMs,
    }
  }

  const metadata = input.error.url ? { url: input.error.url } : undefined
  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: input.providerID.startsWith("openai") ? isOpenAiErrorRetryable(input.error) : input.error.isRetryable,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
  }
}
