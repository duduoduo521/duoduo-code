import { describe, expect, test } from "bun:test"
import { isRecord } from "../../src/util/record"

describe("util.record", () => {
  describe("isRecord", () => {
    test("returns true for plain objects", () => {
      expect(isRecord({})).toBe(true)
      expect(isRecord({ a: 1 })).toBe(true)
    })

    test("returns true for Object.create(null)", () => {
      expect(isRecord(Object.create(null))).toBe(true)
    })

    test("returns false for null", () => {
      expect(isRecord(null)).toBe(false)
    })

    test("returns false for undefined", () => {
      expect(isRecord(undefined)).toBe(false)
    })

    test("returns false for arrays", () => {
      expect(isRecord([])).toBe(false)
      expect(isRecord([1, 2, 3])).toBe(false)
    })

    test("returns false for primitives", () => {
      expect(isRecord("string")).toBe(false)
      expect(isRecord(42)).toBe(false)
      expect(isRecord(true)).toBe(false)
    })

    test("returns true for class instances (they are objects)", () => {
      class Foo {}
      expect(isRecord(new Foo())).toBe(true)
    })

    test("returns false for 0 and NaN", () => {
      expect(isRecord(0)).toBe(false)
      expect(isRecord(NaN)).toBe(false)
    })
  })
})
