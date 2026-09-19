import { describe, expect, test } from "bun:test"
import {
  cascadeBlockArbitration,
  parseJsonObject,
  pathMatches,
  planPreviewMetadata,
} from "../../src/tool/orchestration"

// P1-4 (决策 2b) gate arbitration — the three cases required by the 缺陷调查.md
// test plan: block shadows an older passed; a newer passed supersedes the
// block; an unrelated/absent block never blocks.
describe("tool.orchestration.cascadeBlockArbitration", () => {
  const rel = "src/a.ts"
  const toRel = (p: string) => p

  test("block newer than passed → blocked", () => {
    const block = { status: "failed" as const, files: [rel], checkedAt: 2000 }
    const validation = { status: "passed" as const, files: [rel], checkedAt: 1000 }
    expect(cascadeBlockArbitration(block, validation, rel, toRel)).toBe(true)
  })

  test("re-pass newer than block → unblocked", () => {
    const block = { status: "failed" as const, files: [rel], checkedAt: 1000 }
    const validation = { status: "passed" as const, files: [rel], checkedAt: 2000 }
    expect(cascadeBlockArbitration(block, validation, rel, toRel)).toBe(false)
  })

  test("no block / unrelated block / non-failed block → unblocked", () => {
    expect(cascadeBlockArbitration(undefined, undefined, rel, toRel)).toBe(false)
    expect(
      cascadeBlockArbitration(
        { status: "failed", files: ["src/other.ts"], checkedAt: 9999 },
        { status: "passed", files: [rel], checkedAt: 1 },
        rel,
        toRel,
      ),
    ).toBe(false)
    expect(
      cascadeBlockArbitration(
        { status: "passed", files: [rel], checkedAt: 9999 },
        { status: "passed", files: [rel], checkedAt: 1 },
        rel,
        toRel,
      ),
    ).toBe(false)
  })
})

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
