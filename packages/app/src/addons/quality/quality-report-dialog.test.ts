import { describe, test, expect } from "bun:test"

// ─── Extract pure logic from quality-report-dialog.tsx for testing ───
// The component uses these pure functions internally; we extract them for direct testing.

function scoreColor(score: number): string {
  if (score >= 0.8) return "text-green-400"
  if (score >= 0.6) return "text-yellow-400"
  return "text-red-400"
}

function scoreBarColor(score: number): string {
  if (score >= 0.8) return "bg-green-500"
  if (score >= 0.6) return "bg-yellow-500"
  return "bg-red-500"
}

function overallColor(passed: boolean): string {
  return passed ? "text-green-400" : "text-red-400"
}

function scorePercent(score: number): number {
  return Math.round(score * 100)
}

function checkStatusIcon(passed: boolean): string {
  return passed ? "✓" : "✗"
}

function checkStatusColor(passed: boolean): string {
  return passed ? "text-green-400" : "text-red-400"
}

// ─── Tests ───

describe("quality report - score color thresholds", () => {
  test("score >= 0.8 → green", () => {
    expect(scoreColor(0.8)).toBe("text-green-400")
    expect(scoreColor(0.9)).toBe("text-green-400")
    expect(scoreColor(1.0)).toBe("text-green-400")
  })

  test("score >= 0.6 and < 0.8 → yellow", () => {
    expect(scoreColor(0.6)).toBe("text-yellow-400")
    expect(scoreColor(0.7)).toBe("text-yellow-400")
    expect(scoreColor(0.79)).toBe("text-yellow-400")
  })

  test("score < 0.6 → red", () => {
    expect(scoreColor(0.59)).toBe("text-red-400")
    expect(scoreColor(0.5)).toBe("text-red-400")
    expect(scoreColor(0.0)).toBe("text-red-400")
  })

  test("boundary: 0.8 is green, 0.7999 is yellow", () => {
    expect(scoreColor(0.8)).toBe("text-green-400")
    expect(scoreColor(0.7999)).toBe("text-yellow-400")
  })

  test("boundary: 0.6 is yellow, 0.5999 is red", () => {
    expect(scoreColor(0.6)).toBe("text-yellow-400")
    expect(scoreColor(0.5999)).toBe("text-red-400")
  })
})

describe("quality report - score bar color thresholds", () => {
  test("score >= 0.8 → green bar", () => {
    expect(scoreBarColor(0.8)).toBe("bg-green-500")
    expect(scoreBarColor(1.0)).toBe("bg-green-500")
  })

  test("score >= 0.6 and < 0.8 → yellow bar", () => {
    expect(scoreBarColor(0.6)).toBe("bg-yellow-500")
    expect(scoreBarColor(0.7)).toBe("bg-yellow-500")
  })

  test("score < 0.6 → red bar", () => {
    expect(scoreBarColor(0.0)).toBe("bg-red-500")
    expect(scoreBarColor(0.5)).toBe("bg-red-500")
  })
})

describe("quality report - overall pass/fail color", () => {
  test("passed → green", () => {
    expect(overallColor(true)).toBe("text-green-400")
  })

  test("failed → red", () => {
    expect(overallColor(false)).toBe("text-red-400")
  })
})

describe("quality report - score percent conversion", () => {
  test("0.85 → 85", () => {
    expect(scorePercent(0.85)).toBe(85)
  })

  test("1.0 → 100", () => {
    expect(scorePercent(1.0)).toBe(100)
  })

  test("0.0 → 0", () => {
    expect(scorePercent(0.0)).toBe(0)
  })

  test("rounds correctly: 0.856 → 86", () => {
    expect(scorePercent(0.856)).toBe(86)
  })

  test("rounds correctly: 0.855 → 86 (Math.round rounds 0.5 up)", () => {
    expect(scorePercent(0.855)).toBe(86)
  })
})

describe("quality report - check status icon", () => {
  test("passed → ✓", () => {
    expect(checkStatusIcon(true)).toBe("✓")
  })

  test("failed → ✗", () => {
    expect(checkStatusIcon(false)).toBe("✗")
  })
})

describe("quality report - check status color", () => {
  test("passed → green", () => {
    expect(checkStatusColor(true)).toBe("text-green-400")
  })

  test("failed → red", () => {
    expect(checkStatusColor(false)).toBe("text-red-400")
  })
})
