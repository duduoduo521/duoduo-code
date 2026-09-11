import { describe, expect, test } from "bun:test"
import { selectionFromLines } from "./types"
import type { SelectedLineRange } from "./types"

describe("selectionFromLines", () => {
  test("normalizes start > end range", () => {
    const range: SelectedLineRange = { start: 10, end: 5 }
    const result = selectionFromLines(range)
    expect(result.startLine).toBe(5)
    expect(result.endLine).toBe(10)
    expect(result.startChar).toBe(0)
    expect(result.endChar).toBe(0)
  })

  test("preserves start <= end range", () => {
    const range: SelectedLineRange = { start: 3, end: 7 }
    const result = selectionFromLines(range)
    expect(result.startLine).toBe(3)
    expect(result.endLine).toBe(7)
  })

  test("handles single line selection", () => {
    const range: SelectedLineRange = { start: 5, end: 5 }
    const result = selectionFromLines(range)
    expect(result.startLine).toBe(5)
    expect(result.endLine).toBe(5)
  })

  test("always sets char positions to 0", () => {
    const range: SelectedLineRange = { start: 1, end: 20 }
    const result = selectionFromLines(range)
    expect(result.startChar).toBe(0)
    expect(result.endChar).toBe(0)
  })

  test("handles range with side properties", () => {
    const range: SelectedLineRange = { start: 15, end: 5, side: "additions" }
    const result = selectionFromLines(range)
    expect(result.startLine).toBe(5)
    expect(result.endLine).toBe(15)
  })
})
