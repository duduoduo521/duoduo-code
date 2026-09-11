import { Schema } from "effect"
import { isRecord } from "./record"
import { currentLocale } from "./locale"

/** Shared tagged error used in Effect failure channels / catch callbacks.
 *  Replaces the global `Error` constructor so the effect linter's `globalError*`
 *  rules are satisfied while preserving the original message and optionally
 *  wrapping the underlying defect in `cause`. It is a `Schema.TaggedErrorClass`
 *  (not the global `Error`) so the `globalError*` lints are satisfied.
 *
 *  Bilingual: `message` is the English (default) text and `messageZh` the
 *  Chinese translation. `errorMessage()` returns the one matching the user's
 *  current locale (see `util/locale`). When `messageZh` is absent the English
 *  `message` is returned as a fallback, so existing single-language call sites
 *  keep working unchanged.
 *
 *  Note: `Effect.fail(new DuoduoError(...))` also trips `unnecessaryFailYieldableError`
 *  (a known false-positive conflict between the two effect rules for tagged errors —
 *  the same pre-existing conflict already exists for e.g. `AccountServiceError`).
 *  Those specific sites carry a precise inline `@effect-diagnostics-next-line`
 *  suppression rather than disabling the rule project-wide. */
export class DuoduoError extends Schema.TaggedErrorClass<DuoduoError>()("DuoduoError", {
  message: Schema.String,
  messageZh: Schema.optional(Schema.String),
  // Mirrors Rust `UnifiedError::is_retryable`, transported verbatim over the SSE
  // `error` event so the TS retry policy trusts a single source of truth instead
  // of guessing from free-text.
  retryable: Schema.optional(Schema.Boolean),
  // Mirrors Rust `UnifiedError::retry_after_ms` (only `RateLimited` populates it,
  // e.g. when the upstream provider returned a `Retry-After` hint). When present the
  // TS backoff honors the server's suggested delay instead of guessing one.
  retry_after_ms: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect),
}) {}

export function errorFormat(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`
  }

  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error, null, 2)
    } catch {
      return "Unexpected error (unserializable)"
    }
  }

  return String(error)
}

export function errorMessage(error: unknown): string {
  // Bilingual: DuoduoError carries an optional `messageZh`; when the user's
  // locale is Chinese and a translation exists, prefer it. This is the single
  // centralized exit point for user-visible error text, so all callers that go
  // through `errorMessage()` become locale-aware for free.
  if (error instanceof DuoduoError && currentLocale() === "zh") {
    if (error.messageZh && error.messageZh.length > 0) return error.messageZh
  }

  if (error instanceof Error) {
    if (error.message) return error.message
    if (error.name) return error.name
  }

  if (isRecord(error) && typeof error.message === "string" && error.message) {
    return error.message
  }

  if (isRecord(error) && isRecord(error.data) && typeof error.data.message === "string" && error.data.message) {
    return error.data.message
  }

  const text = String(error)
  if (text && text !== "[object Object]") return text

  const formatted = errorFormat(error)
  if (formatted && formatted !== "{}") return formatted
  return "unknown error"
}

export function errorData(error: unknown) {
  if (error instanceof Error) {
    return {
      type: error.name,
      message: errorMessage(error),
      stack: error.stack,
      cause: error.cause === undefined ? undefined : errorFormat(error.cause),
      formatted: errorFormatted(error),
    }
  }

  if (!isRecord(error)) {
    return {
      type: typeof error,
      message: errorMessage(error),
      formatted: errorFormatted(error),
    }
  }

  const data = Object.getOwnPropertyNames(error).reduce<Record<string, unknown>>((acc, key) => {
    const value = error[key]
    if (value === undefined) return acc
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      acc[key] = value
      return acc
    }
    // oxlint-disable-next-line no-base-to-string -- intentional coercion of arbitrary error properties
    acc[key] = value instanceof Error ? value.message : String(value)
    return acc
  }, {})

  if (typeof data.message !== "string") data.message = errorMessage(error)
  if (typeof data.type !== "string") data.type = error.constructor?.name
  data.formatted = errorFormatted(error)
  return data
}

function errorFormatted(error: unknown) {
  const formatted = errorFormat(error)
  if (formatted !== "{}") return formatted
  return String(error)
}
