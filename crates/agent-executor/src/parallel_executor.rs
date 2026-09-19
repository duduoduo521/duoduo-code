//! Parallel multi-agent dispatch (G7).
//!
//! Dispatches a set of independent sub-tasks to multiple [`AgenticLoopExecutor`]
//! instances that run **concurrently**. Each sub-agent writes through the *shared*
//! blackboard coordinator (`FileLockManager` exclusive lock (single winner) + under-lock read + optimistic version check),
//! so concurrent writes to the same file are serialized safely — no corruption, no
//! double-write. This is exactly the G7 design intent: parallel dispatch + blackboard
//! gate + At-Least-Once delivery.
//!
//! # Zero-risk contract
//!
//! * The whole subsystem is inert unless the caller opts in (e.g. `LoopConfig.parallel_dispatch`).
//! * Each sub-agent gets a **unique `agent_id`** and a **child `CancellationToken`** cloned
//!   from the parent, so cancelling the parent loop cancels every parallel sub-agent at once
//!   (reusing the G11 cancel path).
//! * Sub-agents are built **without a session manager** (`with_session_manager` unset), so the
//!   `task` tool cannot spawn further nested sub-agents — recursion is bounded at depth 1.
//! * Failed sub-agents are retried up to `max_retries` (At-Least-Once best-effort). A sub-agent
//!   that still fails is reported as `Failed` and does **not** abort the others (fault isolation).
//! * The blackboard kernel is the *same* one the single-agent path uses, so there is no
//!   divergent write path to regress.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU32;
use std::time::Duration;

use serde_json;
use tokio_util::sync::CancellationToken;

use crate::agentic_loop::{AgenticLoopExecutor, LoopToolSet};
use crate::permission::PermissionRule;
use duo_types::InterfaceContract;

/// Shared token-usage counters propagated from the parent runLoop into every
/// parallel sub-agent. Because the counters are `Arc<AtomicU32>`, concurrent
/// sub-agents accumulate directly into the parent's live metrics with no extra
/// merge step (see [`ParallelContext::shared_token_usage`]).
pub struct SharedTokenUsage {
    pub tokens_used: Arc<AtomicU32>,
    pub input_tokens: Arc<AtomicU32>,
}

/// Shared resources every parallel sub-agent needs. Cloned per sub-task; cheap
/// because all members are `Arc`/cheap-to-clone handles.
#[derive(Clone)]
pub struct ParallelContext {
    pub executor: crate::executor::AgentExecutor,
    pub project_path: PathBuf,
    pub blackboard: Arc<blackboard_coordinator::BlackboardCoordinator>,
    pub security_policy: Option<Arc<security_design::SecurityPolicy>>,
    pub syntax_check: bool,
    pub reflect_on: Option<String>,
    pub context_builder: Option<Arc<context_builder::ContextBuilder>>,
    pub graph:
        Option<Arc<knowledge_graph_store::graph::KnowledgeGraphStore>>,
    pub code_search: Option<Arc<code_search::CodeSearch>>,
    pub max_rounds: Option<usize>,
    pub loop_timeout: Option<Duration>,
    /// Cumulative token budget per sub-agent (user-configurable LoopConfig
    /// `sub_agent_max_total_tokens`). `None` ⇒ the executor's compile-time
    /// default (100K).
    pub max_total_tokens: Option<u32>,
    /// Max file reads per sub-agent (LoopConfig `sub_agent_max_file_reads`).
    /// `None` ⇒ the executor's compile-time default (10).
    pub max_file_reads: Option<usize>,
    /// Cap on retries per sub-task (At-Least-Once). 0 = no retry.
    pub max_retries: u32,
    /// Max number of sub-agents that may run concurrently. Bounds the fan-out
    /// so a large decomposition cannot exhaust the LLM rate limit or memory.
    pub max_concurrent: usize,
    /// Per-round tool concurrency for each sub-agent. `None` ⇒ uses the
    /// executor's [`DEFAULT_TOOL_CONCURRENCY`]. Clamping to `[1, 16]` is
    /// enforced internally by `effective_tool_concurrency`, so no extra
    /// validation is needed here.
    pub tool_concurrency: Option<u32>,
    /// Permission ruleset propagated from the parent runLoop. When `Some`,
    /// `build_executor` enforces it on every sub-agent with `interactive=false`,
    /// so delete/sensitive operations are gated globally regardless of depth.
    pub permission_rules: Option<Vec<PermissionRule>>,
    /// When true, an `Ask` result is treated as `Allow` for the (non-interactive)
    /// sub-agents — honoring the user's "auto-accept permissions" switch (option
    /// B). Propagated from the parent runLoop's `auto_accept`.
    pub auto_accept: bool,
    /// When set, every sub-agent's `tokens_used`/`input_tokens` atomics ARE the
    /// parent's live-metrics atomics, so parallel sub-agent usage is reflected in
    /// the parent's `GET /agent/metrics` totals. `None` ⇒ each sub-agent keeps its
    /// own counters (previous behavior; usage not aggregated).
    pub shared_token_usage: Option<Arc<SharedTokenUsage>>,
    /// Parent runLoop session id, used for event attribution when emitting
    /// per-subtask start/finish events.
    pub session_id: String,
    /// Parent runLoop event bus. When set, each sub-task emits
    /// `ParallelSubtaskStarted`/`ParallelSubtaskFinished` so the SSE bridge can
    /// surface fan-out progress to the frontend. `None` ⇒ no events (tests).
    pub event_bus: Option<crate::event_bus::RunLoopEventBus>,
}

