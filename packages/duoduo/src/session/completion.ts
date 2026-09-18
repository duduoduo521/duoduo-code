/**
 * Session Completion — stores conversation memory to the smart layer after a session ends.
 *
 * When a session completes (assistant finishes with "stop" and no tool calls pending),
 * this module extracts the conversation summary and stores it as a memory entry in the
 * duo-smart-layer sidecar.
 *
 * Storage is fire-and-forget: failures are logged but never block or crash the main flow.
 * When the smart layer is unavailable (no DUO_SMART_LAYER_URL env var), this is a no-op.
 */

import { Effect, Layer, Context } from "effect"
import { createSmartLayerClients } from "@/smart-layer"
import { Log } from "@/util"
import { Instance } from "@/project/instance"
import type { MessageV2 } from "./message-v2"

const log = Log.create({ service: "session.completion" })

export interface Interface {
  /**
   * Store conversation memory for a completed session.
   *
   * Extracts a summary of the user-assistant exchange and stores it
   * in the smart layer's memory system at Layer 1 (short-term).
   *
   * This is designed to be called as a fire-and-forget side effect
   * after a session completes. It never throws.
   */
  readonly storeConversationMemory: (
    sessionID: string,
    messages: MessageV2.WithParts[],
  ) => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/SessionCompletion") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of({
      storeConversationMemory(sessionID, messages) {
        return Effect.gen(function* () {
          const clients = createSmartLayerClients()
          if (!clients) return

          // Extract text parts from user messages (skip synthetic parts)
          const userTexts: string[] = []
          for (const msg of messages) {
            if (msg.info.role !== "user") continue
            for (const part of msg.parts) {
              if (part.type === "text" && !("synthetic" in part && part.synthetic)) {
                userTexts.push(part.text)
              }
            }
          }

          // Extract text parts from assistant messages
          const assistantTexts: string[] = []
          for (const msg of messages) {
            if (msg.info.role !== "assistant") continue
            for (const part of msg.parts) {
              if (part.type === "text" && !("synthetic" in part && part.synthetic)) {
                assistantTexts.push(part.text)
              }
            }
          }

          // Only store if there's meaningful content
          if (userTexts.length === 0 && assistantTexts.length === 0) return

          // ─── Extract structured information ───
          const assistantFull = assistantTexts.join("\n")
          const userFull = userTexts.join("\n")
          const textFileChanges = extractFileChanges(assistantFull)
          const summaryDiffs = messages.flatMap((msg) =>
            msg.info.role === "user" && msg.info.summary?.diffs ? msg.info.summary.diffs : [],
          )
          const fileChanges = summaryDiffs.length > 0 ? summaryDiffs.map((d) => d.file) : textFileChanges
          const decisions = extractDecisions(assistantFull)
          const toolErrors = extractToolErrors(messages)
          const userSummary = userFull.slice(0, 500)
          const assistantSummary = assistantFull.slice(0, 1000)

          // ─── Compute importance ───
          let importance = 0.3 // default: ordinary conversation
          let memoryType = "conversation"
          if (fileChanges.length > 0) {
            importance = 0.7
            memoryType = "code_pattern"
          }
          if (decisions.length > 0) {
            importance = Math.max(importance, 0.85)
            memoryType = "decision"
          }

          // ─── Build structured memory content ───
          const memoryContent = buildStructuredMemory({
            userSummary,
            assistantSummary,
            filesModified: fileChanges,
            decisions,
            toolErrors,
          })

          // Extract project path from assistant messages for per-project memory isolation.
          // P1-10: fall back to the Instance worktree — without a fallback a
          // missing assistant message leaves `projectPath` undefined, and the
          // Rust store lands the memory under '' (`OR project_path = ''`),
          // making it visible from EVERY project.
          const assistantMsg = messages.find(
            (m): m is MessageV2.WithParts & { info: MessageV2.Assistant } => m.info.role === "assistant",
          )
          const projectPath = assistantMsg?.info.path?.cwd ?? Instance.directory

          // Release project task lock and send notifications in parallel
          // with memory storage — these operations are independent.
          const hadErrors = toolErrors.length > 0
          yield* Effect.all(
            [
              // Feishu notification (fire-and-forget, non-blocking)
              projectPath
                ? Effect.promise(() =>
                    clients.client
                      .post("/im/notify", {
                        projectPath,
                        sessionId: sessionID,
                        summary: assistantSummary || "任务已完成",
                        files: fileChanges,
                        diffs: summaryDiffs.map((diff) => ({
                          file: diff.file,
                          additions: diff.additions,
                          deletions: diff.deletions,
                          status: diff.status,
                        })),
                      })
                      .catch((e) => {
                        log.warn("failed to send Feishu completion notification, degrading silently", {
                          sessionID,
                          error: e instanceof Error ? e.message : String(e),
                        })
                      }),
                  )
                : Effect.void,

              // Release project task lock (enables next request to acquire)
              projectPath
                ? Effect.promise(() =>
                    clients.client
                      .post("/task/release", {
                        projectPath,
                        taskId: sessionID,
                        state: "completed",
                      })
                      .catch((e) => {
                        log.warn("failed to release project task lock, degrading silently", {
                          sessionID,
                          error: e instanceof Error ? e.message : String(e),
                        })
                      }),
                  )
                : Effect.void,

              // Store memory with importance-driven layer auto-classification
              Effect.promise(() =>
                clients.memory
                  .store(memoryContent, "auto", {
                    importance,
                    sessionId: sessionID,
                    memoryType,
                    metadata: { timestamp: new Date().toISOString(), filePaths: fileChanges },
                    tags: hadErrors ? ["conversation", "auto-stored", "had-errors"] : ["conversation", "auto-stored"],
                    projectPath,
                  })
                  .then((result) => {
                    log.info("conversation memory stored", { sessionID, memoryID: result.id, importance, memoryType })
                  })
                  .catch((e) => {
                    log.warn("failed to store conversation memory, degrading silently", {
                      sessionID,
                      error: e instanceof Error ? e.message : String(e),
                    })
                  }),
              ),
            ],
            { concurrency: "unbounded" },
          )
        })
      },
    })
  }),
)

