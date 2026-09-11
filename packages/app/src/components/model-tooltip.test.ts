import { describe, expect, test } from "bun:test"

// Testing pure helper functions from model-tooltip.tsx and dialog-select-model.tsx
// These are not exported, so we replicate the logic here

type InputKey = "text" | "image" | "audio" | "video" | "pdf"
type InputMap = Record<InputKey, boolean>

type ModelInfo = {
  id: string
  name: string
  provider: {
    name: string
  }
  capabilities?: {
    reasoning: boolean
    input: InputMap
  }
  modalities?: {
    input: Array<string>
  }
  reasoning?: boolean
  limit: {
    context: number
  }
}

// sourceName from model-tooltip.tsx
function sourceName(model: ModelInfo): string {
  const value = `${model.id} ${model.name}`.toLowerCase()

  if (/claude|anthropic/.test(value)) return "Anthropic"
  if (/gpt|o[1-4]|codex|openai/.test(value)) return "OpenAI"
  if (/gemini|palm|bard|google/.test(value)) return "Google"
  if (/grok|xai/.test(value)) return "xAI"
  if (/llama|meta/.test(value)) return "Meta"

  return model.provider.name
}

// inputLabel from model-tooltip.tsx
function inputLabel(value: string): string {
  if (value === "text") return "Text"
  if (value === "image") return "Image"
  if (value === "audio") return "Audio"
  if (value === "video") return "Video"
  if (value === "pdf") return "PDF"
  return value
}

// formatTokens from dialog-select-model.tsx
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

describe("sourceName", () => {
  test("identifies Anthropic models", () => {
    expect(sourceName({ id: "claude-3", name: "Claude 3", provider: { name: "Other" }, limit: { context: 200000 } })).toBe("Anthropic")
  })

  test("identifies OpenAI models by gpt pattern", () => {
    expect(sourceName({ id: "gpt-4", name: "GPT-4", provider: { name: "Other" }, limit: { context: 128000 } })).toBe("OpenAI")
  })

  test("identifies OpenAI models by o[1-4] pattern", () => {
    expect(sourceName({ id: "o1", name: "o1", provider: { name: "Other" }, limit: { context: 128000 } })).toBe("OpenAI")
    expect(sourceName({ id: "o3", name: "o3", provider: { name: "Other" }, limit: { context: 128000 } })).toBe("OpenAI")
  })

  test("identifies OpenAI models by codex pattern", () => {
    expect(sourceName({ id: "codex-mini", name: "Codex Mini", provider: { name: "Other" }, limit: { context: 128000 } })).toBe("OpenAI")
  })

  test("identifies Google models", () => {
    expect(sourceName({ id: "gemini-pro", name: "Gemini Pro", provider: { name: "Other" }, limit: { context: 128000 } })).toBe("Google")
  })

  test("identifies xAI models", () => {
    expect(sourceName({ id: "grok-2", name: "Grok 2", provider: { name: "Other" }, limit: { context: 128000 } })).toBe("xAI")
  })

  test("identifies Meta models", () => {
    expect(sourceName({ id: "llama-3", name: "Llama 3", provider: { name: "Other" }, limit: { context: 128000 } })).toBe("Meta")
  })

  test("falls back to provider name", () => {
    expect(sourceName({ id: "custom-model", name: "Custom", provider: { name: "MyProvider" }, limit: { context: 128000 } })).toBe("MyProvider")
  })

  test("matches case-insensitively", () => {
    expect(sourceName({ id: "CLAUDE-3", name: "Claude 3", provider: { name: "Other" }, limit: { context: 200000 } })).toBe("Anthropic")
  })

  test("o5 does not match OpenAI pattern (only o[1-4])", () => {
    expect(sourceName({ id: "o5", name: "o5", provider: { name: "Other" }, limit: { context: 128000 } })).toBe("Other")
  })
})

describe("inputLabel", () => {
  test("maps known input types", () => {
    expect(inputLabel("text")).toBe("Text")
    expect(inputLabel("image")).toBe("Image")
    expect(inputLabel("audio")).toBe("Audio")
    expect(inputLabel("video")).toBe("Video")
    expect(inputLabel("pdf")).toBe("PDF")
  })

  test("returns raw value for unknown types", () => {
    expect(inputLabel("custom")).toBe("custom")
  })
})

describe("formatTokens", () => {
  test("formats millions", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M")
    expect(formatTokens(2_000_000)).toBe("2.0M")
  })

  test("formats thousands", () => {
    expect(formatTokens(1_000)).toBe("1K")
    expect(formatTokens(50_000)).toBe("50K")
    expect(formatTokens(999_999)).toBe("1000K")
  })

  test("formats small numbers as-is", () => {
    expect(formatTokens(999)).toBe("999")
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(42)).toBe("42")
  })

  test("formats exactly 1M", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M")
  })

  test("formats exactly 1K", () => {
    expect(formatTokens(1_000)).toBe("1K")
  })
})