/// A single independent sub-task to dispatch in parallel.
pub struct SubTask {
    /// Stable identifier used for result correlation and the sub-agent `agent_id`.
    pub id: String,
    pub system_prompt: String,
    pub task_prompt: String,
    /// `Codegen` to allow writing (gated by the blackboard); `Explore` for read-only.
    pub tool_set: LoopToolSet,
    /// Files this sub-task is expected to create or modify. Used **only** for
    /// conflict grouping at dispatch: sub-tasks that share a file are serialized
    /// into one group while disjoint groups still run in parallel. Empty/unknown
    /// ⇒ treated as "no declared overlap" ⇒ stays fully parallel (never
    /// over-serializes). Best-effort; the blackboard lock (#1) remains the
    /// correctness backstop for any mis-prediction.
    pub files: Vec<String>,
    /// ③ Contract planner: target file the `interface_contract` is bound to.
    /// When set, the sub-agent's writes to this file are contract-checked
    /// (B5). `None` ⇒ no contract check.
    pub target_file: Option<String>,
    /// ③ Contract planner: interface contract for `target_file`. Mirrors
    /// `SubTaskRequest.interface_contract` (duo-smart-layer). `None` ⇒ no check.
    pub interface_contract: Option<InterfaceContract>,
    /// Optional least-privilege tool whitelist for this sub-task. Mirrors
    /// `SubTaskRequest.allowed_tools` (duo-smart-layer). `None` ⇒ no filtering
    /// (the `LoopToolSet` governs the tool set, existing behavior preserved).
    /// When `Some(list)`, only the named tools are exposed to the LLM. Plumbing
    /// only — consumed by `AgenticLoopExecutor::with_allowed_tools`.
    pub allowed_tools: Option<Vec<String>>,
}

/// Outcome of a single sub-task.
#[derive(Debug, Clone)]
pub struct SubTaskResult {
    pub id: String,
    /// Final assistant text (empty on failure).
    pub output: String,
    pub status: SubTaskStatus,
    /// [P-03] Failure reason, populated when `status == Failed` (retry exhaustion,
    /// cancellation, or join error). Surfaced by `aggregate_reports` so the main
    /// loop sees *why* a sub-task failed instead of a bare "see logs".
    pub error: Option<String>,
}

/// Terminal status of a sub-task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubTaskStatus {
    /// Completed successfully; `output` holds the report.
    Succeeded,
    /// Exhausted retries (or panicked). `output` is empty; see caller logs.
    Failed,
}

