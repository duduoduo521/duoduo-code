import { describe, expect, test } from "bun:test"
import { Layout } from "../../src/config/layout"

describe("config.layout", () => {
  describe("Layout", () => {
    test("has zod schema", () => {
      expect(Layout.zod).toBeDefined()
      expect(typeof Layout.zod.parse).toBe("function")
    })

    test("parses 'auto' value", () => {
      const result = Layout.zod.parse("auto")
      expect(result).toBe("auto")
    })

    test("parses 'stretch' value", () => {
      const result = Layout.zod.parse("stretch")
      expect(result).toBe("stretch")
    })

    test("rejects invalid values", () => {
      expect(() => Layout.zod.parse("invalid")).toThrow()
    })
  })
})
