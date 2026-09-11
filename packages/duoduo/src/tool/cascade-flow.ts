import crypto from "crypto"
import { Effect } from "effect"
import { DuoduoError } from "@/util/error"
import { Instance } from "@/project/instance"
import { createSmartLayerClients } from "@/smart-layer"
import { Config } from "@/config"
import { buildFileContract } from "@/smart-layer/contract"
import { withLlmVerdict } from "./cascade-runner"
import { writeCascadeValidationResult } from "./cascade-blackboard"
import type { CascadeReport } from "@/quality/types"
import type { InterfaceContract } from "@/smart-layer/types"

type CascadeLike = {
  verify(input: { filepath: string; content: string; language: undefined }): Effect.Effect<
    CascadeReport,
    never,
    any
  >
}

/**
 * Shared cascade-QA helpers for the write / edit / apply_patch tools.
 *
 * Previously `rememberCascadeResult` was copy-pasted verbatim into all three
 * tools and `submitStable` was copy-pasted verbatim into all three as well;
 * the copies had already drifted once (apply_patch tags its memory entries
 * with `source: "apply_patch"`, the other two do not). Keep them here.
 */

type SmartClients = ReturnType<typeof createSmartLayerClients>
type BlackboardClient = NonNullable<NonNullable<SmartClients>["blackboard"]>

/**
 * Record a cascade QA verdict into project memory (fire-and-forget).
 * `source` distinguishes which tool produced the verdict.
 */
export function rememberCascadeResult(
  filePath: string,
  passed: boolean,
  summary: string,
  source?: string,
) {
  const clients = createSmartLayerClients()
  if (!clients?.memory) return
  clients.memory
    .store(summary, passed ? "semantic" : "episode", {
      memoryType: "cascade_result",
      tags: ["cascade", passed ? "pass" : "fail"],
      projectPath: Instance.directory,
      metadata: source ? { filePath, passed, source } : { filePath, passed },
    })
    .catch(() => {})
}

/** Cascade issue shape carried into the submit gate (subset of CascadeReport issues). */
export type CascadeIssue = { severity: string; message: string; line?: number }

/**
 * Build the LLM content-check config for a single target file.
 *
 * Reads `quality.enableLlmCheck` from the user's settings; when on, derives a
 * `contract` from the KG (buildFileContract) and collects `kgRelated` (the
 * file's own members + true CROSS-FILE dependencies from the KG neighbor graph,
 * see smart-layer/contract).
 *
 * Every write path (`write` / `edit` / `apply_patch`) must use this: passing
 * no `quality` made `runPostFormatCascade` skip `withLlmVerdict` entirely, so
 * the LLM content check silently never ran for write/edit (P1-24).
 */
export const resolveCascadeQuality = (target: string) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const info = yield* cfg.get()
    if (info.quality?.enableLlmCheck !== true) return { quality: undefined }

    const contract = yield* buildFileContract(target)
    const kgRelated = contract
      ? [
          ...(contract.extends ? [contract.extends] : []),
          ...Object.keys(contract.methods),
          ...Object.keys(contract.properties),
          // Cross-file related entities (true cross-file dependencies from KG
          // 1–2 hop neighbors in OTHER files) — enriches the LLM content-check
          // context beyond this file's own members.
          ...(contract.related ?? []),
        ]
      : []
    return {
      // P2-32: `contract` was computed here (a KG round-trip) and then
      // dropped — only its derived `kgRelated` reached the LLM check, so the
      // content-correctness prompt ran without the interface contract it was
      // designed to use.
      quality: { enableLlmCheck: true, contract, diff: undefined, kgRelated },
    }
  })

/**
 * Resolve the optimistic-lock base for a blackboard submit: the CURRENT
 * version + ast hash of `filePath`, plus the hash of the new content.
 *
 * `version 0` + empty hash is truthful ONLY for a file the blackboard has
 * never tracked. The previous hard-coded `baseVersion: 0` accepted the first
 * submit and made every subsequent one conflict — the disk write (already
 * done by the tool) and the blackboard state diverged, and each failed submit
 * fed the conflict-rate metric a false 1.0 sample (P1-04). Shared by
 * `makeSubmitStable` (write/edit/apply_patch) and the `blackboard_submit_*`
 * tools so this lookup exists exactly once.
 */
export async function resolveBlackboardSubmitBase(
  blackboard: BlackboardClient,
  promptId: string,
  filePath: string,
  content: string,
): Promise<{ baseVersion: number; baseAstHash?: string; newAstHash: string }> {
  let baseVersion = 0
  let baseAstHash: string | undefined
  try {
    const v = await blackboard.getVersion(promptId, filePath)
    if (v.found && typeof v.version === "number") {
      baseVersion = v.version
      baseAstHash = v.astHash
    }
  } catch {
    // Version lookup is best-effort: fall back to 0 (new-file semantics)
    // rather than failing the whole submit.
  }
  return {
    baseVersion,
    baseAstHash,
    newAstHash: crypto.createHash("sha256").update(content).digest("hex"),
  }
}