impl ParallelContext {
    /// Build a configured [`AgenticLoopExecutor`] for one sub-task.
    ///
    /// Deliberately *without* a session manager so the `task` tool cannot spawn
    /// nested sub-agents (recursion bounded at depth 1). Blackboard + unique
    /// agent_id + child cancel token are always attached.
    fn build_executor(
        &self,
        agent_id: &str,
        cancel: CancellationToken,
        target_file: Option<String>,
        interface_contract: Option<InterfaceContract>,
        allowed_tools: Option<Vec<String>>,
    ) -> AgenticLoopExecutor {
        let gear_load = crate::intel_gear::load_gears_from_env();
        let mut ex = AgenticLoopExecutor::new(self.executor.clone(), &self.project_path)
            .with_cancel_token(cancel)
            .with_agent_id(agent_id.to_string())
            .with_blackboard(Arc::clone(&self.blackboard))
            .with_syntax_check(self.syntax_check)
            // ③ Contract planner (B5): bind the sub-task's interface contract to
            // its target file so writes to that file are contract-checked.
            .with_target_file(target_file)
            .with_interface_contract(interface_contract)
            // Optional least-privilege tool whitelist (plumbing). `None` ⇒ no
            // filtering (existing behavior preserved).
            .with_allowed_tools(allowed_tools)
            .with_gears(gear_load.payloads)
            .with_skill_catalog(gear_load.skill_catalog);
        // Propagate the parent's live token counters into the sub-agent so its usage
        // accumulates directly into the parent's metrics (no merge step needed).
        if let Some(ref shared) = self.shared_token_usage {
            ex = ex.with_shared_token_usage(
                shared.tokens_used.clone(),
                shared.input_tokens.clone(),
            );
        }
        if let Some(ref policy) = self.security_policy {
            ex = ex.with_security_policy(policy.clone());
        }
        if let Some(ref r) = self.reflect_on {
            ex = ex.with_reflect_on(r.clone());
        }
        if let Some(ref cb) = self.context_builder {
            ex = ex.with_context_builder(cb.clone());
        }
        if let Some(ref g) = self.graph {
            ex = ex.with_graph(g.clone());
        }
        if let Some(ref cs) = self.code_search {
            ex = ex.with_code_search(cs.clone());
        }
        if let Some(mr) = self.max_rounds {
            ex = ex.with_max_rounds(mr);
        }
        if let Some(lt) = self.loop_timeout {
            ex = ex.with_loop_timeout(lt);
        }
        if let Some(mt) = self.max_total_tokens {
            ex = ex.with_max_total_tokens(mt);
        }
        if let Some(mf) = self.max_file_reads {
            ex = ex.with_max_file_reads(mf);
        }
        // Reuse the exact same validated path as the single-agent loop. Clamp
        // ∈ [1, 16] is applied internally by `effective_tool_concurrency`, so a
        // malformed value here cannot widen the per-sub-agent blast radius.
        if let Some(tc) = self.tool_concurrency {
            ex = ex.with_tool_concurrency(tc);
        }
        // Reuse the exact same validated path as the single-agent loop. Sub-agents
        // are non-interactive, so `Ask` permission results are denied (no UI to
        // prompt mid-loop) — making sensitive-op gating global. Clamp is applied
        // internally by `effective_tool_concurrency`, so no extra clamp needed.
        if let Some(rules) = &self.permission_rules {
            ex = ex
                .with_permission_rules(rules.clone())
                .with_interactive(false)
                .with_auto_accept(self.auto_accept);
        }
        // Register the sub-agent's file scope so its blackboard writes are not
        // rejected with `OutOfScope`. The main agent holds `["*"]`, which makes
        // `has_any_registered_scope()` true and would otherwise reject every
        // unscoped sub-agent write. Sub-agents inherit the main agent's scope.
        // Best-effort: a failure only logs, it must not block dispatch.
        if let Err(e) = self
            .blackboard
            .register_agent_scope(agent_id, &["*".to_string()])
        {
            tracing::warn!(
                agent = agent_id,
                error = %e,
                "Failed to register parallel sub-agent scope (best-effort); writes may be rejected"
            );
        }
        ex
    }
}

/// Dispatch all sub-tasks concurrently and wait for every one to finish.
///
/// * Concurrency is bounded only by Tokio's runtime (one `tokio::spawn` per task).
/// * Parent cancellation propagates to every child via child tokens.
/// * Each task is retried up to `ctx.max_retries` times on error (At-Least-Once).
///
/// Returns one [`SubTaskResult`] per input task, in submission order.
pub async fn dispatch(ctx: Arc<ParallelContext>, tasks: Vec<SubTask>) -> Vec<SubTaskResult> {
    if tasks.is_empty() {
        return Vec::new();
    }

    // Thin wrapper for callers that only have the context (e.g. tests). The
    // parent cancel token is supplied per-call via `dispatch_with_cancel`; here
    // we use a standalone token so the fan-out is cancellable in isolation.
    dispatch_with_cancel(ctx, tasks, CancellationToken::new()).await
}

