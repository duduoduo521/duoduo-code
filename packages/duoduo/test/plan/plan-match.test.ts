import { describe, expect, test } from "bun:test"
import { collectPlanEntityIds, entitySearchName, matchPlanCandidates, parsePlanCandidateContent } from "../../src/plan/plan-match"

describe("plan-match", () => {
  test("parses JSON candidate content", () => {
    expect(parsePlanCandidateContent({ content: JSON.stringify({ intent: "fix bug" }) })).toEqual({ intent: "fix bug" })
    expect(parsePlanCandidateContent({ content: "not json" })).toBeUndefined()
  })

  test("collects unique KG entity ids", () => {
    const ids = collectPlanEntityIds([
      { content: { intent_kg_entities: ["function:a@a.ts", "function:a@a.ts", "function:b@b.ts"] } },
      { content: JSON.stringify({ intent_kg_entities: ["Class:C@c.ts"] }) },
    ])
    expect(ids).toEqual(["function:a@a.ts", "function:b@b.ts", "Class:C@c.ts"])
  })

  test("extracts entity search names", () => {
    expect(entitySearchName("function:doWork@src/a.ts")).toBe("doWork")
    expect(entitySearchName("plain")).toBe("plain")
  })

  test("ranks matching candidates and does not select rejected similar plan", () => {
    const keep = { content: { intent: "fix README title", intent_kg_entities: ["file:README.md"] } }
    const rejected = { content: { intent: "delete README title", intent_kg_entities: ["file:README.md"] } }
    const result = matchPlanCandidates({
      query: "fix README title",
      candidates: [rejected, keep],
      preferences: [{ category: "rejected_plan", content: "delete README title" }],
    })
    expect(result.selected).toBe(keep)
    expect(result.candidates.find((item) => item.candidate === rejected)?.rejected).toBe(true)
  })
})
