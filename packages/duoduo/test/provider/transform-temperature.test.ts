import { describe, expect, test } from "bun:test"
import { temperature, topP, topK, maxOutputTokens, smallOptions } from "../../src/provider/transform"

function makeModel(overrides: { id?: string; providerID?: string; npm?: string; outputLimit?: number }) {
  return {
    id: overrides.id ?? "test-model",
    providerID: overrides.providerID ?? "test",
    api: {
      id: overrides.id ?? "test-model",
      url: "https://api.test.com",
      npm: overrides.npm ?? "@ai-sdk/openai-compatible",
    },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: undefined,
    },
    limit: { context: 128000, input: undefined, output: overrides.outputLimit ?? 4096 },
    status: "active" as const,
    options: {},
    headers: {},
  } as any
}

// ─── temperature ───

describe("ProviderTransform.temperature", () => {
  test("returns 0.55 for qwen models", () => {
    expect(temperature(makeModel({ id: "qwen-2.5-coder" }))).toBe(0.55)
  })

  test("returns undefined for claude models", () => {
    expect(temperature(makeModel({ id: "claude-sonnet-4-20250514" }))).toBeUndefined()
  })

  test("returns 1.0 for gemini models", () => {
    expect(temperature(makeModel({ id: "gemini-2.5-pro" }))).toBe(1.0)
  })

  test("returns 1.0 for glm-4.6 models", () => {
    expect(temperature(makeModel({ id: "glm-4.6-flash" }))).toBe(1.0)
  })

  test("returns 1.0 for glm-4.7 models", () => {
    expect(temperature(makeModel({ id: "glm-4.7-plus" }))).toBe(1.0)
  })

  test("returns 1.0 for minimax-m2 models", () => {
    expect(temperature(makeModel({ id: "minimax-m2-pro" }))).toBe(1.0)
  })

  test("returns 0.6 for kimi-k2 base model", () => {
    expect(temperature(makeModel({ id: "kimi-k2" }))).toBe(0.6)
  })

  test("returns 1.0 for kimi-k2-thinking", () => {
    expect(temperature(makeModel({ id: "kimi-k2-thinking" }))).toBe(1.0)
  })

  test("returns 1.0 for kimi-k2.5", () => {
    expect(temperature(makeModel({ id: "kimi-k2.5" }))).toBe(1.0)
  })

  test("returns 1.0 for kimi-k2p5", () => {
    expect(temperature(makeModel({ id: "kimi-k2p5" }))).toBe(1.0)
  })

  test("returns 1.0 for kimi-k2-5", () => {
    expect(temperature(makeModel({ id: "kimi-k2-5" }))).toBe(1.0)
  })

  test("returns undefined for unknown models", () => {
    expect(temperature(makeModel({ id: "gpt-4o" }))).toBeUndefined()
    expect(temperature(makeModel({ id: "llama-3" }))).toBeUndefined()
  })

  test("is case-insensitive", () => {
    expect(temperature(makeModel({ id: "QWEN-2.5" }))).toBe(0.55)
    expect(temperature(makeModel({ id: "CLAUDE-opus" }))).toBeUndefined()
  })
})

// ─── topP ───

describe("ProviderTransform.topP", () => {
  test("returns 1 for qwen models", () => {
    expect(topP(makeModel({ id: "qwen-2.5-coder" }))).toBe(1)
  })

  test("returns 0.95 for minimax-m2 models", () => {
    expect(topP(makeModel({ id: "minimax-m2-pro" }))).toBe(0.95)
  })

  test("returns 0.95 for gemini models", () => {
    expect(topP(makeModel({ id: "gemini-2.5-pro" }))).toBe(0.95)
  })

  test("returns 0.95 for kimi-k2.5", () => {
    expect(topP(makeModel({ id: "kimi-k2.5" }))).toBe(0.95)
  })

  test("returns 0.95 for kimi-k2p5", () => {
    expect(topP(makeModel({ id: "kimi-k2p5" }))).toBe(0.95)
  })

  test("returns 0.95 for kimi-k2-5", () => {
    expect(topP(makeModel({ id: "kimi-k2-5" }))).toBe(0.95)
  })

  test("returns undefined for kimi-k2 base", () => {
    expect(topP(makeModel({ id: "kimi-k2" }))).toBeUndefined()
  })

  test("returns undefined for unknown models", () => {
    expect(topP(makeModel({ id: "gpt-4o" }))).toBeUndefined()
    expect(topP(makeModel({ id: "claude-opus" }))).toBeUndefined()
  })
})

// ─── topK ───

describe("ProviderTransform.topK", () => {
  test("returns 40 for minimax-m2. models", () => {
    expect(topK(makeModel({ id: "minimax-m2.1-pro" }))).toBe(40)
  })

  test("returns 40 for minimax-m25 models", () => {
    expect(topK(makeModel({ id: "minimax-m25" }))).toBe(40)
  })

  test("returns 40 for minimax-m21 models", () => {
    expect(topK(makeModel({ id: "minimax-m21" }))).toBe(40)
  })

  test("returns 20 for minimax-m2 base model", () => {
    expect(topK(makeModel({ id: "minimax-m2" }))).toBe(20)
  })

  test("returns 64 for gemini models", () => {
    expect(topK(makeModel({ id: "gemini-2.5-pro" }))).toBe(64)
  })

  test("returns undefined for unknown models", () => {
    expect(topK(makeModel({ id: "gpt-4o" }))).toBeUndefined()
    expect(topK(makeModel({ id: "claude-opus" }))).toBeUndefined()
    expect(topK(makeModel({ id: "qwen-2.5" }))).toBeUndefined()
  })
})

// ─── maxOutputTokens ───

describe("ProviderTransform.maxOutputTokens", () => {
  test("returns model output limit when within OUTPUT_TOKEN_MAX", () => {
    expect(maxOutputTokens(makeModel({ outputLimit: 4096 }))).toBe(4096)
  })

  test("returns OUTPUT_TOKEN_MAX when model limit exceeds it", () => {
    expect(maxOutputTokens(makeModel({ outputLimit: 100000 }))).toBe(32000)
  })

  test("returns OUTPUT_TOKEN_MAX when model limit is 0", () => {
    expect(maxOutputTokens(makeModel({ outputLimit: 0 }))).toBe(32000)
  })

  test("returns OUTPUT_TOKEN_MAX when model limit is undefined", () => {
    const model = makeModel({ outputLimit: 0 })
    model.limit.output = undefined
    expect(maxOutputTokens(model)).toBe(32000)
  })
})

// ─── smallOptions ───

// After OPT-6/15 all cloud-vendor-specific smallOptions branches (openai
// store:false, gpt-5 reasoningEffort, github-copilot, google thinkingConfig,
// openrouter/llmgateway reasoning) were removed. Only `venice` remains; every
// other provider (including local frameworks) returns an empty object.
describe("ProviderTransform.smallOptions", () => {
  test("returns veniceParameters with disableThinking for venice provider", () => {
    const model = makeModel({ providerID: "venice", id: "llama-3" })
    expect(smallOptions(model)).toEqual({ veniceParameters: { disableThinking: true } })
  })

  test("returns empty object for unknown providers", () => {
    const model = makeModel({ providerID: "anthropic", id: "claude-sonnet-4" })
    expect(smallOptions(model)).toEqual({})
  })
})
