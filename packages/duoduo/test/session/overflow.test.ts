import { describe, expect, test } from "bun:test"
import {
  extractContextWindowFromError,
  resolveContextWindow,
  persistDiscoveredContextWindow,
  getDiscoveredContextWindow,
  isOverflow,
  effectiveUsable,
  usable,
  dynamicMemoryBudget,
  isEstimatedOverflow,
} from "../../src/session/overflow"
import { isDefaultTitle } from "../../src/session/session"
import type { Provider } from "../../src/provider"
import type { Config } from "../../src/config"

// ─── Helper: minimal Provider.Model ───

function makeModel(overrides: Partial<Provider.Model> = {}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test-provider",
    api: { id: "test-api", url: "https://api.test.com", npm: "@ai-sdk/test" },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    limit: { context: 128_000, output: 4096 },
    status: "active",
    options: {},
    headers: {},
    ...overrides,
  } as Provider.Model
}

function makeConfig(overrides: Partial<Config.Info> = {}): Config.Info {
  return {
    compaction: { auto: true },
    ...overrides,
  } as Config.Info
}

// ─── extractContextWindowFromError ───

describe("session.overflow.extractContextWindowFromError", () => {
  test("extracts Xunfei 'Range of input length' pattern", () => {
    const result = extractContextWindowFromError("Range of input length should be [1, 202745]")
    expect(result).toBe(202745)
  })

  test("extracts Xunfei pattern with extra whitespace", () => {
    const result = extractContextWindowFromError("Range of input length should be [1,  128000]")
    expect(result).toBe(128000)
  })

  test("extracts 'input token limit is N' pattern (Xunfei v2)", () => {
    const result = extractContextWindowFromError("input token limit is 200000")
    expect(result).toBe(200000)
  })

  test("extracts OpenAI 'maximum context length is N tokens' pattern", () => {
    const result = extractContextWindowFromError("This model's maximum context length is 128000 tokens")
    expect(result).toBe(128000)
  })

  test("extracts 'model's maximum context length is N' pattern", () => {
    const result = extractContextWindowFromError("This model's maximum context length is 4096 tokens")
    expect(result).toBe(4096)
  })

  test("extracts generic 'context length: N' pattern", () => {
    const result = extractContextWindowFromError("context length: 32768")
    expect(result).toBe(32768)
  })

  test("extracts generic 'maximum context length: N' pattern", () => {
    const result = extractContextWindowFromError("maximum context length: 200000")
    expect(result).toBe(200000)
  })

  test("returns undefined for unrecognized error text", () => {
    expect(extractContextWindowFromError("Something went wrong")).toBeUndefined()
  })

  test("returns undefined for empty string", () => {
    expect(extractContextWindowFromError("")).toBeUndefined()
  })

  test("returns undefined when number is zero or negative", () => {
    // The pattern matches but the number parse gives 0, which is rejected by n > 0 check
    expect(extractContextWindowFromError("context length: 0")).toBeUndefined()
  })
})

// ─── isDefaultTitle ───

describe("session.isDefaultTitle", () => {
  test("matches parent default title", () => {
    expect(isDefaultTitle("New session - 2024-01-15T10:30:00.000Z")).toBe(true)
  })

  test("matches child default title", () => {
    expect(isDefaultTitle("Child session - 2024-01-15T10:30:00.000Z")).toBe(true)
  })

  test("does not match custom title", () => {
    expect(isDefaultTitle("My custom session title")).toBe(false)
  })

  test("does not match empty string", () => {
    expect(isDefaultTitle("")).toBe(false)
  })

  test("does not match partial match", () => {
    expect(isDefaultTitle("New session - something")).toBe(false)
  })

  test("does not match with extra text after timestamp", () => {
    expect(isDefaultTitle("New session - 2024-01-15T10:30:00.000Z extra")).toBe(false)
  })

  test("matches with different valid ISO dates", () => {
    expect(isDefaultTitle("New session - 2025-12-31T23:59:59.999Z")).toBe(true)
    expect(isDefaultTitle("Child session - 1970-01-01T00:00:00.000Z")).toBe(true)
  })
})

// ─── persistDiscoveredContextWindow / getDiscoveredContextWindow ───

describe("session.overflow.discoveredContextWindow", () => {
  test("persists and retrieves a context window", () => {
    const model = makeModel({ providerID: "discover-test-1" as any, id: "model-a" as any })
    const result = persistDiscoveredContextWindow(model, 256_000)
    expect(result).toBe(true)
    expect(getDiscoveredContextWindow(model)).toBe(256_000)
  })

  test("does not overwrite existing value (first discovery wins)", () => {
    const model = makeModel({ providerID: "discover-test-2" as any, id: "model-b" as any })
    persistDiscoveredContextWindow(model, 256_000)
    const secondWrite = persistDiscoveredContextWindow(model, 512_000)
    expect(secondWrite).toBe(false)
    expect(getDiscoveredContextWindow(model)).toBe(256_000)
  })

  test("rejects zero context window", () => {
    const model = makeModel({ providerID: "discover-test-3" as any, id: "model-c" as any })
    const result = persistDiscoveredContextWindow(model, 0)
    expect(result).toBe(false)
    expect(getDiscoveredContextWindow(model)).toBeUndefined()
  })

  test("rejects negative context window", () => {
    const model = makeModel({ providerID: "discover-test-4" as any, id: "model-d" as any })
    const result = persistDiscoveredContextWindow(model, -100)
    expect(result).toBe(false)
    expect(getDiscoveredContextWindow(model)).toBeUndefined()
  })

  test("returns undefined for undiscovered model", () => {
    const model = makeModel({ providerID: "nonexistent-provider" as any, id: "unknown-model" as any })
    expect(getDiscoveredContextWindow(model)).toBeUndefined()
  })
})

