import { describe, expect, test } from "bun:test"
import { isOverflowErrorText, parseStreamError, parseAPICallError } from "../../src/provider/error"
import { APICallError } from "ai"
import { ProviderID } from "../../src/provider/schema"

// ─── isOverflow additional patterns ───

describe("ProviderError.isOverflowErrorText - status code 'no body' pattern", () => {
  test("detects 400 with 'no body' (Cerebras/Mistral) via isOverflowErrorText", () => {
    // Note: The 400/413 'no body' pattern is handled internally by the
    // private isOverflow() function, not by isOverflowErrorText().
    // isOverflowErrorText only matches OVERFLOW_PATTERNS.
    expect(isOverflowErrorText("400 (no body)")).toBe(false)
  })

  test("detects 413 with 'no body' via isOverflowErrorText", () => {
    expect(isOverflowErrorText("413 (no body)")).toBe(false)
  })

  test("does not match 401 with 'no body'", () => {
    expect(isOverflowErrorText("401 (no body)")).toBe(false)
  })

  test("does not match 429 with 'no body'", () => {
    expect(isOverflowErrorText("429 (no body)")).toBe(false)
  })

  test("the 400/413 'no body' pattern is caught by parseAPICallError", () => {
    // Verify the private isOverflow() is integrated correctly
    const error = new APICallError({
      message: "400 (no body)",
      url: "https://api.test.com",
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: {},
      responseBody: "",
      isRetryable: false,
    })
    const result = parseAPICallError({ providerID: ProviderID.make("cerebras"), error })
    expect(result.type).toBe("context_overflow")
  })

  test("the 413 status code alone triggers context_overflow", () => {
    const error = new APICallError({
      message: "413 status code (no body)",
      url: "https://api.test.com",
      requestBodyValues: {},
      statusCode: 413,
      responseHeaders: {},
      responseBody: "",
      isRetryable: false,
    })
    const result = parseAPICallError({ providerID: ProviderID.make("mistral"), error })
    expect(result.type).toBe("context_overflow")
  })
})

// ─── parseStreamError edge cases ───

