import { describe, expect, test } from "bun:test"
import { Info } from "../../src/config/command"

// ---------------------------------------------------------------------------
// ConfigCommand.Info — schema validation, optional fields, type safety
//
// The Info schema is an Effect Schema derived via withStatics into a Zod
// validator. We test the Zod interface (Info.zod.safeParse) directly for pure,
// fast unit tests.
// ---------------------------------------------------------------------------

describe("ConfigCommand.Info schema", () => {
  test("has zod schema", () => {
    expect(Info).toBeDefined()
    expect(Info.zod).toBeDefined()
    expect(typeof Info.zod.parse).toBe("function")
  })

  describe("valid configs", () => {
    test("minimal config with only template", () => {
      const result = Info.zod.safeParse({
        template: "Run `npm test` in the project directory",
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.template).toBe("Run `npm test` in the project directory")
        expect(result.data.description).toBeUndefined()
        expect(result.data.agent).toBeUndefined()
        expect(result.data.model).toBeUndefined()
        expect(result.data.subtask).toBeUndefined()
      }
    })

    test("full config with all optional fields", () => {
      const result = Info.zod.safeParse({
        template: "Run tests for {{path}}",
        description: "Run tests in the current project",
        agent: "tester",
        model: "gpt-4",
        subtask: true,
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.template).toBe("Run tests for {{path}}")
        expect(result.data.description).toBe("Run tests in the current project")
        expect(result.data.agent).toBe("tester")
        expect(result.data.model).toBe("gpt-4")
        expect(result.data.subtask).toBe(true)
      }
    })

    test("accepts false for subtask", () => {
      const result = Info.zod.safeParse({
        template: "Deploy {{path}}",
        subtask: false,
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.subtask).toBe(false)
      }
    })

    test("accepts complex model IDs", () => {
      const result = Info.zod.safeParse({
        template: "Review {{path}}",
        model: "claude-3-5-sonnet-20241022",
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.model).toBe("claude-3-5-sonnet-20241022")
      }
    })

    test("extra fields are stripped", () => {
      const result = Info.zod.safeParse({
        template: "Build {{path}}",
        name: "custom-command",
        unknownField: "should be stripped",
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.template).toBe("Build {{path}}")
        // Extra fields should be stripped by Zod
        expect("name" in result.data).toBe(false)
        expect("unknownField" in result.data).toBe(false)
      }
    })
  })

  describe("invalid configs", () => {
    test("rejects missing template", () => {
      const result = Info.zod.safeParse({})
      expect(result.success).toBe(false)
    })

    test("rejects null template", () => {
      const result = Info.zod.safeParse({ template: null })
      expect(result.success).toBe(false)
    })

    test("rejects non-string template", () => {
      const result = Info.zod.safeParse({ template: 123 })
      expect(result.success).toBe(false)
    })

    test("rejects non-string description", () => {
      const result = Info.zod.safeParse({
        template: "test",
        description: 42,
      })
      expect(result.success).toBe(false)
    })

    test("rejects non-string agent", () => {
      const result = Info.zod.safeParse({
        template: "test",
        agent: true,
      })
      expect(result.success).toBe(false)
    })

    test("rejects non-boolean subtask", () => {
      const result = Info.zod.safeParse({
        template: "test",
        subtask: "yes",
      })
      expect(result.success).toBe(false)
    })

    test("rejects non-string model", () => {
      const result = Info.zod.safeParse({
        template: "test",
        model: 123,
      })
      expect(result.success).toBe(false)
    })

    test("accepts empty string template (valid string)", () => {
      const result = Info.zod.safeParse({
        template: "",
      })
      expect(result.success).toBe(true)
    })

    test("rejects undefined", () => {
      const result = Info.zod.safeParse(undefined)
      expect(result.success).toBe(false)
    })

    test("rejects null input", () => {
      const result = Info.zod.safeParse(null)
      expect(result.success).toBe(false)
    })

    test("rejects array input", () => {
      const result = Info.zod.safeParse([])
      expect(result.success).toBe(false)
    })
  })
})
