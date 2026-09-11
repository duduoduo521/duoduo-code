import { describe, expect, test } from "bun:test"
import { same } from "./same"

describe("same", () => {
  test("returns true for identical arrays", () => {
    expect(same([1, 2, 3], [1, 2, 3])).toBe(true)
  })

  test("returns true for identical string arrays", () => {
    expect(same(["a", "b"], ["a", "b"])).toBe(true)
  })

  test("returns false for different arrays", () => {
    expect(same([1, 2, 3], [1, 2, 4])).toBe(false)
  })

  test("returns false for different lengths", () => {
    expect(same([1, 2], [1, 2, 3])).toBe(false)
  })

  test("returns true for two empty arrays", () => {
    expect(same([], [])).toBe(true)
  })

  test("returns false for different order", () => {
    expect(same([1, 2, 3], [3, 2, 1])).toBe(false)
  })

  test("returns true when both are the same reference", () => {
    const arr = [1, 2, 3]
    expect(same(arr, arr)).toBe(true)
  })

  test("returns false when first is undefined", () => {
    expect(same(undefined, [1])).toBe(false)
  })

  test("returns false when second is undefined", () => {
    expect(same([1], undefined)).toBe(false)
  })

  test("returns true when both are undefined", () => {
    expect(same(undefined, undefined)).toBe(true)
  })

  test("uses strict equality (===) for elements", () => {
    expect(same([1] as (number | string)[], ["1"])).toBe(false)
  })

  test("returns false for one empty and one non-empty", () => {
    expect(same([], [1])).toBe(false)
    expect(same([1], [])).toBe(false)
  })
})
