import { describe, expect, test } from "bun:test"
import { parseModel, sort } from "../../src/provider/provider"

// ─── parseModel ───

describe("Provider.parseModel", () => {
  test("parses provider/model format", () => {
    const result = parseModel("anthropic/claude-sonnet-4-20250514")
    expect(result.providerID as any).toBe("anthropic")
    expect(result.modelID as any).toBe("claude-sonnet-4-20250514")
  })

  test("parses provider with model ID containing slashes", () => {
    const result = parseModel("openrouter/deepseek/deepseek-r1")
    expect(result.providerID as any).toBe("openrouter")
    expect(result.modelID as any).toBe("deepseek/deepseek-r1")
  })

  test("parses simple single-segment model", () => {
    const result = parseModel("ollama/llama3")
    expect(result.providerID as any).toBe("ollama")
    expect(result.modelID as any).toBe("llama3")
  })

  test("parses gateway format with nested path", () => {
    const result = parseModel("gateway/anthropic/claude-sonnet-4")
    expect(result.providerID as any).toBe("gateway")
    expect(result.modelID as any).toBe("anthropic/claude-sonnet-4")
  })

  test("parses amazon-bedrock with region prefix", () => {
    const result = parseModel("amazon-bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0")
    expect(result.providerID as any).toBe("amazon-bedrock")
    expect(result.modelID as any).toBe("us.anthropic.claude-sonnet-4-20250514-v1:0")
  })
})

// ─── sort ───

describe("Provider.sort", () => {
  // sort uses desc on findIndex result:
  // priority = ["gpt-5", "claude-sonnet-4", "gemini-3-pro"]
  // findIndex: gpt-5=0, claude-sonnet-4=1, gemini-3-pro=2, others=-1
  // desc order: 2 > 1 > 0 > -1, so gemini-3-pro first, then claude-sonnet-4, then gpt-5

  test("sorts gemini-3-pro first by priority (highest index desc)", () => {
    const models = [{ id: "claude-sonnet-4" }, { id: "gpt-5" }, { id: "gemini-3-pro" }]
    const sorted = sort(models)
    expect(sorted[0].id).toBe("gemini-3-pro")
    expect(sorted[1].id).toBe("claude-sonnet-4")
    expect(sorted[2].id).toBe("gpt-5")
  })

  test("sorts claude-sonnet-4 before gpt-5 by priority index", () => {
    const models = [{ id: "gpt-5" }, { id: "claude-sonnet-4" }]
    const sorted = sort(models)
    expect(sorted[0].id).toBe("claude-sonnet-4")
    expect(sorted[1].id).toBe("gpt-5")
  })

  test("places non-priority models at the end", () => {
    const models = [{ id: "llama-3" }, { id: "gemini-3-pro" }, { id: "mistral-large" }]
    const sorted = sort(models)
    expect(sorted[0].id).toBe("gemini-3-pro")
    // Non-priority models come after priority ones
    expect(sorted.map((m) => m.id)).toContain("llama-3")
    expect(sorted.map((m) => m.id)).toContain("mistral-large")
  })

  test("prefers 'latest' models within same priority group", () => {
    const models = [{ id: "gpt-5" }, { id: "gpt-5-latest" }]
    const sorted = sort(models)
    expect(sorted[0].id).toBe("gpt-5-latest")
  })

  test("handles empty array", () => {
    expect(sort([])).toEqual([])
  })

  test("handles single model", () => {
    const models = [{ id: "gpt-5" }]
    expect(sort(models)).toEqual(models)
  })

  test("does not mutate original array", () => {
    const models = [{ id: "b" }, { id: "a" }]
    const original = [...models]
    sort(models)
    expect(models.map((m) => m.id)).toEqual(original.map((m) => m.id))
  })
})
