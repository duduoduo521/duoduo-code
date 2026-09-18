import { describe, expect, test } from "bun:test"
import { Effect, Context, Layer, Exit } from "effect"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { CascadeService, cascadeLayer } from "../../src/quality/cascade"
import { LSP } from "../../src/lsp"
import type { CascadeInput, CascadeReport } from "../../src/quality/types"
import { testEffect } from "../lib/effect"

// ─── Mock LSP Service ───

function makeMockLSP(overrides: Partial<LSP.Interface> = {}): LSP.Interface {
  // Normalize diagnostics keys exactly the way the production LSP client
  // does (`Filesystem.normalizePath(fileURLToPath(uri))` in `lsp/client.ts`),
  // so the mock honors the real contract on every platform instead of
  // encoding one platform's key shape (P0-02 regression guard).
  const withNormalizedDiagnostics: Partial<LSP.Interface> = overrides.diagnostics
    ? {
        ...overrides,
        diagnostics: (() =>
          Effect.map(overrides.diagnostics() as Effect.Effect<Record<string, unknown>, unknown, never>, (map) => {
            const out: Record<string, unknown> = {}
            for (const [key, value] of Object.entries(map)) {
              out[AppFileSystem.normalizePath(key)] = value
            }
            return out
          })) as any,
      }
    : overrides

  return {
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}) as any,
    hover: () => Effect.succeed(null),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
    ...withNormalizedDiagnostics,
  }
}

function makeLSPLayer(impl: LSP.Interface) {
  return Layer.succeed(LSP.Service, LSP.Service.of(impl))
}

// ─── Helpers ───

const defaultInput: CascadeInput = {
  filepath: "/project/src/index.ts",
  content: "const x = 1",
}

async function runVerify(input: CascadeInput, lspImpl?: LSP.Interface): Promise<CascadeReport> {
  const lspLayer = lspImpl ? makeLSPLayer(lspImpl) : Layer.empty
  const mergedLayer = Layer.merge(cascadeLayer, lspLayer)

  const program = Effect.gen(function* () {
    const svc = yield* CascadeService
    return yield* svc.verify(input)
  })

  const result = await Effect.runPromise(program.pipe(Effect.provide(mergedLayer as Layer.Layer<any, any, never>)))
  return result
}

// ─── testEffect-based tests ───
// For the no-LSP case, we use testEffect with an empty LSP layer
// to verify the serviceOption(None) path through the Effect context

const noLspLayer = Layer.merge(cascadeLayer, Layer.empty) as Layer.Layer<any, any, never>
const noLspIt = testEffect(noLspLayer)

describe("quality.cascade (testEffect)", () => {
  noLspIt.effect(
    "returns passed when no LSP service is available",
    Effect.gen(function* () {
      const svc = yield* CascadeService
      const result = yield* svc.verify(defaultInput)
      expect(result.passed).toBe(true)
      expect(result.fixed).toBe(false)
      // P2-12: the verdict is now explicitly UNVERIFIED — fail-open but
      // visible instead of silently looking like a passing check.
      expect(result.unchecked).toBe(true)
      expect(result.issues).toHaveLength(1)
      expect(result.issues[0]?.severity).toBe("info")
      expect(result.retries).toBe(0)
      expect(result.content).toBe(defaultInput.content)
    }),
  )

  noLspIt.effect(
    "returns passed with empty content when input has empty content",
    Effect.gen(function* () {
      const svc = yield* CascadeService
      const result = yield* svc.verify({ filepath: "/test.ts", content: "" })
      expect(result.passed).toBe(true)
      expect(result.content).toBe("")
    }),
  )
})

// ─── Direct-run tests (for per-test LSP mocking) ───

