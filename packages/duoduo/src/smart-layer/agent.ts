import { SmartLayerClient } from "./client"
import { context, propagation } from "@opentelemetry/api"
import type { InterfaceContract } from "./types"

/**
 * The loop configuration as persisted on the Rust side (LoopConfig).
 * Only the fields relevant to the TS side are typed here; unknown fields are
 * preserved via the index signature.
 */
export interface LoopConfig {
  syntaxCheck?: boolean
  reflect?: boolean
  /** G7 parallel multi-agent dispatch switch. When true, run_loop decomposes
   *  the task (or uses explicit `subTasks`) and runs sub-agents concurrently. */
  parallelDispatch?: boolean
  reflectOn?: string | null
  // NOTE: `intent` / `blackboard` were declared here but GET /agent/loop_config
  // never returns them (agent.rs get_loop_config_handler) — dead declarations
  // removed. Unknown keys still land in the index signature below.
  [key: string]: unknown
}

/**
 * A single explicit sub-task for G7 parallel dispatch, sent by the TS side.
 * Mirrors Rust's `SubTaskRequest` (serde snake_case wire format). When present
 * and `parallel_dispatch` is enabled, Rust uses these directly instead of its
 * LLM planner — giving TS deterministic control of the decomposition.
 */
export interface SubTaskRequest {
  id: string
  task_prompt: string
  system_prompt?: string
  /** "codegen" (may write, gated by the blackboard) or "explore" (read-only).
   *  Defaults to "codegen" on the Rust side when omitted. */
  mode?: "codegen" | "explore"
  /** Files this sub-task is expected to create or modify. Used by Rust purely
   *  for conflict grouping at dispatch: sub-tasks sharing a file are serialized
   *  into one group, disjoint ones stay parallel. Omitted/empty ⇒ fully
   *  parallel. Distinct from `target_file`, which is only set when a KG
   *  contract was found; grouping must work even without a contract. */
  files?: string[]
  /** ③ Contract planner: target file this sub-task is expected to implement.
   *  When set alongside `interface_contract`, the Rust agentic loop runs a
   *  contract-consistency check on writes to that file (B5). Snake_case to match
   *  Rust's `SubTaskRequest.target_file` wire field. */
  target_file?: string
  /** ③ Contract planner: interface contract bound to `target_file`, produced by
   *  `contract.ts` from the KG. Snake_case to match Rust's
   *  `SubTaskRequest.interface_contract` wire field. */
  interface_contract?: InterfaceContract
}

/**
 * AgentClient provides typed access to the duo-smart-layer agent API.
 *
 * The agent API manages the Rust-side runLoop and tool result submission,
 * bridging the gap between Rust's suspended runLoop and TS-side tool execution.
 */
export class AgentClient {
  constructor(private client: SmartLayerClient) {}

