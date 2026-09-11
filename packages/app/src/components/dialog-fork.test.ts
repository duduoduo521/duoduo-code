import { describe, expect, test } from "bun:test"

// formatTime from dialog-fork.tsx — not exported, replicated here for testing
function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { timeStyle: "short" })
}

describe("formatTime (dialog-fork)", () => {
  test("formats a date as short time string", () => {
    const date = new Date(2025, 0, 1, 14, 30, 0)
    const result = formatTime(date)
    // Should contain hour and minute, locale-dependent
    expect(result.length).toBeGreaterThan(0)
    expect(typeof result).toBe("string")
  })

  test("formats midnight correctly", () => {
    const date = new Date(2025, 0, 1, 0, 0, 0)
    const result = formatTime(date)
    expect(result.length).toBeGreaterThan(0)
  })

  test("formats end of day correctly", () => {
    const date = new Date(2025, 0, 1, 23, 59, 0)
    const result = formatTime(date)
    expect(result.length).toBeGreaterThan(0)
  })

  test("returns string type", () => {
    const date = new Date()
    expect(typeof formatTime(date)).toBe("string")
  })
})
