import { describe, expect, test } from "bun:test"
import { isValidHex, hexToRgb, hexToAnsiBold } from "../../src/util/color"

describe("util.color", () => {
  describe("isValidHex", () => {
    test("returns true for valid 6-digit hex", () => {
      expect(isValidHex("#FF5733")).toBe(true)
      expect(isValidHex("#000000")).toBe(true)
      expect(isValidHex("#ffffff")).toBe(true)
      expect(isValidHex("#aAbBcC")).toBe(true)
    })

    test("returns false for undefined", () => {
      expect(isValidHex(undefined)).toBe(false)
    })

    test("returns false for empty string", () => {
      expect(isValidHex("")).toBe(false)
    })

    test("returns false for hex without hash", () => {
      expect(isValidHex("FF5733")).toBe(false)
    })

    test("returns false for 3-digit shorthand", () => {
      expect(isValidHex("#F53")).toBe(false)
    })

    test("returns false for 8-digit hex with alpha", () => {
      expect(isValidHex("#FF573380")).toBe(false)
    })

    test("returns false for invalid characters", () => {
      expect(isValidHex("#GG5733")).toBe(false)
    })
  })

  describe("hexToRgb", () => {
    test("converts black", () => {
      expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 })
    })

    test("converts white", () => {
      expect(hexToRgb("#ffffff")).toEqual({ r: 255, g: 255, b: 255 })
    })

    test("converts red", () => {
      expect(hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 })
    })

    test("converts mixed color", () => {
      expect(hexToRgb("#FF5733")).toEqual({ r: 255, g: 87, b: 51 })
    })
  })

  describe("hexToAnsiBold", () => {
    test("returns undefined for undefined input", () => {
      expect(hexToAnsiBold(undefined)).toBeUndefined()
    })

    test("returns undefined for invalid hex", () => {
      expect(hexToAnsiBold("invalid")).toBeUndefined()
      expect(hexToAnsiBold("#FFF")).toBeUndefined()
    })

    test("returns ANSI escape sequence for valid hex", () => {
      const result = hexToAnsiBold("#FF5733")
      expect(result).toContain("\x1b[38;2;")
      expect(result).toContain("255")
      expect(result).toContain("87")
      expect(result).toContain("51")
      expect(result).toContain("\x1b[1m")
    })

    test("returns correct sequence for black", () => {
      expect(hexToAnsiBold("#000000")).toBe("\x1b[38;2;0;0;0m\x1b[1m")
    })
  })
})
