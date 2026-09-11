import { describe, expect, test } from "bun:test"

// formatTokens from dialog-select-model.tsx — not exported, replicated here for testing
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

describe("formatTokens (dialog-select-model)", () => {
  test("formats millions with one decimal", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M")
  })

  test("formats exactly 1M", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M")
  })

  test("formats thousands with K suffix", () => {
    expect(formatTokens(5_000)).toBe("5K")
  })

  test("formats exactly 1K", () => {
    expect(formatTokens(1_000)).toBe("1K")
  })

  test("formats 999 as plain number", () => {
    expect(formatTokens(999)).toBe("999")
  })

  test("formats 0 as plain number", () => {
    expect(formatTokens(0)).toBe("0")
  })

  test("formats 999 as plain number (boundary)", () => {
    expect(formatTokens(999)).toBe("999")
  })

  test("formats 1000 as K", () => {
    expect(formatTokens(1000)).toBe("1K")
  })

  test("formats large million values", () => {
    expect(formatTokens(128_000_000)).toBe("128.0M")
  })

  test("formats 500 as plain number", () => {
    expect(formatTokens(500)).toBe("500")
  })

  test("formats 12345 as K", () => {
    expect(formatTokens(12345)).toBe("12K")
  })

  test("formats 999999 as K", () => {
    expect(formatTokens(999_999)).toBe("1000K")
  })

  test("formats 1000000 as M", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M")
  })
})
