import { describe, expect, test } from "bun:test"
import { PlanExitTool } from "../../src/tool/plan"
import { TodoWriteTool } from "../../src/tool/todo"
import { LspTool } from "../../src/tool/lsp"
import { Effect } from "effect"

describe("PlanExitTool", () => {
  test("has id 'plan_exit'", () => {
    expect(PlanExitTool.id).toBe("plan_exit")
  })

  test("is an Effect", () => {
    expect(Effect.isEffect(PlanExitTool)).toBe(true)
  })
})

describe("TodoWriteTool", () => {
  test("has id 'todowrite'", () => {
    expect(TodoWriteTool.id).toBe("todowrite")
  })

  test("is an Effect", () => {
    expect(Effect.isEffect(TodoWriteTool)).toBe(true)
  })
})

describe("LspTool", () => {
  test("has id 'lsp'", () => {
    expect(LspTool.id).toBe("lsp")
  })

  test("is an Effect", () => {
    expect(Effect.isEffect(LspTool)).toBe(true)
  })
})
