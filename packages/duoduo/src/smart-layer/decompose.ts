import { Effect, Stream } from "effect"
import { tool, jsonSchema } from "ai"
import { LLM } from "@/session/llm"
import { Agent } from "@/agent/agent"
import { SystemPrompt } from "@/session/system"
import type { Provider } from "@/provider"
import type { MessageV2 } from "@/session/message-v2"
import type { SubTaskRequest } from "./agent"
import type { InterfaceContract } from "./types"
import { buildFileContract, renderFileContract } from "./contract"

/**
 * Deterministic TS-side task decomposition for G7 parallel dispatch.
 *
 * When the Rust side has `parallel_dispatch` enabled, the TS runtime calls this
 * to split the user's task into independent sub-tasks and send them explicitly
 * via `subTasks` (see `AgentClient.postRunLoop`). This gives TS — not the Rust
 * planner — deterministic control over the decomposition, satisfying the
 * "TS 显式下发" requirement.
 *
 * The planner runs read-only (no tools that write) and returns its result by
 * calling a single JSON-schema `decompose` tool. Any failure (no LLM, parse
 * error, malformed output) yields an empty list, so the caller falls back to
 * the Rust LLM planner (or the serial loop) with no behaviour change.
 */
const PLANNER_SYSTEM = [
  "You are a task decomposition planner. Given a high-level engineering task, " +
    "break it into a set of INDEPENDENT sub-tasks that can be executed in " +
    "parallel by separate agents without shared mutable state. Avoid overlapping " +
    "work. Call the `decompose` tool exactly once with a JSON array where each " +
    "element is an object: { \"id\": short_ascii_string, \"task\": self_contained_instruction_string, " +
    "\"mode\": \"codegen\" | \"explore\" }. Use \"codegen\" when the sub-task may need to write " +
    "or edit files (gated by the blackboard), and \"explore\" for read-only analysis. " +
    "Optionally include \"targetFile\": \"path/to/file\" when the sub-task is expected to implement " +
    "or modify a SPECIFIC existing file whose interface should be honored (omit it otherwise). " +
    "If the task is indivisible, return an empty array [].",
]

/**
 * Map the planner's `decompose` tool-call input into concrete sub-tasks.
 *
 * ③ Contract planner (M1+M2): when a planned sub-task names a `targetFile`, we
 * build its interface contract from the KG (via `buildFileContract`) and attach
 * it as `target_file`/`interface_contract` (snake_case → Rust wire), and inject
 * the rendered contract into the sub-agent's `system_prompt` (M2). If the KG is
 * down or the file has no class node, `buildFileContract` returns `undefined`
 * and the sub-task simply runs unconstrained (R6.1, zero regression).
 *
 * Extracted from `decomposeTask` so the `targetFile` → contract wiring is
 * unit-testable without mocking the LLM stream.
 */
export function buildSubTasks(
  input: Array<{ id?: string; task?: string; mode?: string; targetFile?: string }>,
  envLines: string[],
  codingStandards: string | undefined,
): Effect.Effect<SubTaskRequest[], unknown, never> {
  return Effect.gen(function* () {
    const planned = input.filter((s) => s && s.id && s.task)
    const subtasks: SubTaskRequest[] = []
    for (const s of planned) {
      const id = s.id as string
      const task = s.task as string
      const mode = s.mode === "explore" ? ("explore" as const) : ("codegen" as const)

      // ③ Contract planner (M1+M2): if the planner named a target file, build its
      // interface contract from the KG and attach it. Best-effort — a KG outage or
      // a file with no class node yields no contract, and the sub-task simply runs
      // unconstrained (R6.1, zero regression).
      let targetFile: string | undefined
      let interfaceContract: InterfaceContract | undefined
      const tf =
        typeof s.targetFile === "string" && s.targetFile.trim().length > 0
          ? s.targetFile.trim()
          : undefined
      if (tf) {
        const contract = yield* buildFileContract(tf)
        if (contract) {
          targetFile = tf
          interfaceContract = contract
        }
      }

      // R5 fix: give each sub-agent the environment + local coding standards so
      // parallel workers honour the team's rules instead of running unconstrained.
      // Remote URLs are excluded here (supply-chain guard); the main path keeps them.
      const systemPromptParts = [
        ...envLines,
        ...(codingStandards ? [codingStandards] : []),
        // M2: inject the rendered file contract into the sub-agent system prompt.
        ...(interfaceContract ? [renderFileContract(tf!, interfaceContract)] : []),
        `You are executing ONE independent sub-task. Do not assume other sub-tasks exist; coordinate only via the blackboard if needed.\n\nSub-task:\n${task}`,
      ]
      subtasks.push({
        id,
        task_prompt: task,
        mode,
        system_prompt: systemPromptParts.filter(Boolean).join("\n"),
        // Conflict grouping (Rust `group_by_conflict`): declare the planned file
        // so two sub-tasks aiming at the same file are serialized instead of
        // racing. This uses the planner's raw `tf`, NOT `targetFile` — the
        // latter is only set when the KG yielded a contract, and grouping must
        // work regardless.
        files: tf ? [tf] : undefined,
        // ③ structured contract → Rust (B1→B5). Snake_case keys match the Rust
        // `SubTaskRequest` wire fields.
        target_file: targetFile,
        interface_contract: interfaceContract,
      })
    }
    return subtasks
  })
}

export function decomposeTask(args: {
  user: MessageV2.Info
  task: string
  model: Provider.Model
  agentName: string
  sessionID: string
}): Effect.Effect<SubTaskRequest[], unknown, unknown> {
  return Effect.gen(function* () {
    const llm = yield* LLM.Service
    const agents = yield* Agent.Service
    const agent = yield* agents.get(args.agentName)
    const sys = yield* SystemPrompt.Service
    // Date appended after the stable environment lines (sub-agent prompts are
    // per-task unique anyway, so this is informational, not cache-relevant).
    const envLines = [...sys.environment(args.model), SystemPrompt.dateDirective()]
    // Supply-chain guard: sub-agents must NOT receive remote instruction URLs.
    const codingStandards = yield* sys.projectGuidance({ excludeRemoteUrls: true, includeSharedTypes: true, tokenBudget: 800 })

    const decomposeTool = tool({
      description: "Decompose the engineering task into independent parallel sub-tasks.",
      inputSchema: jsonSchema({
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            task: { type: "string" },
            mode: { type: "string", enum: ["codegen", "explore"] },
            targetFile: { type: "string" },
          },
          required: ["id", "task"],
        },
      }),
      // The parsed input is surfaced via the `tool-call` event; the execute
      // result is irrelevant (kept minimal to satisfy the tool contract).
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })

    const events = llm.stream({
      user: args.user as MessageV2.User,
      sessionID: args.sessionID,
      agent: agent ?? ({ name: args.agentName } as Agent.Info),
      model: args.model,
      system: PLANNER_SYSTEM,
      messages: [{ role: "user", content: args.task }],
      tools: { decompose: decomposeTool },
      toolChoice: "required",
      small: true,
      retries: 1,
    })

    const collected = yield* Stream.runCollect(events)
    const toolCall = collected.find(
      (e): e is Extract<LLM.Event, { type: "tool-call" }> =>
        e.type === "tool-call" && e.toolName === "decompose",
    )
    if (!toolCall) return [] as SubTaskRequest[]

    const input = toolCall.input as Array<{
      id?: string
      task?: string
      mode?: string
      targetFile?: string
    }>
    return yield* buildSubTasks(input, envLines, codingStandards)
  }).pipe(Effect.orElseSucceed(() => [] as SubTaskRequest[]))
}
