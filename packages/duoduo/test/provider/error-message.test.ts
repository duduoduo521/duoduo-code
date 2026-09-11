import { describe, expect, test } from "bun:test"
import { parseAPICallError } from "../../src/provider/error"
import { APICallError } from "ai"
import { ProviderID } from "../../src/provider/schema"

// Test the internal `message()` function's behavior via `parseAPICallError`.
// The `message()` function handles:
// 1. Empty messages with response body fallback
// 2. Empty messages with status code fallback
// 3. JSON response body extraction (always attempted when responseBody exists)
// 4. HTML response body handling (gateway/proxy errors)
//
// Key logic: When responseBody exists, always attempt JSON/HTML parsing.
// If msg already contains the extracted error message, return msg as-is to avoid redundancy.
// Otherwise, merge: `${msg}: ${errMsg}`.

function makeAPICallError(overrides: Partial<ConstructorParameters<typeof APICallError>[0]> = {}) {
  return new APICallError({
    message: "API error",
    url: "https://api.test.com/v1/chat",
    requestBodyValues: {},
    statusCode: 400,
    responseHeaders: {},
    responseBody: "{}",
    isRetryable: false,
    ...overrides,
  })
}

describe("ProviderError.message (via parseAPICallError)", () => {
  test("uses responseBody when message is empty", () => {
    const error = makeAPICallError({
      message: "",
      responseBody: "raw error body text",
      statusCode: 500,
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.message).toBe("raw error body text")
  })

  test("uses status code text when both message and responseBody are empty", () => {
    const error = makeAPICallError({
      message: "",
      responseBody: "",
      statusCode: 503,
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.message).toBe("Service Unavailable")
  })

  test("uses 'Unknown error' when message, responseBody, and status code are all empty", () => {
    const error = makeAPICallError({
      message: "",
      responseBody: "",
      statusCode: undefined,
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.message).toBe("Unknown error")
  })

  test("merges responseBody error into uninformative msg (e.g. pure status code)", () => {
    // "400" !== "Bad Request" (STATUS_CODES[400]), and msg is uninformative.
    // The fix now attempts to extract error info from responseBody even when
    // msg doesn't match STATUS_CODES, merging it when it adds new information.
    const error = makeAPICallError({
      message: "400",
      statusCode: 400,
      responseBody: '{"error":{"message":"Invalid model specified"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    // msg "400" does not contain "Invalid model specified", so they are merged
    expect(result.message).toContain("400")
    expect(result.message).toContain("Invalid model specified")
  })

  test("returns msg as-is when it already contains the responseBody error", () => {
    // When SDK extracts error.message from responseBody, msg already has the info.
    // The fix detects this and returns msg without duplication.
    const error = makeAPICallError({
      message: "Rate limit reached for gpt-4",
      statusCode: 429,
      responseBody: '{"error":{"message":"Rate limit reached for gpt-4"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    // msg already contains the extracted message, so no duplication
    expect(result.message).toBe("Rate limit reached for gpt-4")
  })

  test("extracts error.message from JSON response body regardless of msg content", () => {
    // After fix: JSON parsing is always attempted when responseBody exists,
    // not only when msg === STATUS_CODES[statusCode]
    const error = makeAPICallError({
      message: "Bad Request",
      statusCode: 400,
      responseBody: '{"error":{"message":"Invalid model specified"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.message).toContain("Invalid model specified")
    expect(result.message).toContain("Bad Request")
  })

  test("extracts error.error.message from nested JSON response body", () => {
    const error = makeAPICallError({
      message: "Bad Request",
      statusCode: 400,
      responseBody: '{"error":{"message":"Rate limit exceeded","type":"rate_limit_error"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.message).toContain("Rate limit exceeded")
  })

  test("handles HTML 401 response body with gateway warning (even with non-standard msg)", () => {
    // After fix: HTML detection is no longer gated by msg === STATUS_CODES
    const error = makeAPICallError({
      message: "Authentication Error", // non-standard, !== "Unauthorized"
      statusCode: 401,
      responseBody: "<!doctype html><html><body>Unauthorized</body></html>",
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.message).toContain("Unauthorized")
    expect(result.message).toContain("gateway or proxy")
  })

  test("handles HTML 401 with standard message too", () => {
    const error = makeAPICallError({
      message: "Unauthorized",
      statusCode: 401,
      responseBody: "<!doctype html><html><body>Unauthorized</body></html>",
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.message).toContain("Unauthorized")
    expect(result.message).toContain("gateway or proxy")
  })

  test("handles HTML 403 with non-standard message", () => {
    // After fix: HTML detection works even when msg !== STATUS_CODES
    const error = makeAPICallError({
      message: "Access Denied", // non-standard, !== "Forbidden"
      statusCode: 403,
      responseBody: "<!DOCTYPE html><html><body>Forbidden</body></html>",
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.message).toContain("Forbidden")
    expect(result.message).toContain("gateway or proxy")
  })

  test("handles HTML 403 with standard message", () => {
    const error = makeAPICallError({
      message: "Forbidden",
      statusCode: 403,
      responseBody: "<!DOCTYPE html><html><body>Forbidden</body></html>",
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.message).toContain("Forbidden")
    expect(result.message).toContain("gateway or proxy")
  })

  test("uses message directly for HTML response body with non-401/403 status", () => {
    const error = makeAPICallError({
      message: "Bad Gateway",
      statusCode: 502,
      responseBody: "<html><body>Bad Gateway</body></html>",
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    // For non-401/403 HTML responses, the message is used directly (not the HTML body)
    expect(result.message).toBe("Bad Gateway")
  })

  test("returns msg directly for non-JSON, non-HTML responseBody with informative msg", () => {
    // When msg is already informative and responseBody is not structured,
    // return msg as-is to avoid appending raw text
    const error = makeAPICallError({
      message: "Bad Request",
      statusCode: 400,
      responseBody: "plain text error",
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    // With the fix, non-JSON non-HTML responseBody is only appended when msg is
    // uninformative (e.g. pure status code number). "Bad Request" is informative.
    expect(result.message).toBe("Bad Request")
  })

  test("appends non-JSON responseBody when msg is uninformative (pure status code)", () => {
    const error = makeAPICallError({
      message: "400",
      statusCode: 400,
      responseBody: "plain text error",
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    // "400" is uninformative, so responseBody is appended with standard status text
    expect(result.message).toContain("Bad Request")
    expect(result.message).toContain("plain text error")
  })

  test("returns msg directly when responseBody is empty", () => {
    const error = makeAPICallError({
      message: "Custom error message",
      statusCode: 400,
      responseBody: "",
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.message).toBe("Custom error message")
  })

  test("trims whitespace from message", () => {
    const error = makeAPICallError({
      message: "  Bad Request  ",
      statusCode: 400,
      responseBody: '{"error":{"message":"  trimmed  "}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.message).not.toMatch(/^\s/)
    expect(result.message).not.toMatch(/\s$/)
  })

  test("extracts body.message (top-level) from JSON response body", () => {
    const error = makeAPICallError({
      message: "Bad Request",
      statusCode: 400,
      responseBody: '{"message":"Top-level error message"}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.message).toContain("Top-level error message")
  })

  test("falls back to body.error string from JSON response body", () => {
    const error = makeAPICallError({
      message: "Bad Request",
      statusCode: 400,
      responseBody: '{"error":"Simple error string"}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.message).toContain("Simple error string")
  })
})

// ─── json() helper function via parseStreamError ───

describe("ProviderError.json (via parseStreamError)", () => {
  test("parses JSON string input", async () => {
    const { parseStreamError } = await import("../../src/provider/error")
    const result = parseStreamError('{"type":"error","error":{"code":"context_length_exceeded","message":"too long"}}')
    expect(result).toBeDefined()
    expect(result!.type).toBe("context_overflow")
  })

  test("handles object input directly", async () => {
    const { parseStreamError } = await import("../../src/provider/error")
    const result = parseStreamError({
      type: "error",
      error: { code: "context_length_exceeded", message: "too long" },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("context_overflow")
  })

  test("returns undefined for primitive JSON values", async () => {
    const { parseStreamError } = await import("../../src/provider/error")
    expect(parseStreamError("42")).toBeUndefined()
    expect(parseStreamError('"hello"')).toBeUndefined()
    expect(parseStreamError("true")).toBeUndefined()
  })
})