/// Same as [`dispatch`] but binds the parallel fan-out to an explicit parent
/// cancellation token (the run_loop's token), so an SSE disconnect (G11) cancels
/// all parallel sub-agents too.
pub async fn dispatch_with_cancel(
    ctx: Arc<ParallelContext>,
    tasks: Vec<SubTask>,
    parent_cancel: CancellationToken,
) -> Vec<SubTaskResult> {
    if tasks.is_empty() {
        return Vec::new();
    }

    // 2-7a: snapshot the submission order so the collected results can be
    // reordered back to it (completion order differs once groups run parallel).
    let submission_order: Vec<String> = tasks.iter().map(|t| t.id.clone()).collect();

    // Bound concurrency so a large fan-out cannot exhaust the LLM rate limit
    // or memory. `max(1)` guards a zero config value that would otherwise
    // dead-lock every task permanently.
    // Group by declared file overlap: sub-tasks that share a file are serialized
    // into one group; disjoint groups still run concurrently. Sub-tasks with no
    // declared `files` each form their own group ⇒ fully parallel (never
    // over-serialized). This cuts retry/lock contention (saves tokens) at the
    // root without sacrificing parallelism.
    let groups = group_by_conflict(tasks);

    // Bound concurrency so a large fan-out cannot exhaust the LLM rate limit
    // or memory. `max(1)` guards a zero config value that would otherwise
    // dead-lock every task permanently.
    let sem = Arc::new(tokio::sync::Semaphore::new(ctx.max_concurrent.max(1)));

    // 2-4: every finished sub-task is streamed to the collector through this
    // channel the moment it settles, so a panic later in a group task can no
    // longer discard its already-completed siblings (the old design returned
    // the group's results as one value, which a panic erased entirely).
    let (result_tx, mut result_rx) = tokio::sync::mpsc::unbounded_channel::<SubTaskResult>();

    let mut handles = Vec::with_capacity(groups.len());
    for group in groups {
        let ctx = Arc::clone(&ctx);
        let parent_cancel = parent_cancel.clone();
        let sem = Arc::clone(&sem);
        let result_tx = result_tx.clone();
        let handle = tokio::spawn(async move {
            // One permit gates the whole group: serial inside, parallel across
            // groups. Released when the group's future is dropped.
            let _permit = match sem.clone().acquire_owned().await {
                Ok(p) => p,
                Err(_) => {
                    for t in group {
                        let _ = result_tx.send(SubTaskResult {
                            id: t.id,
                            output: String::new(),
                            status: SubTaskStatus::Failed,
                            error: Some("semaphore acquire failed".into()),
                        });
                    }
                    return;
                }
            };
            for task in group {
                let id = task.id.clone();
                let system_prompt = task.system_prompt.clone();
                let task_prompt = task.task_prompt.clone();
                let tool_set = task.tool_set;
                let max_retries = ctx.max_retries;
                let child_cancel = parent_cancel.child_token();
                let mut attempts = 0u32;
                let mode = match tool_set {
                    LoopToolSet::Explore => "explore",
                    LoopToolSet::Codegen => "codegen",
                };
                loop {
                    if child_cancel.is_cancelled() {
                        if let Some(bus) = &ctx.event_bus {
                            bus.emit(crate::event_bus::LoopStreamEvent::ParallelSubtaskFinished {
                                session_id: ctx.session_id.clone(),
                                subtask_id: id.clone(),
                                ok: false,
                                error: Some("cancelled".into()),
                            });
                        }
                        let _ = result_tx.send(SubTaskResult {
                            id,
                            output: String::new(),
                            status: SubTaskStatus::Failed,
                            error: Some("cancelled".into()),
                        });
                        break;
                    }
                    if attempts == 0 && let Some(bus) = &ctx.event_bus {
                        // Best-effort progress event; the task text is truncated to
                        // keep the SSE payload small.
                        let mut task_preview = task_prompt.clone();
                        task_preview.truncate(200);
                        bus.emit(crate::event_bus::LoopStreamEvent::ParallelSubtaskStarted {
                            session_id: ctx.session_id.clone(),
                            subtask_id: id.clone(),
                            task: task_preview,
                            mode: mode.to_string(),
                        });
                    }
                    let agent_id = format!("parallel-{}", id);
                    let executor = ctx.build_executor(
                        &agent_id,
                        child_cancel.clone(),
                        task.target_file.clone(),
                        task.interface_contract.clone(),
                        task.allowed_tools.clone(),
                    );
                    match executor
                        .execute_subagent_loop(&system_prompt, &task_prompt, tool_set)
                        .await
                    {
                        Ok(output) => {
                            if let Some(bus) = &ctx.event_bus {
                                bus.emit(crate::event_bus::LoopStreamEvent::ParallelSubtaskFinished {
                                    session_id: ctx.session_id.clone(),
                                    subtask_id: id.clone(),
                                    ok: true,
                                    error: None,
                                });
                            }
                            let _ = result_tx.send(SubTaskResult {
                                id,
                                output,
                                status: SubTaskStatus::Succeeded,
                                error: None,
                            });
                            break;
                        }
                        Err(e) => {
                            attempts += 1;
                            // A retry re-runs the WHOLE sub-agent loop, tools
                            // included. If the failed attempt already executed
                            // any tool, replaying it would double-apply file
                            // edits and re-run shell commands (the typical
                            // case is a mid-write `loop_timeout`). So a retry
                            // is only ever safe for an attempt that did
                            // nothing but talk to the LLM.
                            let side_effects = executor.tools_executed();
                            if attempts > max_retries || side_effects > 0 {
                                tracing::warn!(
                                    sub_task = %id,
                                    agent = %agent_id,
                                    attempts,
                                    tools_executed = side_effects,
                                    error = %e,
                                    "Parallel sub-task failed (no retry: attempt had side effects or retry budget spent)"
                                );
                                if let Some(bus) = &ctx.event_bus {
                                    bus.emit(crate::event_bus::LoopStreamEvent::ParallelSubtaskFinished {
                                        session_id: ctx.session_id.clone(),
                                        subtask_id: id.clone(),
                                        ok: false,
                                        error: Some(format!("{}", e)),
                                    });
                                }
                                let _ = result_tx.send(SubTaskResult {
                                    id,
                                    output: String::new(),
                                    status: SubTaskStatus::Failed,
                                    error: Some(format!("{}", e)),
                                });
                                break;
                            }
                            tracing::info!(
                                sub_task = %id,
                                agent = %agent_id,
                                attempt = attempts,
                                error = %e,
                                "Parallel sub-task retrying (previous attempt had no side effects)"
                            );
                        }
                    }
                }
            }
        });
        handles.push(handle);
    }

    // Wait for every group task; a panicked/aborted group adds ONE placeholder
    // (its completed siblings were already streamed through the channel).
    let mut join_placeholders = Vec::new();
    for h in handles {
        if let Err(e) = h.await {
            tracing::warn!(error = %e, "Parallel sub-task join error (treated as Failed)");
            join_placeholders.push(SubTaskResult {
                id: String::new(),
                output: String::new(),
                status: SubTaskStatus::Failed,
                error: Some(format!("join error: {}", e)),
            });
        }
    }
    let mut streamed = Vec::new();
    while let Ok(r) = result_rx.try_recv() {
        streamed.push(r);
    }

    // 2-7a: reorder to submission order (the "in submission order" contract).
    // A result whose id is unknown keeps the tail; join placeholders stay at
    // the end exactly as before.
    let mut results = Vec::with_capacity(streamed.len() + join_placeholders.len());
    let mut unmatched = Vec::new();
    for id in &submission_order {
        if let Some(pos) = streamed.iter().position(|r| &r.id == id) {
            results.push(streamed.remove(pos));
        }
    }
    unmatched.append(&mut streamed);
    results.append(&mut unmatched);
    results.append(&mut join_placeholders);
    results
}

