import { describe, expect, test } from "bun:test"
import { JsonError, InvalidError } from "../../src/config/error"

describe("config.error", () => {
  describe("JsonError", () => {
    test("creates error with path and optional message", () => {
      const err = new JsonError({ path: "/config/settings.json" })
      expect(err.name).toBe("ConfigJsonError")
      expect(err.data.path).toBe("/config/settings.json")
    })

    test("includes message when provided", () => {
      const err = new JsonError({ path: "/config/settings.json", message: "parse error" })
      expect(err.data.message).toBe("parse error")
    })

    test("isInstance works", () => {
      const err = new JsonError({ path: "/test" })
      expect(JsonError.isInstance(err)).toBe(true)
    })

    test("isInstance returns false for other errors", () => {
      const err = new Error("other")
      expect(JsonError.isInstance(err)).toBe(false)
    })
  })

  describe("InvalidError", () => {
    test("creates error with path", () => {
      const err = new InvalidError({ path: "/config/settings.json" })
      expect(err.name).toBe("ConfigInvalidError")
      expect(err.data.path).toBe("/config/settings.json")
    })

    test("includes issues when provided", () => {
      const issues = [{ message: "invalid field" }] as any
      const err = new InvalidError({ path: "/test", issues })
      expect(err.data.issues).toEqual(issues)
    })

    test("includes message when provided", () => {
      const err = new InvalidError({ path: "/test", message: "validation failed" })
      expect(err.data.message).toBe("validation failed")
    })

    test("isInstance works", () => {
      const err = new InvalidError({ path: "/test" })
      expect(InvalidError.isInstance(err)).toBe(true)
    })
  })
})