  /**
   * Trigger a Rust-side runLoop for the given session.
   * Returns immediately with { status: "started", sessionId } — the actual
   * loop runs in a tokio::spawn background task.
   */
  postRunLoop(
    sessionID: string,
    options?: {
      tools?: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>
      permission_rules?: Array<{ permission: string; action: string; pattern: string }>
      model?: string
      agent_name?: string
      project_path?: string
      /** Snapshot gitdir resolved by TS (identical to Snapshot.Service's gitdir).
       *  When undefined, Rust skips snapshot tracking (non-git / disabled). */
      snapshot_gitdir?: string
      output_format?: { type: "json_schema"; schema: Record<string, unknown>; retryCount?: number }
      /** Provider ID (e.g. "openai", "xunfei-new"). Passed inline so the
       *  smart-layer can use it without a prior POST /agent/config call. */
      provider?: string
      /** Base URL for the chat completions API. Falls back to stored config. */
      base_url?: string
      /** API key for the provider. Falls back to stored config or env var. */
      api_key?: string
      /** Intent type from intent clarification (e.g. "question", "command", "discussion").
       *  Maps to intent_type in Rust's RunLoopRequest (Option<String>, camelCase serde). */
      intent_type?: string
      /** System prompt assembled by TS (SystemPrompt.provider + environment).
       *  When provided, Rust injects it as the first system message before the
       *  conversation history. Without this, the LLM in the Rust runLoop path
       *  would not receive "You are DuoDuoCode..." or tool-usage instructions. */
      system_prompt?: string
      /** Model context window in tokens. Enables Rust-side pre-flight compression
       *  of long conversations to avoid context overflow. Read from the model
       *  registry (`model.limit.context`). */
      context_window?: number
      /** Whether this model's provider accepts `cache_control` (prompt caching).
       *  Read from `model.capabilities.promptCaching` — the same flag the TS
       *  path's `ProviderTransform.applyCaching` gates on. When true, Rust marks
       *  the leading system message as a cache breakpoint so the stable system
       *  prefix is billed once per TTL instead of on every round. Left false for
       *  providers that reject the field (they answer HTTP 400).
       *  Maps to `RunLoopRequest.prompt_caching`. */
      prompt_caching?: boolean
      /** Enable progressive tool disclosure on the Rust side: non-core tools are
       *  sent as name-only stubs and the model pulls their full JSON-Schema on
       *  demand via the synthetic `expand_tools` tool. Cuts the per-round tool
       *  payload without changing which tools are callable.
       *  Maps to `RunLoopRequest.progressive_tools`. */
      progressive_tools?: boolean
      /** Explicit G7 sub-task list for parallel dispatch. When provided and the
       *  Rust side has `parallel_dispatch` enabled, these take precedence over
       *  the Rust LLM planner. Each item is a self-contained sub-task. */
      subTasks?: SubTaskRequest[]
      /** Whether the user's "auto-accept permissions" switch is on. When true,
       *  sub-agents (interactive=false) treat an `Ask` permission result as
       *  `Allow`, so autonomous work isn't blocked by confirmation prompts.
       *  Maps to Rust's `RunLoopRequest.auto_accept` (snake_case on the wire). */
      autoAccept?: boolean
      /** Conversation history assembled by TS in LlmMessage wire format
       *  ({ role, content }). The Rust runLoop treats its per-project DB as
       *  the primary history source; these messages are the authoritative
       *  fallback used when the DB copy contains NO user message (invariant
       *  guard against DB-relocation / write-path regressions where the
       *  loop would otherwise run with zero user input and the LLM could
       *  call tools arbitrarily). Maps to `RunLoopRequest.messages`. */
      messages?: Array<{ role: string; content: string }>
      /** Task-scoped directory allow-list ("logical sandbox"). Mirrors
       *  `InstanceContext.allowedPaths`. When non-empty, Rust builds a
       *  per-request `SecurityPolicy` that scopes every path-taking tool to
       *  these directories (the project path is added implicitly), instead of
       *  using the process-global policy. This is what allows legitimate
       *  cross-project work without opening up the whole filesystem.
       *  Maps to `RunLoopRequest.allowed_paths`. */
      allowedPaths?: string[]
      /** Sampling temperature for this runLoop. Resolved by TS from the model's
       *  configured `temperature` (falling back to `ProviderTransform.temperature`).
       *  Overrides the Rust-side `LlmConfig.temperature`. Maps to `RunLoopRequest.temperature`. */
      temperature?: number
    },
  ): Promise<{ status: string; sessionId: string }> {
    return this.client.post("/agent/run_loop", {
      session_id: sessionID,
      messages: options?.messages,
      tools: options?.tools,
      permission_rules: options?.permission_rules,
      model: options?.model,
      agent_name: options?.agent_name,
      project_path: options?.project_path,
      snapshot_gitdir: options?.snapshot_gitdir,
      output_format: options?.output_format,
      provider: options?.provider,
      base_url: options?.base_url,
      api_key: options?.api_key,
      intent_type: options?.intent_type,
      system_prompt: options?.system_prompt,
      context_window: options?.context_window,
      prompt_caching: options?.prompt_caching,
      progressive_tools: options?.progressive_tools,
      sub_tasks: options?.subTasks,
      auto_accept: options?.autoAccept,
      allowed_paths: options?.allowedPaths,
      temperature: options?.temperature,
    })
  }

  /**
   * Read the current Rust-side loop configuration (LoopConfig).
   *
   * Used by the TS runtime to decide whether to perform a deterministic
   * TS-side task decomposition and send explicit `subTasks` (G7). The single
   * source of truth is the Rust `config_manager` (set via the UI's
   * POST /agent/loop_config), so the TS side reads it rather than duplicating
   * the toggle in its own settings store.
   */
  getLoopConfig(): Promise<LoopConfig> {
    return this.client.get<LoopConfig>("/agent/loop_config")
  }

  /**
   * Ensure a session exists on the Rust side (upsert semantics).
   * Must be called before postRunLoop so the Rust SessionManager
   * knows about this session ID.
   */
  ensureSession(sessionID: string, projectPath: string): Promise<{ id: string }> {
    return this.client.post("/session/create", {
      id: sessionID,
      projectId: projectPath,
    })
  }

  /**
   * Submit a tool execution result back to the Rust runLoop.
   *
   * When Rust encounters a tool it cannot execute (MCP, subtask, LSP,
   * permission-ask, etc.), it inserts a Pending tool part into the DB and
   * suspends on `wait_for_tool_result`. TS detects the pending part,
   * executes the tool, then calls this method to unblock the Rust loop.
   */
  postToolResult(sessionID: string, callID: string, result: string): Promise<{ ok: boolean }> {
    return this.client.post("/agent/tool_result", {
      session_id: sessionID,
      call_id: callID,
      result,
    })
  }