/**
 * Build the blackboard `submit_stable` closure used after a successful write.
 *
 * Submits directly as STABLE so the Rust-side tree-sitter L1 syntax gate
 * (`validate_syntax`) runs on the final content. Honors the "语法校验"
 * switch via `skipSyntaxCheck`. Failures are swallowed by design — the
 * blackboard is an auxiliary ledger; a submit failure must not fail the
 * user-visible write.
 *
 * P1-27: the closure also IS the cascade submit gate. Callers pass the
 * error-severity issues found for this write; when any exist the file is NOT
 * promoted to stable (it stays a draft in the blackboard ledger) and the
 * caller is expected to surface the issues so the agent fixes them. Previously
 * the submit ran unconditionally, so a change the cascade had just failed was
 * still recorded as accepted work.
 */
export function makeSubmitStable(input: {
  blackboard: BlackboardClient | undefined
  promptID: string | undefined
  agentId: string
  skipSyntaxCheck?: boolean
}) {
  return (filePath: string, content: string, cascadeErrors?: ReadonlyArray<CascadeIssue>) =>
    cascadeErrors && cascadeErrors.length > 0
      ? Effect.void
      : input.blackboard && input.promptID
      ? Effect.tryPromise({
          try: async () => {
            const base = await resolveBlackboardSubmitBase(
              input.blackboard!,
              input.promptID!,
              filePath,
              content,
            )
            return input.blackboard!.submit({
              promptId: input.promptID!,
              agentId: input.agentId,
              filePath,
              content,
              baseVersion: base.baseVersion,
              status: "stable",
              baseAstHash: base.baseAstHash,
              newAstHash: base.newAstHash,
              skipSyntaxCheck: input.skipSyntaxCheck,
            })
          },
          catch: () =>
            new DuoduoError({ message: "blackboard submit failed", messageZh: "黑板提交失败", cause: undefined }),
        }).pipe(Effect.catch(() => Effect.void))
      : Effect.void
}

/**
 * Record a cascade verdict everywhere it matters: project memory (fire-and-
 * forget) and the blackboard `validation_result` key (consumed by the fixed4
 * orchestration gate). The three tool copies of this recording step had
 * drifted — edit's new-file branch skipped `cascadeErrorIssues`, edit's
 * normal branch skipped `writeCascadeValidationResult` — so the unified flow
 * always does BOTH (P2-31).
 */
function recordEverywhere(input: {
  promptID: string | undefined
  agentId: string
  filePath: string
  report: CascadeReport
  label: string
  source?: string
}) {
  return Effect.gen(function* () {
    rememberCascadeResult(
      input.filePath,
      input.report.passed,
      input.report.passed ? `${input.label} passed` : `${input.label} failed`,
      input.source,
    )
    yield* writeCascadeValidationResult({
      promptID: input.promptID,
      agentID: input.agentId,
      filePath: input.filePath,
      report: input.report,
    })
  })
}

/**
 * Post-format re-verify — the authoritative cascade verdict, and the ONLY one.
 *
 * P2-31: a pre-format pass used to run a full LSP verify on the pre-format
 * content, then this pass ran the SAME verify on the final content, and the
 * tool fetched diagnostics a third time for its output. All three were
 * redundant: with no deterministic fixer (P1-25) the pre-format verify could
 * not change the outcome, and its verdict was overwritten by this pass anyway.
 * Runs after the formatter so the content that is actually on disk is what gets
 * judged. Writes back auto-fixes if a fixer ever exists, runs the optional LLM
 * content-correctness check, and records the verdict.
 */
export function runPostFormatCascade(input: {
  service: CascadeLike
  filepath: string
  content: string
  writeBack: (content: string) => Effect.Effect<void, unknown, unknown>
  promptID: string | undefined
  agentId: string
  source?: string
  quality?: {
    enableLlmCheck?: boolean
    contract?: InterfaceContract
    diff?: string
    kgRelated?: string[]
  }
}) {
  return Effect.gen(function* () {
    const report = yield* input.service.verify({
      filepath: input.filepath,
      content: input.content,
      language: undefined,
    })
    let content = input.content
    if (report.fixed && report.content !== content) {
      yield* input.writeBack(report.content)
      content = report.content
    }
    // LLM content-correctness check on the FINAL content (moved here from the
    // pre-format pass — the formatter's output is what ships).
    const finalReport = input.quality?.enableLlmCheck
      ? yield* withLlmVerdict(report, input.filepath, content, input.quality)
      : report
    yield* recordEverywhere({
      promptID: input.promptID,
      agentId: input.agentId,
      filePath: input.filepath,
      report: finalReport,
      label: "Post-format cascade QA",
      source: input.source,
    })
    return { content, report: finalReport }
  })
}
