import { describe, expect, test } from "bun:test"
import { Model, Provider } from "../../src/provider/models"

describe("Model schema", () => {
  test("validates a complete model", () => {
    const result = Model.safeParse({
      id: "gpt-4",
      name: "GPT-4",
      release_date: "2023-06-01",
      attachment: true,
      reasoning: false,
      temperature: true,
      tool_call: true,
      limit: { context: 8192, output: 4096 },
    })
    expect(result.success).toBe(true)
  })

  test("validates model with optional fields", () => {
    const result = Model.safeParse({
      id: "claude-3-opus",
      name: "Claude 3 Opus",
      family: "claude",
      release_date: "2024-03-01",
      attachment: true,
      reasoning: true,
      temperature: true,
      tool_call: true,
      interleaved: true,
      limit: { context: 200000, input: 200000, output: 4096 },
      modalities: {
        input: ["text", "image"],
        output: ["text"],
      },
    })
    expect(result.success).toBe(true)
  })

  test("validates model with interleaved object form", () => {
    const result = Model.safeParse({
      id: "deepseek-r1",
      name: "DeepSeek R1",
      release_date: "2025-01-01",
      attachment: false,
      reasoning: true,
      temperature: false,
      tool_call: true,
      interleaved: { field: "reasoning_content" },
      limit: { context: 128000, output: 8192 },
    })
    expect(result.success).toBe(true)
  })

  test("rejects model without required fields", () => {
    const result = Model.safeParse({
      id: "test",
      // missing name, release_date, etc.
    })
    expect(result.success).toBe(false)
  })

  test("validates model with status", () => {
    const result = Model.safeParse({
      id: "test-model",
      name: "Test Model",
      release_date: "2024-01-01",
      attachment: false,
      reasoning: false,
      temperature: true,
      tool_call: false,
      status: "beta",
      limit: { context: 4096, output: 2048 },
    })
    expect(result.success).toBe(true)
  })

  test("rejects invalid status value", () => {
    const result = Model.safeParse({
      id: "test-model",
      name: "Test Model",
      release_date: "2024-01-01",
      attachment: false,
      reasoning: false,
      temperature: true,
      tool_call: false,
      status: "unknown",
      limit: { context: 4096, output: 2048 },
    })
    expect(result.success).toBe(false)
  })
})

describe("Provider schema", () => {
  test("validates a complete provider", () => {
    const result = Provider.safeParse({
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      models: {
        "gpt-4": {
          id: "gpt-4",
          name: "GPT-4",
          release_date: "2023-06-01",
          attachment: true,
          reasoning: false,
          temperature: true,
          tool_call: true,
          limit: { context: 8192, output: 4096 },
        },
      },
    })
    expect(result.success).toBe(true)
  })

  test("validates provider with optional fields", () => {
    const result = Provider.safeParse({
      id: "anthropic",
      name: "Anthropic",
      api: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
      env: ["ANTHROPIC_API_KEY"],
      models: {},
    })
    expect(result.success).toBe(true)
  })

  test("rejects provider without required fields", () => {
    const result = Provider.safeParse({
      id: "test",
      // missing name, env, models
    })
    expect(result.success).toBe(false)
  })

  test("validates provider with multiple models", () => {
    const result = Provider.safeParse({
      id: "test",
      name: "Test",
      env: [],
      models: {
        "model-1": {
          id: "model-1",
          name: "Model 1",
          release_date: "2024-01-01",
          attachment: false,
          reasoning: false,
          temperature: true,
          tool_call: true,
          limit: { context: 4096, output: 2048 },
        },
        "model-2": {
          id: "model-2",
          name: "Model 2",
          release_date: "2024-02-01",
          attachment: true,
          reasoning: true,
          temperature: true,
          tool_call: true,
          limit: { context: 100000, output: 4096 },
        },
      },
    })
    expect(result.success).toBe(true)
  })
})
