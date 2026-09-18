import { DuoduoError } from "@/util/error"
import { Effect } from "effect"
import type { CascadeReport } from "@/quality/types"
import { createSmartLayerClients } from "@/smart-layer"

export function writeCascadeValidationResult(input: {
  promptID?: string
  agentID: string
  filePath: string
  report?: CascadeReport
}) {
  return Effect.gen(function* () {
    if (!input.promptID || !input.report || input.report.passed) return
    const clients = createSmartLayerClients()
    if (!clients?.blackboard) return
    const issues = input.report.issues ?? []
    yield* Effect.tryPromise({
      try: () =>
        clients.blackboard.write({
          promptId: input.promptID!,
          agentId: "system:cascade",
          // P1-4 (决策 2b): failures go to a DEDICATED key. The gate on
          // `validation_result` is LWW — a concurrent validator writing
          // `passed` could silently overwrite this failure and unblock the
          // write. With a separate key, the gate (orchestration.ts) compares
          // checkedAt ordering: a validation `passed` written AFTER this
          // failure supersedes the block; until then the write stays blocked.
          key: "cascade_block",
          value: JSON.stringify(
            {
              status: "failed",
              files: [input.filePath],
              checkedAt: Date.now(),
              source: "cascade",
              agent: input.agentID,
              issues,
              message: "Cascade verification failed. Semantic fixes were not applied automatically; re-plan or ask for confirmation before changing behavior.",
            },
            null,
            2,
          ),
        }),
      catch: () => new DuoduoError({ message: "failed to write cascade_block", messageZh: "写入 cascade_block 失败", cause: undefined }),
    }).pipe(Effect.catch(() => Effect.void))
  })
}
