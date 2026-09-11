import { describe, expect, test } from "bun:test"

// Testing pure helper functions from view-cache.ts that are not exported
// We replicate the logic here for testing since they are file-scoped

type SelectedLineRange = {
  start: number
  end: number
  side?: "left" | "right"
  endSide?: "left" | "right"
}

function normalizeSelectedLines(range: SelectedLineRange): SelectedLineRange {
  if (range.start <= range.end) return { ...range }

  const startSide = range.side
  const endSide = range.endSide ?? startSide

  return {
    ...range,
    start: range.end,
    end: range.start,
    side: endSide,
    endSide: startSide !== endSide ? startSide : undefined,
  }
}

function equalSelectedLines(a: SelectedLineRange | null | undefined, b: SelectedLineRange | null | undefined) {
  if (!a && !b) return true
  if (!a || !b) return false
  const left = normalizeSelectedLines(a)
  const right = normalizeSelectedLines(b)
  return (
    left.start === right.start && left.end === right.end && left.side === right.side && left.endSide === right.endSide
  )
}

describe("normalizeSelectedLines", () => {
  test("returns copy when start <= end", () => {
    const range = { start: 1, end: 5 }
    const result = normalizeSelectedLines(range)
    expect(result).toEqual({ start: 1, end: 5 })
    expect(result).not.toBe(range)
  })

  test("swaps start and end when start > end", () => {
    const range = { start: 5, end: 1 }
    const result = normalizeSelectedLines(range)
    expect(result.start).toBe(1)
    expect(result.end).toBe(5)
  })

  test("swaps sides when start > end", () => {
    const range = { start: 5, end: 1, side: "left" as const, endSide: "right" as const }
    const result = normalizeSelectedLines(range)
    expect(result.side).toBe("right")
    expect(result.endSide).toBe("left")
  })

  test("clears endSide when both sides are the same", () => {
    const range = { start: 5, end: 1, side: "left" as const, endSide: "left" as const }
    const result = normalizeSelectedLines(range)
    expect(result.side).toBe("left")
    expect(result.endSide).toBeUndefined()
  })

  test("uses side as endSide fallback when endSide is undefined", () => {
    const range = { start: 5, end: 1, side: "right" as const }
    const result = normalizeSelectedLines(range)
    expect(result.side).toBe("right")
    // When endSide is undefined, it falls back to side ("right"),
    // so startSide === endSide, and endSide is cleared to undefined
    expect(result.endSide).toBeUndefined()
  })

  test("preserves side when start <= end", () => {
    const range = { start: 1, end: 5, side: "left" as const, endSide: "right" as const }
    const result = normalizeSelectedLines(range)
    expect(result.side).toBe("left")
    expect(result.endSide).toBe("right")
  })

  test("handles equal start and end", () => {
    const range = { start: 3, end: 3 }
    const result = normalizeSelectedLines(range)
    expect(result).toEqual({ start: 3, end: 3 })
  })
})

describe("equalSelectedLines", () => {
  test("returns true for both null", () => {
    expect(equalSelectedLines(null, null)).toBe(true)
  })

  test("returns true for both undefined", () => {
    expect(equalSelectedLines(undefined, undefined)).toBe(true)
  })

  test("returns true for null and undefined", () => {
    expect(equalSelectedLines(null, undefined)).toBe(true)
  })

  test("returns false when one is null and other is not", () => {
    expect(equalSelectedLines(null, { start: 1, end: 5 })).toBe(false)
    expect(equalSelectedLines({ start: 1, end: 5 }, null)).toBe(false)
  })

  test("returns true for identical ranges", () => {
    expect(equalSelectedLines({ start: 1, end: 5 }, { start: 1, end: 5 })).toBe(true)
  })

  test("returns false for different ranges", () => {
    expect(equalSelectedLines({ start: 1, end: 5 }, { start: 2, end: 5 })).toBe(false)
  })

  test("normalizes before comparing (reversed ranges)", () => {
    expect(equalSelectedLines({ start: 5, end: 1 }, { start: 1, end: 5 })).toBe(true)
  })

  test("compares sides after normalization", () => {
    expect(
      equalSelectedLines(
        { start: 5, end: 1, side: "left", endSide: "right" },
        { start: 1, end: 5, side: "right", endSide: "left" },
      ),
    ).toBe(true)
  })

  test("returns false for same lines but different sides", () => {
    expect(equalSelectedLines({ start: 1, end: 5, side: "left" }, { start: 1, end: 5, side: "right" })).toBe(false)
  })
})
