import { DuoduoError } from "@/util/error"
import { Effect } from "effect"
import * as path from "path"
import type * as Tool from "./tool"
import { Instance } from "@/project/instance"
import { Flag } from "@/flag/flag"
import { createSmartLayerClients } from "@/smart-layer"
import { getPromptID } from "@/session/prompt-id-registry"

type OrchestrationPlan = {
  mode?: "adaptive" | "fixed4"
  level?: "simple" | "medium" | "complex"
  stages?: string[]
  requiresValidation?: boolean
  status?: "implicit" | "planned"
  reason?: string[]
}

type ValidationResult = {
  status?: "passed" | "failed"
  files?: string[]
  checkedAt?: number
}

export function orchestrationMode() {
  const value = String(Flag.DUODUO_MULTI_AGENT_MODE ?? "adaptive").toLowerCase()
  return value === "off" || value === "fixed4" ? value : "adaptive"
}

export function parseJsonObject<T>(content: string | undefined): T | undefined {
  if (!content) return undefined
  try {
    const parsed = JSON.parse(content)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : undefined
  } catch {
    return undefined
  }
}

export function pathMatches(file: string, candidate: string) {
  const normalizedFile = file.replaceAll("\\", "/")
  const normalizedCandidate = candidate.replaceAll("\\", "/")
  return normalizedFile === normalizedCandidate || normalizedFile.endsWith(`/${normalizedCandidate}`)
}

// P1-4 (决策 2b) pure arbitration, extracted so the checkedAt ordering rule
// is unit-testable without a live blackboard: the block shadows the write
// only while it is NEWER than the `passed` validation; a re-pass with a newer
// timestamp supersedes it (no delete needed).
export function cascadeBlockArbitration(
  block: ValidationResult | undefined,
  validation: ValidationResult | undefined,
  relPath: string,
  toWorktreeRel: (p: string) => string,
): boolean {
  if (block?.status !== "failed") return false
  if (!(block.files ?? []).some((file) => pathMatches(relPath, toWorktreeRel(file)))) return false
  const blockAt = block.checkedAt ?? 0
  const passedAt = validation?.checkedAt ?? 0
  return blockAt > passedAt
}