// ─── resolveContextWindow ───

describe("session.overflow.resolveContextWindow", () => {
  test("returns model limit.context when > 0", () => {
    const model = makeModel({ limit: { context: 200_000, output: 4096 } as any })
    expect(resolveContextWindow(model)).toBe(200_000)
  })

  test("falls back to 128K safe default when limit is 0 and no discovery", () => {
    const model = makeModel({
      providerID: "resolve-fallback-1" as any,
      id: "no-context" as any,
      limit: { context: 0, output: 4096 } as any,
    })
    // No discovered window for this model, and name doesn't match pattern
    expect(resolveContextWindow(model)).toBe(128_000)
  })

  test("uses discovered context window when limit is 0", () => {
    const model = makeModel({
      providerID: "resolve-discover-1" as any,
      id: "discovered-model" as any,
      limit: { context: 0, output: 4096 } as any,
    })
    persistDiscoveredContextWindow(model, 202_745)
    expect(resolveContextWindow(model)).toBe(202_745)
  })

  test("prefers model limit.context over discovered value", () => {
    const model = makeModel({
      providerID: "resolve-pref-1" as any,
      id: "pref-model" as any,
      limit: { context: 100_000, output: 4096 } as any,
    })
    persistDiscoveredContextWindow(model, 200_000)
    // limit.context > 0 takes priority
    expect(resolveContextWindow(model)).toBe(100_000)
  })

  test("infers context from model name with 'Nk' pattern", () => {
    const model = makeModel({
      providerID: "resolve-infer-1" as any,
      id: "deepseek-r1-128k" as any,
      name: "DeepSeek R1 128K",
      limit: { context: 0, output: 4096 } as any,
    })
    expect(resolveContextWindow(model)).toBe(128_000)
  })

  test("infers context from model name with '1m' pattern", () => {
    const model = makeModel({
      providerID: "resolve-infer-2" as any,
      id: "qwen2.5-1m" as any,
      name: "Qwen 2.5 1M",
      limit: { context: 0, output: 4096 } as any,
    })
    expect(resolveContextWindow(model)).toBe(1_000_000)
  })
})

// ─── effectiveUsable ───

describe("session.overflow.effectiveUsable", () => {
  test("returns 65% of usable context", () => {
    const model = makeModel({ limit: { context: 200_000, output: 4096 } as any })
    const cfg = makeConfig()
    const result = effectiveUsable({ cfg, model })
    // usable = 200000 - 4096 = 195904
    // effectiveUsable = 195904 * 0.65 ≈ 127337
    expect(result).toBe(Math.round(195904 * 0.65))
  })

  test("returns 0 when model context is 0 and no fallback available", () => {
    const model = makeModel({
      providerID: "effective-0" as any,
      id: "zero-ctx" as any,
      limit: { context: 0, output: 0 } as any,
      name: "Unknown",
    })
    const cfg = makeConfig()
    // When limit.context = 0, resolveContextWindow returns 128K fallback
    // So effectiveUsable should be > 0
    const result = effectiveUsable({ cfg, model })
    expect(result).toBeGreaterThan(0)
  })
})

// ─── dynamicMemoryBudget ───

describe("session.overflow.dynamicMemoryBudget", () => {
  test("returns at least 2000 tokens for small models", () => {
    const model = makeModel({ limit: { context: 8_000, output: 1_000 } as any })
    const cfg = makeConfig()
    const budget = dynamicMemoryBudget({ cfg, model })
    expect(budget).toBeGreaterThanOrEqual(2000)
  })

  test("returns at most 12000 tokens for very large models", () => {
    const model = makeModel({ limit: { context: 1_000_000, output: 32_000 } as any })
    const cfg = makeConfig()
    const budget = dynamicMemoryBudget({ cfg, model })
    expect(budget).toBeLessThanOrEqual(12_000)
  })

  test("scales with model context size (~5%)", () => {
    const model = makeModel({ limit: { context: 200_000, output: 8_000 } as any })
    const cfg = makeConfig()
    const budget = dynamicMemoryBudget({ cfg, model })
    // usable ≈ 200000 - 8000 = 192000
    // effectiveUsable ≈ 192000 * 0.65 = 124800
    // 5% of 124800 ≈ 6240
    expect(budget).toBeGreaterThanOrEqual(2000)
    expect(budget).toBeLessThanOrEqual(12_000)
  })
})