  /**
   * Liveness probe for the Rust runLoop task.
   *
   * GET /agent/metrics returns `running: false` once the loop task has exited
   * (the metrics entry is removed in the loop's cleanup, see run_loop_handler).
   * Used by rustRunLoopPoll as a replacement for the old hard poll budget: the
   * poll may now run indefinitely for legitimately long tasks, with this probe
   * (plus a no-progress watchdog in the poll loop) providing termination.
   *
   * Probe failures resolve `true` (assume alive) so a transient network blip
   * can never kill the poll for a healthy loop.
   */
  async isRunLoopActive(sessionID: string): Promise<boolean> {
    try {
      const data = await this.client.get<{ running?: boolean }>("/agent/metrics", { session_id: sessionID })
      return data.running === true
    } catch {
      return true
    }
  }

  /**
   * Cancel a running Rust runLoop by session ID.
   *
   * Calls /agent/cancel/runloop-{sessionID} to trigger the
   * CancellationToken, which causes the SSE parser and LLM
   * stream to exit on the next iteration.
   *
   * Safe to call when no runLoop is running — the Rust side
   * returns { cancelled: false } in that case.
   */
  cancelRunLoop(sessionID: string): Promise<{ cancelled: boolean; task_id: string; message?: string }> {
    return this.client.post(`/agent/cancel/runloop-${sessionID}`, {})
  }

  /**
   * Subscribe to real-time SSE events from a running runLoop.
   *
   * Returns an async generator that yields parsed SSE events. The loop runs
   * detached; SSE disconnect does NOT cancel the loop. Reconnect gets
   * subsequent events (no replay — DB is source of truth).
   */
  async *subscribeRunLoopEvents(sessionID: string): AsyncGenerator<{ event: string; data: string }> {
    const url = `${this.client.getUrl()}/agent/run_loop/events/${sessionID}`
    const headers: Record<string, string> = {}
    propagation.inject(context.active(), headers)
    if (this.client.getAuthHeader()) {
      headers["Authorization"] = this.client.getAuthHeader()!
    }
    const response = await fetch(url, { headers })
    if (!response.ok || !response.body) return
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    // Persist across chunk reads: an SSE `event:` and `data:` line may arrive
    // in separate frames, so they must accumulate until the blank-line boundary.
    let currentEvent = ""
    let currentData = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim()
          } else if (line.startsWith("data:")) {
            currentData = line.slice(5).trim()
          } else if (line === "" && currentEvent && currentData) {
            yield { event: currentEvent, data: currentData }
            currentEvent = ""
            currentData = ""
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * Delete a message (and its parts) from the project DB via Rust sidecar.
   * Used when RUST_SINGLE_WRITE is enabled so the DB delete is not skipped.
   */
  deleteMessage(messageID: string): Promise<{ ok: boolean }> {
    return this.client.post("/agent/messages/delete", { message_id: messageID })
  }

  /**
   * Delete a single part from the project DB via Rust sidecar.
   * Used when RUST_SINGLE_WRITE is enabled so the DB delete is not skipped.
   */
  deletePart(partID: string): Promise<{ ok: boolean }> {
    return this.client.post("/agent/parts/delete", { part_id: partID })
  }

  /**
   * Delete a provider's API key from the OS keyring immediately.
   *
   * This is the "instant" counterpart to the Rust side's startup orphan-sweep:
   * when the user removes a provider (via the UI "disconnect" or the CLI
   * `providers logout`), we purge the OS keyring entry right away so the
   * credential does not linger until the next restart. The Rust handler also
   * clears the in-memory `LlmConfig.api_key`, so the running agent path stops
   * using the deleted key without a restart.
   *
   * Best-effort: the caller must not depend on this succeeding (the smart
   * layer may be temporarily unavailable). The durable source of truth is
   * `auth.json` (removed by the auth service); the orphan-sweep during the
   * next Rust startup is the backstop that still removes a missed entry.
   */
  keyringDelete(provider: string): Promise<{ ok: boolean }> {
    return this.client.post("/agent/keyring/delete", { provider })
  }

  /**
   * Full structured context pipeline (Rust-side).
   *
   * Replaces the TS-side assembler→graph→renderer chain with a single
   * /context/structured call that runs entirely in the Rust smart-layer
   * process (zero HTTP round-trips for memory/KG data).
   *
   * Returns { rendered: string } — the 5-layer Chinese Markdown context.
   */
  postStructuredContext(options: {
    sessionID: string
    userMessage?: string
    tokenBudget?: number
    projectPath: string
    phase?: string
    kgEnabled?: boolean
  }): Promise<{ rendered: string }> {
    return this.client.post("/context/structured", {
      session_id: options.sessionID,
      user_message: options.userMessage,
      token_budget: options.tokenBudget ?? 2000,
      project_path: options.projectPath,
      phase: options.phase ?? "execute",
      kg_enabled: options.kgEnabled ?? false,
    })
  }
}
