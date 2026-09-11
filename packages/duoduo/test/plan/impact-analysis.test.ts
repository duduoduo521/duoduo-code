import { describe, expect, test } from "bun:test"
import { analyzeAstOperationImpact, collectAstOperations } from "../../src/plan/impact-analysis"

describe("impact-analysis", () => {
  test("collects ast operations from snake/camel case candidate content", () => {
    expect(
      collectAstOperations([
        { content: { ast_operations: [{ op: "replace_function" }] } },
        { content: JSON.stringify({ astOperations: [{ op: "add_field" }] }) },
      ]),
    ).toEqual([{ op: "replace_function" }, { op: "add_field" }])
  })

  test("flags incoming dependency not covered by candidate operations", () => {
    const candidate = {
      content: {
        intent_kg_entities: ["function:foo@a.ts"],
        ast_operations: [{ op: "replace_function", file: "a.ts", symbol: "foo" }],
      },
    }
    const result = analyzeAstOperationImpact({
      candidates: [candidate],
      impactGraphs: [
        {
          entityId: "function:foo@a.ts",
          nodes: [],
          edges: [{ source: "function:caller@b.ts", target: "function:foo@a.ts", relation: "Calls" }],
        },
      ],
    })
    expect(result[0]?.risk).toBe("medium")
    expect(result[0]?.missingCoverage).toEqual(["function:caller@b.ts"])
  })

  test("does not flag dependency already covered by plan entities", () => {
    const candidate = {
      content: {
        intent_kg_entities: ["function:foo@a.ts", "function:caller@b.ts"],
        ast_operations: [{ entityId: "function:foo@a.ts" }],
      },
    }
    const result = analyzeAstOperationImpact({
      candidates: [candidate],
      impactGraphs: [
        {
          entityId: "function:foo@a.ts",
          nodes: [],
          edges: [{ source: "function:caller@b.ts", target: "function:foo@a.ts", relation: "Calls" }],
        },
      ],
    })
    expect(result[0]?.risk).toBe("low")
    expect(result[0]?.missingCoverage).toEqual([])
  })
})
