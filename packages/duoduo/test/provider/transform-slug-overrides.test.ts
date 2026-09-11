import { describe, expect, test } from "bun:test"

// Replicate the SLUG_OVERRIDES constant and gateway slug extraction logic
// from transform.ts for unit testing.

const SLUG_OVERRIDES: Record<string, string> = {
  amazon: "bedrock",
}

function extractGatewaySlug(apiId: string): string | undefined {
  const i = apiId.indexOf("/")
  const rawSlug = i > 0 ? apiId.slice(0, i) : undefined
  return rawSlug ? (SLUG_OVERRIDES[rawSlug] ?? rawSlug) : undefined
}

// ─── SLUG_OVERRIDES ───

describe("ProviderTransform.SLUG_OVERRIDES", () => {
  test("maps amazon to bedrock", () => {
    expect(SLUG_OVERRIDES["amazon"]).toBe("bedrock")
  })

  test("only has amazon override", () => {
    expect(Object.keys(SLUG_OVERRIDES)).toEqual(["amazon"])
  })
})

// ─── extractGatewaySlug ───

describe("ProviderTransform.extractGatewaySlug", () => {
  test("extracts slug from anthropic/claude-sonnet-4", () => {
    expect(extractGatewaySlug("anthropic/claude-sonnet-4")).toBe("anthropic")
  })

  test("extracts slug from openai/gpt-4o", () => {
    expect(extractGatewaySlug("openai/gpt-4o")).toBe("openai")
  })

  test("maps amazon slug to bedrock", () => {
    expect(extractGatewaySlug("amazon/nova-2-lite")).toBe("bedrock")
  })

  test("extracts slug from google/gemini-2.5-pro", () => {
    expect(extractGatewaySlug("google/gemini-2.5-pro")).toBe("google")
  })

  test("extracts slug from deepseek/deepseek-r1", () => {
    expect(extractGatewaySlug("deepseek/deepseek-r1")).toBe("deepseek")
  })

  test("returns undefined for model ID without slash", () => {
    expect(extractGatewaySlug("gpt-4o")).toBeUndefined()
  })

  test("returns undefined for empty string", () => {
    expect(extractGatewaySlug("")).toBeUndefined()
  })

  test("returns undefined for slash at start (no slug before it)", () => {
    expect(extractGatewaySlug("/model")).toBeUndefined()
  })

  test("handles nested paths — only first segment is slug", () => {
    expect(extractGatewaySlug("anthropic/claude/sonnet-4")).toBe("anthropic")
  })
})
