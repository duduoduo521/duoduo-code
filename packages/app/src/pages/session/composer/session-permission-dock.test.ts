import { describe, expect, test } from "bun:test"
import { planOperationSummary, planPreview, planPreviewImpactWarnings } from "./session-permission-dock-utils"

describe("session-permission-dock planPreview", () => {
  test("returns undefined for missing or invalid metadata", () => {
    expect(planPreview(undefined)).toBeUndefined()
    expect(planPreview(null)).toBeUndefined()
    expect(planPreview({})).toBeUndefined()
    expect(planPreview({ planPreview: "invalid" })).toBeUndefined()
  })

  test("extracts plan preview object", () => {
    const preview = planPreview({
      planPreview: {
        summary: "Review planned changes",
        risks: ["touches auth"],
        astOperations: [{ op: "replace_function" }],
        operationImpact: [{ entityId: "function:foo@a.ts", missingCoverage: ["function:bar@b.ts"] }],
      },
    })
    expect(preview?.summary).toBe("Review planned changes")
    expect(preview?.risks).toEqual(["touches auth"])
    expect(preview?.astOperations).toEqual([{ op: "replace_function" }])
    expect(planPreviewImpactWarnings(preview)).toEqual(["function:foo@a.ts: 1 uncovered dependent entity"])
    expect(planOperationSummary({ op: "replace_function", symbol: "foo", file: "a.ts" })).toBe(
      "replace_function foo in a.ts",
    )
  })

  test("impact warnings ignore covered operations", () => {
    expect(
      planPreviewImpactWarnings({ operationImpact: [{ entityId: "function:foo@a.ts", missingCoverage: [] }] }),
    ).toEqual([])
  })
})
