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

// P2-12: bound every LSP round-trip. Fixed value: longer means a wedged LSP
// server stalls every write; shorter risks missing slow first-boot analysis.
const LSP_STEP_TIMEOUT = "15 seconds" as const

const verifyWithLSP = Effect.fn("CascadeQA.verifyWithLSP")(function* (input: CascadeInput) {
  const lsp = yield* LSP.Service
  const diagnostics = yield* lsp
    .diagnostics()
    .pipe(Effect.timeout(LSP_STEP_TIMEOUT), Effect.catch(() => Effect.succeed(undefined as any)))
  if (diagnostics === undefined) {
    return "timeout" as const
  }
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
            // P2-12: mark the verdict UNVERIFIED (fail-open, but visible) —
            // `passed: true` used to be indistinguishable from a real check
            // that found nothing.
            cascadeLog.warn("cascade checks skipped: no LSP service", { file: input.filepath })
            return {
              passed: true,
              fixed: false,
              content: input.content,
              issues: [
                { severity: "info" as const, message: "质量校验未执行（LSP 服务不可用）——本次写入未经校验" },
              ],
              retries: 0,
              unchecked: true,
            } satisfies CascadeReport
          }

          // Ensure LSP server is aware of the file update for accurate diagnostics
// @effect-diagnostics-next-line catchUnfailableEffect:off
          const touched = yield* lspOption.value
            .touchFile(input.filepath, "document")
            .pipe(Effect.timeout(LSP_STEP_TIMEOUT), Effect.catch(() => Effect.succeed(false)))
          if (touched === false) {
            cascadeLog.warn("cascade checks skipped: LSP touchFile failed/timed out", { file: input.filepath })
            return {
              passed: true,
              fixed: false,
              content: input.content,
              issues: [
                { severity: "info" as const, message: "质量校验未执行（LSP 更新失败或超时）——本次写入未经校验" },
              ],
              retries: 0,
              unchecked: true,
            } satisfies CascadeReport
          }

// @effect-diagnostics-next-line catchUnfailableEffect:off
          const diagnostics = yield* verifyWithLSP(input).pipe(
            Effect.catch(() => Effect.succeed("lsp-error" as const)),
          )

          if (diagnostics === "timeout" || diagnostics === "lsp-error") {
            cascadeLog.warn("cascade checks skipped: diagnostics unavailable", {
              file: input.filepath,
              reason: diagnostics,
            })
            return {
              passed: true,
              fixed: false,
              content: input.content,
              issues: [
                { severity: "info" as const, message: "质量校验未执行（诊断获取失败或超时）——本次写入未经校验" },
              ],
              retries: 0,
              unchecked: true,
            } satisfies CascadeReport
          }

          const lspErrors = (diagnostics as any[]).filter((d: any) => d.severity === 1 || d.severity === "error")

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
