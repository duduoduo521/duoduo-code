import { Effect } from "effect"
import z from "zod"
import * as Tool from "./tool"
import { createSmartLayerClients } from "@/smart-layer"
import type { MemorySearchResult } from "@/smart-layer/memory"

/**
 * `recall_memory` — long-term cross-session memory retrieval.
 *
 * ## Why this definition lives in TypeScript
 *
 * The main agent loop runs in Rust (`duo-smart-layer::routes::agent::run_loop_handler`),
 * but the tool list advertised to the LLM is built **exclusively** from this TS
 * registry (`session/prompt.ts` → `registry.tools()` + MCP). The Rust-side
 * `TOOL_REGISTRY` only drives *dispatch*, never the advertised list. So a tool
 * that exists solely in Rust is invisible to the model and can never be called.
 *
 * Execution is **Rust-first**: `run_loop_handler` calls
 * `AgenticLoopExecutor::execute_tool` first, which routes through the
 * `GearToolRegistry` to the native `recall_memory_handler` (HNSW + FTS5 fusion,
 * in-process, no HTTP hop) and bumps the `recall_hits` metric. The `execute`
 * below is the **fallback** taken only when the Rust path returns an error
 * (e.g. no memory system bound) and the call is delegated back to TS — mirroring
 * how `graph_query` degrades via `createSmartLayerClients()`.
 *
 * Deliberately performs no `ctx.ask()`: this is a read-only query that touches
 * no filesystem path, matching the native handler which has no permission gate
 * of its own. Tool-level permission is still enforced upstream by
 * `check_tool_permission` (Rust) and `Permission.disabled` (TS).
 */

const FALLBACK_MESSAGE =
  "Long-term memory is not available right now (memory service unreachable). Proceed using the current conversation context."

const parameters = z.object({
  query: z
    .string()
    .describe("Natural-language description of what to recall (e.g. 'how we fixed the auth timeout')"),
  top_k: z.number().int().positive().optional().default(10).describe("Maximum number of memory entries to return"),
  project_path: z.string().optional().describe("Optional project path to scope the recall to a single project"),
})

type Args = z.infer<typeof parameters>

interface RecallMemoryMetadata {
  matches: number
  available: boolean
}

/** Render entries as compact, token-efficient lines for the model. */
function formatEntries(entries: MemorySearchResult[]): string {
  const lines: string[] = [`Recalled ${entries.length} memory entr${entries.length === 1 ? "y" : "ies"}:`, ""]
  for (const entry of entries) {
    const score = Number.isFinite(entry.score) ? entry.score.toFixed(3) : "n/a"
    const tags = entry.tags?.length ? ` tags=[${entry.tags.join(", ")}]` : ""
    lines.push(`- [${entry.layer}] (score ${score}${tags})`)
    lines.push(`  ${entry.content.replace(/\s+/g, " ").trim()}`)
  }
  return lines.join("\n")
}

export const RecallMemoryTool = Tool.define(
  "recall_memory",
  Effect.gen(function* () {
    return {
      description: [
        "Retrieve long-term memory across sessions: past decisions, solved problems, error patterns, and project context.",
        "Use this when you need prior context that may not be present in the current conversation — for example when the user refers to an earlier decision, a bug fixed previously, or an established convention.",
        "Returns ranked memory entries with their content and relevance score. Returns an empty result when nothing relevant has been stored yet.",
      ].join("\n"),
      parameters,
      execute: (args: Args): Effect.Effect<Tool.ExecuteResult<RecallMemoryMetadata>> =>
        Effect.gen(function* () {
          const topK = args.top_k ?? 10

          const clients = createSmartLayerClients()
          if (!clients?.memory) {
            return {
              title: args.query,
              metadata: { matches: 0, available: false },
              output: FALLBACK_MESSAGE,
            }
          }

          // `null` marks an unreachable/failing service so it can be told apart
          // from a successful search that simply found nothing.
          const entries: MemorySearchResult[] | null = yield* Effect.tryPromise(() =>
            clients.memory.search(args.query, topK, undefined, undefined, args.project_path),
          ).pipe(Effect.catch(() => Effect.succeed(null)))

          if (entries === null) {
            return {
              title: args.query,
              metadata: { matches: 0, available: false },
              output: FALLBACK_MESSAGE,
            }
          }

          if (entries.length === 0) {
            return {
              title: args.query,
              metadata: { matches: 0, available: true },
              output: `No long-term memory found for "${args.query}".`,
            }
          }

          return {
            title: args.query,
            metadata: { matches: entries.length, available: true },
            output: formatEntries(entries),
          }
        }),
    }
  }),
)