/// P-01: derive conflict keys for a declared file path.
///
/// Returns **only the single normalized path itself** — no directory-ancestor
/// keys. Conflicts are decided by exact file identity, not by directory
/// co-location: two sub-tasks editing *different* files under the same
/// directory (`src/a.ts` vs `src/b.ts`) genuinely do not conflict and must run
/// in parallel, not be over-serialized into one group. Any true intra-file
/// write race is still caught by the blackboard exclusive lock (#1), which
/// remains the correctness backstop.
///
/// Normalization collapses the path variants an LLM may emit for the *same*
/// file so they are detected as one conflict key:
/// - separator unification: `\` → `/`
/// - drop empty components (`//`, leading `/`) and `.` segments (`./src/x`, `a/./b`)
/// - case-fold (filesystems the agent targets are case-insensitive)
/// - trim trailing slash
///
/// Note: an absolute path (`/repo/src/a.ts`) and a relative one (`src/a.ts`)
/// pointing at the same file are NOT unified here — that requires the project
/// root, which `conflict_keys` does not receive. Such mixed naming is an
/// edge case and is covered by the blackboard lock.
fn conflict_keys(file: &str) -> Vec<String> {
    let norm = normalize_path(file);
    if norm.is_empty() {
        Vec::new()
    } else {
        vec![norm]
    }
}

/// Normalize a file path into a canonical conflict key. See [`conflict_keys`].
fn normalize_path(file: &str) -> String {
    file.replace('\\', "/")
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect::<Vec<_>>()
        .join("/")
        .to_lowercase()
}

/// Partition sub-tasks into conflict groups by declared file overlap.
///
/// Two sub-tasks belong to the same group iff they declare the *same* file
/// (after path normalization). Groups are disjoint, so within a group writes
/// must be serialized, but different groups never share a file and therefore
/// run in parallel.
///
/// Sub-tasks with no declared `files` form singleton groups (each fully
/// parallel) — we never over-serialize on missing information. The blackboard
/// lock (#1) stays the correctness backstop for any mis-prediction.
fn group_by_conflict(tasks: Vec<SubTask>) -> Vec<Vec<SubTask>> {
    let n = tasks.len();
    if n <= 1 {
        return if n == 0 { Vec::new() } else { vec![tasks] };
    }
    // Union-Find over task indices; an edge connects two tasks that share a file.
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut [usize], mut x: usize) -> usize {
        while p[x] != x {
            p[x] = p[p[x]];
            x = p[x];
        }
        x
    }
    use std::collections::HashMap;
    // Map each declared (normalized) file to the representative task index
    // that first claimed it. Tasks naming the same file are unioned.
    let mut file_owner: HashMap<String, usize> = HashMap::new();
    for (i, t) in tasks.iter().enumerate() {
        for f in &t.files {
            for key in conflict_keys(f) {
                let owner = *file_owner.entry(key).or_insert(i);
                let ro = find(&mut parent, owner);
                let ri = find(&mut parent, i);
                if ro != ri {
                    parent[ro] = ri;
                }
            }
        }
    }
    // Bucket tasks by their final representative, preserving input order within a bucket.
    let mut buckets: HashMap<usize, Vec<SubTask>> = HashMap::new();
    let mut order: Vec<usize> = Vec::new();
    for (i, t) in tasks.into_iter().enumerate() {
        let r = find(&mut parent, i);
        if !buckets.contains_key(&r) {
            order.push(r);
        }
        buckets.entry(r).or_default().push(t);
    }
    order.into_iter().map(|r| buckets.remove(&r).expect("invariant: order holds only bucket representatives, each inserted into buckets above")).collect()
}