export function ensureWriteAllowedByOrchestration(ctx: Tool.Context, filePath: string) {
  return Effect.gen(function* () {
    const promptID = getPromptID(ctx.sessionID)
    if (!promptID) return

    const currentMode = orchestrationMode()
    if (currentMode === "off") return

    const clients = createSmartLayerClients()
    if (!clients?.blackboard) {
      if (currentMode === "fixed4") {
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
        return yield* Effect.fail(new DuoduoError({ message: "Blackboard is required for fixed4 multi-agent writes.", messageZh: "fixed4 多智能体写入需要黑板。", cause: undefined }))
      }
      return
    }

    const relPath = path.relative(Instance.worktree, filePath).replaceAll("\\", "/")
    const planRead = yield* Effect.tryPromise({
      try: () => clients.blackboard.read({ promptId: promptID, key: "orchestration_plan", agentId: ctx.agent }),
      catch: () => new DuoduoError({ message: "failed to read orchestration_plan", messageZh: "读取 orchestration_plan 失败", cause: undefined }),
    }).pipe(Effect.catch(() => Effect.succeed(null)))

    let plan = parseJsonObject<OrchestrationPlan>(planRead?.content)
    if (!plan) {
      plan = {
        mode: currentMode === "fixed4" ? "fixed4" : "adaptive",
        level: "simple",
        stages: currentMode === "fixed4" ? ["retriever", "planner", "validator", "executor"] : ["planner", "executor"],
        requiresValidation: currentMode === "fixed4",
        status: "implicit",
        reason: ["write attempted without orchestration_plan"],
      }
      yield* Effect.tryPromise({
        try: () =>
          clients.blackboard.write({
            promptId: promptID,
            agentId: "system:orchestration",
            key: "orchestration_plan",
            value: JSON.stringify(plan, null, 2),
          }),
        catch: () => new DuoduoError({ message: "failed to write implicit orchestration_plan", messageZh: "写入隐式 orchestration_plan 失败", cause: undefined }),
      }).pipe(Effect.catch(() => Effect.void))
    }

    if (!plan.requiresValidation) return

    const validationRead = yield* Effect.tryPromise({
      try: () => clients.blackboard.read({ promptId: promptID, key: "validation_result", agentId: ctx.agent }),
      catch: () => new DuoduoError({ message: "failed to read validation_result", messageZh: "读取 validation_result 失败", cause: undefined }),
    }).pipe(Effect.catch(() => Effect.succeed(null)))
    const validation = parseJsonObject<ValidationResult>(validationRead?.content)
    const files = validation?.files ?? []
    // Writers of `validation_result` may emit either worktree-relative paths
    // (`src/a.ts`) or absolute ones (`D:\proj\src\a.ts`) — the validator agent
    // prompt does not pin a format (prompt.ts), and cascade failures mirror
    // whatever the tool reported. Normalize to worktree-relative before
    // matching, otherwise the fixed4 gate rejects every write forever (P1-26).
    const worktreeNorm = Instance.worktree.replaceAll("\\", "/")
    const toWorktreeRel = (p: string) => {
      const norm = p.replaceAll("\\", "/")
      return norm.startsWith(`${worktreeNorm}/`) ? norm.slice(worktreeNorm.length + 1) : norm
    }
    const passed =
      validation?.status === "passed" && files.some((file) => pathMatches(relPath, toWorktreeRel(file)))
    if (!passed) {
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
      return yield* Effect.fail(new DuoduoError({ message: String(`Validation is required before writing ${relPath}. Ask a validator agent to write blackboard validation_result={"status":"passed","files":["${relPath}"],"checkedAt":...}.`), messageZh: String(`写入 ${relPath} 前需要校验。请让校验智能体写入黑板 validation_result={"status":"passed","files":["${relPath}"],"checkedAt":...}.`), cause: undefined }))
    }

    // P1-4 (决策 2b): a cascade failure blocks the write until validation is
    // re-passed AFTER the failure. `cascade_block` is a dedicated key written
    // by cascade-blackboard.ts — the LWW `validation_result` alone would let a
    // concurrent validator's `passed` overwrite the failure and silently
    // unblock the write. Both sides carry checkedAt, so ordering decides:
    // block.active iff block.checkedAt > validation.checkedAt (a validation
    // re-pass with a newer timestamp supersedes the block — no delete needed).
    const blockRead = yield* Effect.tryPromise({
      try: () => clients.blackboard.read({ promptId: promptID, key: "cascade_block", agentId: ctx.agent }),
      catch: () => new DuoduoError({ message: "failed to read cascade_block", messageZh: "读取 cascade_block 失败", cause: undefined }),
    }).pipe(Effect.catch(() => Effect.succeed(null)))
    const block = parseJsonObject<ValidationResult>(blockRead?.content)
    if (cascadeBlockArbitration(block, validation, relPath, toWorktreeRel)) {
      const blockAt = block!.checkedAt ?? 0
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
      return yield* Effect.fail(new DuoduoError({ message: String(`Cascade verification failed for ${relPath} at ${new Date(blockAt).toISOString()} and has not been re-validated since. Ask a validator agent to re-check and write blackboard validation_result={"status":"passed","files":["${relPath}"],"checkedAt":...}.`), messageZh: String(`${relPath} 的级联校验于 ${new Date(blockAt).toISOString()} 失败且此后未重新校验通过。请让校验智能体复查并写入黑板 validation_result={"status":"passed","files":["${relPath}"],"checkedAt":...}.`), cause: undefined }))
    }
  })
}

export function planPreviewMetadata(
  source: string,
  filePath: string,
  diff: string,
  extra?: Record<string, unknown>,
): {
  filepath: string
  diff: string
  source: string
  planPreview: Record<string, unknown> & { summary: string; fallbackDiff: string }
} {
  return {
    filepath: filePath,
    diff,
    source,
    planPreview: {
      summary: `${source} proposes changes to ${filePath}`,
      fallbackDiff: diff,
      ...extra,
    },
  }
}
