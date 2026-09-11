import { describe, expect, test } from "bun:test"

// Replicate the effort-related constants and functions from transform.ts for unit testing.

const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]

function anthropicAdaptiveEfforts(apiId: string): string[] | null {
  if (["opus-4-7", "opus-4.7"].some((v) => apiId.includes(v))) {
    return ["low", "medium", "high", "xhigh", "max"]
  }
  if (["opus-4-6", "opus-4.6", "sonnet-4-6", "sonnet-4.6"].some((v) => apiId.includes(v))) {
    return ["low", "medium", "high", "max"]
  }
  return null
}

// ─── Effort constants ───

describe("ProviderTransform.effortConstants", () => {
  test("WIDELY_SUPPORTED_EFFORTS contains low, medium, high", () => {
    expect(WIDELY_SUPPORTED_EFFORTS).toEqual(["low", "medium", "high"])
  })

  test("OPENAI_EFFORTS contains all widely supported plus none, minimal, xhigh", () => {
    expect(OPENAI_EFFORTS).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
  })

  test("OPENAI_EFFORTS includes WIDELY_SUPPORTED_EFFORTS", () => {
    for (const effort of WIDELY_SUPPORTED_EFFORTS) {
      expect(OPENAI_EFFORTS).toContain(effort)
    }
  })
})

// ─── anthropicAdaptiveEfforts ───

describe("ProviderTransform.anthropicAdaptiveEfforts", () => {
  test("returns extended efforts for opus-4-7", () => {
    expect(anthropicAdaptiveEfforts("opus-4-7")).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  test("returns extended efforts for opus-4.7", () => {
    expect(anthropicAdaptiveEfforts("opus-4.7")).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  test("returns extended efforts for opus-4-7 within longer ID", () => {
    expect(anthropicAdaptiveEfforts("claude-opus-4-7-20250610")).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  test("returns standard efforts for opus-4-6", () => {
    expect(anthropicAdaptiveEfforts("opus-4-6")).toEqual(["low", "medium", "high", "max"])
  })

  test("returns standard efforts for opus-4.6", () => {
    expect(anthropicAdaptiveEfforts("opus-4.6")).toEqual(["low", "medium", "high", "max"])
  })

  test("returns standard efforts for sonnet-4-6", () => {
    expect(anthropicAdaptiveEfforts("sonnet-4-6")).toEqual(["low", "medium", "high", "max"])
  })

  test("returns standard efforts for sonnet-4.6", () => {
    expect(anthropicAdaptiveEfforts("sonnet-4.6")).toEqual(["low", "medium", "high", "max"])
  })

  test("returns standard efforts for sonnet-4-6 within longer ID", () => {
    expect(anthropicAdaptiveEfforts("claude-sonnet-4-6-20250514")).toEqual(["low", "medium", "high", "max"])
  })

  test("returns null for sonnet-4 (not 4-6 or 4.6)", () => {
    expect(anthropicAdaptiveEfforts("sonnet-4")).toBeNull()
  })

  test("returns null for opus-3", () => {
    expect(anthropicAdaptiveEfforts("opus-3")).toBeNull()
  })

  test("returns null for haiku models", () => {
    expect(anthropicAdaptiveEfforts("claude-haiku-4")).toBeNull()
  })

  test("returns null for empty string", () => {
    expect(anthropicAdaptiveEfforts("")).toBeNull()
  })

  test("returns null for unrelated model IDs", () => {
    expect(anthropicAdaptiveEfforts("gpt-4")).toBeNull()
    expect(anthropicAdaptiveEfforts("gemini-2.5-pro")).toBeNull()
  })
})
