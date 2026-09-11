import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import { CascadeInput, CascadeReport } from "../../src/quality/types"

// The Super-RAG schemas that used to be asserted here (ElementRole,
// RSTRelation, NarrativeElement, RhetoricGraph, Blueprint, …) moved to the
// Rust `context-builder` crate and were deleted from `quality/types`; what is
// left is the cascade QA contract the TS path still consumes.

// ============================================================================
// Helper: JSON round-trip + Effect Schema decode
// ============================================================================

function jsonRoundTrip<T>(schema: any, value: T): T {
  const json = JSON.stringify(value)
  const parsed = JSON.parse(json)
  return Schema.decodeUnknownSync(schema)(parsed)
}

// ============================================================================
// Schema JSON round-trips (serialize → parse → decode)
// ============================================================================

describe("Schema round-trips", () => {
  describe("CascadeReport", () => {
    test("JSON round-trip with issues", () => {
      const report = new CascadeReport({
        passed: false,
        fixed: true,
        content: "fixed indentation",
        issues: [
          { severity: "error", message: "bad indent", line: 10 },
          { severity: "warning", message: "trailing whitespace" },
          { severity: "info", message: "consider refactoring" },
        ],
        retries: 1,
      })
      const decoded = jsonRoundTrip(CascadeReport, report)
      expect(decoded).toEqual(report)
    })

    test("round-trip with no issues", () => {
      const report = new CascadeReport({
        passed: true,
        fixed: false,
        content: "all good",
        issues: [],
        retries: 0,
      })
      const decoded = jsonRoundTrip(CascadeReport, report)
      expect(decoded).toEqual(report)
    })

    test("round-trip with optional line field", () => {
      const report = new CascadeReport({
        passed: false,
        fixed: false,
        content: "errors found",
        issues: [
          { severity: "error", message: "missing semicolon", line: 42 },
          { severity: "warning", message: "unused variable" },
        ],
        retries: 3,
      })
      const decoded = jsonRoundTrip(CascadeReport, report)
      expect(decoded).toEqual(report)
    })

    test("round-trip preserves the LLM verdict", () => {
      const report = new CascadeReport({
        passed: false,
        fixed: false,
        content: "llm says no",
        issues: [],
        retries: 0,
        llmVerdict: { passed: false, reason: "logic error" },
      })
      const decoded = jsonRoundTrip(CascadeReport, report)
      expect(decoded.llmVerdict).toEqual({ passed: false, reason: "logic error" })
    })
  })

  describe("CascadeInput", () => {
    test("JSON round-trip preserves required fields", () => {
      const input = new CascadeInput({
        filepath: "/src/main.ts",
        content: "const x = 1",
      })
      const decoded = jsonRoundTrip(CascadeInput, input)
      expect(decoded).toEqual(input)
    })

    test("round-trip with optional language", () => {
      const input = new CascadeInput({
        filepath: "/src/main.py",
        content: "x = 1",
        language: "python",
      })
      const decoded = jsonRoundTrip(CascadeInput, input)
      expect(decoded).toEqual(input)
    })
  })
})

// ============================================================================
// Schema validation — reject invalid inputs
// ============================================================================

describe("Schema validation", () => {
  test("CascadeReport rejects invalid severity", () => {
    const invalid = {
      passed: true,
      fixed: false,
      content: "test",
      issues: [{ severity: "critical", message: "bad" }],
      retries: 0,
    }
    expect(() => Schema.decodeUnknownSync(CascadeReport)(invalid)).toThrow()
  })
})
