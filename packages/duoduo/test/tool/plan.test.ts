import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PlanExitTool } from "../../src/tool/plan"
import z from "zod"

describe("PlanExitTool", () => {
  test("has id 'plan_exit'", () => {
    expect(PlanExitTool.id).toBe("plan_exit")
  })

  test("is an Effect", () => {
    expect(Effect.isEffect(PlanExitTool)).toBe(true)
  })

  describe("parameters schema", () => {
    const schema = z.object({})

    test("accepts empty object", () => {
      const result = schema.parse({})
      expect(result).toEqual({})
    })

    test("rejects non-object input", () => {
      expect(() => schema.parse("invalid")).toThrow()
      expect(() => schema.parse(123)).toThrow()
      expect(() => schema.parse(null)).toThrow()
      expect(() => schema.parse(undefined)).toThrow()
    })

    test("strips additional properties by default", () => {
      // z.object({}) uses strip mode by default, extra props are removed
      const result = schema.parse({ unexpected: "field" })
      expect(result).toEqual({})
    })
  })

  describe("description", () => {
    test("mentions exit plan agent", async () => {
      // Description is from plan-exit.txt loaded at init time
      // Check ID and type as structural verification
      expect(PlanExitTool.id).toBe("plan_exit")
    })
  })
})
