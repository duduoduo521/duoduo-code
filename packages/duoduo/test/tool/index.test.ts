import { describe, expect, test } from "bun:test"
import * as ToolIndex from "../../src/tool/index"

describe("tool/index exports", () => {
  test("exports Truncate", () => {
    expect(ToolIndex.Truncate).toBeDefined()
    expect(ToolIndex.Truncate.MAX_LINES).toBe(2000)
    expect(ToolIndex.Truncate.MAX_BYTES).toBe(50 * 1024)
  })

  test("exports ToolRegistry", () => {
    expect(ToolIndex.ToolRegistry).toBeDefined()
  })

  test("exports Tool", () => {
    expect(ToolIndex.Tool).toBeDefined()
    expect(ToolIndex.Tool.define).toBeDefined()
    expect(ToolIndex.Tool.init).toBeDefined()
  })
})
