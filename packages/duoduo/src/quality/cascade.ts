import { Effect, Context, Layer } from "effect"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { LSP } from "@/lsp"
import { Log } from "@/util"
import type { CascadeInput, CascadeReport } from "./types"

const cascadeLog = Log.create({ service: "cascade-qa" })

export interface CascadeInterface {
  readonly verify: (input: CascadeInput) => Effect.Effect<CascadeReport, never, LSP.Service>
}

export class CascadeService extends Context.Service<CascadeService, CascadeInterface>()(
  "@duoduocode/Quality/Cascade",
) {}

const verifyWithLSP = Effect.fn("CascadeQA.verifyWithLSP")(function* (input: CascadeInput) {
  const lsp = yield* LSP.Service
  const diagnostics = yield* lsp.diagnostics()
  // The diagnostics map is keyed by the LSP client's own normalization
  // (`Filesystem.normalizePath` in `lsp/client.ts` — win32 realpath with
  // backslashes). A hand-rolled `replace(/\\/g, "/")` produced forward-slash
  // keys that never matched on Windows, so every lookup missed and cascade
  // QA reported `passed: true` unconditionally (P0-02). Use the same
  // normalization as `write.ts` / `edit.ts` / `apply_patch.ts`.
  const normalizedFilepath = AppFileSystem.normalizePath(input.filepath)
  const issues = diagnostics[normalizedFilepath] ?? []
  return issues
})

export const cascadeLayer = Layer.effect(
  CascadeService,
  Effect.gen(function* () {
    return CascadeService.of({
      verify(input) {
        return Effect.gen(function* () {
          const lspOption = yield* Effect.serviceOption(LSP.Service)
          if (lspOption._tag === "None") {
            // No LSP available — pass through without deterministic checks.
            // Deterministic checks (bracket balance / autoFix) were removed
            // (see `loop汇总实施方案.md` P7.1); syntax correctness is the
            // responsibility of the L1 tree-sitter gate. Returning the original
            // content avoids silently rewriting files.
            return {
              passed: true,
              fixed: false,
              content: input.content,
              issues: [],
              retries: 0,
            } satisfies CascadeReport
          }

          // Ensure LSP server is aware of the file update for accurate diagnostics
// @effect-diagnostics-next-line catchUnfailableEffect:off
          yield* lspOption.value.touchFile(input.filepath, "document").pipe(Effect.catch(() => Effect.void))

// @effect-diagnostics-next-line catchUnfailableEffect:off
          const diagnostics = yield* verifyWithLSP(input).pipe(Effect.catch(() => Effect.succeed([] as any[])))

          const lspErrors = (diagnostics ?? []).filter((d: any) => d.severity === 1 || d.severity === "error")

          const allIssues = lspErrors.map((e: any) => ({
            severity: "error" as const,
            message: e.message ?? String(e),
            line: e.range?.start?.line ?? undefined,
          }))

          const hasErrors = allIssues.some((i) => i.severity === "error")

          return {
            passed: !hasErrors,
            fixed: false,
            content: input.content,
            issues: allIssues,
            retries: 0,
          } satisfies CascadeReport
        })
      },
    })
  }),
)