/// Aggregate sub-task reports into a single context block for the main loop's
/// convergence/Reflect phase. Failed tasks are noted but never abort the run.
pub fn aggregate_reports(results: &[SubTaskResult]) -> String {
    let mut out = String::new();
    let mut succeeded = 0usize;
    let mut failed = 0usize;
    for r in results {
        match r.status {
            SubTaskStatus::Succeeded => {
                succeeded += 1;
                out.push_str(&format!(
                    "\n### Sub-task `{}` (completed)\n{}\n",
                    r.id, r.output
                ));
            }
            SubTaskStatus::Failed => {
                failed += 1;
                // [P-03] Surface the captured failure reason instead of a bare
                // "see logs" so the main loop can react (retry / route around).
                let reason = r
                    .error
                    .as_deref()
                    .filter(|e| !e.is_empty())
                    .unwrap_or("see logs");
                out.push_str(&format!(
                    "\n### Sub-task `{}` (FAILED — {})\n",
                    r.id, reason
                ));
            }
        }
    }
    out.push_str(&format!(
        "\n---\nParallel dispatch summary: {} succeeded, {} failed.\n",
        succeeded, failed
    ));
    out
}

/// Decompose a high-level task into a set of independent sub-tasks via an LLM
/// planner, then dispatch them concurrently.
///
/// # Zero-risk contract
///
/// Returns an **empty** `Vec` on any failure (no LLM configured, planner error,
/// malformed JSON, empty decomposition). The caller treats an empty result as
/// "no parallel work" and transparently falls back to the serial loop, so the
/// existing path is never altered when this feature is off, and best-effort when
/// it is on. The planner runs **read-only** (`LoopToolSet::Explore`), so it can
/// never mutate coordination state or write files.
pub async fn decompose_and_dispatch(
    ctx: &ParallelContext,
    task_prompt: &str,
    parent_cancel: CancellationToken,
) -> Vec<SubTaskResult> {
    let subtasks = decompose_task(ctx, task_prompt).await;
    if subtasks.is_empty() {
        return Vec::new();
    }
    dispatch_with_cancel(Arc::new(ctx.clone()), subtasks, parent_cancel).await
}

/// Ask the LLM to break a high-level task into independent sub-tasks.
///
/// Returns an empty `Vec` on any failure so the caller can fall back to the
/// serial loop. The planner is read-only and produces a JSON array of
/// `{ "id": str, "task": str }` objects (or `[]` when indivisible).
pub async fn decompose_task(ctx: &ParallelContext, task_prompt: &str) -> Vec<SubTask> {
    let planner = ctx.build_executor("planner", CancellationToken::new(), None, None, None);
        let system = "You are a task decomposition planner. Given a high-level \
        engineering task, break it into a set of INDEPENDENT sub-tasks that can \
        be executed in parallel by separate agents without shared mutable state. \
        Avoid overlapping work. Respond with ONLY a JSON array, each element an \
        object with: \"id\" (short ascii string), \"task\" (self-contained \
        instruction string), and \"files\" (array of relative repo paths this \
        sub-task will create or modify — used to serialize only genuinely \
        overlapping work; use [] when the set is unknown). If the task is \
        indivisible, return an empty array [].";
    match planner
        .execute_subagent_loop(system, task_prompt, LoopToolSet::Explore)
        .await
    {
        Ok(text) => parse_subtasks(&text),
        Err(e) => {
            tracing::warn!(error = %e, "G7 task decomposition failed; falling back to serial loop");
            Vec::new()
        }
    }
}

