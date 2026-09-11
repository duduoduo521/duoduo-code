import { Effect } from "effect"
import z from "zod"
import * as Tool from "./tool"

/**
 * `proceed_to_*` — phase-machine hard-signal tools (§3.3, plan A).
 *
 * ## Why this definition lives in TypeScript (and Rust)
 *
 * The main agent loop runs in Rust (`duo-smart-layer::routes::agent::run_loop_handler`),
 * but the tool list advertised to the LLM is built **exclusively** from this TS
 * registry (`session/prompt.ts` → `registry.tools()` + MCP). The Rust-side
 * `TOOL_REGISTRY` (dispatch.rs) only drives *dispatch*, never the advertised list.
 * So these tools must be declared here to be visible to the model.
 *
 * **Single source of truth (Layer A, strategy B2):** the canonical `ToolDefinition`
 * for each `proceed_to_*` phase lives in Rust (`agentic_loop.rs::proceed_to_*_tool()`),
 * which is the contract baseline. This TS file is the mirror that keeps the exact
 * `zod` shape so `execute`'s argument type stays type-safe. Keep the two in sync —
 * the `description` text must match `proceed_to_*_tool()` verbatim.
 *
 * Execution is **Rust-first**: `run_loop_handler` calls
 * `AgenticLoopExecutor::execute_tool` first, which routes through the
 * `GearToolRegistry` to the native `proceed_to_*_handler`. The handler name is
 * the deterministic hard signal — the loop asserts exactly one legal phase
 * transition (validated against the legal-edge table + oscillation / revisit
 * guards in `agentic_loop.rs`). No free-form text is parsed, so the transition
 * is 100% parse-safe.
 *
 * The `execute` below is the **fallback** taken only when the Rust path returns
 * an error and the call is delegated back to TS. It is a no-op that simply
 * explains the signal could not be applied (the real transition happens in Rust).
 */

const NO_ARGS = z.object({})

type Args = z.infer<typeof NO_ARGS>

function fallbackMsg(phase: string): string {
  return (
    `Phase signal 'proceed_to_${phase}' could not be applied by the Rust loop ` +
    `(the handler was unreachable). The loop will continue based on its current phase. ` +
    `This is a no-op fallback; the authoritative transition is performed in Rust.`
  )
}

function makeTool(phase: "investigate" | "plan" | "execute" | "verify") {
  const id = `proceed_to_${phase}`
  const descriptions: Record<string, string> = {
    investigate:
      "Signal the phase machine to enter the Investigate phase (root-cause analysis). " +
      "Call this after you have gathered enough evidence to understand the bug or requirement. " +
      "The transition is validated by the loop; only a legal edge (e.g. from Execute on a " +
      "contract failure, or from Plan) is applied.",
    plan:
      "Signal the phase machine to enter the Plan phase (design the solution). " +
      "Call this after Investigate has produced a root cause. The loop validates the edge " +
      "before applying it.",
    execute:
      "Signal the phase machine to enter the Execute phase (write/modify code). " +
      "Call this after Plan has produced concrete steps. The loop validates the edge " +
      "before applying it.",
    verify:
      "Signal the phase machine to enter the Verify phase (test/build/check). " +
      "Call this after code has been written. The loop also auto-transitions Execute→Verify " +
      "when a file is written, so this is mainly for explicit confirmation.",
  }
  interface PhaseSignalMetadata {
    fallback: boolean
  }
  return Tool.define(
    id,
    Effect.gen(function* () {
      return {
        description: descriptions[phase]!,
        parameters: NO_ARGS,
        execute: (_args: Args): Effect.Effect<Tool.ExecuteResult<PhaseSignalMetadata>> =>
          Effect.sync(() => ({
            title: `Phase signal: ${phase}`,
            output: fallbackMsg(phase),
            metadata: { fallback: true },
          })),
      }
    }),
  )
}

export const ProceedToInvestigateTool = makeTool("investigate")
export const ProceedToPlanTool = makeTool("plan")
export const ProceedToExecuteTool = makeTool("execute")
export const ProceedToVerifyTool = makeTool("verify")
