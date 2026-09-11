import { describe, expect, test } from "bun:test"
import { split, join } from "../../src/util/bom"

describe("util.bom", () => {
  const BOM = "\uFEFF"

  describe("split", () => {
    test("returns bom: false for text without BOM", () => {
      const result = split("hello")
      expect(result.bom).toBe(false)
      expect(result.text).toBe("hello")
    })

    test("returns bom: true for text starting with BOM", () => {
      const result = split(BOM + "hello")
      expect(result.bom).toBe(true)
      expect(result.text).toBe("hello")
    })

    test("handles empty string without BOM", () => {
      const result = split("")
      expect(result.bom).toBe(false)
      expect(result.text).toBe("")
    })

    test("handles string that is only BOM", () => {
      const result = split(BOM)
      expect(result.bom).toBe(true)
      expect(result.text).toBe("")
    })

    test("does not strip BOM in the middle of text", () => {
      const result = split("hello" + BOM + "world")
      expect(result.bom).toBe(false)
      expect(result.text).toBe("hello" + BOM + "world")
    })
  })

  describe("join", () => {
    test("returns text without BOM when bom is false", () => {
      expect(join("hello", false)).toBe("hello")
    })

    test("prepends BOM when bom is true", () => {
      expect(join("hello", true)).toBe(BOM + "hello")
    })

    test("strips existing BOM before re-adding", () => {
      expect(join(BOM + "hello", true)).toBe(BOM + "hello")
    })

    test("strips existing BOM when bom is false", () => {
      expect(join(BOM + "hello", false)).toBe("hello")
    })

    test("handles empty string with bom false", () => {
      expect(join("", false)).toBe("")
    })

    test("handles empty string with bom true", () => {
      expect(join("", true)).toBe(BOM)
    })
  })
})
