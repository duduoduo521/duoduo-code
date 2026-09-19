import { describe, expect, test } from "bun:test"
import {
  fileToolGuidance,
  reuseGuidance,
  searchStrategyGuidance,
  usePatchForModel,
} from "../../src/session/system"

// P2-4: guidance variants are the contract — when the KG is NOT ready the
// prompt must not mention the unregistered graph_query tool, and when the
// model does not get edit/write (gpt-* → apply_patch) the file-tool guidance
// must not name edit/write.
describe("session.system guidance variants", () => {
  test("searchStrategyGuidance names graph_query only when kgReady", () => {
    expect(searchStrategyGuidance(true)).toContain("graph_query")
    const without = searchStrategyGuidance(false)
    expect(without).not.toContain("graph_query")
    expect(without).toContain("symbol_search")
  })

  test("reuseGuidance follows the same kgReady gate", () => {
    expect(reuseGuidance(true)).toContain("graph_query")
    expect(reuseGuidance(false)).not.toContain("graph_query")
    expect(reuseGuidance(true)).toContain("recall_memory")
  })

  test("fileToolGuidance matches the usePatch decision", () => {
    expect(fileToolGuidance(true)).toContain("apply_patch")
    expect(fileToolGuidance(true)).not.toContain("edit/write tools")
    const edit = fileToolGuidance(false)
    expect(edit).toContain("edit/write tools")
    expect(edit).not.toContain("apply_patch")
  })

  test("usePatchForModel agrees with the fileToolGuidance key", () => {
    expect(usePatchForModel("gpt-5")).toBe(true)
    expect(usePatchForModel("gpt-4o")).toBe(false)
    expect(usePatchForModel("gpt-oss-120b")).toBe(false)
    expect(usePatchForModel("claude-sonnet-4")).toBe(false)
  })
})
