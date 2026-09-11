import { Effect } from "effect"
import type { CascadeReport } from "../quality/types"
import { createSmartLayerClients } from "@/smart-layer"
import type { InterfaceContract } from "@/smart-layer/types"

/**
 * Ask the user's LLM whether the content is correct, and merge the verdict
 * into `report`. Offline / no-LLM / switch-off returns the report unchanged
 * (zero regression). The verdict is a real gate: a failed LLM verdict must
 * fail the report AND surface an error-severity issue (P1-24), because every
 * downstream gate — the stable-submit gate and the tool output the agent
 * reads — keys on the issue list, not on `passed`. Emitting only `passed:
 * false` made the verdict invisible to both.
 */
export function withLlmVerdict(
  report: CascadeReport,
  filepath: string,
  content: string,
  quality: { enableLlmCheck?: boolean; contract?: InterfaceContract; diff?: string; kgRelated?: string[] },
) {
  return Effect.gen(function* () {
    const clients = createSmartLayerClients()
    if (!clients) return report
    const verdict = yield* Effect.promise(() =>
      clients.quality
        .validate({
          artifact: {
            type: "source",
            content,
            language: undefined as any,
            filePath: filepath,
          },
          qualityLevel: "standard",
          interfaceContract: quality.contract,
          enableLlmCheck: true,
          diff: quality.diff,
          kgRelated: quality.kgRelated,
        })
        .then((r) => r.llmVerdict ?? null)
        .catch(() => null),
    )
    if (!verdict) return report
    const reason = verdict.reason.trim() || "no reason given"
    return {
      ...report,
      issues: verdict.passed
        ? report.issues
        : [...report.issues, { severity: "error" as const, message: `LLM content check failed: ${reason}` }],
      llmVerdict: { passed: verdict.passed, reason: verdict.reason },
      passed: report.passed && verdict.passed,
    } satisfies CascadeReport
  })
}
