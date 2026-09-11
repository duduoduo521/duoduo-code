import { describe, expect, test } from "bun:test"
import { parseJsonObject, pathMatches, planPreviewMetadata } from "../../src/tool/orchestration"

describe("tool.orchestration", () => {
  test("parseJsonObject returns undefined for invalid or non-object input", () => {
    expect(parseJsonObject(undefined)).toBeUndefined()
    expect(parseJsonObject("not-json")).toBeUndefined()
    expect(parseJsonObject("null")).toBeUndefined()
    expect(parseJsonObject("[]")).toBeUndefined()
  })

  test("parseJsonObject parses object content", () => {
    expect(parseJsonObject<{ status: string }>('{"status":"passed"}')).toEqual({ status: "passed" })
  })

  test("pathMatches supports exact, suffix, and windows separators", () => {
    expect(pathMatches("src/a.ts", "src/a.ts")).toBe(true)
    expect(pathMatches("/repo/src/a.ts", "src/a.ts")).toBe(true)
    expect(pathMatches("C:\\repo\\src\\a.ts", "src/a.ts")).toBe(true)
    expect(pathMatches("src/abc.ts", "src/a.ts")).toBe(false)
  })

  test("planPreviewMetadata keeps diff fallback and extra fields", () => {
    const metadata = planPreviewMetadata("edit", "src/a.ts", "diff", { risks: ["risk"] })
    expect(metadata.filepath).toBe("src/a.ts")
    expect(metadata.diff).toBe("diff")
    expect(metadata.planPreview.summary).toContain("edit")
    expect(metadata.planPreview.fallbackDiff).toBe("diff")
    expect(metadata.planPreview.risks).toEqual(["risk"])
  })
})
