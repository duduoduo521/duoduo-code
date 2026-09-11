import { describe, expect, test } from "bun:test"
import { ConfigModelID } from "../../src/config/model-id"

describe("config.model-id", () => {
  describe("ConfigModelID", () => {
    test("has zod schema", () => {
      expect(ConfigModelID.zod).toBeDefined()
      expect(typeof ConfigModelID.zod.parse).toBe("function")
    })

    test("parses string model IDs", () => {
      const result = ConfigModelID.zod.parse("gpt-4")
      expect(result).toBe("gpt-4")
    })

    test("parses complex model IDs", () => {
      const result = ConfigModelID.zod.parse("claude-3-5-sonnet-20241022")
      expect(result).toBe("claude-3-5-sonnet-20241022")
    })

    test("rejects non-string values", () => {
      expect(() => ConfigModelID.zod.parse(123)).toThrow()
    })
  })
})
