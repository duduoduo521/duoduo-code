import { describe, expect, test } from "bun:test"
import { jsonc, schema } from "../../src/config/parse"
import { JsonError, InvalidError } from "../../src/config/error"
import { z } from "zod"

describe("config.parse", () => {
  describe("jsonc", () => {
    test("parses valid JSON", () => {
      const result = jsonc('{"key": "value"}', "test.json")
      expect(result).toEqual({ key: "value" })
    })

    test("parses valid JSONC with comments", () => {
      const result = jsonc('{\n// comment\n"key": "value"\n}', "test.jsonc")
      expect(result).toEqual({ key: "value" })
    })

    test("parses JSONC with trailing commas", () => {
      const result = jsonc('{"key": "value",}', "test.jsonc")
      expect(result).toEqual({ key: "value" })
    })

    test("throws JsonError for invalid JSON", () => {
      expect(() => jsonc("{invalid}", "test.json")).toThrow()
    })

    test("throws JsonError with path info", () => {
      try {
        jsonc("{invalid}", "/config/test.json")
      } catch (err) {
        expect(err).toBeInstanceOf(JsonError)
        expect((err as any).data.path).toBe("/config/test.json")
      }
    })

    test("parses arrays", () => {
      const result = jsonc("[1, 2, 3]", "test.json")
      expect(result).toEqual([1, 2, 3])
    })

    test("parses primitives", () => {
      expect(jsonc("42", "test.json")).toBe(42)
      expect(jsonc('"hello"', "test.json")).toBe("hello")
      expect(jsonc("true", "test.json")).toBe(true)
      expect(jsonc("null", "test.json")).toBe(null)
    })
  })

  describe("schema", () => {
    test("returns parsed data for valid input", () => {
      const s = z.object({ name: z.string() })
      const result = schema(s, { name: "test" }, "source")
      expect(result).toEqual({ name: "test" })
    })

    test("throws InvalidError for invalid input", () => {
      const s = z.object({ name: z.string() })
      expect(() => schema(s, { name: 123 }, "source")).toThrow(InvalidError)
    })

    test("InvalidError includes source path", () => {
      const s = z.object({ name: z.string() })
      try {
        schema(s, { name: 123 }, "/config/test.json")
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidError)
        expect((err as any).data.path).toBe("/config/test.json")
      }
    })

    test("InvalidError includes issues", () => {
      const s = z.object({ name: z.string() })
      try {
        schema(s, { name: 123 }, "source")
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidError)
        expect((err as any).data.issues).toBeDefined()
        expect((err as any).data.issues.length).toBeGreaterThan(0)
      }
    })
  })
})