describe("quality.cascade", () => {
  // ─── No LSP available ───

  test("returns passed when no LSP service is available", async () => {
    const result = await runVerify(defaultInput)
    expect(result.passed).toBe(true)
    expect(result.fixed).toBe(false)
    // P2-12: fail-open but explicitly marked unchecked + an info issue.
    expect(result.unchecked).toBe(true)
    expect(result.issues).toHaveLength(1)
    expect(result.retries).toBe(0)
    expect(result.content).toBe(defaultInput.content)
  })

  // ─── LSP with no errors ───

  test("returns passed when LSP has no errors for the file", async () => {
    const lsp = makeMockLSP({
      diagnostics: () =>
        Effect.succeed({
          "/project/src/other.ts": [{ severity: 1, message: "Error in other file", range: { start: { line: 5 } } }],
        }) as any,
    })

    const result = await runVerify(defaultInput, lsp)
    expect(result.passed).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.content).toBe(defaultInput.content)
  })

  test("returns passed when LSP diagnostics is empty", async () => {
    const lsp = makeMockLSP({
      diagnostics: () => Effect.succeed({}) as any,
    })

    const result = await runVerify(defaultInput, lsp)
    expect(result.passed).toBe(true)
    expect(result.issues).toEqual([])
  })

  // ─── LSP with errors ───

  test("returns failed with issues when LSP errors exist (severity=1)", async () => {
    const lsp = makeMockLSP({
      diagnostics: () =>
        Effect.succeed({
          "/project/src/index.ts": [
            {
              severity: 1,
              message: "Type 'string' is not assignable to 'number'",
              range: { start: { line: 10, character: 5 } },
            },
            {
              severity: 1,
              message: "Cannot find name 'foo'",
              range: { start: { line: 20 } },
            },
          ],
        }) as any,
    })

    const result = await runVerify(defaultInput, lsp)
    expect(result.passed).toBe(false)
    expect(result.fixed).toBe(false)
    expect(result.issues).toHaveLength(2)
    expect(result.issues[0]).toEqual({
      severity: "error",
      message: "Type 'string' is not assignable to 'number'",
      line: 10,
    })
    expect(result.issues[1]).toEqual({
      severity: "error",
      message: "Cannot find name 'foo'",
      line: 20,
    })
    expect(result.content).toBe(defaultInput.content)
  })

  test("returns failed with issues when LSP errors exist (severity='error')", async () => {
    const lsp = makeMockLSP({
      diagnostics: () =>
        Effect.succeed({
          "/project/src/index.ts": [
            {
              severity: "error",
              message: "Syntax error",
              range: { start: { line: 3 } },
            },
          ],
        }) as any,
    })

    const result = await runVerify(defaultInput, lsp)
    expect(result.passed).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe("error")
    expect(result.issues[0].message).toBe("Syntax error")
  })

  test("returns passed when LSP has only warnings (severity=2)", async () => {
    const lsp = makeMockLSP({
      diagnostics: () =>
        Effect.succeed({
          "/project/src/index.ts": [
            {
              severity: 2,
              message: "Variable 'x' is declared but never used",
              range: { start: { line: 1 } },
            },
            {
              severity: 3,
              message: "Some info message",
              range: { start: { line: 2 } },
            },
          ],
        }) as any,
    })

    const result = await runVerify(defaultInput, lsp)
    expect(result.passed).toBe(true)
    expect(result.issues).toEqual([])
  })

  // ─── Filepath normalization ───

  test("matches diagnostics keyed by the LSP client's own normalization (P0-02)", async () => {
    const windowsInput: CascadeInput = {
      filepath: "C:\\project\\src\\index.ts",
      content: "const x = 1",
    }

    const lsp = makeMockLSP({
      diagnostics: () =>
        Effect.succeed({
          // Key the map exactly the way `lsp/client.ts` does
          // (`Filesystem.normalizePath(fileURLToPath(uri))`). Hand-rolled
          // forward-slash keys here used to lock in the P0-02 bug where the
          // lookup never matched on Windows and QA always passed.
          [AppFileSystem.normalizePath(windowsInput.filepath)]: [
            {
              severity: 1,
              message: "Error on Windows path",
              range: { start: { line: 0 } },
            },
          ],
        }) as any,
    })

    const result = await runVerify(windowsInput, lsp)
    expect(result.passed).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].message).toBe("Error on Windows path")
  })

  test("handles mixed backslash and forward slash in filepath", async () => {
    const mixedInput: CascadeInput = {
      filepath: "C:/project\\src/index.ts",
      content: "hello",
    }

    const lsp = makeMockLSP({
      diagnostics: () =>
        Effect.succeed({
          [AppFileSystem.normalizePath(mixedInput.filepath)]: [
            {
              severity: 1,
              message: "Mixed slash error",
              range: { start: { line: 0 } },
            },
          ],
        }) as any,
    })

    const result = await runVerify(mixedInput, lsp)
    expect(result.passed).toBe(false)
    expect(result.issues).toHaveLength(1)
  })

  test("filepath normalization matches LSP keys for pure-backslash paths", async () => {
    const input: CascadeInput = {
      filepath: "C:\\Users\\dev\\project\\src\\file.ts",
      content: "test",
    }

    const lsp = makeMockLSP({
      diagnostics: () =>
        Effect.succeed({
          [AppFileSystem.normalizePath(input.filepath)]: [{ severity: 1, message: "Found", range: { start: { line: 0 } } }],
        }) as any,
    })

    const result = await runVerify(input, lsp)
    expect(result.passed).toBe(false)
  })

  test("posix-style filepath matches its normalized key", async () => {
    const input: CascadeInput = {
      filepath: "/project/src/index.ts",
      content: "test",
    }

    const lsp = makeMockLSP({
      diagnostics: () =>
        Effect.succeed({
          [AppFileSystem.normalizePath(input.filepath)]: [{ severity: 1, message: "Error", range: { start: { line: 0 } } }],
        }) as any,
    })

    const result = await runVerify(input, lsp)
    expect(result.passed).toBe(false)
    expect(result.issues[0].message).toBe("Error")
  })

  // ─── Error handling on LSP failures ───

  test("returns passed when LSP diagnostics call fails", async () => {
    const lsp = makeMockLSP({
      diagnostics: () => Effect.fail(new Error("LSP connection lost")) as any,
    })

    const result = await runVerify(defaultInput, lsp)
    // P2-12: fail-open but explicitly UNVERIFIED, with a visible info issue.
    expect(result.passed).toBe(true)
    expect(result.unchecked).toBe(true)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.severity).toBe("info")
  })

  test("returns passed when touchFile fails", async () => {
    const lsp = makeMockLSP({
      touchFile: () => Effect.fail(new Error("touchFile failed")) as any,
      diagnostics: () => Effect.succeed({}) as any,
    })

    const result = await runVerify(defaultInput, lsp)
    expect(result.passed).toBe(true)
    expect(result.unchecked).toBe(true)
    expect(result.issues).toHaveLength(1)
  })

  test("returns passed when both touchFile and diagnostics fail", async () => {
    const lsp = makeMockLSP({
      touchFile: () => Effect.fail(new Error("touchFile failed")) as any,
      diagnostics: () => Effect.fail(new Error("diagnostics also failed")) as any,
    })

    const result = await runVerify(defaultInput, lsp)
    expect(result.passed).toBe(true)
    expect(result.unchecked).toBe(true)
    expect(result.issues).toHaveLength(1)
  })

  // ─── Edge cases ───

  test("handles diagnostics without range field", async () => {
    const lsp = makeMockLSP({
      diagnostics: () =>
        Effect.succeed({
          "/project/src/index.ts": [
            {
              severity: 1,
              message: "Error without range",
            },
          ],
        }) as any,
    })

    const result = await runVerify(defaultInput, lsp)
    expect(result.passed).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].line).toBeUndefined()
    expect(result.issues[0].message).toBe("Error without range")
  })

  test("handles diagnostics without message field", async () => {
    const lsp = makeMockLSP({
      diagnostics: () =>
        Effect.succeed({
          "/project/src/index.ts": [
            {
              severity: 1,
              range: { start: { line: 5 } },
            },
          ],
        }) as any,
    })

    const result = await runVerify(defaultInput, lsp)
    expect(result.passed).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].line).toBe(5)
    expect(typeof result.issues[0].message).toBe("string")
  })

  test("preserves original content in report", async () => {
    const input: CascadeInput = {
      filepath: "/project/src/app.ts",
      content: "export function hello() { return 'world' }",
    }

    const lsp = makeMockLSP({
      diagnostics: () =>
        Effect.succeed({
          "/project/src/app.ts": [
            {
              severity: 1,
              message: "Some error",
              range: { start: { line: 0 } },
            },
          ],
        }) as any,
    })

    const result = await runVerify(input, lsp)
    expect(result.content).toBe(input.content)
    expect(result.fixed).toBe(false)
  })

  test("returns retries=0 in all cases (auto-fix not implemented)", async () => {
    const lsp = makeMockLSP({
      diagnostics: () =>
        Effect.succeed({
          "/project/src/index.ts": [
            {
              severity: 1,
              message: "Error",
              range: { start: { line: 0 } },
            },
          ],
        }) as any,
    })

    const result = await runVerify(defaultInput, lsp)
    expect(result.retries).toBe(0)
  })

  test("filters only severity=1 and severity='error' as errors", async () => {
    const lsp = makeMockLSP({
      diagnostics: () =>
        Effect.succeed({
          "/project/src/index.ts": [
            { severity: 1, message: "Error1", range: { start: { line: 1 } } },
            { severity: 2, message: "Warning", range: { start: { line: 2 } } },
            { severity: 3, message: "Info", range: { start: { line: 3 } } },
            { severity: 4, message: "Hint", range: { start: { line: 4 } } },
            { severity: "error", message: "StringError", range: { start: { line: 5 } } },
          ],
        }) as any,
    })

    const result = await runVerify(defaultInput, lsp)
    expect(result.passed).toBe(false)
    expect(result.issues).toHaveLength(2)
    expect(result.issues[0].message).toBe("Error1")
    expect(result.issues[1].message).toBe("StringError")
  })

  test("handles empty filepath", async () => {
    const input: CascadeInput = {
      filepath: "",
      content: "test",
    }

    const lsp = makeMockLSP({
      diagnostics: () => Effect.succeed({}) as any,
    })

    const result = await runVerify(input, lsp)
    expect(result.passed).toBe(true)
    expect(result.issues).toEqual([])
  })

  test("handles multiple files with errors, only reports for target file", async () => {
    const lsp = makeMockLSP({
      diagnostics: () =>
        Effect.succeed({
          "/project/src/index.ts": [{ severity: 1, message: "Error in target", range: { start: { line: 1 } } }],
          "/project/src/other.ts": [{ severity: 1, message: "Error in other", range: { start: { line: 2 } } }],
        }) as any,
    })

    const result = await runVerify(defaultInput, lsp)
    expect(result.passed).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].message).toBe("Error in target")
  })
})
