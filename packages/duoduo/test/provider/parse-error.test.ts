import { describe, expect, test } from "bun:test"
import {
  isOverflowErrorText,
  parseStreamError,
  parseAPICallError,
} from "../../src/provider/error"
import { APICallError } from "ai"
import { ProviderID } from "../../src/provider/schema"

// ─── isOverflowErrorText additional patterns ───

describe("isOverflowErrorText - additional patterns", () => {
  test("detects 'range of input length should be' (Xunfei)", () => {
    expect(isOverflowErrorText("Range of input length should be [1, 202745]")).toBe(true)
  })

  test("detects 'InvalidParameter...range of input' (Xunfei combined)", () => {
    expect(
      isOverflowErrorText("InternalError.Algo.InvalidParameter: Range of input length should be [1, 128000]"),
    ).toBe(true)
  })

  test("detects 'input token limit' (Xunfei v2)", () => {
    expect(isOverflowErrorText("input token limit is 202752")).toBe(true)
  })

  test("detects 'model_context_window_exceeded' (z.ai)", () => {
    expect(isOverflowErrorText("model_context_window_exceeded")).toBe(true)
  })

  test("detects 'prompt too long; exceeded max context length' (Ollama)", () => {
    expect(isOverflowErrorText("prompt too long; exceeded max context length")).toBe(true)
  })

  test("detects 'prompt too long; exceeded context length' (Ollama variant)", () => {
    expect(isOverflowErrorText("prompt too long; exceeded context length")).toBe(true)
  })

  test("detects 'too large for model with N maximum context length' (Mistral)", () => {
    expect(isOverflowErrorText("too large for model with 32768 maximum context length")).toBe(true)
  })

  test("detects 'context_length_exceeded' (generic)", () => {
    expect(isOverflowErrorText("context_length_exceeded")).toBe(true)
  })

  test("detects 'context length exceeded' (with space)", () => {
    expect(isOverflowErrorText("context length exceeded")).toBe(true)
  })

  test("detects 'exceeded model token limit' (Kimi)", () => {
    expect(isOverflowErrorText("exceeded model token limit")).toBe(true)
  })

  test("detects 'context window exceeds limit' (MiniMax)", () => {
    expect(isOverflowErrorText("context window exceeds limit")).toBe(true)
  })

  test("detects 'greater than the context length' (LM Studio)", () => {
    expect(isOverflowErrorText("greater than the context length")).toBe(true)
  })

  test("detects 'exceeds the available context size' (llama.cpp)", () => {
    expect(isOverflowErrorText("exceeds the available context size")).toBe(true)
  })

  test("detects 'context length is only N tokens' (vLLM)", () => {
    expect(isOverflowErrorText("context length is only 4096 tokens")).toBe(true)
  })

  test("detects 'input length exceeds context length' (vLLM)", () => {
    expect(isOverflowErrorText("input length exceeds context length")).toBe(true)
  })

  test("detects 'request entity too large' (HTTP 413)", () => {
    expect(isOverflowErrorText("request entity too large")).toBe(true)
  })

  test("does not match non-overflow errors", () => {
    expect(isOverflowErrorText("internal server error")).toBe(false)
    expect(isOverflowErrorText("rate limit exceeded")).toBe(false)
    expect(isOverflowErrorText("unauthorized")).toBe(false)
    expect(isOverflowErrorText("")).toBe(false)
  })
})

// ─── parseStreamError ───

