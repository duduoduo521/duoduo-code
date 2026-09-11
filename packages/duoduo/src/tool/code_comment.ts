import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { assertExternalDirectoryEffect } from "./external-directory"
import { createSmartLayerClients } from "@/smart-layer"

/// Resolve the promptId used to scope blackboard access (mirrors tool/blackboard.ts).
function promptIdFromContext(ctx: Tool.Context): string {
  const extra = (ctx as { extra?: Record<string, unknown> }).extra
  const explicit = extra?.["promptID"]
  if (typeof explicit === "string" && explicit.length > 0) return explicit
  return ctx.sessionID
}

const parameters = z.object({
  filePath: z.string().describe("The absolute path to the file to comment on"),
  line: z.number().describe("The line number in the file (1-indexed)"),
  comment: z.string().describe("The review comment about this line"),
  suggestion: z.string().optional().describe("Optional suggested fix or replacement code"),
  originalLine: z.number().describe("The original line number from the diff"),
  confidence: z.number().min(0).max(1).describe("Confidence score for this comment (0-1)"),
})

type CommentMetadata = {
  filePath: string
  line: number
  comment: string
  suggestion?: string
  originalLine: number
  confidence: number
  recorded: boolean
}

export const CodeCommentTool = Tool.define(
  "code_comment",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description:
        "Add an inline code review comment for a specific line in a file. Use this to report issues, suggest improvements, or flag potential bugs during code review.",
      parameters,
      execute: (
        params: {
          filePath: string
          line: number
          comment: string
          suggestion?: string
          originalLine: number
          confidence: number
        },
        ctx: Tool.Context<CommentMetadata>,
      ) =>
        Effect.gen(function* () {
          yield* assertExternalDirectoryEffect(ctx, params.filePath, { kind: "file" })

          const exists = yield* fs.exists(params.filePath).pipe(Effect.orElseSucceed(() => false))
          if (!exists) {
            return {
              title: `Comment on ${params.filePath}:${params.line}`,
              metadata: {
                filePath: params.filePath,
                line: params.line,
                recorded: false,
                comment: "",
                suggestion: undefined,
                originalLine: 0,
                confidence: 0,
              },
              output: `File not found: ${params.filePath}`,
            } as Tool.ExecuteResult<CommentMetadata>
          }

          // Best-effort: persist the review comment as a blackboard annotation so the
          // main loop's Reflect phase can surface it (G5 annotation 回流). Failures are
          // swallowed — they must not break the code_comment tool itself.
          const clients = createSmartLayerClients()
          if (clients) {
            yield* Effect.tryPromise({
              try: () =>
                clients.blackboard.annotate({
                  promptId: promptIdFromContext(ctx),
                  agentId: ctx.agent,
                  filePath: params.filePath,
                  content: `[L${params.line}] ${params.comment}${params.suggestion ? `\nSuggestion: ${params.suggestion}` : ""}`,
                  annotationType: "review",
                }),
              catch: () => undefined,
            }).pipe(Effect.orElseSucceed(() => undefined))
          }

          return {
            title: `Comment on ${params.filePath}:${params.line}`,
            metadata: {
              filePath: params.filePath,
              line: params.line,
              comment: params.comment,
              suggestion: params.suggestion,
              originalLine: params.originalLine,
              confidence: params.confidence,
              recorded: true,
            },
            output: `Recorded review comment on ${params.filePath}:${params.line}: ${params.comment}${params.suggestion ? `\nSuggestion: ${params.suggestion}` : ""}`,
          }
        }),
    }
  }),
)
