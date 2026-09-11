import { describe, expect, test } from "bun:test"
import { Info as FormatterInfo } from "../../src/config/formatter"

describe("config.formatter", () => {
  describe("FormatterInfo", () => {
    test("has zod schema", () => {
      expect(FormatterInfo.zod).toBeDefined()
    })

    test("parses boolean formatter (enable all)", () => {
      const result = FormatterInfo.zod.parse(true)
      expect(result).toBe(true)
    })

    test("parses boolean formatter (disable all)", () => {
      const result = FormatterInfo.zod.parse(false)
      expect(result).toBe(false)
    })

    test("parses object formatter with per-language config", () => {
      const result = FormatterInfo.zod.parse({
        typescript: {
          command: ["prettier", "--write"],
          extensions: [".ts", ".tsx"],
        },
      })
      expect(result).toEqual({
        typescript: {
          command: ["prettier", "--write"],
          extensions: [".ts", ".tsx"],
        },
      })
    })

    test("parses formatter entry with disabled flag", () => {
      const result = FormatterInfo.zod.parse({
        python: {
          disabled: true,
          command: ["black"],
        },
      })
      expect(result).toEqual({
        python: {
          disabled: true,
          command: ["black"],
        },
      })
    })

    test("parses formatter entry with environment", () => {
      const result = FormatterInfo.zod.parse({
        rust: {
          command: ["rustfmt"],
          environment: { RUST_BACKTRACE: "1" },
        },
      })
      expect(result).toEqual({
        rust: {
          command: ["rustfmt"],
          environment: { RUST_BACKTRACE: "1" },
        },
      })
    })
  })
})
