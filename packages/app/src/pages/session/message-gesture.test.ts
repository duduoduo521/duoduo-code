import { describe, expect, test } from "bun:test"
import { normalizeWheelDelta, shouldMarkBoundaryGesture } from "./message-gesture"

describe("normalizeWheelDelta", () => {
  test("returns deltaY as-is for pixel mode (deltaMode=0)", () => {
    expect(normalizeWheelDelta({ deltaY: 42, deltaMode: 0, rootHeight: 800 })).toBe(42)
  })

  test("multiplies by 40 for line mode (deltaMode=1)", () => {
    expect(normalizeWheelDelta({ deltaY: 3, deltaMode: 1, rootHeight: 800 })).toBe(120)
  })

  test("multiplies by rootHeight for page mode (deltaMode=2)", () => {
    expect(normalizeWheelDelta({ deltaY: 1, deltaMode: 2, rootHeight: 600 })).toBe(600)
  })

  test("handles negative deltaY", () => {
    expect(normalizeWheelDelta({ deltaY: -5, deltaMode: 0, rootHeight: 800 })).toBe(-5)
  })

  test("handles zero deltaY", () => {
    expect(normalizeWheelDelta({ deltaY: 0, deltaMode: 0, rootHeight: 800 })).toBe(0)
  })
})

describe("shouldMarkBoundaryGesture", () => {
  test("returns true when scrollHeight equals clientHeight (no scroll)", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 10,
        scrollTop: 0,
        scrollHeight: 100,
        clientHeight: 100,
      }),
    ).toBe(true)
  })

  test("returns true when scrollHeight is only 1px more than clientHeight", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 10,
        scrollTop: 0,
        scrollHeight: 101,
        clientHeight: 100,
      }),
    ).toBe(true)
  })

  test("returns false when delta is 0", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 0,
        scrollTop: 0,
        scrollHeight: 500,
        clientHeight: 100,
      }),
    ).toBe(false)
  })

  test("returns true when scrolling up at top", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: -10,
        scrollTop: 0,
        scrollHeight: 500,
        clientHeight: 100,
      }),
    ).toBe(true)
  })

  test("returns false when scrolling down not at bottom", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 10,
        scrollTop: 50,
        scrollHeight: 500,
        clientHeight: 100,
      }),
    ).toBe(false)
  })

  test("returns true when delta exceeds remaining scroll at bottom", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 11,
        scrollTop: 390,
        scrollHeight: 500,
        clientHeight: 100,
      }),
    ).toBe(true)
  })

  test("returns false when delta equals remaining scroll", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 10,
        scrollTop: 390,
        scrollHeight: 500,
        clientHeight: 100,
      }),
    ).toBe(false)
  })

  test("returns false when scrolling up not at top", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: -10,
        scrollTop: 100,
        scrollHeight: 500,
        clientHeight: 100,
      }),
    ).toBe(false)
  })

  test("returns true when delta exceeds remaining scroll space", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 20,
        scrollTop: 385,
        scrollHeight: 500,
        clientHeight: 100,
      }),
    ).toBe(true)
  })
})
