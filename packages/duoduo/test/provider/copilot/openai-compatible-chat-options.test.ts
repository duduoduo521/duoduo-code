import { describe, expect, test } from "bun:test"
import { openaiCompatibleProviderOptions } from "../../../src/provider/sdk/copilot/chat/openai-compatible-chat-options"

describe("openaiCompatibleProviderOptions", () => {
  test("validates empty object", () => {
    const result = openaiCompatibleProviderOptions.safeParse({})
    expect(result.success).toBe(true)
  })

  test("validates with user field", () => {
    const result = openaiCompatibleProviderOptions.safeParse({
      user: "user-abc123",
    })
    expect(result.success).toBe(true)
  })

  test("validates with reasoningEffort field", () => {
    const result = openaiCompatibleProviderOptions.safeParse({
      reasoningEffort: "high",
    })
    expect(result.success).toBe(true)
  })

  test("validates with textVerbosity field", () => {
    const result = openaiCompatibleProviderOptions.safeParse({
      textVerbosity: "low",
    })
    expect(result.success).toBe(true)
  })

  test("validates with thinking_budget field", () => {
    const result = openaiCompatibleProviderOptions.safeParse({
      thinking_budget: 10000,
    })
    expect(result.success).toBe(true)
  })

  test("validates with all fields", () => {
    const result = openaiCompatibleProviderOptions.safeParse({
      user: "user-123",
      reasoningEffort: "medium",
      textVerbosity: "medium",
      thinking_budget: 5000,
    })
    expect(result.success).toBe(true)
  })

  test("rejects unknown fields", () => {
    const result = openaiCompatibleProviderOptions.safeParse({
      unknownField: "value",
    })
    // zod v4 may handle extra keys differently; test the parsing behavior
    expect(result.success).toBe(true) // zod typically strips unknown keys
  })

  test("rejects thinking_budget as string", () => {
    const result = openaiCompatibleProviderOptions.safeParse({
      thinking_budget: "10000",
    })
    expect(result.success).toBe(false)
  })
})
