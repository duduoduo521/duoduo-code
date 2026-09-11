import { describe, expect, test } from "bun:test"
import { pretty, report } from "../../src/lsp/diagnostic"
import type { Diagnostic } from "vscode-languageserver-types"

function makeDiagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 10 },
    },
    message: "test diagnostic",
    severity: 1,
    ...overrides,
  }
}

describe("lsp/diagnostic – pretty", () => {
  test("formats severity 1 (Error) with 1-based line/col", () => {
    const d = makeDiagnostic({ severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } })
    const result = pretty(d)
    expect(result).toBe("ERROR [1:1] test diagnostic")
  })

  test("formats severity 2 (Warning)", () => {
    const d = makeDiagnostic({ severity: 2 })
    const result = pretty(d)
    expect(result).toStartWith("WARN")
  })

  test("formats severity 3 (Info)", () => {
    const d = makeDiagnostic({ severity: 3 })
    const result = pretty(d)
    expect(result).toStartWith("INFO")
  })

  test("formats severity 4 (Hint)", () => {
    const d = makeDiagnostic({ severity: 4 })
    const result = pretty(d)
    expect(result).toStartWith("HINT")
  })

  test("defaults to ERROR when severity is undefined", () => {
    const d = makeDiagnostic({ severity: undefined })
    const result = pretty(d)
    expect(result).toStartWith("ERROR")
  })

  test("defaults to ERROR when severity is 0 (invalid)", () => {
    const d = makeDiagnostic({ severity: 0 as any })
    const result = pretty(d)
    expect(result).toStartWith("ERROR")
  })

  test("uses 1-based line number", () => {
    const d = makeDiagnostic({ range: { start: { line: 9, character: 3 }, end: { line: 9, character: 10 } } })
    const result = pretty(d)
    expect(result).toContain("[10:4]")
  })

  test("uses 1-based column number", () => {
    const d = makeDiagnostic({ range: { start: { line: 0, character: 14 }, end: { line: 0, character: 20 } } })
    const result = pretty(d)
    expect(result).toContain("[1:15]")
  })

  test("includes diagnostic message", () => {
    const d = makeDiagnostic({ message: "some error occurred" })
    const result = pretty(d)
    expect(result).toEndWith("some error occurred")
  })

  test("handles multiline message", () => {
    const d = makeDiagnostic({ message: "line1\nline2\nline3" })
    const result = pretty(d)
    expect(result).toEndWith("line1\nline2\nline3")
  })

  test("handles empty message", () => {
    const d = makeDiagnostic({ message: "" })
    const result = pretty(d)
    expect(result).toMatch(/\[1:1\] $/)
  })
})

describe("lsp/diagnostic – report", () => {
  test("returns empty string when no errors (severity 1)", () => {
    const diagnostics: Diagnostic[] = [
      makeDiagnostic({ severity: 2 }),
      makeDiagnostic({ severity: 3 }),
      makeDiagnostic({ severity: 4 }),
    ]
    expect(report("test.ts", diagnostics)).toBe("")
  })

  test("returns empty string when empty array", () => {
    expect(report("test.ts", [])).toBe("")
  })

  test("formats single error correctly", () => {
    const diagnostics = [makeDiagnostic({ severity: 1, message: "zerr" })]
    const result = report("file.ts", diagnostics)
    expect(result).toBe('<diagnostics file="file.ts">\nERROR [1:1] zerr\n</diagnostics>')
  })

  test("formats multiple errors", () => {
    const diagnostics = [
      makeDiagnostic({ severity: 1, message: "err1", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }),
      makeDiagnostic({ severity: 1, message: "err2", range: { start: { line: 1, character: 3 }, end: { line: 1, character: 5 } } }),
    ]
    const result = report("a.ts", diagnostics)
    expect(result).toBe(
      '<diagnostics file="a.ts">\nERROR [1:1] err1\nERROR [2:4] err2\n</diagnostics>',
    )
  })

  test("filters out non-error severities", () => {
    const diagnostics = [
      makeDiagnostic({ severity: 2, message: "warn" }),
      makeDiagnostic({ severity: 1, message: "error" }),
      makeDiagnostic({ severity: 3, message: "info" }),
    ]
    const result = report("f.ts", diagnostics)
    expect(result).toContain("ERROR [1:1] error")
    expect(result).not.toContain("warn")
    expect(result).not.toContain("info")
  })

  test("limits to MAX_PER_FILE (20) errors", () => {
    const diagnostics: Diagnostic[] = []
    for (let i = 0; i < 25; i++) {
      diagnostics.push(makeDiagnostic({ severity: 1, message: `err${i + 1}` }))
    }
    const result = report("big.ts", diagnostics)
    // Should contain "err1" through "err20"
    expect(result).toContain("err1")
    expect(result).toContain("err20")
    // Should NOT contain "err21"
    expect(result).not.toContain("err21")
  })

  test("shows count of additional errors beyond limit", () => {
    const diagnostics: Diagnostic[] = []
    for (let i = 0; i < 25; i++) {
      diagnostics.push(makeDiagnostic({ severity: 1, message: `err${i + 1}` }))
    }
    const result = report("big.ts", diagnostics)
    expect(result).toContain("... and 5 more")
  })

  test("does not add suffix when exactly at limit", () => {
    const diagnostics: Diagnostic[] = []
    for (let i = 0; i < 20; i++) {
      diagnostics.push(makeDiagnostic({ severity: 1, message: `err${i + 1}` }))
    }
    const result = report("exact.ts", diagnostics)
    expect(result).not.toContain("more")
  })

  test("does not add suffix when under limit", () => {
    const diagnostics = [makeDiagnostic({ severity: 1, message: "only" })]
    const result = report("small.ts", diagnostics)
    expect(result).not.toContain("more")
  })

  test("escapes file path in XML tag", () => {
    const diagnostics = [makeDiagnostic({ severity: 1, message: "x" })]
    const result = report("path/to/file.ts", diagnostics)
    expect(result).toStartWith('<diagnostics file="path/to/file.ts">')
  })

  test("cross-platform: works with backslash paths", () => {
    const diagnostics = [makeDiagnostic({ severity: 1, message: "x" })]
    const result = report("path\\to\\file.ts", diagnostics)
    expect(result).toStartWith('<diagnostics file="path\\to\\file.ts">')
  })
})
