import { describe, expect, test } from "bun:test"
import { openaiCompatibleProviderOptions } from "../../src/provider/sdk/copilot/chat/openai-compatible-chat-options"

describe("provider/copilot openaiCompatibleProviderOptions", () => {
  test("validates empty object", () => {
    const result = openaiCompatibleProviderOptions.safeParse({})
    expect(result.success).toBe(true)
  })

  test("validates with user", () => {
    const result = openaiCompatibleProviderOptions.safeParse({
      user: "user-123",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.user).toBe("user-123")
    }
  })

  test("validates with reasoningEffort", () => {
    const result = openaiCompatibleProviderOptions.safeParse({
      reasoningEffort: "high",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.reasoningEffort).toBe("high")
    }
  })

  test("validates with textVerbosity", () => {
    const result = openaiCompatibleProviderOptions.safeParse({
      textVerbosity: "low",
    })
    expect(result.success).toBe(true)
  })

  test("validates with thinking_budget", () => {
    const result = openaiCompatibleProviderOptions.safeParse({
      thinking_budget: 10000,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.thinking_budget).toBe(10000)
    }
  })

  test("validates with all fields", () => {
    const result = openaiCompatibleProviderOptions.safeParse({
      user: "user-1",
      reasoningEffort: "medium",
      textVerbosity: "medium",
      thinking_budget: 5000,
    })
    expect(result.success).toBe(true)
  })

  test("rejects non-string user", () => {
    const result = openaiCompatibleProviderOptions.safeParse({
      user: 123,
    })
    expect(result.success).toBe(false)
  })

  test("rejects non-number thinking_budget", () => {
    const result = openaiCompatibleProviderOptions.safeParse({
      thinking_budget: "large",
    })
    expect(result.success).toBe(false)
  })
})