describe("parseStreamError", () => {
  test("returns undefined for non-object input", () => {
    expect(parseStreamError("not json")).toBeUndefined()
    expect(parseStreamError(42)).toBeUndefined()
    expect(parseStreamError(null)).toBeUndefined()
    expect(parseStreamError(undefined)).toBeUndefined()
  })

  test("returns undefined when type is not 'error'", () => {
    expect(parseStreamError({ type: "success", data: {} })).toBeUndefined()
  })

  test("parses context_length_exceeded error", () => {
    const result = parseStreamError({
      type: "error",
      error: { code: "context_length_exceeded", message: "too long" },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("context_overflow")
    expect(result!.message).toBe("Input exceeds context window of this model")
  })

  test("parses insufficient_quota error as quota_exceeded (retryable)", () => {
    const result = parseStreamError({
      type: "error",
      error: { code: "insufficient_quota", message: "quota exceeded" },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("quota_exceeded")
    if (result!.type === "quota_exceeded") {
      expect(result!.isRetryable).toBe(true)
      expect(result!.retryAfterMs).toBe(5000)
    }
  })

  test("parses Xunfei 11210 error as quota_exceeded", () => {
    const result = parseStreamError({
      type: "error",
      error: { code: "11210", message: "NotEnoughCvError" },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("quota_exceeded")
    if (result!.type === "quota_exceeded") {
      expect(result!.isRetryable).toBe(true)
    }
  })

  test("parses Xunfei 10010 error as quota_exceeded", () => {
    const result = parseStreamError({
      type: "error",
      error: { code: "10010", message: "RecvFromEngineError" },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("quota_exceeded")
  })

  test("parses Xunfei 10012 WITHOUT overflow keywords as quota_exceeded", () => {
    const result = parseStreamError({
      type: "error",
      error: { code: "10012", message: "EngineInternalError: system busy" },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("quota_exceeded")
  })

  test("parses Xunfei 10012 WITH overflow keywords as context_overflow", () => {
    const result = parseStreamError({
      type: "error",
      error: {
        code: "10012",
        message: "InternalError.Algo.InvalidParameter: Range of input length should be [1, 202745]",
      },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("context_overflow")
  })

  test("parses usage_not_included as non-retryable api_error", () => {
    const result = parseStreamError({
      type: "error",
      error: { code: "usage_not_included", message: "upgrade required" },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("api_error")
    if (result!.type === "api_error") {
      expect(result!.isRetryable).toBe(false)
    }
  })

  test("parses invalid_prompt as non-retryable api_error", () => {
    const result = parseStreamError({
      type: "error",
      error: { code: "invalid_prompt", message: "bad prompt" },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("api_error")
    if (result!.type === "api_error") {
      expect(result!.isRetryable).toBe(false)
    }
  })

  test("parses embedded NotEnoughCv in error.message as quota_exceeded", () => {
    const result = parseStreamError({
      type: "error",
      error: {
        code: "unknown",
        message: "NotEnoughCvError: tokens.total exceeded limit",
      },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("quota_exceeded")
  })

  test("parses embedded overflow in error.message as context_overflow", () => {
    const result = parseStreamError({
      type: "error",
      error: {
        code: "unknown",
        message: "prompt is too long: 50000 tokens requested",
      },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("context_overflow")
  })

  test("returns undefined for unknown error code without message patterns", () => {
    const result = parseStreamError({
      type: "error",
      error: { code: "some_unknown_code", message: "something happened" },
    })
    expect(result).toBeUndefined()
  })
})

// ─── parseAPICallError ───

describe("parseAPICallError", () => {
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

  test("detects context overflow by pattern", () => {
    const error = makeAPICallError({
      message: "prompt is too long: 50000 tokens",
      responseBody: '{"error":{"message":"prompt is too long"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("anthropic"), error })
    expect(result.type).toBe("context_overflow")
  })

  test("detects context overflow by 413 status code", () => {
    const error = makeAPICallError({
      message: "Request Entity Too Large",
      statusCode: 413,
      responseBody: "",
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.type).toBe("context_overflow")
  })

  test("detects context overflow by context_length_exceeded code", () => {
    const error = makeAPICallError({
      message: "Bad request",
      responseBody: '{"error":{"code":"context_length_exceeded","message":"too long"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("openai"), error })
    expect(result.type).toBe("context_overflow")
  })

  test("detects quota exceeded by 429 status", () => {
    const error = makeAPICallError({
      message: "Too many requests",
      statusCode: 429,
      responseBody: '{"error":{"message":"rate limited"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.type).toBe("quota_exceeded")
    if (result.type === "quota_exceeded") {
      expect(result.isRetryable).toBe(true)
    }
  })

  test("detects quota exceeded by insufficient_quota code", () => {
    const error = makeAPICallError({
      message: "Insufficient quota",
      responseBody: '{"error":{"code":"insufficient_quota","message":"quota exceeded"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("openai"), error })
    expect(result.type).toBe("quota_exceeded")
  })

  test("classifies Xunfei 10012 without overflow keywords as quota_exceeded", () => {
    const error = makeAPICallError({
      message: "Engine error",
      responseBody: '{"error":{"code":"10012","message":"EngineInternalError: system busy"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("xunfei"), error })
    expect(result.type).toBe("quota_exceeded")
  })

  test("classifies Xunfei 10012 with overflow keywords as context_overflow", () => {
    const error = makeAPICallError({
      message: "Engine error",
      responseBody:
        '{"error":{"code":"10012","message":"InternalError.Algo.InvalidParameter: Range of input length should be [1, 202745]"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("xunfei"), error })
    expect(result.type).toBe("context_overflow")
  })

  test("returns api_error for non-overflow, non-quota errors", () => {
    const error = makeAPICallError({
      message: "Bad request",
      statusCode: 400,
      responseBody: '{"error":{"message":"invalid input"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.isRetryable).toBe(false)
    }
  })

  test("marks openai 404 as retryable", () => {
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

  test("extracts retry-after-ms from headers for quota errors", () => {
    const error = makeAPICallError({
      message: "Rate limited",
      statusCode: 429,
      responseHeaders: { "retry-after-ms": "3000" },
      responseBody: '{"error":{"message":"rate limit"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    if (result.type === "quota_exceeded") {
      expect(result.retryAfterMs).toBe(3000)
    }
  })

  test("uses default retryAfterMs for quota errors without headers", () => {
    const error = makeAPICallError({
      message: "Rate limited",
      statusCode: 429,
      responseHeaders: {},
      responseBody: '{"error":{"message":"rate limit"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    if (result.type === "quota_exceeded") {
      expect(result.retryAfterMs).toBe(5000)
    }
  })

  test("detects overflow by body message even when error code doesn't match", () => {
    const error = makeAPICallError({
      message: "Error",
      responseBody: '{"error":{"code":"unknown","message":"prompt is too long: 60000 tokens"}}',
    })
    const result = parseAPICallError({ providerID: ProviderID.make("test"), error })
    expect(result.type).toBe("context_overflow")
  })
})