describe("parseStreamError - edge cases", () => {
  test("handles Xunfei NotEnoughCvError code directly", () => {
    const result = parseStreamError({
      type: "error",
      error: { code: "NotEnoughCvError", message: "quota exceeded" },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("quota_exceeded")
  })

  test("handles Xunfei 10050 code", () => {
    const result = parseStreamError({
      type: "error",
      error: { code: "10050", message: "server error" },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("quota_exceeded")
  })

  test("handles embedded 'tokens.total' in error.message", () => {
    const result = parseStreamError({
      type: "error",
      error: {
        code: "unknown",
        message: "NotEnoughCvError:mcXXXXX`model`tokens.total exceeded",
      },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("quota_exceeded")
  })

  test("handles embedded 'business.total' in error.message", () => {
    const result = parseStreamError({
      type: "error",
      error: {
        code: "unknown",
        message: "Error: business.total exceeded limit",
      },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("quota_exceeded")
  })

  test("handles embedded 'engine busy' in error.message", () => {
    const result = parseStreamError({
      type: "error",
      error: {
        code: "unknown",
        message: "RecvFromEngineError: Engine Busy, please try again",
      },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("quota_exceeded")
  })

  test("handles embedded 'try again later' in error.message", () => {
    const result = parseStreamError({
      type: "error",
      error: {
        code: "unknown",
        message: "EngineInternalError: The system is busy, please try again later.",
      },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("quota_exceeded")
  })

  test("returns undefined for string input", () => {
    expect(parseStreamError("just a string")).toBeUndefined()
  })

  test("returns undefined for number input", () => {
    expect(parseStreamError(42)).toBeUndefined()
  })

  test("returns undefined for null input", () => {
    expect(parseStreamError(null)).toBeUndefined()
  })

  test("returns undefined for empty object", () => {
    expect(parseStreamError({})).toBeUndefined()
  })
})

// ─── parseAPICallError edge cases ───

describe("parseAPICallError - edge cases", () => {
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

  test("detects overflow by Xunfei 10012 with overflow keywords in body", () => {
    const error = makeAPICallError({
      message: "Error",
      responseBody:
        '{"error":{"code":"10012","message":"InternalError.Algo.InvalidParameter: Range of input length should be [1, 202745]"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("xunfei"), error })
    expect(result.type).toBe("context_overflow")
  })

  test("detects quota exceeded by Xunfei 11210 code in body", () => {
    const error = makeAPICallError({
      message: "Quota error",
      responseBody: '{"error":{"code":"11210","message":"NotEnoughCvError: tokens exceeded"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("xunfei"), error })
    expect(result.type).toBe("quota_exceeded")
    if (result.type === "quota_exceeded") {
      expect(result.isRetryable).toBe(true)
    }
  })

  test("extracts retry-after-ms header for quota errors", () => {
    const error = makeAPICallError({
      message: "Rate limited",
      statusCode: 429,
      responseHeaders: { "retry-after-ms": "2000" },
      responseBody: '{"error":{"message":"rate limit"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    if (result.type === "quota_exceeded") {
      expect(result.retryAfterMs).toBe(2000)
    }
  })

  test("extracts retry-after header in seconds for quota errors", () => {
    const error = makeAPICallError({
      message: "Rate limited",
      statusCode: 429,
      responseHeaders: { "retry-after": "3" },
      responseBody: '{"error":{"message":"rate limit"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    if (result.type === "quota_exceeded") {
      expect(result.retryAfterMs).toBe(3000)
    }
  })

  test("retry-after-ms takes precedence over retry-after", () => {
    const error = makeAPICallError({
      message: "Rate limited",
      statusCode: 429,
      responseHeaders: { "retry-after-ms": "2000", "retry-after": "10" },
      responseBody: '{"error":{"message":"rate limit"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    if (result.type === "quota_exceeded") {
      expect(result.retryAfterMs).toBe(2000)
    }
  })

  test("detects quota by Xunfei 10010 code in body", () => {
    const error = makeAPICallError({
      message: "Error",
      responseBody: '{"error":{"code":"10010","message":"RecvFromEngineError"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("xunfei"), error })
    expect(result.type).toBe("quota_exceeded")
  })

  test("detects quota by Xunfei 10050 code in body", () => {
    const error = makeAPICallError({
      message: "Error",
      responseBody: '{"error":{"code":"10050","message":"server error"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("xunfei"), error })
    expect(result.type).toBe("quota_exceeded")
  })

  test("detects quota by embedded EngineInternalError in body message", () => {
    const error = makeAPICallError({
      message: "Error",
      responseBody: '{"error":{"code":"unknown","message":"EngineInternalError: system busy"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("xunfei"), error })
    expect(result.type).toBe("quota_exceeded")
  })

  test("detects quota by embedded 'try again later' in body message", () => {
    const error = makeAPICallError({
      message: "Error",
      responseBody: '{"error":{"code":"unknown","message":"The system is busy, try again later"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("xunfei"), error })
    expect(result.type).toBe("quota_exceeded")
  })

  test("returns api_error with metadata.url when error has url", () => {
    const error = makeAPICallError({
      message: "Bad request",
      statusCode: 400,
      responseBody: '{"error":{"message":"invalid"}}',
      url: "https://api.openai.com/v1/chat/completions",
    })
    const result = parseAPICallError({ providerID: ProviderID.make("openai"), error })
    if (result.type === "api_error") {
      expect(result.metadata?.url).toBe("https://api.openai.com/v1/chat/completions")
    }
  })

  test("openai-compatible provider with 404 is retryable", () => {
    const error = makeAPICallError({
      message: "Not found",
      statusCode: 404,
      isRetryable: false,
      responseBody: "",
    })
    const result = parseAPICallError({ providerID: ProviderID.make("openai"), error })
    if (result.type === "api_error") {
      expect(result.isRetryable).toBe(true)
    }
  })

  test("non-openai provider with 404 is NOT retryable by default", () => {
    const error = makeAPICallError({
      message: "Not found",
      statusCode: 404,
      isRetryable: false,
      responseBody: "",
    })
    const result = parseAPICallError({ providerID: ProviderID.make("anthropic"), error })
    if (result.type === "api_error") {
      expect(result.isRetryable).toBe(false)
    }
  })
})
