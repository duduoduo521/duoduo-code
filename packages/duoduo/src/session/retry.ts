import type { NamedError } from "@duoduo-ai/shared/util/error"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"
import { isOverflowErrorText } from "@/provider/error"

export type Err = ReturnType<NamedError["toObject"]>

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
// P2-2: hard cap on any single retry delay (retry-after hints included).
// The old value was 2^31-1 ms (~24.86 days) — a gateway sending an absurd
// `Retry-After` would schedule a retry for weeks later. 60s covers real
// rate-limit windows; beyond that the error surfaces to the user instead.
export const RETRY_MAX_DELAY = 60_000
export const RETRY_MAX_ATTEMPTS = 5 // Maximum retry attempts before giving up

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: MessageV2.APIError, retryAfterMs?: number) {
  // Honor an explicit upstream/retry-after hint when present (transported from
  // Rust's UnifiedError::retry_after_ms over the SSE `error` event). This takes
  // precedence over the local exponential curve so we respect the server's
  // suggested backoff (e.g. an upstream `Retry-After` from a 429).
  if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
    return cap(retryAfterMs)
  }
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
    }
  }

  return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
}

export function retryable(error: Err) {
  // Rust-transported errors carry an explicit `retryable` flag on the SSE
  // `error` event. Trust it directly — this is the single source of truth and
  // avoids divergence from Rust's UnifiedError::is_retryable. When true we
  // retry (using the original message as the user-facing hint); when false we
  // do not retry.
  if (typeof error.data?.retryable === "boolean") {
    return error.data.retryable ? error.data.message : undefined
  }

  // context overflow errors should not be retried
  if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
  if (MessageV2.APIError.isInstance(error)) {
    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (!error.data.isRetryable && !(status !== undefined && status >= 500)) return undefined
    return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
  }

  // Check for rate limit and quota patterns in plain text error messages
  // IMPORTANT: Check for context overflow keywords FIRST. Xunfei 10012 with
  // "InvalidParameter" / "Range of input length" is context overflow, not quota.
  const msg = error.data?.message
  if (typeof msg === "string") {
    const lower = msg.toLowerCase()
    // Context overflow patterns — NOT retryable
    if (isOverflowErrorText(msg)) {
      return undefined // Not retryable — context overflow
    }
    // Quota/rate-limit patterns — retryable
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests") ||
      lower.includes("notenoughcv") ||
      lower.includes("not enough cv") ||
      lower.includes("quota") ||
      lower.includes("tokens.total") ||
      lower.includes("business.total") ||
      lower.includes("insufficient_quota") ||
      lower.includes("capacity") ||
      lower.includes("10010") ||
      lower.includes("10012") ||
      lower.includes("10050") ||
      lower.includes("engineinternalerror") ||
      lower.includes("recvfromengineerror") ||
      lower.includes("engine busy") ||
      lower.includes("system is busy") ||
      lower.includes("try again later")
    ) {
      return msg
    }
  }

  const json = iife(() => {
    try {
      if (typeof error.data?.message === "string") {
        const parsed = JSON.parse(error.data.message)
        return parsed
      }

      return JSON.parse(error.data.message)
    } catch {
      return undefined
    }
  })
  if (!json || typeof json !== "object") return undefined
  const code = typeof json.code === "string" ? json.code : ""

  if (json.type === "error" && json.error?.type === "too_many_requests") {
    return "Too Many Requests"
  }
  if (code.includes("exhausted") || code.includes("unavailable")) {
    return "Provider is overloaded"
  }
  // Xunfei-specific error codes: 11210 = NotEnoughCvError (token/quota exceeded)
  // 10012 = EngineInternalError — dual semantics:
  //   * 10012 + InvalidParameter / "Range of input length" = context overflow (NOT retryable)
  //   * 10012 standalone = engine internal error (retryable)
  // Check overflow keywords in json.error.message BEFORE matching on code.
  if (typeof json.error?.message === "string") {
    if (isOverflowErrorText(json.error.message as string)) {
      return undefined // Not retryable — context overflow
    }
  }
  // Only treat 10012 as quota (retryable) when NOT accompanied by overflow keywords
  if (
    code.includes("11210") ||
    code.includes("10010") ||
    code.includes("10012") ||
    code.includes("10050") ||
    code.includes("notenoughcv") ||
    code.includes("insufficient_quota") ||
    code.includes("quota_exceeded") ||
    code.includes("token_limit") ||
    code.includes("capacity_exceeded")
  ) {
    return "Quota exceeded — will retry after cooldown"
  }
  if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
    return "Rate Limited"
  }
  // Catch Xunfei-style errors embedded in error.message
  // e.g. "NotEnoughCvError: ... code: 11210"
  // e.g. "EngineInternalError:The system is busy, please try again later."
  // e.g. "RecvFromEngineError:Engine Busy" (code 10010)
  // IMPORTANT: Check overflow keywords FIRST — 10012 + InvalidParameter = context overflow.
  if (typeof json.error?.message === "string") {
    const errMsg = json.error.message as string
    const errMsgLower = errMsg.toLowerCase()
    if (isOverflowErrorText(errMsg)) {
      return undefined // Not retryable — context overflow
    }
    if (
      errMsg.includes("NotEnoughCv") ||
      errMsg.includes("11210") ||
      errMsg.includes("tokens.total") ||
      errMsg.includes("business.total") ||
      errMsg.includes("10010") ||
      errMsg.includes("10012") ||
      errMsg.includes("EngineInternalError") ||
      errMsgLower.includes("recvfromengineerror") ||
      errMsgLower.includes("engine busy") ||
      errMsgLower.includes("system is busy") ||
      errMsgLower.includes("try again later")
    ) {
      return "Provider is temporarily busy — will retry after cooldown"
    }
  }
  return undefined
}

export function policy(opts: {
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; next: number }) => Effect.Effect<void>
  maxAttempts?: number
}) {
  const max = opts.maxAttempts ?? RETRY_MAX_ATTEMPTS
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      // Enforce maximum retry attempts — allow up to `max` retries.
      // meta.attempt starts at 1 (first retry), so we stop when attempt > max.
      if (meta.attempt > max) return Cause.done(meta.attempt)
      const error = opts.parse(meta.input)
      const message = retryable(error)
      if (!message) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const retryAfterMs =
          typeof error.data?.retry_after_ms === "number" ? error.data.retry_after_ms : undefined
        const wait = delay(
          meta.attempt,
          MessageV2.APIError.isInstance(error) ? error : undefined,
          retryAfterMs,
        )
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({ attempt: meta.attempt, message, next: now + wait })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
