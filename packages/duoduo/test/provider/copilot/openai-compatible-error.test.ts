import { describe, expect, test } from "bun:test"
import {
  openaiCompatibleErrorDataSchema,
  defaultOpenAICompatibleErrorStructure,
} from "../../../src/provider/sdk/copilot/openai-compatible-error"

describe("openaiCompatibleErrorDataSchema", () => {
  test("validates a standard OpenAI error response", () => {
    const result = openaiCompatibleErrorDataSchema.safeParse({
      error: {
        message: "Rate limit exceeded",
        type: "rate_limit_error",
        param: null,
        code: "rate_limit_exceeded",
      },
    })
    expect(result.success).toBe(true)
  })

  test("validates error with minimal fields", () => {
    const result = openaiCompatibleErrorDataSchema.safeParse({
      error: {
        message: "Bad request",
      },
    })
    expect(result.success).toBe(true)
  })

  test("validates error with numeric code", () => {
    const result = openaiCompatibleErrorDataSchema.safeParse({
      error: {
        message: "Error occurred",
        code: 400,
      },
    })
    expect(result.success).toBe(true)
  })

  test("validates error with string code", () => {
    const result = openaiCompatibleErrorDataSchema.safeParse({
      error: {
        message: "Error occurred",
        code: "invalid_api_key",
      },
    })
    expect(result.success).toBe(true)
  })

  test("rejects missing error wrapper", () => {
    const result = openaiCompatibleErrorDataSchema.safeParse({
      message: "Bad request",
    })
    expect(result.success).toBe(false)
  })

  test("rejects missing message field", () => {
    const result = openaiCompatibleErrorDataSchema.safeParse({
      error: {
        type: "error",
      },
    })
    expect(result.success).toBe(false)
  })

  test("rejects non-object input", () => {
    const result = openaiCompatibleErrorDataSchema.safeParse("error")
    expect(result.success).toBe(false)
  })

  test("accepts param as string", () => {
    const result = openaiCompatibleErrorDataSchema.safeParse({
      error: {
        message: "Invalid parameter",
        param: "model",
      },
    })
    expect(result.success).toBe(true)
  })

  test("accepts param as object", () => {
    const result = openaiCompatibleErrorDataSchema.safeParse({
      error: {
        message: "Multiple parameter errors",
        param: { field: "temperature", reason: "out_of_range" },
      },
    })
    expect(result.success).toBe(true)
  })

  test("accepts param as null", () => {
    const result = openaiCompatibleErrorDataSchema.safeParse({
      error: {
        message: "Error",
        param: null,
      },
    })
    expect(result.success).toBe(true)
  })

  test("accepts code as number 0", () => {
    const result = openaiCompatibleErrorDataSchema.safeParse({
      error: {
        message: "Error",
        code: 0,
      },
    })
    expect(result.success).toBe(true)
  })

  test("accepts empty error type", () => {
    const result = openaiCompatibleErrorDataSchema.safeParse({
      error: {
        message: "Error",
        type: "",
      },
    })
    expect(result.success).toBe(true)
  })
})

describe("defaultOpenAICompatibleErrorStructure", () => {
  test("extracts message from error data", () => {
    const data = {
      error: {
        message: "Something went wrong",
        type: "server_error",
      },
    }
    expect(defaultOpenAICompatibleErrorStructure.errorToMessage(data)).toBe("Something went wrong")
  })

  test("has errorSchema defined", () => {
    expect(defaultOpenAICompatibleErrorStructure.errorSchema).toBeDefined()
  })

  test("errorSchema is the openaiCompatibleErrorDataSchema", () => {
    expect(defaultOpenAICompatibleErrorStructure.errorSchema).toBe(openaiCompatibleErrorDataSchema)
  })
})
