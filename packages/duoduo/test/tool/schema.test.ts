import { describe, expect, test } from "bun:test"
import { ToolID } from "../../src/tool/schema"

describe("tool/schema.ToolID", () => {
  test("make creates a branded string", () => {
    const id = ToolID.make("tool_123")
    expect(id).toBe("tool_123" as any)
  })

  test("ascending creates an ascending-order ID", () => {
    const id = ToolID.ascending()
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
  })

  test("ToolID.ascending with valid prefixed id passes through", () => {
    const id = ToolID.ascending("tool_custom123")
    expect(id).toBe("tool_custom123" as any)
  })

  test("zod is a valid zod schema", () => {
    const result = ToolID.zod.safeParse("tool_456")
    expect(result.success).toBe(true)
  })

  test("ascending IDs are unique", () => {
    const id1 = ToolID.ascending()
    const id2 = ToolID.ascending()
    expect(id1).not.toBe(id2)
  })
})
