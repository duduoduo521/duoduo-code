import { describe, expect, test } from "bun:test"
import { substitute } from "../../src/config/variable"
import { InvalidError } from "../../src/config/error"

describe("config.variable", () => {
  describe("substitute", () => {
    test("substitutes {env:VAR} with environment variable value", async () => {
      const orig = process.env.TEST_VAR_SUB
      process.env.TEST_VAR_SUB = "hello"
      try {
        const result = await substitute({
          type: "virtual",
          source: "test",
          dir: "/tmp",
          text: "value is {env:TEST_VAR_SUB}",
        })
        expect(result).toBe("value is hello")
      } finally {
        if (orig === undefined) delete process.env.TEST_VAR_SUB
        else process.env.TEST_VAR_SUB = orig
      }
    })

    test("replaces missing env vars with empty string", async () => {
      const orig = process.env.NONEXISTENT_VAR_XYZ
      delete process.env.NONEXISTENT_VAR_XYZ
      try {
        const result = await substitute({
          type: "virtual",
          source: "test",
          dir: "/tmp",
          text: "value is {env:NONEXISTENT_VAR_XYZ}end",
        })
        expect(result).toBe("value is end")
      } finally {
        if (orig !== undefined) process.env.NONEXISTENT_VAR_XYZ = orig
      }
    })

    test("substitutes multiple env vars", async () => {
      const orig1 = process.env.TEST_VAR_A
      const orig2 = process.env.TEST_VAR_B
      process.env.TEST_VAR_A = "AAA"
      process.env.TEST_VAR_B = "BBB"
      try {
        const result = await substitute({
          type: "virtual",
          source: "test",
          dir: "/tmp",
          text: "{env:TEST_VAR_A} and {env:TEST_VAR_B}",
        })
        expect(result).toBe("AAA and BBB")
      } finally {
        if (orig1 === undefined) delete process.env.TEST_VAR_A
        else process.env.TEST_VAR_A = orig1
        if (orig2 === undefined) delete process.env.TEST_VAR_B
        else process.env.TEST_VAR_B = orig2
      }
    })

    test("returns text unchanged when no substitution tokens present", async () => {
      const result = await substitute({
        type: "virtual",
        source: "test",
        dir: "/tmp",
        text: "plain text with no tokens",
      })
      expect(result).toBe("plain text with no tokens")
    })

    test("skips {file:} tokens on lines starting with //", async () => {
      const result = await substitute({
        type: "virtual",
        source: "test",
        dir: "/tmp",
        text: "// {file:/nonexistent.txt}\nactual content",
        missing: "empty",
      })
      expect(result).toBe("// {file:/nonexistent.txt}\nactual content")
    })

    test("throws InvalidError for missing file with missing=error (default)", async () => {
      try {
        await substitute({
          type: "virtual",
          source: "test",
          dir: "/tmp",
          text: "{file:/nonexistent/path/file.txt}",
        })
        expect.unreachable("Should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidError)
      }
    })

    test("returns empty for missing file with missing=empty", async () => {
      const result = await substitute({
        type: "virtual",
        source: "test",
        dir: "/tmp",
        text: "prefix{file:/nonexistent/path/file.txt}suffix",
        missing: "empty",
      })
      expect(result).toBe("prefixsuffix")
    })
  })
})