/// Best-effort extraction of a JSON sub-task array from free-form planner output.
/// Tolerates prose surrounding the JSON by locating the first `[` … last `]`.
fn parse_subtasks(text: &str) -> Vec<SubTask> {
    let start = match text.find('[') {
        Some(i) => i,
        None => {
            tracing::warn!("G7 planner output has no JSON array; falling back to serial loop");
            return Vec::new();
        }
    };
    let end = match text.rfind(']') {
        Some(i) => i + 1,
        None => {
            tracing::warn!("G7 planner output has no JSON array terminator; falling back to serial loop");
            return Vec::new();
        }
    };
    let json = &text[start..end];
    let Ok(arr) = serde_json::from_str::<serde_json::Value>(json) else {
        tracing::warn!("G7 planner output is not valid JSON; falling back to serial loop");
        return Vec::new();
    };
    let Some(arr) = arr.as_array() else {
        tracing::warn!("G7 planner output is not a JSON array; falling back to serial loop");
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let task = item
            .get("task")
            .and_then(|v| v.as_str())
            .or_else(|| item.get("task_prompt").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();
        if id.is_empty() || task.is_empty() {
            continue;
        }
        // Best-effort: a sub-task may declare the files it will touch so the
        // dispatcher can serialize only genuinely overlapping work. Missing/empty
        // ⇒ fully parallel (no over-serialization).
        let files = item
            .get("files")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();
        out.push(SubTask {
            id,
            system_prompt: String::new(),
            task_prompt: task,
            tool_set: LoopToolSet::Codegen,
            files,
            // ③ Contract planner (B5): the Rust planner produces no structured
            // contract — TS-side decomposition (decompose.ts) is the source of
            // interface contracts. So the planner sub-task carries none.
            target_file: None,
            interface_contract: None,
            allowed_tools: None,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_tasks_returns_empty() {
        let ctx = Arc::new(ParallelContext {
            executor: dummy_executor(),
            project_path: PathBuf::from("."),
            blackboard: dummy_blackboard(),
            security_policy: None,
            syntax_check: true,
            reflect_on: None,
            context_builder: None,
            graph: None,
            code_search: None,
            max_rounds: None,
            loop_timeout: Some(Duration::from_secs(1)),
            max_total_tokens: None,
            max_file_reads: None,
            max_retries: 0,
            max_concurrent: 3,
            tool_concurrency: None,
            permission_rules: None,
            auto_accept: false,
            shared_token_usage: None,
            session_id: "test-session".into(),
            event_bus: None,
        });
        let results = dispatch(Arc::clone(&ctx), vec![]).await;
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn aggregate_marks_failures() {
        let results = vec![
            SubTaskResult {
                id: "a".into(),
                output: "did x".into(),
                status: SubTaskStatus::Succeeded,
                error: None,
            },
            SubTaskResult {
                id: "b".into(),
                output: String::new(),
                status: SubTaskStatus::Failed,
                error: None,
            },
        ];
        let agg = aggregate_reports(&results);
        assert!(agg.contains("1 succeeded, 1 failed"));
        assert!(agg.contains("did x"));
    }

    // ── Test helpers (no real LLM / blackboard needed for structural tests) ──

    fn dummy_executor() -> crate::executor::AgentExecutor {
        // AgentExecutor::new() builds with no LLM configured (orchestration
        // placeholder mode). These structural tests never issue a real LLM call.
        crate::executor::AgentExecutor::new().expect("build placeholder AgentExecutor")
    }

    fn dummy_blackboard() -> Arc<blackboard_coordinator::BlackboardCoordinator> {
        // Build a transient in-memory blackboard; tests only need it to exist.
        let dir = std::env::temp_dir().join(format!(
            "duoduo-par-ctx-{}",
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::create_dir_all(&dir);
        Arc::new(
            blackboard_coordinator::BlackboardCoordinator::new(
                &dir,
                &format!("test-{}", uuid::Uuid::new_v4()),
                blackboard_coordinator::coordinator::BlackboardConfig::default(),
            )
            .expect("create test blackboard"),
        )
    }

    // ── ③ B5: build_executor must forward the sub-task's contract (target_file
    //    + interface_contract) into the per-sub-agent AgenticLoopExecutor so its
    //    writes are contract-checked. A refactor that drops the
    //    `.with_target_file`/`.with_interface_contract` calls would silently
    //    disable B5 for every parallel sub-agent — this guards against that. ──

    fn ctx_with_dummy() -> Arc<ParallelContext> {
        Arc::new(ParallelContext {
            executor: dummy_executor(),
            project_path: PathBuf::from("."),
            blackboard: dummy_blackboard(),
            security_policy: None,
            syntax_check: true,
            reflect_on: None,
            context_builder: None,
            graph: None,
            code_search: None,
            max_rounds: None,
            loop_timeout: Some(Duration::from_secs(1)),
            max_total_tokens: None,
            max_file_reads: None,
            max_retries: 0,
            max_concurrent: 3,
            tool_concurrency: None,
            permission_rules: None,
            auto_accept: false,
            shared_token_usage: None,
            session_id: "test-session".into(),
            event_bus: None,
        })
    }

    #[test]
    fn build_executor_forwards_contract_to_sub_agent() {
        let ctx = ctx_with_dummy();
        let contract = duo_types::InterfaceContract {
            extends: None,
            properties: std::collections::HashMap::new(),
            methods: std::collections::HashMap::new(),
        };
        let ex = ctx.build_executor(
            "parallel-x",
            CancellationToken::new(),
            Some("src/foo.ts".to_string()),
            Some(contract),
            None,
        );
        assert_eq!(ex.contract_target_file(), Some("src/foo.ts"));
        assert!(ex.interface_contract_ref().is_some());

        // No-contract path ⇒ both stay None (R6.1, zero regression).
        let ex2 = ctx.build_executor("parallel-y", CancellationToken::new(), None, None, None);
        assert_eq!(ex2.contract_target_file(), None);
        assert!(ex2.interface_contract_ref().is_none());
    }

    #[test]
    fn build_executor_forwards_allowed_tools_to_sub_agent() {
        let ctx = ctx_with_dummy();
        // Whitelist path ⇒ executor carries the narrowed tool set.
        let ex = ctx.build_executor(
            "parallel-x",
            CancellationToken::new(),
            None,
            None,
            Some(vec!["read_file".to_string(), "grep".to_string()]),
        );
        assert_eq!(
            ex.allowed_tools_ref(),
            Some(&vec!["read_file".to_string(), "grep".to_string()])
        );

        // No-whitelist path ⇒ stays None (existing behavior preserved, zero regression).
        let ex2 = ctx.build_executor("parallel-y", CancellationToken::new(), None, None, None);
        assert_eq!(ex2.allowed_tools_ref(), None);
    }

    fn task_with_files(id: &str, files: &[&str]) -> SubTask {
        SubTask {
            id: id.to_string(),
            system_prompt: String::new(),
            task_prompt: String::new(),
            tool_set: LoopToolSet::Codegen,
            files: files.iter().map(|f| f.to_string()).collect(),
            target_file: None,
            interface_contract: None,
            allowed_tools: None,
        }
    }

    /// Ids per group, each group sorted, groups sorted — order-independent view.
    fn grouped_ids(tasks: Vec<SubTask>) -> Vec<Vec<String>> {
        let mut groups: Vec<Vec<String>> = group_by_conflict(tasks)
            .into_iter()
            .map(|g| {
                let mut ids: Vec<String> = g.into_iter().map(|t| t.id).collect();
                ids.sort();
                ids
            })
            .collect();
        groups.sort();
        groups
    }

    #[test]
    fn tasks_sharing_a_file_are_serialized_into_one_group() {
        // Disjoint top-level roots, otherwise the shared directory ancestor
        // would merge the groups (see `directory_ancestors_also_conflict`).
        let groups = grouped_ids(vec![
            task_with_files("a", &["x/f.rs"]),
            task_with_files("b", &["x/f.rs"]),
            task_with_files("c", &["y/g.rs"]),
        ]);
        assert_eq!(
            groups,
            vec![vec!["a".to_string(), "b".to_string()], vec!["c".to_string()]],
            "tasks touching the same file must share a group so they run serially"
        );
    }

    #[test]
    fn shared_files_are_grouped_transitively() {
        // a—b via x/f, b—c via y/g ⇒ all three must end up in one group.
        let groups = grouped_ids(vec![
            task_with_files("a", &["x/f.rs"]),
            task_with_files("b", &["x/f.rs", "y/g.rs"]),
            task_with_files("c", &["y/g.rs"]),
        ]);
        assert_eq!(groups, vec![vec!["a".to_string(), "b".to_string(), "c".to_string()]]);
    }

    /// P-01 (fixed): directory-level keys were removed. A task naming a
    /// directory (`src/`) and one naming a file beneath it (`src/x.rs`) no
    /// longer over-serialize — they run in parallel. Any real intra-file race
    /// is caught by the blackboard exclusive lock (#1).
    #[test]
    fn directory_key_no_longer_over_serializes() {
        let groups = grouped_ids(vec![
            task_with_files("a", &["src/x.rs"]),
            task_with_files("b", &["src/"]),
            task_with_files("c", &["other/z.rs"]),
        ]);
        assert_eq!(
            groups,
            vec![
                vec!["a".to_string()],
                vec!["b".to_string()],
                vec!["c".to_string()]
            ],
            "directory-level keys must not force serialization; blackboard lock is the backstop"
        );
    }

    /// P-01 (fixed): two sub-tasks editing *different* files under the same
    /// directory must NOT be over-serialized — they belong to separate groups
    /// and run in parallel. The previous ancestor-key implementation wrongly
    /// merged every task under a shared directory.
    #[test]
    fn different_files_same_directory_run_parallel() {
        let groups = grouped_ids(vec![
            task_with_files("a", &["src/a.ts"]),
            task_with_files("b", &["src/b.ts"]),
        ]);
        assert_eq!(
            groups,
            vec![vec!["a".to_string()], vec!["b".to_string()]],
            "distinct files under one directory must run in parallel"
        );
    }

    /// P-01 (fixed): path variants an LLM may emit for the *same* file must
    /// normalize to one conflict key and be serialized.
    #[test]
    fn path_variants_for_same_file_conflict() {
        let cases: &[(&[&str], &[&str])] = &[
            // leading ./ prefix
            (&["./src/a.ts"], &["src/a.ts"]),
            // windows separator
            (&["src\\a.ts"], &["src/a.ts"]),
            // case fold
            (&["src/A.ts"], &["src/a.ts"]),
            // doubled separators / empty components
            (&["src//a.ts"], &["src/a.ts"]),
        ];
        for (left, right) in cases {
            let groups = grouped_ids(vec![
                task_with_files("a", left),
                task_with_files("b", right),
            ]);
            assert_eq!(
                groups,
                vec![vec!["a".to_string(), "b".to_string()]],
                "variants {:?} and {:?} must be treated as the same file",
                left,
                right
            );
        }
    }

    #[test]
    fn tasks_without_declared_files_stay_parallel() {
        let groups = grouped_ids(vec![
            task_with_files("a", &[]),
            task_with_files("b", &[]),
        ]);
        assert_eq!(
            groups,
            vec![vec!["a".to_string()], vec!["b".to_string()]],
            "missing file information must never over-serialize"
        );
    }
}
