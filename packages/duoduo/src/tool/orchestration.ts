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