export const defaultLayer = layer

export * as SessionCompletion from "./completion"

// ─── Memory content extraction helpers ───

/** Extract file modification references from assistant text. */
export function extractFileChanges(texts: string): string[] {
  const patterns = [
    /\b(?:modified|new file|deleted|renamed):\s+(\S+)/gi,
    /---\s+a\/(\S+)/g,
    /\+\+\+\s+b\/(\S+)/g,
    /📁\s*(\S+)/g,
    /(?:文件|修改了?)\s+(\S+)/g,
  ]
  const results = new Set<string>()
  for (const pat of patterns) {
    let match: RegExpExecArray | null
    while ((match = pat.exec(texts)) !== null) {
      results.add(match[1]!)
    }
  }
  return [...results]
}

/** Extract decision/conclusion statements from assistant text. */
export function extractDecisions(texts: string): string[] {
  const patterns = [
    /(?:决定|选择|采用|方案|策略|架构|设计)[^。\n]*[。\n]/g,
    /(?:decided|chose|adopted|strategy|architecture|design)[^.\n]*[.\n]/gi,
  ]
  const results: string[] = []
  for (const pat of patterns) {
    let match: RegExpExecArray | null
    while ((match = pat.exec(texts)) !== null) {
      results.push(match[0].trim())
    }
  }
  return results
}

/** Extract tool error information from assistant messages' tool-call parts. */
export function extractToolErrors(messages: MessageV2.WithParts[]): string[] {
  const errors: string[] = []
  for (const msg of messages) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      if (part.tool !== "write" && part.tool !== "edit") continue
      const output = part.state.output
      const input = part.state.input as Record<string, unknown>
      const filePath = (input?.filePath as string) ?? "unknown"
      const fileName = filePath.split("/").pop() ?? filePath
      if (output.includes("LSP errors detected in this file")) {
        errors.push(`${fileName}: LSP 类型/语法错误`)
      }
      if (output.includes("Code quality issues")) {
        errors.push(`${fileName}: 代码质量问题（括号/缩进）`)
      }
    }
  }
  return [...new Set(errors)]
}

/** Build a structured memory content string. */
export function buildStructuredMemory(info: {
  userSummary: string
  assistantSummary: string
  filesModified: string[]
  decisions: string[]
  toolErrors?: string[]
}): string {
  let content = ""
  if (info.filesModified.length > 0) {
    content += `## 修改的文件\n${info.filesModified.map((f) => `- ${f}`).join("\n")}\n\n`
  }
  if (info.toolErrors && info.toolErrors.length > 0) {
    content += `## 遇到的问题\n${info.toolErrors.map((e) => `- ${e}`).join("\n")}\n\n`
  }
  if (info.decisions.length > 0) {
    content += `## 决策与结论\n${info.decisions.map((d) => `- ${d}`).join("\n")}\n\n`
  }
  content += `## 摘要\nUser: ${info.userSummary}\nAssistant: ${info.assistantSummary}`
  return content
}
