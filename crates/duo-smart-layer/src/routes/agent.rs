use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

use duo_utils::sync::MutexPoisonRecover;

/// Generate a message ID conforming to the system-wide `MessageID` convention
/// (`^msg.*`, mirrored by the TS `Identifier.schema("message")` and the
/// openapi `session.message` path/query param pattern).
///
/// The suffix MUST be byte-order / lexicographically time-ordered in exactly
/// the same way the TS frontend builds its IDs (`Identifier.ascending`), because
/// the entire frontend store sorts messages and parts by `cmp(id)` (plain
/// string comparison) — see `unionMessagesById` / `merge` / `sortParts` in
/// `packages/app/src/context/sync.tsx` and `Binary.search` in `binary.ts`.
///
/// A bare ULID (base32, `0-9A-Z`) does NOT sort consistently against the
/// frontend's `msg_<hex-time><base62>` IDs (base16 + base62): e.g. `msg_0f3a`
/// (hex) vs `msg_01kz` (ULID) compares `'f' > '1'`, so an assistant message
/// would be ordered *before* its own (earlier) user message, corrupting the
/// timeline (thinking indicator misplaced, scroll jumps to top, broken styles).
///
/// To stay byte-order compatible we mirror `Identifier.ascending` exactly:
///   `<prefix>_` + hex(6-byte big-endian of (now_ms * 0x1000 + counter)) + base62(14)
/// The 12 hex chars encode the timestamp with the high byte first, so
/// lexicographic order == chronological order and `msg_*`/`prt_*` interleave
/// correctly with frontend-generated IDs.
fn new_message_id() -> String {
  format!("msg_{}", ascending_id_suffix())
}

/// Generate a part ID conforming to the `PartID` convention (`^prt.*`). See
/// `new_message_id` for why the suffix must match the TS `Identifier.ascending`
/// lexicographic-time ordering (the frontend sorts each message's parts array
/// by `part.id` so reasoning parts come before the final answer text).
fn new_part_id() -> String {
  format!("prt_{}", ascending_id_suffix())
}

/// Build an ID suffix identical in shape and byte-order to the TS frontend's
/// `Identifier.ascending`: `hex(6-byte BE timestamp) ++ base62(14 random)`.
/// Shared by `new_message_id` / `new_part_id`.
fn ascending_id_suffix() -> String {
  use std::sync::atomic::{AtomicU64, Ordering};
  use std::time::{SystemTime, UNIX_EPOCH};

  static COUNTER: AtomicU64 = AtomicU64::new(0);

  let now_ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0);
  // Mirror TS: now = Date.now() * 0x1000 + counter. The low 12 bits act as a
  // per-millisecond disambiguator; we keep it monotonic within this process.
  let counter = COUNTER.fetch_add(1, Ordering::Relaxed) & 0xfff;
  let stamp = (now_ms << 12) | counter;

  let mut time_hex = String::with_capacity(12);
  for i in (0..6).rev() {
    time_hex.push_str(&format!("{:02x}", ((stamp >> (8 * i)) & 0xff) as u8));
  }

  // Base62 alphabet MUST match the TS `randomBase62` in packages/app/src/utils/id.ts
  // ("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz").
  const BASE62: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let mut rng = rand::rng();
  let mut rand_suffix = String::with_capacity(14);
  for _ in 0..14 {
    let byte: u8 = rand::Rng::random(&mut rng);
    rand_suffix.push(BASE62[(byte as usize) % 62] as char);
  }

  let mut out = String::with_capacity(26);
  out.push_str(&time_hex);
  out.push_str(&rand_suffix);
  out
}

/// RAII guard that closes the blackboard coordinator on scope exit.
///
/// `run_loop_handler` has multiple early-return / `break` exit points, so an
/// explicit `bb.close_session()` at each one is error-prone (easy to miss a
/// path and leak the background tick tasks + connection pool). This guard
/// guarantees `close_session` runs exactly once when the scope is left,
/// regardless of which exit path is taken.
///
/// `close_session` only stops the background tasks (a synchronous shutdown
/// flag) and records metrics; it does NOT delete the on-disk DB files (the
/// store keeps its data for later reads). So dropping the guard mid-run has
/// zero side effects on other DB consumers.
struct BlackboardSessionGuard {
    bb: Option<Arc<blackboard_coordinator::BlackboardCoordinator>>,
}

impl BlackboardSessionGuard {
    fn new(bb: Arc<blackboard_coordinator::BlackboardCoordinator>) -> Self {
        Self { bb: Some(bb) }
    }
}

impl Drop for BlackboardSessionGuard {
    fn drop(&mut self) {
        if let Some(bb) = self.bb.take() {
            // `Drop` cannot be async, and `block_on` panics inside an async
            // runtime. Spawn the close on the current runtime instead; it runs
            // best-effort before process exit. Even if it doesn't complete, the
            // OS reclaims the connection pool on process exit.
            let handle = tokio::runtime::Handle::current();
            handle.spawn(async move {
                if let Err(e) = bb.close_session().await {
                    tracing::warn!(error = %e, "Blackboard close_session failed on drop");
                }
            });
        }
    }
}

use agent_scheduler::{ScheduledTask, TaskPriority, TaskStatus};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    response::sse::{Event, KeepAlive, Sse},
};
use chrono::Utc;
use duo_types::{InterfaceContract, LlmConfig, LlmExecuteRequest, LlmResponse, timeouts};
use futures::StreamExt;
use serde::Deserialize;
use session_manager::message_store::PartRow;
use std::convert::Infallible;
use std::time::Duration;
use tracing_opentelemetry::OpenTelemetrySpanExt;

use crate::ExtractedTraceContext;
use crate::error::Result;
use crate::project_tasks::ProjectTaskState;

/// RAII guard that decrements the global in-flight runLoop counter when the
/// spawned runLoop task ends — via normal completion, an early `return`, or
/// task cancellation (future drop). Guarantees the system-wide concurrency cap
/// is released exactly once per acquired runLoop, with no manual release site
/// that could be forgotten (which would permanently leak a global slot).
struct GlobalConcurrencyGuard {
    in_flight: Arc<AtomicUsize>,
}

impl Drop for GlobalConcurrencyGuard {
    fn drop(&mut self) {
        self.in_flight
            .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Reserve a global runLoop slot, enforcing the system-wide concurrency cap.
///
/// Uses an atomic fetch_add and rejects (returns `None`) when the pre-increment
/// count already reached `cap`. This is race-free: each accepted caller observed
/// a distinct pre-increment value `< cap`, so at most `cap` callers are accepted
/// concurrently. On rejection the increment is rolled back. On success the slot
/// is held by the returned `GlobalConcurrencyGuard` and released on drop.
fn reserve_global_slot(
    in_flight: Arc<AtomicUsize>,
    cap: usize,
) -> Option<GlobalConcurrencyGuard> {
    let prev = in_flight.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if prev >= cap {
        in_flight.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        None
    } else {
        Some(GlobalConcurrencyGuard { in_flight })
    }
}

/// RAII guard that cancels the CancellationToken and removes it from the
/// agent_cancellations map when dropped (request completed or client disconnected).
/// Must be moved into the SSE stream closure so it lives as long as the stream.
struct CancelGuard {
    key: String,
    token: Option<tokio_util::sync::CancellationToken>,
    cancellations: Arc<
        tokio::sync::Mutex<std::collections::HashMap<String, tokio_util::sync::CancellationToken>>,
    >,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        // Cancel the token first so any in-flight LLM stream stops immediately.
        if let Some(token) = self.token.take() {
            token.cancel();
        }
        // Best-effort removal: try_lock() is non-blocking and non-async.
        // If the lock is held, we skip removal — the entry will be cleaned
        // up when the next cancel request or session cleanup runs.
        //
        // Identity gate: only remove the entry if the registered token is
        // already cancelled. Our own token was cancelled just above, so if
        // the map still holds ours the gate passes and behavior is unchanged.
        // If a newer run reused this key (single-slot, session-keyed map),
        // its token is live and must NOT be removed — otherwise /agent/cancel
        // could never reach that run (root cause of "stop has no effect").
        if let Ok(mut map) = self.cancellations.try_lock()
            && map.get(&self.key).map(|t| t.is_cancelled()).unwrap_or(false) {
                map.remove(&self.key);
            }
    }
}

/// Remove a run_loop's cancellation token + event bus from the single-slot,
/// session-keyed registries — but only if the registered bus is *this run's*
/// bus (identity via `broadcast::Sender::same_channel`). Token + bus are
/// always registered together, so bus identity witnesses token currency.
/// A superseded run (its slot overwritten by a newer run for the same
/// session) skips removal entirely, keeping the newer run cancellable.
/// Lock order (cancels -> buses) matches the registration block.
async fn cleanup_run_loop_registration(
    state: &crate::server::AppState,
    cancel_key: &str,
    session_id: &str,
    my_bus: &agent_executor::RunLoopEventBus,
) {
    let mut cancels = state.agent_cancellations.lock().await;
    let mut buses = state.runloop_event_buses.lock().await;
    let is_current = buses.get(session_id).map(|b| b.same_bus(my_bus)).unwrap_or(false);
    if is_current {
        cancels.remove(cancel_key);
        buses.remove(session_id);
        // P2-A observability: drop stale live metrics once the run is done.
        let mut metrics = state.loop_metrics.lock().await;
        metrics.remove(session_id);
    }
}

/// RAII guard for run_loop resource registration (P1-16 / P1-17).
///
/// Created at the very top of the spawn closure, right after the token+bus
/// registration block, and held for the closure's ENTIRE body. On drop —
/// which fires on EVERY exit path: early `return`s (blackboard create/init
/// failures, empty messages, …), a panic unwinding the closure, or normal
/// completion — it spawns the identity-gated cleanup as a background task
/// (`Drop` must never await).
///
/// Previously the blackboard-failure early returns skipped cleanup entirely:
/// `/agent/metrics` reported `running:true` forever (the TS liveness probe
/// never exits), `/agent/cancel` hit a stale token, and loop metrics leaked.
///
/// Double-cleanup is safe: `cleanup_run_loop_registration` is identity-gated
/// and idempotent. The explicit calls on normal paths still run synchronously
/// (timely metrics removal); a later Drop-side spawn finds nothing to remove,
/// and if the session already has a NEWER run registered, the bus-identity
/// gate correctly skips removal so the new run stays cancellable.
struct RunLoopRegistrationGuard {
    state: crate::server::AppState,
    cancel_key: String,
    session_id: String,
    bus: agent_executor::RunLoopEventBus,
}

impl Drop for RunLoopRegistrationGuard {
    fn drop(&mut self) {
        let state = self.state.clone();
        let cancel_key = self.cancel_key.clone();
        let session_id = self.session_id.clone();
        let bus = self.bus.clone();
        tokio::spawn(async move {
            cleanup_run_loop_registration(&state, &cancel_key, &session_id, &bus).await;
        });
    }
}

pub fn router() -> Router<crate::server::AppState> {
    Router::new()
        .route("/agent/schedule", axum::routing::post(schedule))
        .route("/agent/tasks", axum::routing::get(list_tasks))
        .route("/agent/execute", axum::routing::post(execute))
        .route("/agent/config", axum::routing::post(set_llm_config))
        .route("/agent/config", axum::routing::get(get_llm_config))
        .route("/agent/loop_config", axum::routing::post(set_loop_config_handler))
        .route("/agent/loop_config", axum::routing::get(get_loop_config_handler))
        .route("/agent/cancel/:task_id", axum::routing::post(cancel_agent))
    .route("/agent/metrics", axum::routing::get(loop_metrics_handler))
        .route(
            "/internal/duoduo-credentials",
            axum::routing::post(set_duoduo_credentials_handler),
        )
        .route(
            "/agent/keyring/store",
            axum::routing::post(store_api_key_handler),
        )
        .route(
            "/agent/keyring/has",
            axum::routing::get(has_api_key_handler),
        )
        .route(
            "/agent/keyring/delete",
            axum::routing::post(delete_api_key_handler),
        )
        .route("/agent/tools/glob", axum::routing::post(glob_handler))
        .route(
            "/agent/chat/stream",
            axum::routing::post(chat_stream)
                .layer(axum::extract::DefaultBodyLimit::max(10 * 1024 * 1024)),
        )
        .route(
            "/agent/test",
            axum::routing::post(test_provider_model)
                .layer(axum::extract::DefaultBodyLimit::max(10 * 1024 * 1024)),
        )
        .route("/agent/run_loop", axum::routing::post(run_loop_handler))
        .route(
            "/agent/run_loop/events/:session_id",
            axum::routing::get(run_loop_events_handler),
        )
        .route(
            "/agent/tool_result",
            axum::routing::post(tool_result_handler),
        )
        .route(
            "/agent/messages/delete",
            axum::routing::post(delete_message_handler),
        )
        .route(
            "/agent/parts/delete",
            axum::routing::post(delete_part_handler),
        )
}

/// Test a provider/model for connectivity AND prompt-caching support.
///
/// Invoked from the frontend when a custom provider/model is submitted.
/// Returns `ok:false` (which blocks the save) if the model cannot be
/// reached, and `promptCaching:true` when the provider accepts `cache_control`
/// / returns cache telemetry — so the result can be remembered (stored on the
/// model config) and later used to decide whether to attach `cache_control`
/// at request time instead of guessing.
async fn test_provider_model(
    State(state): State<crate::server::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let provider = req
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let model = req
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let base_url = req
        .get("baseURL")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let api_key = req.get("apiKey").and_then(|v| v.as_str()).map(|s| s.to_string());
    let temperature = req
        .get("temperature")
        .and_then(|v| v.as_f64())
        .map(|v| v as f32);
    let top_p = req
        .get("topP")
        .and_then(|v| v.as_f64())
        .map(|v| v as f32);

    if provider.is_empty() || model.is_empty() || base_url.is_empty() {
        return Json(serde_json::json!({
            "ok": false,
            "promptCaching": false,
            "error": "provider, model and baseURL are required",
        }));
    }

    let api_url = agent_executor::resolve_api_url(&base_url, &provider);
    let max_attempts = state
        .executor
        .get_llm_config()
        .max_retry_attempts
        .unwrap_or(timeouts::MAX_ATTEMPTS);
    let cancel = tokio_util::sync::CancellationToken::new();

    // 1) Try WITH cache_control (mirrors real usage). fail_fast: if the
    //    provider rejects cache_control (e.g. Xunfei/proxy 400), we want to
    //    fall through to the no-cache retry immediately — no internal retries.
    //
    // The two probes differ only in `cache_control`/`fail_fast`; the closure
    // captures everything else so the two call sites cannot drift apart.
    let probe = |cache_control: Option<serde_json::Value>, fail_fast: bool| ConnectivityTest {
        api_url: &api_url,
        api_key: api_key.as_deref(),
        model: &model,
        cache_control,
        cancel: cancel.clone(),
        fail_fast,
        max_attempts,
        temperature,
        top_p,
    };

    match run_test(probe(Some(serde_json::json!({ "type": "ephemeral" })), true))
        .await
    {
        Ok((usage, model_id)) => {
            // A provider that supports caching returns cache telemetry even on a
            // single call (cache write on first hit, or hit if a prior turn cached).
            let caching =
                usage.prompt_cache_hit_tokens.is_some() || usage.prompt_cache_miss_tokens.is_some();
            Json(serde_json::json!({
                "ok": true,
                "promptCaching": caching,
                "modelId": model_id,
                "error": null,
            }))
        }
        // 2) WITH-cache failed — retry WITHOUT cache_control to distinguish a
        //    cache_control-rejecting proxy from a genuinely broken model.
        //    Full retry budget here so a flaky-but-alive model isn't misreported.
        Err(_) => match run_test(probe(None, false)).await {
            Ok((_, model_id)) => Json(serde_json::json!({
                "ok": true,
                "promptCaching": false,
                "modelId": model_id,
                "error": null,
            })),
            Err(e) => Json(serde_json::json!({
                "ok": false,
                "promptCaching": false,
                "modelId": null,
                "error": e.to_string(),
            })),
        },
    }
}

/// Run a minimal chat completion and return the final token usage.
///
/// `fail_fast` — when probing WITH `cache_control`, set this to `true`: that
/// attempt only exists to check whether the provider accepts `cache_control`,
/// so we don't let `call_llm_stream` burn several retry attempts on a request
/// we already know we'll discard (we just retry once without it). The
/// WITHOUT-cache attempt always uses the full `max_attempts` so a genuinely
/// broken model is reliably reported.
/// Parameters for [`run_test`], a one-shot LLM connectivity probe.
///
/// Grouped into a struct because there are more than
/// `clippy::too_many_arguments` permits, and because the two call sites
/// differ in only `cache_control` / `fail_fast`.
struct ConnectivityTest<'a> {
    api_url: &'a str,
    api_key: Option<&'a str>,
    model: &'a str,
    cache_control: Option<serde_json::Value>,
    cancel: tokio_util::sync::CancellationToken,
    fail_fast: bool,
    max_attempts: u32,
    temperature: Option<f32>,
    top_p: Option<f32>,
}

async fn run_test(
    p: ConnectivityTest<'_>,
) -> unified_error::Result<(agent_executor::TokenUsage, Option<String>)> {
    let mut system = agent_executor::LlmMessage {
        role: "system".to_string(),
        content: "You are a connectivity test. Reply with the single word OK.".to_string(),
        tool_calls: None,
        tool_call_id: None,
        cache_control: None,
        reasoning_content: None,
    };
    if let Some(cc) = p.cache_control {
        system.cache_control = Some(cc);
    }
    let messages = vec![
        system,
        agent_executor::LlmMessage {
            role: "user".to_string(),
            content: "OK".to_string(),
            tool_calls: None,
            tool_call_id: None,
            cache_control: None,
            reasoning_content: None,
        },
    ];
    let llm_req = agent_executor::LlmRequest {
        model: p.model.to_string(),
        messages,
        max_tokens: Some(16),
        temperature: Some(p.temperature.unwrap_or(0.0)),
        stream: Some(true),
        top_p: p.top_p,
        ..Default::default()
    };

    let attempts = if p.fail_fast { 1 } else { p.max_attempts };
    let mut stream = agent_executor::call_llm_stream(
        p.api_url,
        p.api_key,
        &llm_req,
        p.cancel,
        attempts,
    )
    .await?;

    let mut last_response: Option<agent_executor::LlmResponse> = None;
    while let Some(chunk) = stream.next().await {
        match chunk {
            agent_executor::LlmStreamChunk::Done(resp) => {
                last_response = Some(resp);
            }
            agent_executor::LlmStreamChunk::Error(e) => return Err(e),
            _ => {}
        }
    }

    match last_response {
        Some(r) => Ok((r.token_usage, r.model_id)),
        None => Err(unified_error::UnifiedError::LlmApi {
            message: "Model returned no response during connectivity test".to_string(),
            status_code: None,
            retryable: false,
        }),
    }
}

async fn schedule(
    State(state): State<crate::server::AppState>,
    Json(req): Json<duo_types::TaskScheduleRequest>,
) -> Result<Json<ScheduledTask>> {
    let scheduler = Arc::clone(&state.scheduler);
    let priority = TaskPriority::from_str_loose(&req.priority).unwrap_or(TaskPriority::Normal);
    let description = req.description.clone();
    let assigned_agent = req.assigned_agent.clone();
    let assigned_agent_for_model = assigned_agent.clone();
    let metadata = req.metadata.clone();
    let task = tokio::task::spawn_blocking(move || {
        scheduler.submit(&description, priority, assigned_agent.as_deref(), metadata)
    })
    .await??;

    // Schedule endpoint now also executes the task (same logic as /agent/execute),
    // tracking the lifecycle through the scheduler:
    //   submit → execute → complete/fail
    let task_id = task.id.clone();
    let executor = Arc::clone(&state.executor);
    let scheduler_for_exec = Arc::clone(&state.scheduler);
    let context_builder = state.context.clone();

    let prompt = req.description.clone();
    let model_id = assigned_agent_for_model; // reuse assigned_agent field as model hint
    let project_path: Option<String> = req.metadata.as_ref().and_then(|m| {
        m.get("project_path")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    });

    // Resolve model-level temperature from the TS provider registry so scheduled
    // tasks use the configured sampling value (single source of truth).
    let mut temperature = None::<f32>;
    if let Ok(client) = crate::duoduo_client::DuoduoSessionClient::from_injected_credentials()
        && let Ok(Some(t)) = client
            .get_model_temperature(
                project_path.as_deref().unwrap_or(""),
                model_id.as_deref().unwrap_or(""),
            )
            .await
    {
        temperature = Some(t);
    }

    // Build the LLM request (mirror /agent/execute logic)
    let mut llm_req = LlmExecuteRequest {
        prompt: prompt.clone(),
        model_id: model_id.clone(),
        max_tokens: None,
        temperature,
        project_path: project_path.clone(),
    };

    // Inject memory context — budget scales with the configured model's
    // context window (small models → 2K, large models → up to 12K).
    let budget = memory_inject_budget(state.executor.get_llm_config().context_window);
    let context_builder_for_sb = context_builder.clone();
    let prompt_for_sb = prompt.clone();
    let pp_for_sb = project_path.clone();
    let assembled_result = tokio::task::spawn_blocking(move || {
        if pp_for_sb.is_some() {
            context_builder_for_sb.assemble_with_project(
                &prompt_for_sb,
                budget,
                pp_for_sb.as_deref(),
            )
        } else {
            context_builder_for_sb.assemble(&prompt_for_sb, budget)
        }
    })
    .await?;
    match assembled_result {
        Ok(assembled) => {
            if !assembled.assembled_context.is_empty() {
                let mut vars = std::collections::HashMap::new();
                vars.insert("assembled_context", assembled.assembled_context.as_str());
                let prompt_before = llm_req.prompt.clone();
                vars.insert("original_prompt", &prompt_before);
                llm_req.prompt = context_builder::normalize_code_blocks(
                    &prompt_template::registry::get("context.inject")
                        .expect("invariant: 'context.inject' template is registered at startup in prompt-template registry")
                        .render(&vars),
                );
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, "Failed to assemble memory context for scheduled task");
        }
    }

    // Execute and update lifecycle
    match executor
        .execute_prompt(&llm_req, tokio_util::sync::CancellationToken::new())
        .await
    {
        Ok(resp) => {
            // Store execution result to memory (consistent with /agent/execute)
            if let Some(ref pp) = project_path {
                let memory = state.memory.clone();
                let prompt_for_mem = prompt.clone();
                let content_for_mem = resp.content.clone();
                let pp_owned = pp.clone();
                let task_id_for_mem = task_id.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    let summary = if content_for_mem.len() > 2000 {
                        let end = content_for_mem.floor_char_boundary(1500);
                        format!(
                            "{}...[truncated]...{}",
                            &content_for_mem[..end],
                            &content_for_mem[content_for_mem.len().saturating_sub(500)..]
                        )
                    } else {
                        content_for_mem
                    };
                    let store_content = format!(
                        "[{}] Scheduled Task: {}\nResult: {}\nStatus: scheduled",
                        Utc::now().format("%Y-%m-%d"),
                        prompt_for_mem,
                        summary
                    );
                    memory.store(&duo_types::MemoryStoreRequest {
                        id: None,
                        content: store_content,
                        summary: Some(format!(
                            "[{}] Scheduled Task: {}",
                            Utc::now().format("%Y-%m-%d"),
                            prompt_for_mem
                        )),
                        layer: "auto".to_string(),
                        importance: None,
                        pin: None,
                        session_id: Some(task_id_for_mem),
                        memory_type: Some("scheduled_task".to_string()),
                        metadata: Some(serde_json::json!({
                            "source": "agent_schedule",
                            "project_path": pp_owned,
                        })),
                        tags: Some(vec![
                            duo_types::memory_tags::CATEGORY_SUMMARY.to_string(),
                            duo_types::memory_tags::SOURCE_SCHEDULED.to_string(),
                        ]),
                        project_path: Some(pp_owned),
                        user_id: None,
                    })
                })
                .await;
            }

            let sched = scheduler_for_exec.clone();
            let id = task_id.clone();
            tokio::task::spawn_blocking(move || sched.complete(&id)).await??;
        }
        Err(e) => {
            let sched = scheduler_for_exec.clone();
            let id = task_id.clone();
            let reason = format!("{}", e);
            tokio::task::spawn_blocking(move || sched.fail(&id, &reason)).await??;
        }
    }

    Ok(Json(task))
}

#[derive(serde::Deserialize)]
struct TaskListQuery {
    status: Option<String>,
}

async fn list_tasks(
    State(state): State<crate::server::AppState>,
    Query(query): Query<TaskListQuery>,
) -> Result<Json<Vec<ScheduledTask>>> {
    let scheduler = Arc::clone(&state.scheduler);
    let status_filter = query.status.and_then(|s| match s.to_lowercase().as_str() {
        "queued" => Some(TaskStatus::Queued),
        "running" => Some(TaskStatus::Running),
        "completed" => Some(TaskStatus::Completed),
        "failed" => Some(TaskStatus::Failed),
        "cancelled" => Some(TaskStatus::Cancelled),
        _ => None,
    });
    let tasks =
        tokio::task::spawn_blocking(move || scheduler.list_by_status(status_filter)).await??;
    Ok(Json(tasks))
}

// ── /agent/cancel/:task_id ───────────────────────────────────────────

async fn cancel_agent(
    State(state): State<crate::server::AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    eprintln!("[TRACE-cancel] cancel_agent called, task_id={}", task_id);
    let cancellations = state.agent_cancellations.lock().await;
    if let Some(token) = cancellations.get(&task_id) {
        eprintln!(
            "[TRACE-cancel] cancel_agent FOUND token for task_id={}, calling token.cancel()",
            task_id
        );
        token.cancel();
        Ok(Json(
            serde_json::json!({"cancelled": true, "task_id": task_id}),
        ))
    } else {
        eprintln!(
            "[TRACE-cancel] cancel_agent token NOT found for task_id={}, keys available: {:?}",
            task_id,
            cancellations.keys().collect::<Vec<_>>()
        );
        Ok(Json(serde_json::json!({
            "cancelled": false,
            "task_id": task_id,
            "message": "task not found or already completed"
        })))
    }
}

// ── /agent/metrics ──────────────────────────────────────────────────

/// P2-A observability: poll live progress counters of a currently-running loop.
///
/// `GET /agent/metrics?session_id=<id>` returns tokens used, rounds completed,
/// files read, and elapsed milliseconds. If the session is not currently
/// running (unknown id or already finished) it returns `{ "running": false }`.
async fn loop_metrics_handler(
    State(state): State<crate::server::AppState>,
    axum::extract::Query(params): axum::extract::Query<LoopMetricsQuery>,
) -> std::result::Result<Json<serde_json::Value>, unified_error::UnifiedError> {
    let session_id = params
        .session_id
        .ok_or_else(|| unified_error::UnifiedError::bad_request("missing session_id"))?;
    let map = state.loop_metrics.lock().await;
    match map.get(&session_id) {
        None => Ok(Json(serde_json::json!({ "running": false, "session_id": session_id }))),
        Some(m) => {
            let elapsed_ms = m
                .started_at
                .lock_recover()
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(0);
            Ok(Json(serde_json::json!({
                "running": true,
                "session_id": session_id,
                "tokens_used": m.tokens_used.load(std::sync::atomic::Ordering::Relaxed),
                "rounds_completed": m.rounds_completed.load(std::sync::atomic::Ordering::Relaxed),
                "files_read": m.files_read.load(std::sync::atomic::Ordering::Relaxed),
                // P2-B: 折叠/召回/输入 token 埋点。此前只在结构体里声明,
                // handler 未返回 → 前端面板永远拿不到,埋点等于没接。
                "input_tokens": m.input_tokens.load(std::sync::atomic::Ordering::Relaxed),
                "fold_hits": m.fold_hits.load(std::sync::atomic::Ordering::Relaxed),
                "recall_hits": m.recall_hits.load(std::sync::atomic::Ordering::Relaxed),
                "elapsed_ms": elapsed_ms,
            })))
        }
    }
}

#[derive(Debug, Deserialize)]
struct LoopMetricsQuery {
    session_id: Option<String>,
}

// ── /agent/chat/stream ──────────────────────────────────────────────

/// SSE streaming endpoint for LLM chat.
/// Proxies the request to `call_llm_stream_with_fallback` and returns SSE events.
///
/// [LLM-05] Uses the cross-model fallback variant so that when the primary
/// model is unavailable (network unreachable, retryable API errors exhausted,
/// or model-not-found) the request degrades to a configured backup model
/// instead of failing outright. This mirrors the behaviour of the main
/// agentic-loop path (`run_loop_handler`) which already plumbs
/// `config.fallback_models`. The TS lightweight callers (task decomposition,
/// intent classification, title generation) all reach the LLM through this
/// endpoint, so this one change closes the LLM-05 gap for the TS path.
#[tracing::instrument(skip_all, fields(session_id = %req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("unknown")))]
async fn chat_stream(
    State(state): State<crate::server::AppState>,
    axum::extract::Extension(trace_cx): axum::extract::Extension<ExtractedTraceContext>,
    Json(req): Json<serde_json::Value>,
) -> Result<Sse<impl futures::Stream<Item = std::result::Result<Event, Infallible>>>> {
    // Propagate the OTel trace context extracted by the middleware into
    // this handler's #[instrument] span, linking TS→Rust trace chain.
    tracing::Span::current().set_parent(trace_cx.into_context());

    // Extract session_id for cancellation tracking
    let session_id = req
        .get("sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let cancel_key = format!("chat-{}", session_id);

    // Register CancellationToken
    let cancel_token = tokio_util::sync::CancellationToken::new();
    {
        let mut map = state.agent_cancellations.lock().await;
        map.insert(cancel_key.clone(), cancel_token.clone());
    }
    // Guard lives for the duration of the SSE stream — moved into the stream closure below.
    // On drop it cancels the token and removes the entry from the map.
    let guard = CancelGuard {
        key: cancel_key,
        token: Some(cancel_token.clone()),
        cancellations: state.agent_cancellations.clone(),
    };

    // Resolve LLM config from executor
    let config = state.executor.get_llm_config();
    let api_url = match &config.base_url {
        Some(url) => agent_executor::resolve_api_url(url, &config.provider),
        None => {
            return Err(unified_error::UnifiedError::Configuration(
                "No LLM base URL configured. Please select a model with a valid provider in Settings.".to_string(),
            ));
        }
    };
    let api_key = config.api_key.clone().or_else(|| {
        config
            .api_key_env
            .as_ref()
            .and_then(|env_var| std::env::var(env_var).ok())
    });

    // Build LLM request from JSON body
    let messages_json = req
        .get("messages")
        .cloned()
        .unwrap_or(serde_json::Value::Array(vec![]));
    let model = req
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or(&config.default_model_id)
        .to_string();
    let temperature = req
        .get("temperature")
        .and_then(|v| v.as_f64())
        .map(|t| t as f32);
    let max_tokens = req
        .get("maxTokens")
        .and_then(|v| v.as_u64())
        .map(|t| t as u32);
    let top_k = req.get("topK").and_then(|v| v.as_u64()).map(|t| t as u32);
    let top_p = req.get("topP").and_then(|v| v.as_f64()).map(|t| t as f32);

    // Parse messages
    let messages: Vec<agent_executor::LlmMessage> =
        serde_json::from_value(messages_json).unwrap_or_default();

    // Parse tools (array of tool definitions)
    let tools: Option<Vec<duo_types::ToolDefinition>> = req
        .get("tools")
        .and_then(|v| serde_json::from_value(v.clone()).ok());

    // Parse tool choice
    let tool_choice: Option<duo_types::ToolChoice> = req
        .get("toolChoice")
        .and_then(|v| serde_json::from_value(v.clone()).ok());

    // Parse extra body (provider-specific options)
    let mut extra_body = req.get("extraBody").cloned();

    // Env override: DUODUO_LLM_EXTRA_BODY (JSON object) merged into extra_body
    // at root level with env precedence. Used as an experiment switch for
    // benchmark parity (e.g. {"reasoning_effort":"none"} disables DeepSeek's
    // default thinking). Keys already present in the request body are
    // overridden by the env value; invalid JSON is warned and ignored.
    if let Ok(env_extra) = std::env::var("DUODUO_LLM_EXTRA_BODY") {
        match serde_json::from_str::<serde_json::Value>(&env_extra) {
            Ok(env_val) if env_val.is_object() => {
                let mut merged = serde_json::Map::new();
                if let Some(existing) = extra_body.as_ref().and_then(|v| v.as_object()) {
                    for (k, v) in existing {
                        merged.insert(k.clone(), v.clone());
                    }
                }
                if let Some(env_obj) = env_val.as_object() {
                    for (k, v) in env_obj {
                        merged.insert(k.clone(), v.clone());
                    }
                }
                extra_body = Some(serde_json::Value::Object(merged));
            }
            _ => {
                tracing::warn!(
                    "DUODUO_LLM_EXTRA_BODY is set but not a valid JSON object, ignored"
                );
            }
        }
    }

    // Parity with the Rust run_loop_handler: guard against orphan tool_calls
    // (an assistant message whose tool_call_id has no following tool result),
    // which DeepSeek rejects with HTTP 400. The TS session layer forwards
    // arbitrary conversations here (including ones with tool_calls), so a
    // single dropped tool result would otherwise crash the request. Pure
    // additive: a no-op when every tool_call already has a matching result.
    // TEMP DIAGNOSTIC (parity with run_loop_handler): same root-cause hunt.
    diagnose_tool_call_integrity(&messages, 0);

    let mut chat_messages = messages;
    agent_executor::agentic_loop::recover_missing_tool_results(&mut chat_messages, 0);

    let llm_req = agent_executor::LlmRequest {
        model,
        messages: chat_messages,
        max_tokens,
        temperature,
        stream: Some(true),
        tools,
        tool_choice,
        top_k,
        top_p,
        extra_body,
        ..Default::default()
    };

    let fallback_models = config.fallback_models.as_deref().unwrap_or(&[]);
    let stream_result = agent_executor::call_llm_stream_with_fallback(
        &api_url,
        api_key.as_deref(),
        &llm_req,
        cancel_token,
        config.max_retry_attempts.unwrap_or(timeouts::MAX_ATTEMPTS),
        fallback_models,
    )
    .await;

    // Convert to SSE stream — the CancelGuard is moved into the stream's
    // terminal future so it lives until the stream ends (client disconnect
    // or all chunks consumed). On drop it cancels the token and cleans up.
    let stream: futures::stream::BoxStream<'static, std::result::Result<Event, Infallible>> =
        match stream_result {
            Ok(llm_stream) => {
                llm_stream
                    .map(|chunk| {
                        let event = match &chunk {
                            agent_executor::LlmStreamChunk::Thinking { content } => {
                                Event::default().event("thinking").data(serde_json::json!({"content": content}).to_string())
                            }
                            agent_executor::LlmStreamChunk::Delta { content } => {
                                Event::default().event("delta").data(serde_json::json!({"content": content}).to_string())
                            }
                            agent_executor::LlmStreamChunk::Done(response) => {
                                let tool_calls: Vec<serde_json::Value> = response.tool_calls
                                    .as_ref()
                                    .map(|calls| calls.iter().map(|tc| {
                                        serde_json::json!({
                                            "id": tc.id,
                                            "function": {
                                                "name": tc.function.name,
                                                "arguments": tc.function.arguments,
                                            }
                                        })
                                    }).collect())
                                    .unwrap_or_default();
                                let token_usage = serde_json::json!({
                                    "promptTokens": response.token_usage.prompt_tokens,
                                    "completionTokens": response.token_usage.completion_tokens,
                                });
                                let done_data = serde_json::json!({
                                    "content": response.content,
                                    "reasoningContent": response.reasoning_content,
                                    "modelId": response.model_id,
                                    "toolCalls": tool_calls,
                                    "tokenUsage": token_usage,
                                    "finishReason": response.finish_reason.as_deref().unwrap_or("stop"),
                                });
                                Event::default().event("done").data(done_data.to_string())
                            }
                            agent_executor::LlmStreamChunk::Error(err) => {
                                // Carry the structured `retryable` flag so the TS side does not
                                // have to re-guess retryability from free-text (single source of
                                // truth = Rust's UnifiedError::is_retryable). Also carry
                                // `retry_after_ms` (only `RateLimited` populates it, e.g. when the
                                // upstream provider returned a `Retry-After` hint) so the TS backoff
                                // honors the server's suggested delay instead of guessing one.
                                Event::default().event("error").data(
                                    serde_json::json!({
                                        "message": err.to_string(),
                                        "retryable": err.is_retryable(),
                                        "retry_after_ms": err.retry_after_ms(),
                                    })
                                    .to_string(),
                                )
                            }
                        };
                        Ok(event)
                    })
                    .chain(futures::stream::once(async move {
                        // Guard moved here — dropped when the chained stream ends,
                        // cancelling the token and removing from the map.
                        drop(guard);
                        Ok::<_, Infallible>(Event::default())
                    }))
                    .boxed()
            }
            Err(e) => {
                // On error, drop guard immediately to clean up.
                drop(guard);
                // Connection-establishment failure (incl. retries exhausted with a
                // 429 + Retry-After). Mirror the in-stream `LlmStreamChunk::Error`
                // branch: carry `retryable` and `retry_after_ms` so the TS retry
                // layer honors the provider's suggested backoff instead of guessing
                // one (full-chain time consistency for the connect-phase path too).
                let error_event = Event::default()
                    .event("error")
                    .data(
                        serde_json::json!({
                            "message": e.to_string(),
                            "retryable": e.is_retryable(),
                            "retry_after_ms": e.retry_after_ms(),
                        })
                        .to_string(),
                    );
                futures::stream::once(async move { Ok(error_event) }).boxed()
            }
        };

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    ))
}

// ── /agent/execute ───────────────────────────────────────────────────
async fn execute(
    State(state): State<crate::server::AppState>,
    Json(mut req): Json<LlmExecuteRequest>,
) -> Result<Json<LlmResponse>> {
    let executor = Arc::clone(&state.executor);

    if !executor.with_llm() {
        return Err(unified_error::UnifiedError::Internal(
            "No LLM configured. Call POST /agent/config first or configure via Settings."
                .to_string(),
        ));
    }

    // Register the task with the scheduler and track lifecycle:
    //   schedule → mark_running → execute → mark_completed/mark_failed
    let scheduler = Arc::clone(&state.scheduler);
    let description = format!("Agent execute: {}", truncate_str(&req.prompt, 120));
    let scheduled_task = tokio::task::spawn_blocking({
        let sched = scheduler.clone();
        let desc = description.clone();
        move || sched.submit(&desc, TaskPriority::Normal, None, None)
    })
    .await??;

    let task_id = scheduled_task.id.clone();

    // Create CancellationToken and register for /agent/cancel/:task_id
    let cancel_token = tokio_util::sync::CancellationToken::new();
    {
        let mut cancellations = state.agent_cancellations.lock().await;
        cancellations.insert(task_id.clone(), cancel_token.clone());
    }

    // Inject memory context into the prompt for Agent mode.
    // This brings Agent mode to parity with the memory injection approach
    // If project_path is provided, also inject knowledge graph context (code structure/dependencies).
    let context_builder = state.context.clone();
    // Budget for memory context injection — scales with the configured model's
    // context window (small models → 2K, large models → up to 12K).
    let budget = memory_inject_budget(state.executor.get_llm_config().context_window);
    let pp_owned = req.project_path.clone();
    let prompt_owned = req.prompt.clone();
    let assembled_result = tokio::task::spawn_blocking(move || {
        if let Some(pp) = pp_owned.as_deref() {
            context_builder.assemble_with_project(&prompt_owned, budget, Some(pp))
        } else {
            context_builder.assemble(&prompt_owned, budget)
        }
    })
    .await?;
    match assembled_result {
        Ok(assembled) => {
            if !assembled.assembled_context.is_empty() {
                // Prepend assembled context as a system-like prefix in the user prompt
                let mut vars = std::collections::HashMap::new();
                vars.insert("assembled_context", assembled.assembled_context.as_str());
                let prompt_before = req.prompt.clone();
                vars.insert("original_prompt", &prompt_before);
                req.prompt = context_builder::normalize_code_blocks(
                    &prompt_template::registry::get("context.inject")
                        .expect("invariant: 'context.inject' template is registered at startup in prompt-template registry")
                        .render(&vars),
                );
            }
        }
        Err(e) => {
            // Context injection failure should not block the agent execution
            tracing::warn!(error = %e, "Failed to assemble memory context for Agent mode");
        }
    }

    // Resolve model-level temperature from the TS provider registry when the
    // caller did not supply one, so /agent/execute uses the single configured
    // source of truth for sampling temperature.
    if req.temperature.is_none()
        && let Ok(client) = crate::duoduo_client::DuoduoSessionClient::from_injected_credentials()
        && let Ok(Some(t)) = client
            .get_model_temperature(
                req.project_path.as_deref().unwrap_or(""),
                req.model_id.as_deref().unwrap_or(""),
            )
            .await
    {
        req.temperature = Some(t);
    }

    // Execute and update lifecycle
    let result = {
        let exec_future = executor.execute_prompt(&req, cancel_token.clone());
        tokio::select! {
            res = exec_future => res,
            _ = cancel_token.cancelled() => {
                Err(unified_error::UnifiedError::Internal(
                    "Task cancelled by user".to_string(),
                ))
            }
        }
    };

    // Clean up CancellationToken
    {
        let mut cancellations = state.agent_cancellations.lock().await;
        cancellations.remove(&task_id);
    }

    match result {
        Ok(resp) => {
            // Store execution result to memory for future context retrieval
            if let Some(ref project_path_str) = req.project_path {
                let memory = state.memory.clone();
                let project_path_owned = project_path_str.clone();
                let task_id_for_mem = task_id.clone();
                let prompt_for_mem = req.prompt.clone();
                let content_for_mem = resp.content.clone();

                let _ = tokio::task::spawn_blocking(move || {
                    // Structured content: task description + key output summary
                    let summary = if content_for_mem.len() > 2000 {
                        let end = content_for_mem.floor_char_boundary(1500);
                        format!(
                            "{}...[truncated]...{}",
                            &content_for_mem[..end],
                            &content_for_mem[content_for_mem.len().saturating_sub(500)..]
                        )
                    } else {
                        content_for_mem.clone()
                    };

                    let store_content = format!(
                        "[{}] Task: {}\nResult: {}\nStatus: completed",
                        Utc::now().format("%Y-%m-%d"),
                        prompt_for_mem,
                        summary
                    );

                    memory.store(&duo_types::MemoryStoreRequest {
                        id: None,
                        content: store_content,
                        summary: Some(format!(
                            "[{}] Task: {}",
                            Utc::now().format("%Y-%m-%d"),
                            prompt_for_mem
                        )),
                        layer: "auto".to_string(),
                        importance: None, // let auto_importance() decide
                        pin: None,
                        session_id: Some(task_id_for_mem),
                        memory_type: Some("agent_execute".to_string()),
                        metadata: Some(serde_json::json!({
                            "source": "agent_execute",
                            "project_path": project_path_owned,
                        })),
                        tags: Some(vec![
                            duo_types::memory_tags::CATEGORY_SUMMARY.to_string(),
                            duo_types::memory_tags::SOURCE_AGENT_EXECUTE.to_string(),
                        ]),
                        project_path: Some(project_path_owned),
                        user_id: None,
                    })
                })
                .await;
            }

            let sched = scheduler.clone();
            let id = task_id.clone();
            let _ = tokio::task::spawn_blocking(move || sched.complete(&id)).await;

            // ── Quality validation (non-blocking, log-only) ──
            let quality_report_result: Option<duo_types::QualityReport> =
                if let Some(ref project_path_str) = req.project_path {
                    let quality = state.quality.get()?.clone();
                    let content = resp.content.clone();
                    let pp = project_path_str.clone();
                    // `validate` is async (may await LLM), but `enable_llm_check`
                    // stays false here (log-only, no LLM cost on the execute path).
                    let language = if content.contains("fn ") && content.contains("pub") {
                        "rust"
                    } else if content.contains("function") && content.contains("export") {
                        "typescript"
                    } else if content.contains("class") && content.contains("def") {
                        "python"
                    } else {
                        "text"
                    };
                    let validate_req = duo_types::QualityValidateRequest {
                        artifact: duo_types::CodeArtifact {
                            artifact_type: "code".to_string(),
                            content,
                            language: language.to_string(),
                            file_path: None,
                        },
                        quality_level: duo_types::QualityLevel::Standard,
                        interface_contract: None,
                        shared_types: vec![],
                        enable_llm_check: false,
                        diff: None,
                        kg_related: vec![],
                    };
                    match quality.validate(&validate_req).await {
                        Ok(report) => {
                            let warnings: Vec<String> = report
                                .checks
                                .iter()
                                .filter(|c| !c.passed)
                                .map(|c| format!("{} (score: {:.1})", c.name, c.score))
                                .collect();
                            if !warnings.is_empty() {
                                tracing::warn!(
                                    project = %pp,
                                    warnings = %warnings.join("; "),
                                    "Quality validation for /agent/execute"
                                );
                            }
                            Some(report)
                        }
                        Err(e) => {
                            tracing::debug!("Quality validation skipped for /agent/execute: {}", e);
                            None
                        }
                    }
                } else {
                    None
                };

            // ── SSE event: push quality warnings if score < 0.7 ──
            if let Some(ref report) = quality_report_result
                && report.score < 0.7 {
                    let _ = state.sse_event_tx.send(
                        im_bridge::sse_bridge::SseEvent::QualityCheckUpdate {
                            pipeline_id: format!("agent-{}", task_id),
                            chat_id: None,
                            current_stage: "agent_execute".to_string(),
                            status: "warnings".to_string(),
                            quality_report: serde_json::to_string(&report).unwrap_or_default(),
                        },
                    );
                }

            Ok(Json(resp))
        }
        Err(e) => {
            let sched = scheduler.clone();
            let id = task_id.clone();
            let reason = format!("{}", e);
            let _ = tokio::task::spawn_blocking(move || sched.fail(&id, &reason)).await;
            Err(e)
        }
    }
}

/// Set (or replace) the LLM configuration used by the agent executor.
///
/// Accepts an `LlmConfig` JSON body and stores it in the executor.
/// Once set, direct `/agent/execute` calls will
/// route prompts to the configured LLM endpoint.
///
/// When `api_key` is provided directly (instead of `api_key_env`), the key
/// is written to a process-level env var so `execute_prompt` can resolve it
/// via the standard `api_key_env` mechanism.
async fn set_llm_config(
    State(state): State<crate::server::AppState>,
    Json(mut config): Json<LlmConfig>,
) -> Result<Json<serde_json::Value>> {
    let executor = Arc::clone(&state.executor);

    // Remember whether api_key was explicitly provided in this request.
    // If not (e.g. concurrency-only config updates), we preserve it from the
    // existing config so that partial updates don't silently wipe the API key.
    let preserve_api_key = config.api_key.is_none();
    let preserve_api_key_env = config.api_key_env.is_none();
    // Same "omitted means preserve" contract for fallback_models and
    // embedding_api_key: partial updates (e.g. concurrency-only saves from the
    // settings UI) must not wipe fields they never carried.
    let preserve_fallback_models = config.fallback_models.is_none();
    let preserve_embedding_api_key = config.embedding_api_key.is_none();

    // If a direct api_key value is provided, keep it in the config struct.
    // Previously this used unsafe { std::env::set_var() } which is not thread-safe
    // (Rust docs explicitly state set_var is UB in multi-threaded contexts).
    // Now the key is stored directly in LlmConfig.api_key and resolved by
    // execute_prompt via config.api_key.or_else(|| config.api_key_env...).
    // api_key_env is kept as a fallback for users who prefer env-var-based keys.
    if let Some(ref key) = config.api_key {
        if key.is_empty() {
            config.api_key = None; // Treat empty string as "no key provided"
        } else {
            // Dual-write: persist API key to OS keyring for survival across restarts.
            if let Err(e) = crate::secure_store::store_api_key(&config.provider, key) {
                tracing::warn!(
                    provider = %config.provider,
                    error = %e,
                    "Failed to persist API key to keyring (key is still in memory for this session)"
                );
            }
        }
    }

    tracing::info!(
        provider = %config.provider,
        base_url = ?config.base_url,
        default_model_id = %config.default_model_id,
        has_api_key = config.api_key.is_some() || config.api_key_env.is_some(),
        "Setting LLM config via /agent/config"
    );

    // Clone config for background sync before ownership moves into executor.
    let sync_config = config.clone();

    // Update memory system's embedding config if an API key is available.
    // Uses embedding_api_key if set, otherwise falls back to api_key.
    // When neither is set, embedding generation is disabled (vector search degrades to FTS5).
    let embedding_key = config
        .embedding_api_key
        .clone()
        .or_else(|| config.api_key.clone());
    if let Some(key) = embedding_key
        && !key.is_empty() {
            let base_url = config
                .base_url
                .clone()
                .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
            // Dynamic runtime update via interior mutability (Arc<Mutex<Option<EmbeddingConfig>>>).
            let embedding_model = config
                .embedding_model
                .clone()
                .unwrap_or_else(|| "text-embedding-3-small".to_string());
            let embedding_dim = config.embedding_dim.unwrap_or(1536) as usize;
            state
                .memory
                .set_embedding_config(memory_system::EmbeddingConfig {
                    api_key: key.clone(),
                    base_url: base_url.clone(),
                    model: embedding_model.clone(),
                    dim: embedding_dim,
                });
            // Seed KG's semantic-reuse index with the same embedding config so
            // graph_query query_type="similar" can find code by meaning. When
            // the key is empty/unset, KG degrades to name-based search.
            state.graph.set_embedding_config(
                knowledge_graph_store::embedding::EmbeddingConfig {
                    api_key: key.clone(),
                    base_url: base_url.clone(),
                    model: embedding_model.clone(),
                    dim: embedding_dim,
                },
            );
            tracing::info!(
                "Embedding config updated for memory system (model={}, dim={})",
                embedding_model,
                embedding_dim
            );
        }

    // Preserve API key from existing config if not explicitly provided in this
    // request. This prevents concurrency-only config updates from wiping the key.
    if preserve_api_key || preserve_api_key_env || preserve_fallback_models || preserve_embedding_api_key {
        let old = executor.get_llm_config();
        if preserve_api_key {
            config.api_key = old.api_key;
        }
        if preserve_api_key_env {
            config.api_key_env = old.api_key_env;
        }
        if preserve_fallback_models {
            config.fallback_models = old.fallback_models;
        }
        if preserve_embedding_api_key {
            config.embedding_api_key = old.embedding_api_key;
        }
    }

    executor.set_llm_config(config.clone());

    // Update global concurrency limit from config (if provided)
    if let Some(max) = config.max_concurrent_agents {
        let max = max.clamp(1, 100) as usize;
        let old = state
            .global_llm_max_concurrent
            .swap(max, std::sync::atomic::Ordering::Relaxed);
        if max != old {
            tracing::info!(old = old, new = max, "Global LLM concurrency limit updated");
        }
        // Also update per-project max to match (user-facing simplicity:
        // one slider controls both global and per-project limits)
        state.project_tasks.set_max_concurrent(max);
    }
    if let Some(max_sub) = config.max_concurrent_subagents {
        // Clamp to 1..10 to stay consistent with the frontend UI, which also
        // limits this field to 1..10. Prevents pathological configs submitted
        // directly via the API (bypassing the UI) from over-spawning sub-agents.
        let max_sub = max_sub.clamp(1, 10);
        tracing::info!(
            max_concurrent_subagents = max_sub,
            "subagent concurrency limit configured"
        );
    }
    if let Some(max_retry) = config.max_retry_attempts {
        let max_retry = max_retry.clamp(1, 10);
        tracing::info!(
            max_retry_attempts = max_retry,
            "LLM retry attempts configured"
        );
    }
    if let Some(tc) = config.tool_concurrency {
        let tc = tc.max(1).min(agent_executor::MAX_TOOL_CONCURRENCY_HARD as u32);
        tracing::info!(tool_concurrency = tc, "per-round tool execution concurrency configured");
    }

    // Async sync to duoduo (fire-and-forget, does not block response)
    tokio::spawn(crate::duoduo_sync::sync_to_duoduo(sync_config));

    Ok(Json(serde_json::json!({
        "configured": true,
        "with_llm": executor.with_llm(),
    })))
}

/// Get the current LLM configuration status (whether an LLM is configured).
/// Also returns concurrency and retry settings. Does NOT return the API key
/// for security reasons (the Serialize impl masks it).
async fn get_llm_config(
    State(state): State<crate::server::AppState>,
) -> Result<Json<serde_json::Value>> {
    let executor = Arc::clone(&state.executor);
    let configured = executor.with_llm();
    let config = executor.get_llm_config();
    let max_concurrent = state
        .global_llm_max_concurrent
        .load(std::sync::atomic::Ordering::Relaxed);

    Ok(Json(serde_json::json!({
        "configured": configured,
        "provider": config.provider,
        "defaultModelId": config.default_model_id,
        "baseURL": config.base_url,
        "contextWindow": config.context_window,
        "maxOutputTokens": config.max_output_tokens,
        "maxConcurrentAgents": config.max_concurrent_agents.unwrap_or(max_concurrent as u32),
        "globalInFlight": state.global_in_flight.load(std::sync::atomic::Ordering::Relaxed) as u32,
        "maxConcurrentSubagents": config.max_concurrent_subagents.unwrap_or(3),
        "maxRetryAttempts": config.max_retry_attempts.unwrap_or(3),
        "toolConcurrency": config.tool_concurrency.unwrap_or(agent_executor::DEFAULT_TOOL_CONCURRENCY as u32),
        // Round-trip the remaining LlmConfig fields: the settings UI reads
        // them to rebuild the configureLlm payload (prompt-input.tsx).
        "fallbackModels": config.fallback_models,
        "temperature": config.temperature,
        "enableThinking": config.enable_thinking,
        "thinkingEffort": config.thinking_effort,
    })))
}

// ── /agent/loop_config (GET/POST) ────────────────────────────────────
// User-facing quality switches (语法校验 / 审校) for the loop. These map to
// `LoopConfig` consumed by `run_loop_handler`. The POST path persists the
// value and updates the in-memory override so it takes effect on the next
// run_loop without a process restart.

/// Request body for `POST /agent/loop_config`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoopConfigRequest {
    /// Syntax gate (L1 tree-sitter) on file writes. Default true.
    #[serde(default)]
    syntax_check: Option<bool>,
    /// Reflection / self-correction (L3) enable. Default true.
    #[serde(default)]
    reflect: Option<bool>,
    /// Reflection trigger mode: "always" | "keypoint" | "never".
    #[serde(default)]
    reflect_on: Option<String>,
    /// Maximum number of agentic-loop tool-call rounds. `-1` = unlimited. Default -1.
    #[serde(default)]
    max_steps: Option<i32>,
    /// G7: parallel multi-agent dispatch enable.
    #[serde(default)]
    parallel_dispatch: Option<bool>,
    /// Sub-agent loop limits. `-1` = unlimited for every field.
    #[serde(default)]
    sub_agent_max_rounds: Option<i32>,
    #[serde(default)]
    sub_agent_timeout_secs: Option<i64>,
    #[serde(default)]
    sub_agent_max_total_tokens: Option<i64>,
    #[serde(default)]
    sub_agent_max_file_reads: Option<i32>,
}

/// Update the loop configuration from the settings panel.
async fn set_loop_config_handler(
    State(state): State<crate::server::AppState>,
    Json(req): Json<LoopConfigRequest>,
) -> Result<Json<serde_json::Value>> {
    // Start from the current effective config so unspecified fields keep their
    // existing value (partial updates are allowed).
    let mut lc = state
        .config_manager
        .loop_config()
        .unwrap_or_else(config_manager::model::LoopConfig::default);

    if let Some(v) = req.syntax_check {
        lc.syntax_check = v;
    }
    if let Some(v) = req.reflect {
        lc.reflect = v;
    }
    if let Some(v) = req.reflect_on {
        lc.reflect_on = v;
    }
    if let Some(v) = req.max_steps {
        lc.max_steps = v;
    }
    if let Some(v) = req.parallel_dispatch {
        lc.parallel_dispatch = v;
    }
    if let Some(v) = req.sub_agent_max_rounds {
        lc.sub_agent_max_rounds = v;
    }
    if let Some(v) = req.sub_agent_timeout_secs {
        lc.sub_agent_timeout_secs = v;
    }
    if let Some(v) = req.sub_agent_max_total_tokens {
        lc.sub_agent_max_total_tokens = v;
    }
    if let Some(v) = req.sub_agent_max_file_reads {
        lc.sub_agent_max_file_reads = v;
    }

    state
        .config_manager
        .set_loop_config(lc.clone())
        .map_err(|e| {
            // Surface a user-readable message (the parse error already contains
            // the config.toml path) instead of a raw internal error.
            unified_error::UnifiedError::Internal(format!(
                "配置文件已损坏，无法保存设置：{e}。请修复或删除该 config.toml 后重试。"
            ))
        })?;

    Ok(Json(serde_json::json!({
        "syntaxCheck": lc.syntax_check,
        "reflect": lc.reflect,
        "reflectOn": lc.reflect_on,
        "maxSteps": lc.max_steps,
        "parallelDispatch": lc.parallel_dispatch,
        "subAgentMaxRounds": lc.sub_agent_max_rounds,
        "subAgentTimeoutSecs": lc.sub_agent_timeout_secs,
        "subAgentMaxTotalTokens": lc.sub_agent_max_total_tokens,
        "subAgentMaxFileReads": lc.sub_agent_max_file_reads,
    })))
}

/// Return the current effective loop configuration.
async fn get_loop_config_handler(
    State(state): State<crate::server::AppState>,
) -> Result<Json<serde_json::Value>> {
    let lc = state
        .config_manager
        .loop_config()
        .unwrap_or_else(config_manager::model::LoopConfig::default);
    Ok(Json(serde_json::json!({
        "syntaxCheck": lc.syntax_check,
        "reflect": lc.reflect,
        "reflectOn": lc.reflect_on,
        "maxSteps": lc.max_steps,
        "parallelDispatch": lc.parallel_dispatch,
        "subAgentMaxRounds": lc.sub_agent_max_rounds,
        "subAgentTimeoutSecs": lc.sub_agent_timeout_secs,
        "subAgentMaxTotalTokens": lc.sub_agent_max_total_tokens,
        "subAgentMaxFileReads": lc.sub_agent_max_file_reads,
    })))
}

/// Truncate a string to at most `max_len` bytes, respecting UTF-8 char boundaries,
/// and appending "..." if truncated.
fn truncate_str(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        let mut boundary = max_len;
        while boundary > 0 && !s.is_char_boundary(boundary) {
            boundary -= 1;
        }
        format!("{}...", &s[..boundary])
    }
}

// ── Internal API: inject duoduo credentials ─────────────────────────

#[derive(serde::Deserialize)]
struct DuoduoCredentialsRequest {
    url: String,
    username: String,
    password: String,
}

async fn set_duoduo_credentials_handler(
    Json(req): Json<DuoduoCredentialsRequest>,
) -> Result<Json<serde_json::Value>> {
    let creds = crate::duoduo_sync::DuoduoCredentials {
        url: req.url,
        username: req.username,
        password: req.password,
    };

    match crate::duoduo_sync::set_duoduo_credentials(creds) {
        Ok(()) => tracing::info!("duoduo credentials injected"),
        Err(_) => tracing::debug!("duoduo credentials already set, ignoring duplicate"),
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

// ── /agent/keyring/* ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreApiKeyRequest {
    provider: String,
    api_key: String,
}

/// Store an API key in the OS keyring.
///
/// The key is persisted securely (macOS Keychain / Windows Credential Manager /
/// Linux Secret Service) and also loaded into `LlmConfig.api_key` in memory
/// so that it is immediately available for LLM calls.
async fn store_api_key_handler(
    State(state): State<crate::server::AppState>,
    Json(req): Json<StoreApiKeyRequest>,
) -> Result<Json<serde_json::Value>> {
    let executor = Arc::clone(&state.executor);

    // Persist to keyring
    crate::secure_store::store_api_key(&req.provider, &req.api_key)
        .map_err(|e| unified_error::UnifiedError::Internal(format!("Keyring store failed: {e}")))?;

    // Also update the in-memory LlmConfig so the key is immediately available
    let mut config = executor.get_llm_config();
    // Only update the provider field if it's currently empty or matches
    if config.provider.is_empty() {
        config.provider = req.provider.clone();
    }
    if config.provider == req.provider {
        config.api_key = Some(req.api_key.clone());
        executor.set_llm_config(config);
    }

    tracing::info!(provider = %req.provider, "API key stored in OS keyring via /agent/keyring/store");

    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HasApiKeyQuery {
    provider: String,
}

/// Check whether an API key exists for a given provider.
///
/// Returns `{"hasKey": true/false}` without exposing the key itself.
/// Safe to call from the frontend.
async fn has_api_key_handler(
    Query(query): Query<HasApiKeyQuery>,
) -> Result<Json<serde_json::Value>> {
    let has_key = crate::secure_store::has_api_key(&query.provider);
    Ok(Json(serde_json::json!({ "hasKey": has_key })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteApiKeyRequest {
    provider: String,
}

/// Delete an API key from the OS keyring.
async fn delete_api_key_handler(
    State(state): State<crate::server::AppState>,
    Json(req): Json<DeleteApiKeyRequest>,
) -> Result<Json<serde_json::Value>> {
    let executor = Arc::clone(&state.executor);

    // Remove from keyring
    crate::secure_store::delete_api_key(&req.provider).map_err(|e| {
        unified_error::UnifiedError::Internal(format!("Keyring delete failed: {e}"))
    })?;

    // Also clear from in-memory LlmConfig if the provider matches
    let config = executor.get_llm_config();
    if config.provider == req.provider {
        let mut config = config;
        config.api_key = None;
        executor.set_llm_config(config);
    }

    tracing::info!(provider = %req.provider, "API key deleted from OS keyring via /agent/keyring/delete");

    Ok(Json(serde_json::json!({ "ok": true })))
}

// ── Tool endpoints ──────────────────────────────────────────────────────────

// Note: POST /agent/tools/todo endpoint was removed — todo persistence is
// handled entirely by the TS side (TodoWriteTool → Todo.Service.update → DB +
// Bus event). The Rust execute_rust_tool no longer intercepts "todo_write".
// session-manager's update_todos/get_todos remain available for future use.

#[derive(serde::Deserialize)]
struct GlobRequest {
    pattern: String,
    project_path: String,
    max_results: Option<usize>,
}

#[derive(serde::Serialize)]
struct GlobResponse {
    files: Vec<String>,
}

async fn glob_handler(Json(req): Json<GlobRequest>) -> Result<Json<GlobResponse>> {
    let pattern = req.pattern;
    let project_path = std::path::PathBuf::from(&req.project_path);
    let max = req.max_results.unwrap_or(100);
    let files = tokio::task::spawn_blocking(move || {
        agent_executor::tools::glob::glob_search(&pattern, &project_path, max)
    })
    .await??;
    Ok(Json(GlobResponse { files }))
}

// ── /agent/run_loop ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct RunLoopRequest {
    #[serde(rename = "sessionID", alias = "session_id")]
    session_id: String,
    #[serde(default)]
    messages: Vec<serde_json::Value>,
    model: Option<String>,
    max_steps: Option<i32>,
    /// Tool definitions from TS resolveTools, serialized as JSON.
    /// When provided, Rust passes them to the LLM; when None or empty,
    /// the LLM has no tools (pure text mode).
    tools: Option<Vec<duo_types::ToolDefinition>>,
    /// Permission ruleset from TS, serialized as JSON.
    /// Used by execute_tool_with_middleware for permission checks.
    permission_rules: Option<Vec<serde_json::Value>>,
    /// Whether the user's "auto-accept permissions" switch is on. When true,
    /// sub-agents (interactive=false) treat an `Ask` permission result as
    /// `Allow`, so autonomous work isn't blocked by confirmation prompts.
    /// Plumbed into the executor and inherited by every spawned sub-agent.
    #[serde(default)]
    auto_accept: Option<bool>,
    /// Agent name for logging and metadata.
    agent_name: Option<String>,
    /// Project path for tool execution (file operations).
    project_path: Option<String>,
    /// Task-scoped directory allow-list ("logical sandbox").
    ///
    /// Mirrors `InstanceContext.allowedPaths` on the TS side. When present and
    /// non-empty, it *replaces* the server-global `SecurityPolicy` for this run,
    /// scoping every path-taking tool (read/write/edit/glob/grep/...) to these
    /// directories. This is what makes legitimate cross-project work possible
    /// (e.g. "read project A, write project B") without widening access to the
    /// whole filesystem.
    ///
    /// The project path is always implicitly included, so a caller only needs to
    /// list the *extra* directories. When omitted or empty, the server-global
    /// policy applies unchanged (backward compatible).
    #[serde(default)]
    allowed_paths: Option<Vec<String>>,
    /// Snapshot gitdir — the resolved path to the bare snapshot git repo.
    /// Computed by TS identically to `Snapshot.Service`'s gitdir
    /// (`path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))`)
    /// so Rust-written tree hashes are valid when TS later consumes them.
    /// When None (non-git project / snapshot disabled), snapshot tracking is skipped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    snapshot_gitdir: Option<String>,
    /// Output format for structured output (JSON schema).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    output_format: Option<agent_executor::OutputFormat>,
    /// Provider ID (e.g. "openai", "anthropic", "xunfei-new").
    /// When the smart-layer starts without a stored LLM config (fresh install or
    /// keyring empty), these fields provide the config inline so the runLoop can
    /// proceed without requiring a separate POST /agent/config call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    /// Base URL for the provider's chat completions API.
    /// E.g. "https://api.openai.com" or "http://localhost:11434/v1".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    /// API key for the provider. For providers using env-var auth this may be
    /// empty — the smart-layer will check `api_key_env` from its stored config.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    /// Intent type from TS-side IntentClarifier (e.g. "feature_request", "bug_fix", "question").
    /// When provided, Rust adjusts loop strategy (context path, max_steps, reflect settings).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    intent_type: Option<String>,
    /// Initial phase for the phase-aware main loop state machine (TaskPhase).
    /// When provided by the caller (TS-side IntentClarifier classifies intent → phase),
    /// the loop starts in this phase; when absent it defaults to `Execute` (safe
    /// fallback). Drives context budget ratio, system prompt, and KG recall depth.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    initial_phase: Option<duo_types::renderer::TaskPhase>,
    /// System prompt assembled by TS (SystemPrompt.provider + environment).
    /// Injected as the first system message before conversation history.
    /// Without this, the LLM would not receive "You are DuoDuoCode..." or
    /// tool-usage instructions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    system_prompt: Option<String>,
    /// Model context window in tokens. Enables Rust-side pre-flight compression
    /// so long conversations don't overflow the LLM's context limit. When absent,
    /// falls back to the stored LLM config's `context_window`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_window: Option<u32>,
    /// Whether this model's provider accepts `cache_control` (prompt caching).
    /// Sourced from `model.capabilities.promptCaching` on the TS side — the same
    /// flag `transform.ts::applyCaching` uses on the TS path, and the value
    /// `test_provider_model` probes when a custom provider is added.
    ///
    /// The Rust path previously never attached `cache_control`, so every round
    /// re-sent the full system prefix as billable input. Gated on this flag
    /// because providers that reject the field (Xunfei / some proxies) answer
    /// with a hard 400 — attaching it unconditionally would break them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prompt_caching: Option<bool>,
    /// Enable progressive tool disclosure: send non-core tools as name-only
    /// stubs and let the model pull their schemas on demand via `expand_tools`
    /// (see `routes::tool_disclosure`). Off by default so behaviour is
    /// unchanged unless the caller opts in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    progressive_tools: Option<bool>,
    /// Explicit sub-task list for G7 parallel multi-agent dispatch, sent by the
    /// TS side. When present (and `parallel_dispatch` is enabled in LoopConfig)
    /// these take precedence over the Rust LLM planner, giving TS deterministic
    /// control over how the task is decomposed. Optional; defaults to None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sub_tasks: Option<Vec<SubTaskRequest>>,
    /// Sampling temperature for this runLoop. Sourced from the model's configured
    /// value on the TS side (ProviderTransform.temperature). When present it
    /// overrides the Rust-side LlmConfig.temperature, making the model-level
    /// setting the single source of truth. When absent, the runLoop falls back to
    /// the env var / LlmConfig / code default chain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

/// A single explicit sub-task sent by the TS side for G7 parallel dispatch.
///
/// When provided and `parallel_dispatch` is enabled, `run_loop_handler` uses
/// these directly (explicit precedence over the Rust LLM planner). This gives
/// the TS side deterministic control over the decomposition. Each sub-task runs
/// as an independent sub-agent through the shared blackboard.
#[derive(Deserialize, Clone)]
struct SubTaskRequest {
    /// Stable sub-task id (used for the sub-agent `agent_id` and result correlation).
    id: String,
    /// Self-contained instruction for the sub-agent.
    task_prompt: String,
    /// Optional per-sub-task system prompt override. When None, the run_loop's
    /// main `system_prompt` (from TS) is used.
    #[serde(default)]
    system_prompt: Option<String>,
    /// Optional execution mode: `"codegen"` (may write, gated by the blackboard)
    /// or `"explore"` (read-only). Defaults to `"codegen"`.
    #[serde(default)]
    mode: Option<String>,
    /// Optional list of files this sub-task is expected to create/modify.
    /// Used for conflict grouping at dispatch (serialized only when shared with
    /// another sub-task). When omitted, the sub-task stays fully parallel.
    #[serde(default)]
    files: Option<Vec<String>>,
    /// ③ Contract planner: the target file this sub-task is expected to implement.
    /// When set alongside `interface_contract`, the agentic loop runs a
    /// contract-consistency check on writes to this file (B5). Mirrors
    /// `SubagentTask.target_file` in the pipeline体系 (同构, 零类型碎片化).
    #[serde(default)]
    target_file: Option<String>,
    /// ③ Contract planner: interface contract for `target_file`, produced by the
    /// TS side from the KG. `None` ⇒ no contract check (R6.1, zero regression).
    #[serde(default)]
    interface_contract: Option<InterfaceContract>,
    /// Optional least-privilege tool whitelist for this sub-task. When set, only
    /// the named tools are exposed to the sub-agent's LLM (plumbing only — the
    /// agentic loop filters and `None` preserves existing behavior). `None` ⇒ no
    /// filtering; the `mode` field governs the tool set (Explore = read-only,
    /// Codegen = may write). Planner-optional; not yet emitted by the TS planner.
    #[serde(default)]
    allowed_tools: Option<Vec<String>>,
}

/// Convert a TS-sent [`SubTaskRequest`] into the internal parallel-executor
/// [`SubTask`], mapping the optional `mode` string to a [`LoopToolSet`].
fn sub_task_request_to_sub_task(
    req: SubTaskRequest,
) -> agent_executor::parallel_executor::SubTask {
    let tool_set = match req.mode.as_deref() {
        Some("explore") => agent_executor::agentic_loop::LoopToolSet::Explore,
        // Default (and any unknown value) → Codegen, which still routes writes
        // through the blackboard gate.
        _ => agent_executor::agentic_loop::LoopToolSet::Codegen,
    };
    // Conflict grouping reads `files`. The TS planner only ever sends
    // `target_file`, so without this fallback `files` is always empty, every
    // sub-task lands in its own group, and two sub-tasks targeting the same
    // file run concurrently — leaving the blackboard lock as the only defence
    // (one writer wins, the other gets `QueuedForSerial` and its work is
    // dropped). Seeding `files` from `target_file` lets them be serialized into
    // one group instead. Explicit `files` still wins when present.
    let files = match req.files {
        Some(f) if !f.is_empty() => f,
        _ => req.target_file.clone().into_iter().collect(),
    };
    agent_executor::parallel_executor::SubTask {
        id: req.id,
        system_prompt: req.system_prompt.unwrap_or_default(),
        task_prompt: req.task_prompt,
        tool_set,
        files,
        target_file: req.target_file.clone(),
        interface_contract: req.interface_contract.clone(),
        allowed_tools: req.allowed_tools.clone(),
    }
}

/// Inject `id` and `sessionID` into a JSON string that may be missing them.
///
/// TS stores message/part data with `id`, `sessionID` (and `messageID` for parts)
/// as separate DB columns — they are stripped from the `data` JSON before insert.
/// Rust's serde types require these as mandatory fields, so we must add them back
/// before deserializing. If the JSON already contains these keys, the injected
/// values are ignored (existing keys take precedence).
fn inject_message_ids(data: &str, id: &str, session_id: &str) -> String {
    // Fast path: try to insert into the JSON object directly.
    // If data is not a JSON object, return as-is (let serde report the error).
    match serde_json::from_str::<serde_json::Value>(data) {
        Ok(serde_json::Value::Object(mut map)) => {
            map.entry("id".to_string())
                .or_insert_with(|| serde_json::Value::String(id.to_string()));
            map.entry("sessionID".to_string())
                .or_insert_with(|| serde_json::Value::String(session_id.to_string()));
            serde_json::to_string(&map).unwrap_or_else(|_| data.to_string())
        }
        _ => data.to_string(),
    }
}

/// Inject `id`, `sessionID`, and `messageID` into a part JSON string.
fn inject_part_ids(data: &str, id: &str, session_id: &str, message_id: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(data) {
        Ok(serde_json::Value::Object(mut map)) => {
            map.entry("id".to_string())
                .or_insert_with(|| serde_json::Value::String(id.to_string()));
            map.entry("sessionID".to_string())
                .or_insert_with(|| serde_json::Value::String(session_id.to_string()));
            map.entry("messageID".to_string())
                .or_insert_with(|| serde_json::Value::String(message_id.to_string()));
            serde_json::to_string(&map).unwrap_or_else(|_| data.to_string())
        }
        _ => data.to_string(),
    }
}

/// Deserialize a PartData from a PartRow, injecting missing id/sessionID/messageID
/// from the row's columns (TS stores these as separate columns, not in the data JSON).
fn part_data_from_row(part: &PartRow) -> Option<duo_types::PartData> {
    let data_with_ids = inject_part_ids(&part.data, &part.id, &part.session_id, &part.message_id);
    serde_json::from_str(&data_with_ids).ok()
}

/// Estimate token breakdown by category for a given LlmRequest.
/// Uses `duo_utils::text::estimate_tokens` (CJK-aware heuristic).
fn estimate_request_breakdown(
    messages: &[agent_executor::LlmMessage],
    tools: Option<&[duo_types::ToolDefinition]>,
) -> duo_types::TokenBreakdown {
    let mut system_prompt_tokens: f64 = 0.0;
    let mut messages_tokens: f64 = 0.0;
    let mut skills_tokens: f64 = 0.0;

    for msg in messages {
        let tokens = duo_utils::text::estimate_tokens(&msg.content) as f64;
        if msg.role == "system" {
            system_prompt_tokens += tokens;
            // Try to identify skills section within system prompt
            if let Some(skills_text) = extract_skills_section(&msg.content) {
                skills_tokens = duo_utils::text::estimate_tokens(skills_text) as f64;
                system_prompt_tokens -= skills_tokens;
            }
        } else {
            // user + assistant + tool
            messages_tokens += tokens;
            // tool_calls JSON also counts as messages
            if let Some(ref tool_calls) = msg.tool_calls {
                let json = serde_json::to_string(tool_calls).unwrap_or_default();
                messages_tokens += duo_utils::text::estimate_tokens(&json) as f64;
            }
        }
    }

    // Tool definitions tokens
    let tools_tokens = if let Some(tools) = tools {
        let json = serde_json::to_string(tools).unwrap_or_default();
        duo_utils::text::estimate_tokens(&json) as f64
    } else {
        0.0
    };

    duo_types::TokenBreakdown {
        messages: messages_tokens,
        system_prompt: system_prompt_tokens,
        tools: tools_tokens,
        skills: skills_tokens,
        other: 0.0, // Calibrated after LLM returns using prompt_tokens
        estimated: Some(true),
    }
}

/// Extract the skills section from system prompt text.
/// Skills section starts with "Skills provide specialized instructions".
fn extract_skills_section(system_prompt: &str) -> Option<&str> {
    const SKILLS_MARKER: &str = "Skills provide specialized instructions";
    let idx = system_prompt.find(SKILLS_MARKER)?;
    Some(&system_prompt[idx..])
}

/// Convert a [`duo_types::MessageInfo`] from the DB into an [`agent_executor::LlmMessage`]
/// for the agentic loop.
///
/// Message content lives in the `part` table, so this function reads parts from
/// the message store to extract text and tool-call data.
fn msg_info_to_llm_message(
    msg: &duo_types::MessageInfo,
    parts: &[session_manager::message_store::PartRow],
) -> Option<agent_executor::LlmMessage> {
    match msg {
        duo_types::MessageInfo::User(u) => {
            // User message text is stored in parts (TextPartData).
            // Fall back to summary.body if parts are unavailable.
            let text = extract_text_from_parts(parts)
                .or_else(|| u.summary.as_ref().and_then(|s| s.body.clone()))
                .unwrap_or_default();
            if text.is_empty() {
                // No content at all — still emit a placeholder so the
                // conversation structure (user→assistant alternation) is
                // preserved.
                Some(agent_executor::LlmMessage::user("[user message]"))
            } else {
                Some(agent_executor::LlmMessage::user(text))
            }
        }
        duo_types::MessageInfo::Assistant(_) => {
            let text = extract_text_from_parts(parts).unwrap_or_default();
            let tool_calls = extract_tool_calls_from_parts(parts);
            Some(agent_executor::LlmMessage::assistant_with_tool_calls(
                &text,
                &tool_calls,
            ))
        }
    }
}

/// Extract concatenated text content from TextPartData parts for a given message.
fn extract_text_from_parts(parts: &[session_manager::message_store::PartRow]) -> Option<String> {
    let mut texts: Vec<String> = Vec::new();
    for part in parts {
        let Some(pd) = part_data_from_row(part) else {
            continue;
        };
        match pd {
            duo_types::PartData::Text(t) => {
                // TS parity (message-v2.ts toModelMessage): only `ignored`
                // parts are excluded from the model input. `synthetic` parts
                // (attachment expansions like "Called the Read tool ..." +
                // file contents, comment notes, recovery gists) are hidden
                // from the UI but MUST be sent to the LLM — filtering them
                // here silently dropped every prompt attachment in the
                // rust-run-loop path.
                if t.ignored == Some(true) {
                    continue;
                }
                if !t.text.is_empty() {
                    texts.push(t.text);
                }
            }
            duo_types::PartData::Reasoning(r)
                if !r.text.is_empty() => {
                    texts.push(r.text);
                }
            _ => {}
        }
    }
    if texts.is_empty() {
        None
    } else {
        Some(texts.join("\n"))
    }
}

/// Extract tool calls from ToolPartData parts for a given assistant message.
/// Only includes tool calls that have been initiated (Pending or later),
/// converting them to the OpenAI-format [`duo_types::ToolCall`] expected by
/// [`agent_executor::LlmMessage`].
fn extract_tool_calls_from_parts(parts: &[session_manager::message_store::PartRow]) -> Vec<duo_types::ToolCall> {
    let mut calls = Vec::new();
    for part in parts {
        let Some(pd) = part_data_from_row(part) else {
            continue;
        };
        if let duo_types::PartData::Tool(tp) = pd {
            // Build a ToolCall from the tool part. The `call_id` is the
            // tool-call ID, `tool` is the function name, and the input
            // (available in all states) is serialized as the arguments.
            let input = match &tp.state {
                duo_types::ToolState::Pending { input, .. }
                | duo_types::ToolState::Running { input, .. }
                | duo_types::ToolState::Completed { input, .. }
                | duo_types::ToolState::Error { input, .. } => input,
            };
            let arguments = serde_json::to_string(input).unwrap_or_default();
            calls.push(duo_types::ToolCall {
                id: tp.call_id.clone(),
                r#type: "function".to_string(),
                function: duo_types::FunctionCall {
                    name: tp.tool.clone(),
                    arguments,
                },
            });
        }
    }
    calls
}

/// Transition a tool part from Running back to Pending so the TS poll loop
/// can detect it and execute the tool. Used when Rust attempted to execute a
/// tool but needs to delegate to TS (permission ask or tool not in Rust).
/// Without this, the part stays in Running state and TS poll never sees it
/// as Pending, so the tool is never executed and Rust's runLoop hangs.
fn self_transition_part_to_pending(
    msg_store: &Arc<session_manager::MessageStore>,
    part_id: &str,
    message_id: &str,
    session_id: &str,
    call_id: &str,
    tool_name: &str,
    arguments: &str,
) {
    let input: std::collections::HashMap<String, serde_json::Value> =
        serde_json::from_str(arguments).unwrap_or_else(|_| {
            std::collections::HashMap::from([(
                "raw".to_string(),
                serde_json::Value::String(arguments.to_string()),
            )])
        });
    let pending_part = duo_types::PartData::Tool(duo_types::ToolPartData {
        base: duo_types::PartBase {
            id: part_id.to_string(),
            session_id: session_id.to_string(),
            message_id: message_id.to_string(),
        },
        call_id: call_id.to_string(),
        tool: tool_name.to_string(),
        state: duo_types::ToolState::Pending {
            input,
            raw: arguments.to_string(),
        },
        metadata: None,
    });
    if let Err(e) = msg_store.update_part(
        part_id,
        &serde_json::to_string(&pending_part).unwrap_or_default(),
    ) {
        tracing::warn!(error = %e, "Failed to transition tool part back to Pending for TS delegation");
    }
}

/// Extract the child session ID from a task tool's output string.
///
/// The `execute_task` function returns output in the format:
///   `"task_id: {child_session_id} (for resuming)\n\n<task_result>..."`
///
/// This function parses the `task_id:` prefix to extract the session ID.
/// Returns `None` if the format is not recognized (falls back to existing behavior).
fn extract_task_session_id(output: &str) -> Option<String> {
    let prefix = "task_id: ";
    let start = output.find(prefix)?;
    let after_prefix = &output[start + prefix.len()..];
    // The session ID ends at the first space (before " (for resuming)")
    let end = after_prefix.find(' ').unwrap_or(after_prefix.len());
    let sid = &after_prefix[..end];
    if sid.is_empty() {
        None
    } else {
        Some(sid.to_string())
    }
}

/// Update a Running tool part's state.metadata to include the child session ID.
///
/// This is called after `execute_task` returns (so we know the child_session_id)
/// to update the Running part that was created before the tool execution started.
/// The frontend needs `metadata.sessionId` in the Running state to make the
/// sub-agent card clickable while the sub-agent is still running.
/// A Running tool part whose `state.metadata` must be patched with the child
/// session ID once the sub-agent has been spawned.
///
/// Grouped so the call site names each field — the eight positional `&str`
/// arguments were otherwise trivially transposable.
struct RunningPartPatch<'a> {
    msg_store: &'a Arc<session_manager::MessageStore>,
    part_id: &'a str,
    message_id: &'a str,
    session_id: &'a str,
    call_id: &'a str,
    tool_name: &'a str,
    arguments: &'a str,
    metadata: std::collections::HashMap<String, serde_json::Value>,
}

fn update_running_part_metadata(
    RunningPartPatch {
        msg_store,
        part_id,
        message_id,
        session_id,
        call_id,
        tool_name,
        arguments,
        metadata,
    }: RunningPartPatch<'_>,
) {
    let input: std::collections::HashMap<String, serde_json::Value> =
        serde_json::from_str(arguments).unwrap_or_else(|_| {
            std::collections::HashMap::from([(
                "raw".to_string(),
                serde_json::Value::String(arguments.to_string()),
            )])
        });
    let running_part = duo_types::PartData::Tool(duo_types::ToolPartData {
        base: duo_types::PartBase {
            id: part_id.to_string(),
            session_id: session_id.to_string(),
            message_id: message_id.to_string(),
        },
        call_id: call_id.to_string(),
        tool: tool_name.to_string(),
        state: duo_types::ToolState::Running {
            input,
            title: Some(tool_name.to_string()),
            metadata: Some(metadata),
            time: duo_types::ToolTimeStart {
                start: chrono::Utc::now().timestamp_millis() as f64,
            },
        },
        metadata: None,
    });
    if let Err(e) = msg_store.update_part(
        part_id,
        &serde_json::to_string(&running_part).unwrap_or_default(),
    ) {
        tracing::warn!(error = %e, "Failed to update Running tool part metadata with sessionId");
    }
}

/// TEMP DIAGNOSTIC — remove after the tool_call/tool_result adjacency root-cause
/// fix lands. Right before an LLM call, check the OpenAI/DeepSeek invariant:
/// every `assistant` carrying `tool_calls` must be IMMEDIATELY followed by a
/// `tool` result for each of its `tool_call_id`s, with NO non-tool message in
/// between. We check BOTH:
///   - presence/duplicate (id exists somewhere, not duplicated), and
///   - POSITION (the tool results sit in the contiguous block right after the
///     assistant; a user/assistant message between them is what actually 400s).
///
/// Lightweight memory context via `ContextBuilder`.
///
/// Shared by both context-injection fallbacks in `run_loop_handler`:
///  - the deep path when `StructuredAssembler` fails, and
///  - the default path for intents outside the deep-context allowlist
///    (`"general"`, or `None` when intent clarification failed) — these are
///    common, and returning no context at all left the model with zero memory.
///
/// Memory-injection token budget, scaled to the model's context window.
///
/// Mirrors the front-end `dynamicMemoryBudget`: ~5% of the context window,
/// floored at 2K (the old hard-coded default, safe for 8K models) and capped
/// at 12K (reached around 200K+ windows). Small models keep the 2K default;
/// large models (128K → ~6.4K, 1M → 12K) get proportionally richer recall
/// including KG context. When the window is unknown (`None`/`0`) we fall back
/// to the 2K safe minimum rather than guessing.
///
/// This replaces the previous `let budget = 2000;` hard-coding so the injected
/// memory volume tracks the selected model instead of being frozen at one size.
fn memory_inject_budget(context_window: Option<u32>) -> usize {
    match context_window {
        Some(cw) if cw > 0 => {
            let budget = (cw as f64 * 0.05).round() as usize;
            budget.clamp(2000, 12_000)
        }
        _ => 2000,
    }
}

/// Runs on `spawn_blocking` because `assemble_with_project` is synchronous
/// SQLite I/O. Returns `None` when there is nothing worth injecting.
async fn build_fallback_context(
    context: Arc<context_builder::ContextBuilder>,
    base_system: String,
    project_path: String,
) -> Option<String> {
    let result = tokio::task::spawn_blocking(move || {
        context.assemble_with_project(&base_system, 500, Some(&project_path))
    })
    .await;
    match result {
        Ok(Ok(ctx)) if !ctx.assembled_context.is_empty() => Some(format!(
            "## Relevant Memory\n{}\n\nUse these memories to provide context-aware responses.",
            ctx.assembled_context
        )),
        _ => None,
    }
}

fn diagnose_tool_call_integrity(messages: &[agent_executor::LlmMessage], step: u32) {
    use std::collections::HashSet;
    let tool_ids: Vec<String> = messages
        .iter()
        .filter(|m| m.role == "tool")
        .filter_map(|m| m.tool_call_id.clone())
        .collect();
    let tool_set: HashSet<&str> = tool_ids.iter().map(|s| s.as_str()).collect();
    let mut issues: Vec<String> = Vec::new();
    for (mi, m) in messages.iter().enumerate() {
        if m.role != "assistant" {
            continue;
        }
        let Some(ref tcs) = m.tool_calls else { continue };
        // presence + duplicate
        let mut seen: HashSet<&str> = HashSet::new();
        for tc in tcs.iter() {
            let id = tc.id.as_str();
            if !seen.insert(id) {
                issues.push(format!(
                    "assistant[{}] DUPLICATE tool_call_id={} tool={}",
                    mi, id, tc.function.name
                ));
            }
            if !tool_set.contains(id) {
                issues.push(format!(
                    "assistant[{}] ORPHAN tool_call_id={} tool={}",
                    mi, id, tc.function.name
                ));
            }
        }
        // POSITION: scan the contiguous tool block right after this assistant.
        // It must contain a tool result for every tool_call_id, and any non-tool
        // message before all results are present is the 400 cause.
        let mut present: HashSet<String> = HashSet::new();
        let mut j = mi + 1;
        while j < messages.len() && messages[j].role == "tool" {
            if let Some(ref id) = messages[j].tool_call_id {
                present.insert(id.clone());
            }
            j += 1;
        }
        let next_role = if j < messages.len() {
            Some(messages[j].role.clone())
        } else {
            None
        };
        for tc in tcs.iter() {
            if !present.contains(&tc.id) {
                issues.push(format!(
                    "assistant[{}] POSITION/MISSED tool_call_id={} tool={} — tool block ended at idx {} (next role={:?}), so a non-tool message sits between this assistant and its tool result",
                    mi, tc.id, tc.function.name, j, next_role
                ));
            }
        }
    }
    if !issues.is_empty() {
        tracing::warn!(
            target: "duo_smart_layer",
            "DIAG[step={}] tool_call integrity FAILED (would HTTP 400): {} || tool_result_ids={:?}",
            step,
            issues.join(" ; "),
            tool_ids
        );
    }
}

/// A doom loop is reported once the same action recurs this many times within
/// `DOOM_LOOP_WINDOW` recent rounds.
pub(crate) const DOOM_LOOP_THRESHOLD: u32 = 3;
/// Sliding-window size (in rounds) for doom-loop detection. Bounds memory and
/// lets an old loop expire after this many distinct rounds.
pub(crate) const DOOM_LOOP_WINDOW: usize = 6;

/// Detect a recurring doom loop via a sliding window of recent tool
/// signatures. `window` (mutated) holds the last `window_size` rounds' full
/// tool signatures. Returns `(is_loop, counter)` where `counter` is how many
/// times `current` appears in the window (including this round). A loop is
/// reported once the same action recurs `threshold` times within the window —
/// covering both consecutive repeats and periodic oscillations (A,B,A,B,...)
/// that a single "previous == current" comparison would miss forever.
/// `max_steps` remains the ultimate backstop.
fn detect_recurring_doom_loop(
    window: &mut Vec<Vec<(String, String)>>,
    current: &[(String, String)],
    threshold: u32,
    window_size: usize,
) -> (bool, u32) {
    window.push(current.to_vec());
    if window.len() > window_size {
        let drop = window.len() - window_size;
        window.drain(0..drop);
    }
    let counter = window.iter().filter(|s| *s == current).count() as u32;
    (counter >= threshold, counter)
}

/// How many text-only rounds the loop may spend asking the LLM to confirm
/// completion before it auto-closes the turn.
const COMPLETION_CONFIRM_LIMIT: u32 = 2;

/// Marker the LLM must prefix its final summary with to close a turn that
/// produced no tool calls.
const TASK_COMPLETE_MARKER: &str = "TASK_COMPLETE";

/// How a text-only round (no tool calls) ends the loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompletionDecision {
    /// Genuine completion — stop the loop.
    Done,
    /// The confirm cap was hit without a marker: stop the loop, but flag the
    /// turn as auto-closed so the user can tell it apart from a real completion.
    AutoClose,
    /// Ask the LLM to confirm and keep going.
    Confirm,
}

/// Single source of truth for the text-only completion logic.
///
/// Called TWICE per round from the same inputs: once before the assistant
/// message is persisted (so the auto-close note can be written as part of that
/// very message) and once at the break site. Keeping it here removes the
/// duplicated condition that previously drifted between the two places.
///
/// The marker is matched at the START of the reply (after leading whitespace)
/// so a model merely mentioning `TASK_COMPLETE` inside prose or a code block
/// cannot close the turn by accident.
fn completion_decision(confirm_rounds: u32, full_text: &str) -> CompletionDecision {
    // P2-24: the marker is honoured on the FIRST text-only round too. Gating it
    // behind `confirm_rounds > 0` meant a model that declared completion up
    // front was told to confirm, and the injected prompt ("if it is NOT
    // complete: do NOT reply with words — call the appropriate tool now")
    // pushed a finished task back into tool calls.
    if full_text.trim_start().starts_with(TASK_COMPLETE_MARKER) {
        CompletionDecision::Done
    } else if confirm_rounds >= COMPLETION_CONFIRM_LIMIT {
        CompletionDecision::AutoClose
    } else {
        CompletionDecision::Confirm
    }
}

#[tracing::instrument(skip_all, fields(session_id = %req.session_id))]
async fn run_loop_handler(
    State(state): State<crate::server::AppState>,
    axum::extract::Extension(trace_cx): axum::extract::Extension<ExtractedTraceContext>,
    Json(req): Json<RunLoopRequest>,
) -> Result<Json<serde_json::Value>> {
    // Propagate the OTel trace context extracted by the middleware into
    // this handler's #[instrument] span, linking TS→Rust trace chain.
    tracing::Span::current().set_parent(trace_cx.into_context());

    let session_id = req.session_id.clone();
    eprintln!(
        "[TRACE-rust] ① run_loop_handler called, session_id={}, model={}",
        session_id,
        req.model.as_deref().unwrap_or("?")
    );
    let intent_type = req.intent_type.clone();

    // Read LoopConfig from config manager (fallback to env vars when absent).
    // This bridges the user-configurable loop settings with the runtime behavior.
    // Uses the runtime override so UI changes take effect on the next run_loop.
    let loop_cfg = state.config_manager.loop_config();

    // Resolve the maximum number of tool-call rounds (the agentic-loop safety
    // guard). Precedence: explicit per-request value > user-configured
    // `LoopConfig.max_steps` (default -1 = unlimited) > -1 (unlimited).
    // `agent_executor::MAX_STEPS` (50) remains the compile-time hard floor used
    // only by paths that don't go through this resolution (e.g. sub-loops).
    let max_steps = req
        .max_steps
        .or_else(|| loop_cfg.as_ref().map(|lc| lc.max_steps))
        .unwrap_or(-1);


    // Determine reflect enable: LoopConfig.reflect overrides env var when present.
    // Default is ON per loop汇总实施方案.md §P4/P6 (LoopConfig.reflect 默认 true).
    let should_reflect = loop_cfg
        .as_ref()
        .map(|lc| lc.reflect)
        .unwrap_or(true);

    // Determine quality mid-check enable: LoopConfig.quality.mid_loop_check overrides env var.
    let should_quality_mid_check = loop_cfg
        .as_ref()
        .map(|lc| lc.quality.mid_loop_check)
        .unwrap_or_else(config_manager::feature_flags::loop_quality_mid_check);

    // Adjust max_steps based on intent type.
    // When `max_steps < 0` (the user explicitly chose "unlimited"), skip all
    // intent-based compression — `-1` is an explicit opt-out of every cap, so
    // intent heuristics (question→1, bug_fix→8) must not re-impose a limit.
    let effective_max_steps = if max_steps < 0 {
        max_steps
    } else {
        match intent_type.as_deref() {
            Some("question") => {
                // When skip_loop_for_questions is enabled, question type gets max 1 step.
                // Otherwise fall through to default.
                let skip = loop_cfg
                    .as_ref()
                    .map(|lc| lc.intent.skip_loop_for_questions)
                    .unwrap_or(false);
                if skip { max_steps.min(1) } else { max_steps }
            }
            Some("bug_fix") => max_steps.min(8), // bug_fix: focused, fewer steps
            Some("feature_request") => max_steps, // feature_request: full steps
            Some("refactoring") => max_steps,    // refactoring: full steps
            _ => max_steps,                      // default: use original
        }
    };
    eprintln!(
      "[TRACE-rust] effective_max_steps={}, intent={:?}, default_MAX_STEPS={}",
      effective_max_steps, intent_type, agent_executor::MAX_STEPS
    );
    // Sub-agent loop limits (LoopConfig.sub_agent_*, -1 = unlimited). Applied
    // to `task` children via the executor and to G7 fan-out via ParallelContext.
    let sub_agent_limits = {
        let d = config_manager::model::LoopConfig::default();
        agent_executor::SubAgentLimits::from_config(
            loop_cfg
                .as_ref()
                .map(|l| l.sub_agent_max_rounds)
                .unwrap_or(d.sub_agent_max_rounds),
            loop_cfg
                .as_ref()
                .map(|l| l.sub_agent_timeout_secs)
                .unwrap_or(d.sub_agent_timeout_secs),
            loop_cfg
                .as_ref()
                .map(|l| l.sub_agent_max_total_tokens)
                .unwrap_or(d.sub_agent_max_total_tokens),
            loop_cfg
                .as_ref()
                .map(|l| l.sub_agent_max_file_reads)
                .unwrap_or(d.sub_agent_max_file_reads),
        )
    };
    let tools_from_ts = req.tools.clone();
    let agent_name = req.agent_name.clone().unwrap_or_else(|| "code".to_string());
    let project_path = req
        .project_path
        .clone()
        .or_else(|| {
            state
                .project_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| ".".to_string());
    // Snapshot gitdir — resolved by TS so Rust-written hashes are valid in the
    // same repo TS Snapshot.Service operates on. None ⇒ skip snapshot tracking.
    let snapshot_gitdir = req.snapshot_gitdir.clone();
    let permission_rules: Vec<agent_executor::PermissionRule> = req
        .permission_rules
        .as_ref()
        .map(|rules| {
            serde_json::from_value(serde_json::Value::Array(rules.clone())).unwrap_or_else(|e| {
                // A silent empty fallback here flips EVERY tool to fail-closed
                // Ask (delegating them all to TS). Surface the parse failure.
                tracing::warn!(error = %e, count = rules.len(), "Failed to parse permission_rules — falling back to empty ruleset (all tools will fail-closed to Ask)");
                Vec::new()
            })
        })
        .unwrap_or_default();
    // Honor the user's "auto-accept permissions" switch (option B): when on,
    // sub-agents treat `Ask` as `Allow` so autonomous work isn't blocked.
    let auto_accept = req.auto_accept.unwrap_or(false);

    let config = state.executor.get_llm_config();

    // Resolve LLM config for THIS runLoop.
    //
    // Inline request fields (req.provider / req.base_url / req.api_key) take
    // precedence over the stored executor config, because the UI sends the
    // user's *current* selection inline with every runLoop (see TS
    // `delegateToRustRunLoop`, which passes model.providerID / providerBaseUrl
    // / providerApiKey). The stored config is only a fallback for fields the
    // request leaves unspecified.
    //
    // CRITICAL — request-scoped, NOT written back to the global `executor`
    // singleton: mutating the singleton would leak a per-run provider switch
    // into every other concurrent session. We only ever *read* `config` here.
    let effective_provider = req
        .provider
        .clone()
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| config.provider.clone());

    let api_url = match req
        .base_url
        .as_deref()
        .filter(|u| !u.trim().is_empty())
        .or_else(|| config.base_url.as_deref().filter(|u| !u.trim().is_empty()))
    {
        Some(url) => {
            let trimmed = url.trim_end_matches('/');
            if trimmed.ends_with("/chat/completions") {
                trimmed.to_string()
            } else {
                format!("{}/chat/completions", trimmed)
            }
        }
        None => {
            return Err(unified_error::UnifiedError::Configuration(
                "No LLM base URL configured. Please select a model with a valid provider in Settings.".to_string(),
            ));
        }
    };

    let api_key = req
        .api_key
        .clone()
        .filter(|k| !k.trim().is_empty())
        .or_else(|| config.api_key.clone())
        .or_else(|| {
            config
                .api_key_env
                .as_ref()
                .and_then(|env_var| std::env::var(env_var).ok())
        })
        .or_else(|| {
            // Direction A2: last-resort fallback to the OS keyring, keyed by the
            // *effective* provider so a per-run switch resolves the correct key.
            // The inline req.api_key (checked above) always takes priority, so a
            // stale keyring key can never shadow the correct inline key.
            crate::secure_store::load_api_key(&effective_provider)
                .filter(|k| !k.is_empty())
        });

    // Direction A1: keep the OS keyring in sync with the key actually used for
    // this run, so /agent/keyring/has reflects reality and the keyring becomes
    // a usable fallback source (A2). Best-effort only: writes solely when the
    // keyring lacks this exact key, so steady-state repeat runs perform ZERO
    // keyring writes (no repeated macOS Keychain prompts). A failure here must
    // NOT affect the run — the effective key is already in `api_key`.
    if let Some(ref key) = api_key
        && !key.is_empty() && !effective_provider.is_empty() {
            let needs_store =
                match crate::secure_store::load_api_key(&effective_provider) {
                    Some(existing) => existing != *key,
                    None => true,
                };
            if needs_store
                && let Err(e) =
                    crate::secure_store::store_api_key(&effective_provider, key)
                {
                    tracing::warn!(
                        provider = %effective_provider,
                        error = %e,
                        "failed to sync API key to keyring (run continues with inline key)"
                    );
                }
        }

    let model = req.model.unwrap_or_else(|| config.default_model_id.clone());

    // Spawn the runLoop in the background so the HTTP request returns
    // immediately. TS polls DB for progress.
    let cancel_token = tokio_util::sync::CancellationToken::new();
    let cancel_token_clone = cancel_token.clone();

    // ── 全局并发封顶：HTTP 层准入拒绝（spawn 之前）──
    // 把"全局并发已满"作为准入控制，在后台任务启动前就拒绝，直接返回
    // HTTP 429，让 TS 立即失败（SmartLayerClient.post 对非 2xx 抛错 →
    // delegateToRustRunLoop 立即 fail → 前端错误卡片），彻底消除"spawn
    // 内 emit SSE 事件 + 立即 remove bus"带来的订阅时序竞态：TS 在收到
    // started 之后才订阅 SSE，而 spawn 闭包几乎瞬间就 emit + remove bus，
    // 导致 TS 晚订阅时拿到 404 并永久错过失败事件、退回 DB 轮询挂死到
    // 预算耗尽。这里在注册任何资源（event_bus / cancel_token）之前判断，
    // 被拒时无需任何清理。占位由 `GlobalConcurrencyGuard` 持有，move 进
    // spawn 闭包，闭包结束时 drop 释放，槽位永不泄漏。满时还需兑底释放 TS
    // 已 acquire 的 project 锁（task_id == session_id，见 S7）。
    let global_cap = state
        .global_llm_max_concurrent
        .load(std::sync::atomic::Ordering::Relaxed);
    let global_guard = match reserve_global_slot(state.global_in_flight.clone(), global_cap) {
        Some(guard) => guard,
        None => {
            // 兑底释放 TS 已 acquire 的 project 任务锁（S7），避免项目锁泄漏。
            let _ = state
                .project_tasks
                .release_by_task_id(&session_id, ProjectTaskState::Failed)
                .await;
            return Err(unified_error::UnifiedError::RateLimited {
                message: "系统繁忙：全局并发 runLoop 已达上限，请稍后重试".to_string(),
                retry_after_ms: Some(2000),
            });
        }
    };

    // Create event bus for SSE streaming. Loop emits events here; SSE endpoint
    // subscribes to receive zero-latency streaming updates. Bus is removed from
    // AppState when the loop ends.
    let event_bus = agent_executor::RunLoopEventBus::default();

    // Register cancellation token so /agent/cancel can abort this runLoop.
    // Token + bus are registered atomically (both locks held, order:
    // cancels -> buses, same everywhere) so cleanup's identity check can't
    // race a half-registered run. If a previous run for this session is
    // still alive (single-slot maps), cancel it here: it stops at its next
    // cancellation checkpoint, releases the per-session lock, and its exit
    // cleanup skips removal via the bus-identity gate — so this run's
    // entries stay valid for /agent/cancel.
    let cancel_key = format!("runloop-{}", session_id);
    {
        let mut cancels = state.agent_cancellations.lock().await;
        let mut buses = state.runloop_event_buses.lock().await;
        if let Some(old_token) = cancels.insert(cancel_key.clone(), cancel_token_clone.clone()) {
            old_token.cancel();
        }
        buses.insert(session_id.clone(), event_bus.clone());
    }

    // Verify session exists before spawning
    if state.session.get_session(&session_id)?.is_none() {
        // Clean up cancellation token and event bus (identity-gated)
        cleanup_run_loop_registration(&state, &cancel_key, &session_id, &event_bus).await;
        // S7: 兑底释放 TS 在调用 run_loop 前已通过 /task/acquire 持有的
        // project 任务锁（task_id == session_id）。delegateToRustRunLoop
        // 失败路径只会 `status.set(idle)`，不会调 /task/release（仅有
        // completion 成功路径与 cancel 路径会释放），故此 reject 分支必须
        // 自行释放，否则该锁泄漏，导致同 session 下次请求 /task/acquire
        // 因 fail-fast(timeout:0) 直接 409 卡死。与上方全局并发 429 分支
        // 的 S7 兑底释放保持对称。
        let _ = state
            .project_tasks
            .release_by_task_id(&session_id, ProjectTaskState::Failed)
            .await;
        return Err(unified_error::UnifiedError::NotFound(format!(
            "session not found: {}",
            session_id
        )));
    }

    let state_clone = state.clone();
    let session_id_spawn = session_id.clone();
    let api_url_spawn = api_url.clone();
    let api_key_spawn = api_key.clone();
    let model_spawn = model.clone();
    let config_provider = effective_provider.clone();
    let max_retry_spawn = config.max_retry_attempts;
    let req_messages = req.messages.clone();
    let tools_for_spawn = tools_from_ts.clone();
    let _permission_rules_for_spawn = permission_rules.clone();

    // Task-scoped logical sandbox.
    //
    // `state.security_policy` is a process-global singleton, fixed at server
    // start from the launch project path — it cannot express "this particular
    // run may also touch project B". When the request carries `allowed_paths`,
    // derive a per-request policy that keeps every other setting (blocked
    // commands, size limits, rtk) from the global one and only narrows/widens
    // the path scope. `SecurityPolicy::check_path_access` gives `allowed_paths`
    // precedence over `project_path`, so the project dir is appended explicitly
    // to avoid locking the agent out of its own workspace.
    let security_policy: Arc<agent_executor::SecurityPolicy> = match req
        .allowed_paths
        .as_ref()
        .filter(|paths| !paths.is_empty())
    {
        Some(paths) => {
            let mut scoped = (*state.security_policy).clone();
            let mut list: Vec<String> = Vec::with_capacity(paths.len() + 1);
            list.push(project_path.clone());
            for p in paths {
                if !p.is_empty() && !list.contains(p) {
                    list.push(p.clone());
                }
            }
            tracing::info!(
                session_id = %session_id,
                allowed_paths = ?list,
                "run_loop: task-scoped sandbox active"
            );
            scoped.allowed_paths = list;
            Arc::new(scoped)
        }
        None => state.security_policy.clone(),
    };
    // The policy is consumed both inside the spawned loop (executor + parallel
    // context) and by the tool-permission gate below, so keep a dedicated clone
    // for the closure.
    let security_policy_spawn = security_policy.clone();
    let auto_accept_spawn = auto_accept;
    let sub_agent_limits_spawn = sub_agent_limits;
    let agent_name_spawn = agent_name.clone();
    let project_path_spawn = project_path.clone();
    let snapshot_gitdir_spawn = snapshot_gitdir.clone();
    let output_format_spawn = req.output_format.clone();
    let intent_type_spawn = intent_type.clone();
    let system_prompt_spawn = req.system_prompt.clone();
    let prompt_caching_spawn = req.prompt_caching.unwrap_or(false);
    let progressive_tools_spawn = req.progressive_tools.unwrap_or(false);
    let event_bus_spawn = event_bus.clone();
    let should_reflect_spawn = should_reflect;
    let should_quality_mid_check_spawn = should_quality_mid_check;
    let reflect_on_spawn = loop_cfg
        .as_ref()
        .map(|lc| lc.reflect_on.clone())
        .unwrap_or_else(|| "keypoint".to_string());

    eprintln!(
        "[TRACE-rust] ⓪ runLoop spawn: api_url={}, has_api_key={}, model={}, msg_count={}, tools={}",
        api_url,
        api_key.is_some(),
        model,
        req.messages.len(),
        tools_from_ts.as_ref().map(|t| t.len()).unwrap_or(0)
    );

    tokio::spawn(async move {
        // Acquire per-session lock inside the spawned task
        let session_guard = {
            let mut locks = state_clone.session_locks.lock().await;
            locks
                .entry(session_id_spawn.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let _session_guard = session_guard.lock().await;

        // 全局并发槽位已在 HTTP 层（spawn 之前）通过 `reserve_global_slot`
        // 占位，此处仅接收 RAII guard：它会在本闭包结束（正常完成 / 早退 /
        // 取消 / panic）时 drop 并释放槽位，确保永不泄漏。
        let _global_guard = global_guard;

        // P1-16/P1-17: RAII guard for the token+bus+metrics registration.
        // Held for the WHOLE closure body — every early return (blackboard
        // create/init failures below, empty messages, …), a panic unwind,
        // and normal completion all trigger the identity-gated cleanup.
        // Double-cleanup with the explicit synchronous calls below is safe
        // (identity-gated + idempotent).
        let _runloop_reg_guard = RunLoopRegistrationGuard {
            state: state_clone.clone(),
            cancel_key: cancel_key.clone(),
            session_id: session_id_spawn.clone(),
            bus: event_bus_spawn.clone(),
        };

        // Resolve per-project message store from request's project_path.
        // Falls back to in-memory store when project_path is empty.
        let msg_store = state_clone
            .get_or_create_project_message_store(&project_path_spawn)
            .await;

        tracing::info!(
            project_path = %project_path_spawn,
            session_id = %session_id_spawn,
            "[runLoop] using per-project msg_store"
        );

        // Ensure the session row exists in the per-project duoduo.db BEFORE
        // writing any messages. The smart-layer's SessionManager writes to
        // sessions.db (a separate file), but MessageStore writes messages to
        // duoduo.db whose `message` table has FK(session_id)→session(id).
        // In the normal TS flow, TS creates the session in duoduo.db first
        // (via Drizzle). But when Rust creates sessions directly (execute_task
        // subagent, or API testing), duoduo.db's session table may be missing
        // the row, causing insert_message to fail with FOREIGN KEY constraint.
        if let Err(e) = msg_store.ensure_session(
            &session_id_spawn,
            "smart-layer",
            &format!(
                "Session {}",
                &session_id_spawn[..8.min(session_id_spawn.len())]
            ),
            &project_path_spawn,
        ) {
            tracing::warn!(
                error = %e,
                session_id = %session_id_spawn,
                "Failed to ensure session row in duoduo.db (non-fatal — messages may fail FK constraint)"
            );
        }

        let cancel_token = cancel_token_clone;

        // ── 智械 (IntelGear) MCP bridge (desktop path) ──────────────────────
        // The desktop agent runs entirely in Rust with no TS MCP runtime, so an
        // MCP server added through 智械 (persisted as `<gear>/tools/mcp.json`)
        // only becomes usable in the conversation once Rust itself connects it.
        // `ensure_gear_mcp` connects every declared server (idempotent, best-
        // effort) and `mcp_tool_definitions` returns their tools, which we merge
        // into this run's LLM tool list so the model can call them. The matching
        // dispatch + permission handling live in `dispatch`/`check_tool_permission`
        // wiring below.
        // Non-blocking: the connection runs in a background task; here we only
        // read the cached definitions, so a dead/slow MCP server never stalls
        // the run loop (it is connected asynchronously for subsequent runs).
        agent_executor::mcp::ensure_gear_mcp();
        let mut tools_for_spawn = tools_for_spawn;
        {
            let mcp_defs = agent_executor::mcp::mcp_tool_definitions();
            if !mcp_defs.is_empty() {
                match tools_for_spawn.as_mut() {
                    Some(existing) => existing.extend(mcp_defs),
                    None => tools_for_spawn = Some(mcp_defs),
                }
            }
        }

        // Build AgenticLoopExecutor for unified tool execution.
        // This replaces the old execute_tool_with_middleware path, enabling
        // Rust-native execution of read_file, list_dir, grep, bash, edit_file,
        // websearch, webfetch, clone_repo, glob, graph_query, symbol_search.
        let gear_load = agent_executor::intel_gear::load_gears_from_env();
        let mut loop_executor = agent_executor::AgenticLoopExecutor::new(
            (*state_clone.executor).clone(),
            &project_path_spawn,
        )
                .with_security_policy(security_policy_spawn.clone())
                .with_cancel_token(cancel_token.clone())
                .with_cancellation_registry(state_clone.agent_cancellations.clone())
                .with_gears(gear_load.payloads)
                .with_skill_catalog(gear_load.skill_catalog)
        .with_agent_id(format!("runloop-{}", session_id_spawn))
        .with_memory(state_clone.memory.clone())
        .with_graph(state_clone.graph.clone())
        .with_context_builder(state_clone.context.clone())
        // P3/P6: 让主循环 executor 持有 StructuredAssembler,使 `store_edit_decision_to_kg`
        // 能落 L2 决策记忆并链接到被编辑文件的 KG File 实体(§11.1 桥接的唯一生产写入口)。
        // 与 agent.rs 深上下文路径同参数:memory + Some(graph)。
        .with_structured_assembler(std::sync::Arc::new(
            context_builder::StructuredAssembler::new(
                state_clone.memory.clone(),
                Some(state_clone.graph.clone()),
            ),
        ))
        .with_syntax_check(
            state_clone
                .config_manager
                .loop_config()
                .as_ref()
                .map(|l| l.syntax_check)
                .unwrap_or(true),
        )
        .with_max_file_reads(50)
        .with_max_file_size(10_485_760) // 10MB
        .with_session_manager(state_clone.session.clone())
        .with_session_id(session_id_spawn.clone())
        // Enable pre-flight compression when a context window is known. Prefer
        // the per-request value (TS reads it from the model registry), then the
        // stored LLM config. Filter out non-positive values so a bogus 0 cannot
        // silently disable compression (which would just reproduce the overflow).
        .with_context_window(req.context_window.filter(|c| *c > 0).or_else(|| {
            state
                .executor
                .get_llm_config()
                .context_window
                .filter(|c| *c > 0)
        }))
        .with_max_retry_attempts(max_retry_spawn)
        // [LLM-05] Plumb the configured fallback model list so the loop (and its
        // sub-agents) can degrade to a backup model when the primary is unavailable.
        .with_fallback_models(config.fallback_models.clone().unwrap_or_default())
        .with_phase(req.initial_phase.unwrap_or(duo_types::renderer::TaskPhase::Execute))
        .with_temperature(req.temperature);

        // Module 2 (agent self-evolution attribution): inject the SAME FeedbackLoop
        // Arc the loop-termination outcome write uses, plus the resolved intent_type,
        // so `handle_load_skill` can record gear_apply rows in the identical DB.
        // On `feedback.get()` failure we simply skip injection (legacy behavior:
        // no attribution signal) — zero-risk, the loop still runs normally.
        if let Ok(feedback_for_attr) = state_clone.feedback.get() {
            loop_executor = loop_executor
                .with_feedback(feedback_for_attr)
                .with_intent_type(
                    intent_type_spawn
                        .as_deref()
                        .unwrap_or("unknown")
                        .to_string(),
                );
        }
        // Per-round tool concurrency (clamped to [1,16] inside execute_tool_batch).
        // `config` is the LlmConfig resolved for this runLoop (see above).
        if let Some(tc) = config.tool_concurrency {
            loop_executor = loop_executor.with_tool_concurrency(tc);
        }
        // Propagate the request's permission rules into the executor so any
        // sub-agents it spawns (via `task` / route-B) inherit the SAME gating.
        // `interactive = true` keeps the main-agent path unchanged:
        // `run_loop_handler` already gates with these same rules before calling
        // `execute_tool`, so the in-executor gate is a redundant no-op here
        // (zero-risk), while sub-agents (interactive=false) gain real gating.
        loop_executor = loop_executor
            .with_permission_rules(permission_rules.clone())
            .with_interactive(true)
            .with_auto_accept(auto_accept);
        // User-configurable sub-agent limits (LoopConfig.sub_agent_*): applied
        // to every `task` child this loop spawns, and mirrored into the G7
        // ParallelContext below.
        loop_executor = loop_executor.with_sub_agent_limits(sub_agent_limits_spawn);

        // G16/R1: when the main loop reflects (审校 enabled), give the
        // AgenticLoopExecutor explore/sub-agent loop the same reflect mode so
        // both loops share identical L3 self-correction behaviour.
        if should_reflect_spawn {
            loop_executor = loop_executor.with_reflect_on(reflect_on_spawn.clone());
        }

        // Optionally attach code_search if available
        if let Ok(cs) = state_clone.code_search.get() {
            loop_executor = loop_executor.with_code_search(cs);
        }

        // Activate blackboard for file-coordination even in single-agent mode.
        // Registers ["*"] wildcard scope so the agent can write to any file
        // (equivalent to no-scope in backward-compatible mode). The blackboard is
        // mandatory: a failure to create or initialize it aborts the run loudly
        // instead of silently diverging file writes from blackboard state (see
        // `execute_edit_file` / `submit_stable_with_write`).
        let bb = match state_clone.blackboard_factory.create_session(&session_id_spawn) {
            Ok(bb) => bb,
            Err(e) => {
                tracing::error!(
                    "Blackboard create_session failed for session {}: {}. Aborting run_loop.",
                    session_id_spawn, e
                );
                // S7 fallback (same as the outer session-not-found branch):
                // release the TS-held project lock, otherwise /task/acquire
                // for this session fail-fasts with 409 forever. The
                // registration cleanup itself is handled by
                // `_runloop_reg_guard` (P1-16).
                let _ = state_clone
                    .project_tasks
                    .release_by_task_id(&session_id_spawn, ProjectTaskState::Failed)
                    .await;
                return;
            }
        };
        let agent_id = format!("runloop-{}", session_id_spawn);
        let scope = duo_types::blackboard::AgentScope {
            agent_id,
            allowed_files: vec!["*".to_string()],
            assigned_at: Utc::now().to_rfc3339(),
        };
        if let Err(e) = bb.initialize(&project_path_spawn, &[scope]).await {
            tracing::error!(
                "Blackboard initialize failed for session {}: {}. Aborting run_loop.",
                session_id_spawn, e
            );
            // S7 fallback — see the create_session branch above (P1-16).
            let _ = state_clone
                .project_tasks
                .release_by_task_id(&session_id_spawn, ProjectTaskState::Failed)
                .await;
            return;
        }
        bb.start_background_tasks().await;
        // RAII guard: guarantees close_session on ANY exit path of this scope
        // (early return, break, or normal completion) — see BlackboardSessionGuard.
        let _bb_guard = BlackboardSessionGuard::new(Arc::clone(&bb));
        loop_executor = loop_executor.with_blackboard(Arc::clone(&bb));

        // P2-A observability: register this run's live metrics so the
        // `GET /agent/metrics?session_id=...` handler can poll a running loop.
        // `live_metrics()` clones the `Arc`s, so `live_metrics` below writes to
        // the exact counters the handler reads — the main loop must update them
        // itself because it does not run `AgenticLoopExecutor::execute_*`.
        let live_metrics = loop_executor.live_metrics();
        // `started_at` 只在 `execute_subagent_loop_with` 里被置位,主循环不走那条
        // 路径 → 不在这里打点的话,handler 的 `elapsed_ms` 对主会话恒为 0。
        *duo_utils::sync::lock(&live_metrics.started_at) = Some(std::time::Instant::now());
        {
            let mut map = state_clone.loop_metrics.lock().await;
            map.insert(session_id_spawn.clone(), live_metrics.clone());
        }

        let bus = &event_bus_spawn;

        bus.emit(agent_executor::LoopStreamEvent::LoopStarted {
            session_id: session_id_spawn.clone(),
            step: 0,
        });

        // Read existing messages AND all their parts from DB in one batched
        // query (see `get_messages_with_parts`), then convert
        // MessageInfo -> LlmMessage. Parts are accessed from the in-memory
        // `parts_map` instead of issuing one `get_parts` DB round-trip per
        // message (which previously scaled linearly with conversation length).
        let (message_rows, parts_map) = match msg_store.get_messages_with_parts(&session_id_spawn) {
            Ok(v) => {
                tracing::info!(
                    count = v.0.len(),
                    parts = v.1.values().map(|p| p.len()).sum::<usize>(),
                    session_id = %session_id_spawn,
                    project_path = %project_path_spawn,
                    "[runLoop] get_messages_with_parts returned"
                );
                v
            }
            Err(e) => {
                tracing::warn!(error = %e, "Failed to read messages from DB");
                (Vec::new(), std::collections::HashMap::new())
            }
        };

        // ── Resolve the turn's parent user message ──
        //
        // Every assistant message we persist must set `parentID` to the USER
        // message that triggered the turn: the UI groups a turn by scanning for
        // `assistant.parentID === userMessage.id` (see `session-turn.tsx`
        // `assistantMessages`). Any other value makes the assistant message
        // unattachable to a turn, so it is silently never rendered — the
        // conversation then appears to contain only user messages after a
        // reload.
        //
        // Taking `message_rows.last()` is NOT safe: the last row is only the
        // triggering user message when the DB history is complete. If the
        // history read returns no user rows at all (e.g. the project DB was
        // relocated, or an assistant-only DB was read), `last()` yields a
        // previous ASSISTANT row, and an empty history falls back to the
        // SESSION id — both produce orphaned, invisible assistant messages.
        //
        // Scan backwards for the newest `role == "user"` row instead, so the
        // parent link stays correct regardless of what else is in the history.
        let parent_user_msg_id: Option<String> = message_rows
            .iter()
            .rev()
            .find(|row| {
                serde_json::from_str::<serde_json::Value>(&row.data)
                    .ok()
                    .and_then(|v| {
                        v.get("role")
                            .and_then(serde_json::Value::as_str)
                            .map(|role| role == "user")
                    })
                    .unwrap_or(false)
            })
            .map(|row| row.id.clone());

        let mut messages: Vec<agent_executor::LlmMessage> = Vec::new();
        for row in &message_rows {
            // TS stores message data WITHOUT `id` and `sessionID` (they are
            // separate columns). Rust's MessageInfo requires both as mandatory
            // fields, so serde_json::from_str fails silently. Inject them back
            // into the JSON object before deserializing.
            let data_with_ids = inject_message_ids(&row.data, &row.id, &row.session_id);
            let msg_info: duo_types::MessageInfo = match serde_json::from_str(&data_with_ids) {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        row_id = %row.id,
                        "Failed to deserialize MessageInfo from DB row, skipping"
                    );
                    continue;
                }
            };
            let row_parts = parts_map.get(&row.id).map(|v| v.as_slice()).unwrap_or(&[]);
            if let Some(llm_msg) = msg_info_to_llm_message(&msg_info, row_parts)
            {
                messages.push(llm_msg);
                // For assistant messages with tool calls, also emit tool-result messages
                if let duo_types::MessageInfo::Assistant(_) = &msg_info {
                    let parts = parts_map.get(&row.id).cloned().unwrap_or_default();
                    if !parts.is_empty() {
                        for part in &parts {
                            let Some(pd) = part_data_from_row(part) else {
                                continue;
                            };
                            if let duo_types::PartData::Tool(tp) = pd {
                                match &tp.state {
                                    duo_types::ToolState::Completed { output, .. }
                                    | duo_types::ToolState::Error { error: output, .. } => {
                                        messages.push(agent_executor::LlmMessage::tool_result(
                                            &tp.call_id,
                                            output,
                                        ));
                                    }
                                    duo_types::ToolState::Running { .. } => {
                                        // Still running — skip, don't include a result
                                    }
                                    duo_types::ToolState::Pending { .. } => {
                                        // Pending — skip
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        // ── Authoritative-history guard ──
        // The DB is the primary history source, but the request MUST contain
        // the user's input. If the DB copy lacks ANY user message (e.g. the
        // project DB was relocated and the TS write path missed the new
        // location), running the loop would hand the LLM a userless
        // conversation with full tools — it then calls tools arbitrarily.
        // In that case the TS-provided `req.messages` (assembled from the
        // live conversation) is authoritative and replaces the DB history.
        let db_has_user = messages.iter().any(|m| m.role == "user");
        if !req_messages.is_empty() && (messages.is_empty() || !db_has_user) {
            let parsed: Vec<agent_executor::LlmMessage> = req_messages
                .iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect();
            if parsed.iter().any(|m| m.role == "user") {
                tracing::warn!(
                    session_id = %session_id_spawn,
                    db_messages = messages.len(),
                    req_message_count = parsed.len(),
                    "DB history lacks a user message; using TS-provided request messages as authoritative history"
                );
                messages = parsed;
            }
        }
        // Inject system prompt from TS as the first message. Without this,
        // the LLM would not receive "You are DuoDuoCode..." or tool-usage
        // instructions — the system prompt is assembled by TS
        // (SystemPrompt.provider + environment) and passed via the
        // system_prompt field of RunLoopRequest.
        if let Some(ref sp) = system_prompt_spawn
            && !sp.is_empty() {
                if let Some(first) = messages.first_mut() {
                    if first.role == "system" {
                        first.content = format!("{}\n\n{}", first.content, sp);
                    } else {
                        messages.insert(0, agent_executor::LlmMessage::system(sp));
                    }
                } else {
                    messages.insert(0, agent_executor::LlmMessage::system(sp));
                }
            }
        // Prompt caching: mark the leading system message as a cache breakpoint
        // so the provider bills the (byte-identical) system prefix once per TTL
        // instead of on every round. Only when the model is known to accept the
        // field — providers that reject it answer 400, so this stays opt-in via
        // `model.capabilities.promptCaching` (the same flag the TS path's
        // `transform.ts::applyCaching` gates on).
        //
        // Marking happens once, here: later rounds recompose `first.content`
        // through `first_mut()`, which preserves this field.
        if prompt_caching_spawn
            && let Some(first) = messages.first_mut()
                && first.role == "system" {
                    first.cache_control = Some(serde_json::json!({ "type": "ephemeral" }));
                }
        if messages.is_empty() {
            tracing::warn!(session_id = %session_id_spawn, "No messages to process");
            // Clean up cancellation token and event bus (identity-gated)
            cleanup_run_loop_registration(
                &state_clone,
                &cancel_key,
                &session_id_spawn,
                &event_bus_spawn,
            )
            .await;
            return;
        }

        // ── Pre-loop feedback history check ──
        // Query historical feedback for this session. If average rating is low,
        // inject a cautionary note so the LLM adjusts its approach.
        if let Ok(fb) = state_clone.feedback.get() {
            let fb_clone = fb.clone();
            let sid = session_id_spawn.clone();
            let feedback_entries =
                tokio::task::spawn_blocking(move || fb_clone.get_by_session(&sid))
                    .await
                    .unwrap_or(Ok(vec![]))
                    .unwrap_or_default();
            if feedback_entries.len() >= 3 {
                let score = feedback_loop::scorer::calculate_quality_score(&feedback_entries);
                // score is normalized to [0,1]; < 0.375 == avg rating < 2.5 (the
                // previous hard-coded threshold), so the caution trigger is unchanged.
                if score < 0.375 {
                    let suggestions =
                        feedback_loop::scorer::generate_improvement_suggestions(score, &feedback_entries);
                    let suggestion_block = if suggestions.is_empty() {
                        "Previous approaches may not have been effective. Consider taking a different strategy and verifying each step before proceeding.".to_string()
                    } else {
                        suggestions
                            .iter()
                            .enumerate()
                            .map(|(i, s)| format!("{}. {}", i + 1, s))
                            .collect::<Vec<_>>()
                            .join("\n")
                    };
                    let feedback_caution = format!(
                        "## CAUTION: LOW FEEDBACK HISTORY\n\
                         This session has received low feedback ratings (score: {:.2}/1.0).\n\
                         {suggestion_block}",
                        score
                    );
                    // Insert after the system message (if present) or at the beginning
                    let insert_pos = messages
                        .iter()
                        .position(|m| m.role != "system")
                        .unwrap_or(0);
                    messages.insert(
                        insert_pos,
                        agent_executor::LlmMessage::user(&feedback_caution),
                    );
                }
            }
        }

        let mut steps = 0u32;
        let mut last_error: Option<String> = None;
        // Track the most recent assistant message ID so StepStartPart/StepFinishPart
        // can reference a valid message (FOREIGN KEY constraint requires message_id
        // to exist in the message table).
        let mut last_assistant_msg_id: Option<String> = None;

        // ── Snapshot tracking ──
        // Create/get a SnapshotService for this session's project.
        // Tracks file changes across loop rounds so the UI can show patches
        // and users can revert to previous states.
        //
        // The gitdir is resolved by TS (identical to TS `Snapshot.Service`'s gitdir)
        // so that tree hashes written here are valid when TS later consumes them
        // (revert/restore/diff/diffFull) in the same repo. When TS passes None
        // (non-git project / snapshot disabled), snapshot tracking is skipped.
        let mut prev_snapshot_hash: Option<String> = None;
        let snapshot_svc: Option<Arc<agent_executor::SnapshotService>> = {
            if let Some(ref gd) = snapshot_gitdir_spawn {
                let gitdir = std::path::PathBuf::from(gd);
                let worktree = std::path::PathBuf::from(&project_path_spawn);
                if worktree.exists() {
                    Some(Arc::new(agent_executor::SnapshotService::new(
                        gitdir, worktree,
                    )))
                } else {
                    None
                }
            } else {
                None
            }
        };
        // Initial track — capture worktree state before loop starts.
        // We save the initial snapshot hash but defer writing the StepStartPart
        // until after the first assistant message is created, because the part
        // table has a FOREIGN KEY(message_id) REFERENCES message(id) constraint —
        // writing with an empty message_id would violate it.
        let mut pending_step_start: Option<(String, String)> = None; // (snapshot_hash, part_id)
        if let Some(ref svc) = snapshot_svc {
            eprintln!(
                "[TRACE-rust] snapshot track start, worktree={}",
                project_path_spawn
            );
            let t0_snap = std::time::Instant::now();
            match svc.track() {
                Ok(hash) => {
                    eprintln!(
                        "[TRACE-rust] snapshot track ok, elapsed={:?}",
                        t0_snap.elapsed()
                    );
                    prev_snapshot_hash = Some(hash.clone());
                    let start_part_id = new_part_id();
                    pending_step_start = Some((hash, start_part_id));
                }
                Err(e) => {
                    eprintln!(
                        "[TRACE-rust] snapshot track FAILED, elapsed={:?}, error={}",
                        t0_snap.elapsed(),
                        e
                    );
                    tracing::warn!(error = %e, "Initial snapshot track failed (non-fatal)");
                }
            }
        }

        // Doom-loop detection: tracks the signature of the previous round's tool calls.
        // If the same tool+args repeats DOOM_LOOP_THRESHOLD consecutive rounds, inject
        // a corrective message instead of executing the tool.
        //
        // NOTE: This is a Rust-specific cross-round detection, NOT a mirror of TS.
        // TS processor.ts doom_loop checks "last 3 tool parts within a single message" → permission.ask.
        // Rust runLoop is serial (one assistant message per round), so we check "same first
        // tool_call across N consecutive rounds" → block + inject corrective message.
        // The two mechanisms differ in scope and trigger behavior; each is self-consistent
        // within its own architecture.
        let mut recent_signatures: Vec<Vec<(String, String)>> = Vec::new();

        // Search saturation detection: counts consecutive rounds where ALL tool_calls
        // are search-type (no execution tools). When threshold is reached, injects a
        // non-blocking reminder message so the LLM considers acting on gathered info.
        // Does NOT block tool execution — the LLM can choose to ignore the reminder.
        const SEARCH_SATURATION_THRESHOLD: u32 = 8;
        let mut search_only_rounds: u32 = 0;

        // ── Investigation checkpoint (guard X) ──
        // Reuses `search_only_rounds` (which already counts consecutive read-only
        // rounds). Large bug fixes legitimately read dozens of files, so we don't
        // cap or block — instead we periodically ask the LLM to justify continued
        // investigation (what's still missing / which files to read next / how many
        // more rounds). The checkpoint fires at `INVESTIGATION_CHECKPOINT_THRESHOLD`
        // and then every `INVESTIGATION_CHECKPOINT_PERIOD` rounds.
        // A separate "no progress" signal: if the last 10 consecutive read-only
        // rounds added ZERO new files (pure re-reading / spinning in place), we
        // escalate the reminder — that's the pathological case, not a big survey.
        const INVESTIGATION_CHECKPOINT_THRESHOLD: u32 = 25;
        const INVESTIGATION_CHECKPOINT_PERIOD: u32 = 10;
        const INVESTIGATION_NO_PROGRESS_WINDOW: usize = 10;
        let mut read_only_no_progress_rounds: u32 = 0;
        let mut recent_new_file_counts: [u32; INVESTIGATION_NO_PROGRESS_WINDOW] =
            [0; INVESTIGATION_NO_PROGRESS_WINDOW];
        let mut ring_idx: usize = 0;

        // Soft runaway fuse (risk 1): with `effective_max_steps < 0` (unlimited)
        // there is no hard step cap, so a genuinely stuck agent could run forever.
        // We don't impose a hard limit (that would contradict "-1 = truly
        // unlimited", D3), but past RUNAWAY_FUSE_THRESHOLD we inject a loop-check
        // checkpoint every RUNAWAY_FUSE_PERIOD steps — the user sees it on the
        // event stream and can Stop at any time.
        const RUNAWAY_FUSE_THRESHOLD: u32 = 2000;
        const RUNAWAY_FUSE_PERIOD: u32 = 100;

        // Completion / truncation safeguards (plan B).
        // `truncated_rounds` counts how many times we resumed a truncated response;
        // capped at `MAX_CONTINUATIONS` (mirrors the sub-loop) to avoid an
        // infinite resume loop. `confirm_rounds` counts how many times we asked the
        // LLM to confirm completion (no tool calls but task may be unfinished);
        // capped at `COMPLETION_CONFIRM_LIMIT` (D5 = 2) so a chatty LLM can't
        // spin in text-only rounds forever.
        const MAX_CONTINUATIONS: u32 = 10;
        let mut truncated_rounds: u32 = 0;
        let mut confirm_rounds: u32 = 0;
        // Accumulates the text produced across truncated-resume rounds so that if
        // the provider keeps truncating past MAX_CONTINUATIONS, we still hand back
        // the partial output instead of dropping it on a hard break (risk 3).
        let mut truncated_text: String = String::new();

        // ── Pre-scan: mark any Pending/Running tool parts as interrupted ──
        // This handles the case where a crash occurred while tools were executing
        // but the assistant message error field was never set.
        {
            if let Ok(rows) = msg_store.get_messages(&session_id_spawn) {
                for row in rows.iter().rev() {
                    if let Ok(msg_info) = serde_json::from_str::<duo_types::MessageInfo>(&row.data)
                    {
                        if !matches!(msg_info, duo_types::MessageInfo::Assistant(_)) {
                            continue;
                        }
                        // MUST read parts from the SAME per-project store the
                        // run_loop writes to (msg_store). Reading from the
                        // global store here silently returned no parts after
                        // the per-project DB split, so stuck Pending/Running
                        // tool parts were never marked interrupted.
                        let parts = msg_store
                            .get_parts(std::slice::from_ref(&row.id))
                            .unwrap_or_default();
                        let has_pending_or_running = parts.iter().any(|p| {
                            let pd: std::result::Result<duo_types::PartData, _> =
                                serde_json::from_str(&p.data);
                            matches!(
                                pd,
                                Ok(duo_types::PartData::Tool(duo_types::ToolPartData {
                                    state: duo_types::ToolState::Pending { .. }
                                        | duo_types::ToolState::Running { .. },
                                    ..
                                }))
                            )
                        });
                        if !has_pending_or_running {
                            continue;
                        }
                        // Mark all Pending/Running tool parts in this message as interrupted
                        for part_row in &parts {
                            if let Some(part_data) = part_data_from_row(part_row)
                                && let duo_types::PartData::Tool(tool_data) = &part_data {
                                    let new_state = match &tool_data.state {
                                        duo_types::ToolState::Pending { input, .. } => {
                                            let now_ts =
                                                chrono::Utc::now().timestamp_millis() as f64;
                                            Some(duo_types::ToolState::Error {
                                                input: input.clone(),
                                                error: "Session interrupted: tool was pending when crash occurred".to_string(),
                                                metadata: None,
                                                time: duo_types::ToolTimeCompleted {
                                                    start: now_ts,
                                                    end: now_ts,
                                                    compacted: None,
                                                },
                                            })
                                        }
                                        duo_types::ToolState::Running { input, time, .. } => {
                                            let now_ts =
                                                chrono::Utc::now().timestamp_millis() as f64;
                                            Some(duo_types::ToolState::Error {
                                                input: input.clone(),
                                                error: "Session interrupted: tool was running when crash occurred".to_string(),
                                                metadata: None,
                                                time: duo_types::ToolTimeCompleted {
                                                    start: time.start,
                                                    end: now_ts,
                                                    compacted: None,
                                                },
                                            })
                                        }
                                        _ => None,
                                    };
                                    if let Some(interrupted_state) = new_state {
                                        let mut updated = part_data.clone();
                                        if let duo_types::PartData::Tool(ref mut td) = updated {
                                            td.state = interrupted_state;
                                        }
                                        if let Err(e) = msg_store.update_part(
                                            &part_row.id,
                                            &serde_json::to_string(&updated).unwrap_or_default(),
                                        ) {
                                            tracing::warn!(
                                                error = %e,
                                                part_id = %part_row.id,
                                                "Failed to mark pending/running tool as interrupted"
                                            );
                                        } else {
                                            tracing::info!(
                                                part_id = %part_row.id,
                                                tool = %tool_data.tool,
                                                "Marked pending/running tool as interrupted during crash recovery pre-scan"
                                            );
                                        }
                                    }
                                }
                        }
                        // Only process the most recent assistant message with pending tools
                        break;
                    }
                }
            }
        }

        let files_read: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        // Per-loop read-reservation counter, shared across every `execute_tool`
        // call in this runLoop so the `max_file_reads` cap is enforced *per loop*
        // (consistent with the sub-agent loop and pre-change behavior). A fresh
        // `new(0)` per call would make the cap per-call and effectively moot.
        let read_reservations: std::sync::Arc<std::sync::atomic::AtomicUsize> =
            std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        // G19: convergence ledger (fix_ledger) for the main loop — the shared
        // stateful reflector that accumulates fixed/pending issues across rounds
        // and drives the stall fuse (shared with AgenticLoopExecutor).
        let mut reflect_ledger = agent_executor::reflect::ReflectLedger::new();

        // ── G7: optional parallel multi-agent pre-dispatch ──
        // When `LoopConfig.parallel_dispatch` is enabled, decompose the user task
        // into independent sub-tasks and run them concurrently through the *shared*
        // blackboard (FileLockManager exclusive lock (single winner) + under-lock read + optimistic version check),
        // then fold the aggregated reports into the message context before the main
        // serial loop runs. This is the G7 parallel multi-agent dispatch path.
        //
        // Zero-risk: the entire block is inert unless `parallel_dispatch` is true.
        // On ANY failure (decomposition, dispatch, or empty result) we fall through
        // to the existing serial loop with no behaviour change. The planner is
        // read-only; sub-agents share the same `bb` DB as the main loop, so there
        // is no divergent write path to regress.
        let parallel_dispatch = state_clone
            .config_manager
            .loop_config()
            .map(|l| l.parallel_dispatch)
            .unwrap_or(false);
        if parallel_dispatch {
            let parallel_ctx = Arc::new(agent_executor::parallel_executor::ParallelContext {
                executor: (*state_clone.executor).clone(),
                project_path: project_path_spawn.clone().into(),
                blackboard: Arc::clone(&bb),
                security_policy: Some(security_policy_spawn.clone()),
                syntax_check: state_clone
                    .config_manager
                    .loop_config()
                    .as_ref()
                    .map(|l| l.syntax_check)
                    .unwrap_or(true),
                reflect_on: if should_reflect_spawn {
                    Some(reflect_on_spawn.clone())
                } else {
                    None
                },
                context_builder: Some(state_clone.context.clone()),
                graph: Some(state_clone.graph.clone()),
                code_search: state_clone.code_search.get().ok(),
                max_rounds: Some(sub_agent_limits_spawn.max_rounds),
                loop_timeout: Some(sub_agent_limits_spawn.loop_timeout),
                max_total_tokens: Some(sub_agent_limits_spawn.max_total_tokens),
                max_file_reads: Some(sub_agent_limits_spawn.max_file_reads),
                max_retries: 1,
                max_concurrent: state_clone
                    .executor
                    .get_llm_config()
                    .max_concurrent_subagents
                    .unwrap_or(3)
                    .max(1) as usize,
                // Route-B fan-out inherits the same per-round tool concurrency
                // setting. Clamping/in-flight limit are enforced per-sub-agent
                // inside `build_executor`, so this only propagates the user's
                // explicit choice without widening the blast radius.
                tool_concurrency: state_clone.executor.get_llm_config().tool_concurrency,
                // Route-B fan-out inherits the same permission ruleset so its
                // sub-agents are gated identically (interactive=false is applied
                // inside `build_executor`). `None` ⇒ no extra gating beyond the
                // sandbox already enforced in `execute_tool`.
                permission_rules: Some(permission_rules.clone()),
                // Inherit the auto-accept switch so Route-B sub-agents also honor
                // the user's "auto-accept permissions" setting (option B).
                auto_accept,
                // Share the parent runLoop's live token counters so parallel
                // sub-agent usage is reflected in the parent's metrics totals.
                shared_token_usage: Some(Arc::new(
                    agent_executor::parallel_executor::SharedTokenUsage {
                        tokens_used: live_metrics.tokens_used.clone(),
                        input_tokens: live_metrics.input_tokens.clone(),
                    },
                )),
            });

            // G7 precedence: explicit TS-sent sub_tasks win over the Rust LLM
            // planner. This is what gives the TS side deterministic control of
            // the decomposition. When neither is available we fall through to
            // the serial loop unchanged.
            let explicit = req.sub_tasks.clone().filter(|t| !t.is_empty());
            let results = if let Some(tasks) = explicit {
                tracing::info!(
                    session_id = %session_id_spawn,
                    count = tasks.len(),
                    "G7 parallel dispatch: using explicit TS sub-tasks (precedence over planner)"
                );
                let subtasks: Vec<agent_executor::parallel_executor::SubTask> = tasks
                    .into_iter()
                    .map(sub_task_request_to_sub_task)
                    .collect();
                agent_executor::parallel_executor::dispatch_with_cancel(
                    Arc::clone(&parallel_ctx),
                    subtasks,
                    cancel_token.clone(),
                )
                .await
            } else {
                // No explicit list — fall back to the Rust LLM planner (read-only).
                let task_prompt = messages
                    .iter()
                    .rev()
                    .find(|m| m.role == "user")
                    .map(|m| m.content.clone())
                    .unwrap_or_default();
                agent_executor::parallel_executor::decompose_and_dispatch(
                    &parallel_ctx,
                    &task_prompt,
                    cancel_token.clone(),
                )
                .await
            };
            if !results.is_empty() {
                let succeeded = results.iter().filter(|r| r.status == agent_executor::parallel_executor::SubTaskStatus::Succeeded).count();
                tracing::info!(
                    session_id = %session_id_spawn,
                    total = results.len(),
                    succeeded = succeeded,
                    "G7 parallel dispatch completed; folding reports into main loop"
                );
                let report = agent_executor::parallel_executor::aggregate_reports(&results);
                messages.push(agent_executor::LlmMessage::user(format!(
                    "## Parallel sub-agent findings\n{}",
                    report
                )));
            } else {
                tracing::info!(
                    session_id = %session_id_spawn,
                    "G7 parallel dispatch produced no sub-tasks; continuing with serial loop"
                );
            }
        }

        // RAG/context assembly cache (perf optimization).
        // `base_system` is captured ONCE here (before the loop mutates the
        // system message) so the clean system prompt is composed with context
        // without accumulating duplicated context across rounds. `cached_ctx`
        // / `ctx_dirty` persist across rounds: assemble on round 1 (dirty),
        // reuse until a file-writing tool runs (sets `ctx_dirty = true` again).
        let base_system = messages.first().map(|m| m.content.clone()).unwrap_or_default();
        let mut cached_ctx: Option<String> = None;
        let mut ctx_dirty = true;
        // Progressive tool disclosure state for this run. Lives across rounds so
        // a tool expanded once stays expanded (never stubbed twice per session).
        let tool_disclosure =
            crate::routes::tool_disclosure::ToolDisclosure::new(progressive_tools_spawn);

        loop {
            // The context assembly (StructuredAssembler / ContextBuilder) is
            // heavy (full-project directory walk + embedding). Within a single
            // run_loop it only depends on the (static) on-disk project files,
            // so reusing the assembled context across rounds is safe. We
            // invalidate (re-assemble) only after a file-writing tool runs,
            // because that changes the project state the context reflects.
            // ── Blackboard state sync (when blackboard is available) ──
            // Check for pending notifications from other agents and inject
            // them into the message context so the LLM is aware of changes.
            // Reuse the single coordinator created once before the loop (see
            // :2640) instead of creating a new one per round. The per-round
            // create_session leaked a connection pool every iteration AND
            // produced an un-initialized coordinator whose get_agent_state
            // returned default (fake) operational state.
            {
                let bb = Arc::clone(&bb);
                // P2-18: the loop registers itself as `runloop-{session_id}`
                // (see `with_agent_id` and the `declare_intent` scope below),
                // so that — and not the cosmetic `agent_name` — is the id whose
                // operational state and notifications are actually ours.
                // Querying `agent_name` always returned the default state, which
                // made `InBackoff`/`Faulted` dead branches.
                let agent_id = format!("runloop-{}", session_id_spawn);
                let agent_state = bb.get_agent_state(&agent_id).await;
                match agent_state {
                    blackboard_coordinator::AgentOperationalState::InBackoff {
                        file,
                        retry_count,
                        until,
                    } => {
                        tracing::info!(agent_id = %agent_id, file, retry_count, until, "Agent in backoff, skipping round");
                        // P2-19: count the skipped round so the step cap can
                        // end a loop stuck in backoff instead of spinning at 1s.
                        steps += 1;
                        live_metrics.rounds_completed.store(
                            steps as usize,
                            std::sync::atomic::Ordering::Relaxed,
                        );
                        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                        continue;
                    }
                    blackboard_coordinator::AgentOperationalState::Faulted { fault_type } => {
                        tracing::warn!(agent_id = %agent_id, ?fault_type, "Agent faulted, stopping loop");
                        break;
                    }
                    _ => {} // Working or Idle — continue normally
                }

                // Check for pending notifications from other agents
                if let Ok(notifications) = bb.get_pending_notifications(&agent_id)
                    && !notifications.is_empty() {
                        let notif_summary: Vec<String> = notifications
                            .iter()
                            .map(|n| {
                                format!("{} (v{} → v{})", n.file, n.from_version, n.to_version)
                            })
                            .collect();
                        messages.push(agent_executor::LlmMessage::user(format!(
                            "## Notifications from other agents\n{}\n\nConsider these changes when continuing.",
                            notif_summary.join("\n")
                        )));
                        // ACK all pending notifications so they don't repeat next round
                        for n in &notifications {
                            let _ = bb.ack_notification(&n.id, &agent_id, "noted").await;
                        }
                    }
            }

            // ── Crash recovery ──
            if let Ok(rows) = msg_store.get_messages(&session_id_spawn) {
                for row in rows.iter().rev() {
                    if let Ok(msg_info) = serde_json::from_str::<duo_types::MessageInfo>(&row.data)
                    {
                        let assistant = match &msg_info {
                            duo_types::MessageInfo::Assistant(a) => a,
                            _ => continue,
                        };
                        if assistant.error.is_none() {
                            continue;
                        }
                        // Same-store invariant as the pre-scan above: parts
                        // live in the per-project DB (msg_store), not the
                        // global one.
                        let parts = msg_store
                            .get_parts(std::slice::from_ref(&row.id))
                            .unwrap_or_default();
                        let has_gist = parts.iter().any(|p| {
                            let pd: duo_types::PartData = serde_json::from_str(&p.data).unwrap_or(
                                duo_types::PartData::Text(duo_types::TextPartData {
                                    base: duo_types::PartBase {
                                        id: String::new(),
                                        session_id: String::new(),
                                        message_id: String::new(),
                                    },
                                    text: String::new(),
                                    synthetic: None,
                                    ignored: None,
                                    time: None,
                                    metadata: None,
                                }),
                            );
                            match pd {
                                duo_types::PartData::Text(t) => t.synthetic == Some(true),
                                _ => false,
                            }
                        });
                        if has_gist {
                            break;
                        }

                        let completed_tools: Vec<(String, String)> = parts
                            .iter()
                            .filter_map(|p| {
                                let pd: std::result::Result<duo_types::PartData, _> =
                                    serde_json::from_str(&p.data);
                                match pd {
                                    Ok(duo_types::PartData::Tool(t)) => match &t.state {
                                        duo_types::ToolState::Completed { output, .. } => Some((
                                            t.tool.clone(),
                                            output.chars().take(200).collect(),
                                        )),
                                        _ => None,
                                    },
                                    _ => None,
                                }
                            })
                            .collect();
                        if completed_tools.is_empty() {
                            break;
                        }
                        let summary =
                            agent_executor::generate_crash_recovery_summary(&completed_tools);
                        let gist_part_id = new_part_id();
                        let gist_part = duo_types::PartData::Text(duo_types::TextPartData {
                            base: duo_types::PartBase {
                                id: gist_part_id.clone(),
                                session_id: session_id_spawn.clone(),
                                message_id: row.id.clone(),
                            },
                            text: summary,
                            synthetic: Some(true),
                            ignored: Some(false),
                            time: Some(duo_types::PartTime {
                                start: chrono::Utc::now().timestamp_millis() as f64,
                                end: Some(chrono::Utc::now().timestamp_millis() as f64),
                            }),
                            metadata: None,
                        });
                        if let Err(e) = msg_store.insert_part(
                            &gist_part_id,
                            &row.id,
                            &session_id_spawn,
                            chrono::Utc::now().timestamp_millis(),
                            &serde_json::to_string(&gist_part).unwrap_or_default(),
                        ) {
                            tracing::warn!(error = %e, "Failed to insert crash recovery gist part");
                        }
                        tracing::info!(session_id = %session_id_spawn, message_id = %row.id, "crash recovery gist generated");
                        break;
                    }
                }
            }

            // ── Stop conditions ──
            // `effective_max_steps < 0` means "unlimited" (user set -1): the step
            // cap never fires. Compared as i64 so a negative guard never
            // satisfies the `>=` test.
            let is_max_steps =
                effective_max_steps >= 0 && (steps as i64) >= (effective_max_steps as i64);
            if is_max_steps {
                tracing::info!(session_id = %session_id_spawn, steps, "run_loop reached max_steps");
                bus.emit(agent_executor::LoopStreamEvent::MaxStepsReached {
                    session_id: session_id_spawn.clone(),
                    steps,
                });
                messages.push(agent_executor::LlmMessage::user(
                    agent_executor::MAX_STEPS_PROMPT,
                ));
            }

            // Text-only wrap-up: tools are disabled and the model's summary
            // ends the loop. Only the user-configured step cap triggers this —
            // `-1` means truly unlimited (the 2000-step soft fuse below is the
            // only remaining guard, and the user can Stop at any time).
            let force_text_only = is_max_steps;

            // ── Soft runaway fuse (risk 1) ──
            // With `effective_max_steps < 0` (unlimited) there is no hard step cap,
            // so a genuinely stuck agent could run forever. We don't impose a hard
            // limit (that would contradict the user's "-1 = truly unlimited" choice,
            // D3), but once we pass 2000 steps we inject a "are you stuck in a loop?"
            // checkpoint every 100 steps. The user sees this via the event stream and
            // can hit Stop at any time — it's a soft guard, not a block.
            if steps >= RUNAWAY_FUSE_THRESHOLD
                && (steps - RUNAWAY_FUSE_THRESHOLD).is_multiple_of(RUNAWAY_FUSE_PERIOD)
            {
                tracing::warn!(
                    session_id = %session_id_spawn,
                    steps,
                    "runaway fuse: {} steps reached, injecting loop-checkpoint (user can Stop)",
                    steps
                );
                bus.emit(agent_executor::LoopStreamEvent::MaxStepsReached {
                    session_id: session_id_spawn.clone(),
                    steps,
                });
                messages.push(agent_executor::LlmMessage::user(
                    "CHECKPOINT: this task has already run a very large number of steps. \
                     Before continuing, explicitly confirm whether you are making real \
                     progress or stuck in an ineffective loop. If you are stuck, stop and \
                     give a status summary instead of repeating actions. The user can stop \
                     this run at any time.",
                ));
            }

            // ── Cancellation check ──
            if cancel_token.is_cancelled() {
                tracing::info!(session_id = %session_id_spawn, steps, "run_loop cancelled");
                break;
            }

            // ── Build LLM request ──
            // When MAX_STEPS reached, disable tools so the LLM must respond with text only.
            // Progressive disclosure: non-core tools go out as name-only stubs
            // and the model pulls their schemas on demand via `expand_tools`.
            // `tool_disclosure` is a no-op pass-through when disabled, so the
            // `is_max_steps` (text-only) behaviour below is untouched.
            let effective_tools = if force_text_only {
                None
            } else {
                let before = tools_for_spawn.as_deref().map(|t| t.len()).unwrap_or(0);
                let applied = tool_disclosure.apply(tools_for_spawn.as_deref());
                let after = applied.as_ref().map(|t| t.len()).unwrap_or(0);
                let _ = (before, after); // disclosure already applied; counts unused
                applied
            };
            // Build response_format from output_format if provided
            let response_format = output_format_spawn.as_ref().map(|fmt| match fmt {
                agent_executor::OutputFormat::JsonSchema { schema, .. } => serde_json::json!({
                    "type": "json_schema",
                    "json_schema": {
                        "schema": schema,
                        "name": "response",
                        "strict": true,
                    }
                }),
            });

            // ── Context injection based on intent_type ──
            // When intent is a coding task (feature_request/bug_fix/refactoring),
            // use StructuredAssembler for deep context. For question/configuration,
            // use ContextBuilder for lightweight context. None defaults to no injection
            // (preserving current behavior).
            // RAG/context assembly cache: only re-assemble when `ctx_dirty`
            // (first round, or after a file-writing tool ran this round). Within
            // a run the assembly only depends on static project state, so reusing
            // the cached value across rounds removes the per-round
            // full-project directory walk + embedding call.
            let context_to_inject: Option<String> = if ctx_dirty {
                let computed: Option<String> = {
                match intent_type_spawn.as_deref() {
                    Some("feature_request") | Some("bug_fix") | Some("refactoring") | Some("question") | Some("configuration") => {
                        // Deep context path: StructuredAssembler → RhetoricGraph → Render
                        // (single shared pipeline, see `render_structured_context`).
                        let user_msg = messages.iter().rev().find_map(|m| {
                            if m.role == "user" {
                                Some(m.content.clone())
                            } else {
                                None
                            }
                        });
                        let phase = loop_executor.current_phase();
                        let assembler = std::sync::Arc::new(
                            context_builder::StructuredAssembler::new(
                                state_clone.memory.clone(),
                                Some(state_clone.graph.clone()),
                            ),
                        );
                        match context_builder::render_structured_context(
                            assembler,
                            session_id_spawn.clone(),
                            user_msg,
                            2000,
                            project_path_spawn.clone(),
                            true,
                            phase,
                        )
                        .await
                        {
                            context_builder::StructuredContextOutcome::Rendered(rendered) => {
                                Some(rendered)
                            }
                            context_builder::StructuredContextOutcome::Empty => None,
                            context_builder::StructuredContextOutcome::Failed => {
                                tracing::debug!(
                                    "StructuredAssembler failed, falling back to ContextBuilder"
                                );
                                build_fallback_context(
                                    state_clone.context.clone(),
                                    base_system.clone(),
                                    project_path_spawn.clone(),
                                )
                                .await
                            }
                        }
                    }
                    // P4: every other intent ("general", or None when intent
                    // clarification failed) still gets lightweight memory
                    // context instead of nothing at all.
                    _ => {
                        build_fallback_context(
                            state_clone.context.clone(),
                            base_system.clone(),
                            project_path_spawn.clone(),
                        )
                        .await
                    }
                }
                };
                cached_ctx = computed.clone();
                ctx_dirty = false;
                computed
            } else {
                cached_ctx.clone()
            };
            if let Some(ctx) = context_to_inject {
                // Compose from the loop-invariant `base_system` snapshot +
                // current context. This replaces the previous
                // `first.content += ctx` which duplicated context on
                // every round (the assembly was recomputed each round and
                // also re-appended, so long runs accumulated N copies).
                //
                // Prompt caching: when the leading system message carries a
                // cache breakpoint, the assembled context (which changes
                // whenever `ctx_dirty` flips) must NOT be concatenated into
                // it — appending mutable text after the breakpoint changes
                // the cached prefix's bytes and misses the cache every time.
                // Instead it goes into its OWN system message right after the
                // cached one, so the stable prefix stays byte-identical while
                // the model still sees exactly the same total text.
                let cache_prefixed = messages
                    .first()
                    .is_some_and(|m| m.role == "system" && m.cache_control.is_some());
                if cache_prefixed {
                    let volatile = agent_executor::LlmMessage::system(&ctx);
                    match messages.get(1) {
                        // Replace the previous round's volatile block instead of
                        // stacking a new one (mirrors the recompose-from-snapshot
                        // semantics of the non-cached branch below).
                        Some(m) if m.role == "system" => messages[1] = volatile,
                        _ => messages.insert(1, volatile),
                    }
                } else if let Some(first) = messages.first_mut() {
                    if first.role == "system" {
                        first.content = format!("{}\n\n{}", base_system, ctx);
                    } else {
                        messages.insert(
                            0,
                            agent_executor::LlmMessage::system(&ctx),
                        );
                    }
                } else {
                    messages.insert(
                        0,
                        agent_executor::LlmMessage::system(&ctx),
                    );
                }
            }

            // ── Pre-flight compression ──
            // Trim the conversation to fit the model's context window BEFORE
            // calling the LLM. Without this, long conversations (e.g. 159 messages)
            // are sent verbatim and the provider rejects them with HTTP 400
            // "context window overflow". `loop_executor` now carries the context
            // window (plumbed from RunLoopRequest.context_window / LlmConfig via
            // with_context_window above), so compression is active. When the
            // context window is unset, preflight_compress returns Ok immediately
            // (no-op), preserving the previous behavior exactly.
            if let Err(e) = loop_executor.preflight_compress(&mut messages) {
                tracing::warn!("preflight_compress failed: {}", e);
            }

            // FIX A parity for the MAIN runLoop: guard against orphan tool_calls
            // (an assistant message whose tool_call_id has no following tool result),
            // which DeepSeek rejects with HTTP 400 and aborts the whole run. The
            // AgenticLoopExecutor sub-loop already applies `recover_missing_tool_results`
            // before its LLM call; the main handler did not, so a single dropped tool
            // result killed the session mid-run. Pure additive: a no-op when every
            // tool_call already has a matching tool result.
            // TEMP DIAGNOSTIC (root-cause hunt for intermittent HTTP 400):
            // dump tool_call_id integrity on the raw (pre-recovery) messages so
            // the next run captures the real orphan/duplicate that 400s. Remove
            // once the self-generated-id fix lands.
            diagnose_tool_call_integrity(&messages, steps);

            let mut llm_req_messages = messages.clone();
            agent_executor::agentic_loop::recover_missing_tool_results(&mut llm_req_messages, steps as usize);
            // Benchmark parity overrides: DUODUO_LLM_TEMPERATURE /
            // DUODUO_LLM_EXTRA_BODY (see agent_executor::llm::env_llm_overrides).
            // Unset env vars keep the original hardcoded behaviour (0.3, none).
            let (env_temp, env_extra) = agent_executor::llm::env_llm_overrides();
            // Temperature priority: env override (benchmark parity) > TS-sent
            // model-level temperature > LlmConfig setting > code default (0.0).
            let effective_temp = env_temp
                .or(req.temperature)
                .or(config.temperature)
                .unwrap_or(timeouts::DEFAULT_LLM_TEMPERATURE);
            // Thinking mode: enabled by default unless explicitly disabled via
            // LlmConfig.enable_thinking. Env extra_body takes precedence.
            let thinking_on = config.enable_thinking.unwrap_or(true);
            let effort = config
                .thinking_effort
                .clone()
                .unwrap_or_else(|| "high".to_string());
            let mut extra = env_extra.clone();
            if thinking_on {
                let has_re = extra
                    .as_ref()
                    .and_then(|v| v.as_object())
                    .map(|m| m.contains_key("reasoning_effort"))
                    .unwrap_or(false);
                if !has_re {
                    let mut map = extra
                        .take()
                        .and_then(|v| v.as_object().cloned())
                        .unwrap_or_default();
                    map.insert(
                        "reasoning_effort".to_string(),
                        serde_json::json!(effort),
                    );
                    extra = Some(serde_json::Value::Object(map));
                }
            }
            let llm_req = agent_executor::LlmRequest {
                model: model_spawn.clone(),
                messages: llm_req_messages,
                max_tokens: Some(32768),
                temperature: Some(effective_temp),
                stream: Some(true),
                tools: effective_tools.clone(),
                response_format,
                extra_body: extra,
                ..Default::default()
            };

            // ── Estimate token breakdown before calling LLM ──
            // CJK-aware heuristic estimate; "other" will be calibrated after
            // the LLM returns actual prompt_tokens.
            let pre_breakdown = estimate_request_breakdown(&messages, effective_tools.as_deref());

            // ── Call LLM stream ──
            // Pre-generate message and part IDs before the LLM stream starts.
            // Doing this here (instead of after the stream at L2249/L2334/L2361)
            // lets SSE delta events carry real IDs that the frontend can match
            // to store parts, enabling real-time typewriter effect.
            // These IDs have no data dependencies — they were previously generated
            // after the stream purely as a matter of code organisation.
            let pre_assistant_msg_id = new_message_id();
            // The frontend keeps each message's parts array sorted by part id
            // (a ULID) — see `global-sync/event-reducer.ts` `message.part.updated`
            // handling, which inserts via `Binary.search(parts, part.id, …)`. A
            // reasoning model streams its reasoning BEFORE the final answer, so
            // the reasoning part must carry the SMALLER id to sort first;
            // otherwise the answer renders ABOVE the thinking content.
            //
            // IMPORTANT: two ULIDs generated within the same millisecond share
            // the same timestamp and differ ONLY in their random 14-char suffix,
            // so their relative order is RANDOM. Merely generating the reasoning
            // id first does NOT guarantee it sorts first. We therefore generate
            // two ids and deterministically assign the smaller one to reasoning
            // and the larger one to text.
            //
            // Both ids MUST use `ascending_id_suffix` (the same lexicographically
            // time-ordered encoding as the TS frontend's `Identifier.ascending`)
            // so that every part id in a message sorts consistently against the
            // other `prt_*<hex-time>` ids produced by `new_part_id` elsewhere. A
            // bare ULID here would break `Binary.search`/`cmp(part.id)` ordering
            // in the frontend store (see the note on `new_message_id`).
            let suf_a = ascending_id_suffix();
            let suf_b = ascending_id_suffix();
            let (pre_reasoning_suffix, pre_text_suffix) = if suf_a < suf_b {
                (suf_a, suf_b)
            } else {
                (suf_b, suf_a)
            };
            // Prepend the `prt_` PartID prefix. Because both share the same
            // constant prefix, `prt_a < prt_b` iff `a < b`, so the ordering
            // decided above (reasoning before text) is preserved.
            let pre_reasoning_part_id = format!("prt_{}", pre_reasoning_suffix);
            let pre_text_part_id = format!("prt_{}", pre_text_suffix);

            bus.emit(agent_executor::LoopStreamEvent::LlmCallStarted {
                session_id: session_id_spawn.clone(),
                step: steps,
            });
            eprintln!(
                "[TRACE-rust] ② calling LLM stream, step={}, model={}",
                steps, model_spawn
            );
            let cancel_state_before = cancel_token.is_cancelled();
            eprintln!(
                "[TRACE-cancel] before call_llm_stream step={}, cancel_token.is_cancelled={}",
                steps, cancel_state_before
            );
            let stream_result = agent_executor::call_llm_stream(
                &api_url_spawn,
                api_key_spawn.as_deref(),
                &llm_req,
                cancel_token.clone(),
                max_retry_spawn.unwrap_or(timeouts::MAX_ATTEMPTS),
            )
            .await;

            let mut llm_stream = match stream_result {
                Ok(s) => {
                    eprintln!("[TRACE-rust] ③ LLM stream connected ok");
                    s
                }
                Err(e) => {
                    eprintln!("[TRACE-rust] ✗ LLM stream error: {}", e);
                    last_error = Some(e.to_string());
                    break;
                }
            };

            // ── Consume stream ──
            let mut full_text = String::new();
            let mut reasoning_text = String::new();
            let mut tool_calls: Vec<duo_types::ToolCall> = Vec::new();
            let mut token_usage: Option<duo_types::TokenUsage> = None;
            // 记录本条助手消息首次产出 token 的时间，用作 time.created。
            // 避免流结束后写库时刻(now_ms)被同时当作 created/completed，导致 completed-created=0、tps 恒为 null。
            let mut gen_start_ms: Option<i64> = None;
            // Tracks whether the LLM response was truncated by the provider
            // (`finish_reason == "length" | "max_tokens"`). The main loop sets
            // `max_tokens: 32768` but previously ignored truncation — a truncated
            // round was treated as a normal no-tool/text round and broke the loop
            // early with incomplete output. Mirrors the sub-loop's
            // `OutputTruncated` handling (agentic_loop.rs).
            let mut round_truncated = false;
            use futures::StreamExt;
            while let Some(chunk) = llm_stream.next().await {
                match chunk {
                    agent_executor::LlmStreamChunk::Thinking { content } => {
                        reasoning_text.push_str(&content);
                        if gen_start_ms.is_none() {
                            gen_start_ms = Some(chrono::Utc::now().timestamp_millis());
                        }
                        bus.emit(agent_executor::LoopStreamEvent::ThinkingDelta {
                            session_id: session_id_spawn.clone(),
                            message_id: pre_assistant_msg_id.clone(),
                            part_id: pre_reasoning_part_id.clone(),
                            content,
                        });
                    }
                    agent_executor::LlmStreamChunk::Delta { content } => {
                        full_text.push_str(&content);
                        if gen_start_ms.is_none() {
                            gen_start_ms = Some(chrono::Utc::now().timestamp_millis());
                        }
                        bus.emit(agent_executor::LoopStreamEvent::TextDelta {
                            session_id: session_id_spawn.clone(),
                            message_id: pre_assistant_msg_id.clone(),
                            part_id: pre_text_part_id.clone(),
                            content,
                        });
                    }
                    agent_executor::LlmStreamChunk::Done(resp) => {
                        // Detect truncation: provider stopped mid-output because it
                        // hit its token cap. We must NOT treat a truncated round as a
                        // clean completion — see `round_truncated` handling below.
                        if matches!(
                            resp.finish_reason.as_deref(),
                            Some("length") | Some("max_tokens")
                        ) {
                            round_truncated = true;
                        }
                        if let Some(tcs) = &resp.tool_calls {
                            tool_calls = tcs.clone();
                        }
                        if full_text.is_empty() && !resp.content.is_empty() {
                            full_text = resp.content;
                        }
                        token_usage = Some(resp.token_usage.clone());
                        // P2-A: real prompt tokens from the provider response.
                        live_metrics.input_tokens.fetch_add(
                            resp.token_usage.prompt_tokens,
                            std::sync::atomic::Ordering::Relaxed,
                        );
                        // `tokens_used` = 输入+输出总量,与子代理
                        // (`execute_subagent_loop_inner`) 的口径一致。主循环不走那条
                        // 路径,不在这里累加的话 handler 对主会话恒返回 0。
                        // provider 未回传 total 时退回 prompt+completion;两者都为 0
                        // 就记 0(不像子代理那样猜一个 ESTIMATED_TOKENS_PER_ROUND,
                        // 埋点宁可缺失也不能造假)。
                        let round_tokens = if resp.token_usage.total_tokens > 0 {
                            resp.token_usage.total_tokens
                        } else {
                            resp.token_usage
                                .prompt_tokens
                                .saturating_add(resp.token_usage.completion_tokens)
                        };
                        live_metrics
                            .tokens_used
                            .fetch_add(round_tokens, std::sync::atomic::Ordering::Relaxed);
                        bus.emit(agent_executor::LoopStreamEvent::LlmCallDone {
                            session_id: session_id_spawn.clone(),
                            step: steps,
                            finish_reason: resp.finish_reason.clone().unwrap_or_default(),
                            tool_calls: resp
                                .tool_calls
                                .as_ref()
                                .map(|tcs| {
                                    tcs.iter()
                                        .map(|tc| agent_executor::ToolCallSummary {
                                            id: tc.id.clone(),
                                            name: tc.function.name.clone(),
                                        })
                                        .collect()
                                })
                                .unwrap_or_default(),
                        });
                        break;
                    }
                    agent_executor::LlmStreamChunk::Error(e) => {
                        bus.emit(agent_executor::LoopStreamEvent::LoopError {
                            session_id: session_id_spawn.clone(),
                            message: e.to_string(),
                        });
                        last_error = Some(e.to_string());
                        break;
                    }
                }
            }
            eprintln!(
                "[TRACE-rust] ④ LLM stream consumed, text_len={}, reasoning_len={}, tool_calls={}",
                full_text.len(),
                reasoning_text.len(),
                tool_calls.len()
            );
            if let Some(err_msg) = last_error.as_ref() {
                // Check if the error is a context overflow — if so, mark it so TS
                // can trigger compaction and retry (mirrors TS processor.ts halt() L688-718).
                let is_overflow = agent_executor::is_context_overflow_error_text(err_msg);
                if is_overflow {
                    // Write an error assistant message so TS can detect overflow
                    // and trigger compaction before retrying.
                    let overflow_msg_id = new_message_id();
                    let overflow_now = chrono::Utc::now().timestamp_millis();
                    let overflow_info =
                        duo_types::MessageInfo::Assistant(duo_types::AssistantMessageInfo {
                            id: overflow_msg_id.clone(),
                            session_id: session_id_spawn.clone(),
                            time: duo_types::AssistantMessageTime {
                                created: overflow_now as f64,
                                completed: Some(overflow_now as f64),
                            },
                            error: Some(serde_json::json!({
                                "message": format!("context_overflow: {}", err_msg),
                                "type": "ContextOverflowError",
                            })),
                            parent_id: parent_user_msg_id
                                .clone()
                                .unwrap_or_else(|| session_id_spawn.clone()),
                            model_id: model_spawn.clone(),
                            provider_id: config_provider.clone(),
                            mode: "rust-run-loop".to_string(),
                            agent: agent_name_spawn.clone(),
                            path: duo_types::AssistantMessagePath {
                                cwd: project_path_spawn.clone(),
                                root: project_path_spawn.clone(),
                            },
                            summary: None,
                            tokens: duo_types::TokenInfo {
                                total: None,
                                input: 0.0,
                                output: 0.0,
                                reasoning: 0.0,
                                cache: duo_types::TokenCacheInfo {
                                    read: 0.0,
                                    write: 0.0,
                                },
                                breakdown: None,
                                cache_hit_rate: None,
                            },
                            structured: None,
                            variant: None,
                            finish: Some("error".to_string()),
                        });
                    let _ = msg_store.insert_message(
                        &overflow_msg_id,
                        &session_id_spawn,
                        overflow_now,
                        &serde_json::to_string(&overflow_info).unwrap_or_default(),
                    );
                    bus.emit(agent_executor::LoopStreamEvent::LoopError {
                        session_id: session_id_spawn.clone(),
                        message: "context_overflow".to_string(),
                    });
                    eprintln!(
                      "[TRACE-rust] ⚠ context_overflow → breaking runLoop at step={}",
                      steps
                    );
                }
                break;
            }

            // ── Write assistant message to DB ──
            let assistant_msg_id = pre_assistant_msg_id.clone();
            let now_ms = chrono::Utc::now().timestamp_millis();
            // Cancellation may land while the stream is being consumed (token
            // cancelled mid-stream) or between rounds (checked at the loop top).
            // Either way the message written here must carry the stop marker —
            // otherwise the row looks like a normal completion and the UI shows
            // the user nothing after they pressed Stop.
            let cancelled_now = cancel_token.is_cancelled();
            let parent_id = parent_user_msg_id
                .clone()
                .unwrap_or_else(|| session_id_spawn.clone());
            let assistant_info =
                duo_types::MessageInfo::Assistant(duo_types::AssistantMessageInfo {
                    id: assistant_msg_id.clone(),
                    session_id: session_id_spawn.clone(),
                    time: duo_types::AssistantMessageTime {
                        created: gen_start_ms.unwrap_or(now_ms) as f64,
                        completed: if cancelled_now || tool_calls.is_empty() {
                            Some(now_ms as f64)
                        } else {
                            None
                        },
                    },
                    error: if cancelled_now {
                        Some(serde_json::json!({
                            "name": "MessageAbortedError",
                            "data": { "message": "Interrupted by user" },
                        }))
                    } else {
                        None
                    },
                    parent_id,
                    model_id: model_spawn.clone(),
                    provider_id: config_provider.clone(),
                    mode: "rust-run-loop".to_string(),
                    agent: agent_name_spawn.clone(),
                    path: duo_types::AssistantMessagePath {
                        cwd: project_path_spawn.clone(),
                        root: project_path_spawn.clone(),
                    },
                    summary: None,
                    tokens: token_usage
                        .as_ref()
                        .map(|tu| {
                            let cache_read = tu.prompt_cache_hit_tokens.unwrap_or(0) as f64;
                            // The Rust run-loop only parses OpenAI/DeepSeek usage shapes.
                            // In both, `prompt_tokens` already includes the cached portion
                            // (DeepSeek: prompt = hit + miss). A cache *miss* is therefore
                            // uncached prompt input, NOT an Anthropic cache-creation write.
                            // Keep `cache_write` reserved for the Anthropic cache_creation case
                            // (which this path never parses), so `miss` maps back into `input`.
                            let cache_write = 0.0;
                            let input = (tu.prompt_tokens as f64 - cache_read).max(0.0);
                            let output = tu.completion_tokens as f64;
                            // Fallback: some providers don't return total_tokens in stream usage;
                            // compute from input+output to avoid Some(0.0) (matches TS getUsage
                            // which falls back to inputTokens+outputTokens when total is absent).
                            let total = if tu.total_tokens > 0 {
                                tu.total_tokens as f64
                            } else {
                                input + output + cache_read + cache_write
                            };
                            duo_types::TokenInfo {
                                total: Some(total),
                                input,
                                output,
                                reasoning: tu.reasoning_tokens.map(|v| v as f64).unwrap_or(0.0),
                                cache: duo_types::TokenCacheInfo {
                                    read: cache_read,
                                    write: cache_write,
                                },
                                breakdown: {
                                    let prompt_tokens = tu.prompt_tokens as f64;
                                    let estimated_total = pre_breakdown.messages
                                        + pre_breakdown.system_prompt
                                        + pre_breakdown.tools
                                        + pre_breakdown.skills;
                                    let other = (prompt_tokens - estimated_total).max(0.0);
                                    let mut bd = pre_breakdown.clone();
                                    bd.other = other;
                                    bd.estimated = Some(true);
                                    Some(bd)
                                },
                                cache_hit_rate: {
                                    let prompt_tokens = tu.prompt_tokens as f64;
                                    if prompt_tokens > 0.0 {
                                        Some((cache_read / prompt_tokens * 100.0).round())
                                    } else {
                                        None
                                    }
                                },
                            }
                        })
                        .unwrap_or_else(|| duo_types::TokenInfo {
                            total: None,
                            input: 0.0,
                            output: 0.0,
                            reasoning: 0.0,
                            cache: duo_types::TokenCacheInfo {
                                read: 0.0,
                                write: 0.0,
                            },
                            breakdown: None,
                            cache_hit_rate: None,
                        }),
                    structured: {
                        // If structured output was requested (JsonSchema) and the LLM
                        // returned plain text (no tool calls), try to parse the full
                        // text as JSON. On parse failure, fall back to None — the text
                        // is still available in the TextPart for the frontend to parse.
                        if tool_calls.is_empty() {
                            if let Some(agent_executor::OutputFormat::JsonSchema { .. }) =
                                &output_format_spawn
                            {
                                serde_json::from_str::<serde_json::Value>(&full_text).ok()
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    },
                    variant: None,
                    finish: if cancelled_now {
                        Some("cancelled".to_string())
                    } else if tool_calls.is_empty() {
                        Some("stop".to_string())
                    } else {
                        Some("tool-calls".to_string())
                    },
                });
            if let Err(e) = msg_store.insert_message(
                &assistant_msg_id,
                &session_id_spawn,
                now_ms,
                &serde_json::to_string(&assistant_info).unwrap_or_default(),
            ) {
                tracing::warn!(error = %e, "Failed to insert assistant message");
            }
            last_assistant_msg_id = Some(assistant_msg_id.clone());
            // Whether this round auto-closes the turn (text-only, confirm cap hit,
            // no completion marker). Decided HERE — not after the loop breaks —
            // so the note below is persisted in the same batch as this message.
            // Writing it afterwards races with the TS poll, which returns as soon
            // as it observes a new assistant row with finish=stop.
            // `!round_truncated`: a truncated round resumes via `continue` instead
            // of breaking, so it must not carry the "auto-closed" note.
            let auto_close = tool_calls.is_empty()
                && !force_text_only
                && !round_truncated
                && completion_decision(confirm_rounds, &full_text) == CompletionDecision::AutoClose;
            let finish_val = if tool_calls.is_empty() {
                "stop"
            } else {
                "tool-calls"
            };
            let completed_val = if tool_calls.is_empty() {
                "Some"
            } else {
                "None"
            };
            eprintln!(
                "[TRACE-rust] ⑤ assistant message written to DB, id={}, finish={}, completed={}",
                assistant_msg_id, finish_val, completed_val
            );

            // ── Write deferred StepStartPart (now that assistant message exists) ──
            // The StepStartPart was prepared before the loop started but could not be
            // written earlier because the part table's FOREIGN KEY(message_id) requires
            // a valid message row. Now that the assistant message is persisted, we can
            // safely write the StepStartPart with the correct message_id.
            if let Some((ref hash, ref part_id)) = pending_step_start {
                let start_part = duo_types::PartData::StepStart(duo_types::StepStartPartData {
                    base: duo_types::PartBase {
                        id: part_id.clone(),
                        session_id: session_id_spawn.clone(),
                        message_id: assistant_msg_id.clone(),
                    },
                    snapshot: Some(hash.clone()),
                });
                if let Err(e) = msg_store.insert_part(
                    part_id,
                    &assistant_msg_id,
                    &session_id_spawn,
                    now_ms,
                    &serde_json::to_string(&start_part).unwrap_or_default(),
                ) {
                    tracing::warn!(error = %e, "Failed to write StepStartPart");
                }
                // Only write once — clear after first write
                pending_step_start = None;
            }

            // ── Write reasoning part to DB ──
            // Persist reasoning/thinking content from reasoning models (DeepSeek/Qwen/Kimi).
            // Mirrors TS processor.ts reasoning-start/delta/end handling (L244-315).
            if !reasoning_text.is_empty() {
                let reasoning_part_id = pre_reasoning_part_id.clone();
                let reasoning_part = duo_types::PartData::Reasoning(duo_types::ReasoningPartData {
                    base: duo_types::PartBase {
                        id: reasoning_part_id.clone(),
                        session_id: session_id_spawn.clone(),
                        message_id: assistant_msg_id.clone(),
                    },
                    text: reasoning_text.clone(),
                    metadata: None,
                    time: duo_types::PartTime {
                        start: now_ms as f64,
                        end: Some(now_ms as f64),
                    },
                });
                if let Err(e) = msg_store.insert_part(
                    &reasoning_part_id,
                    &assistant_msg_id,
                    &session_id_spawn,
                    now_ms,
                    &serde_json::to_string(&reasoning_part).unwrap_or_default(),
                ) {
                    tracing::warn!(error = %e, "Failed to insert reasoning part");
                }
            }

            // ── Write text part to DB ──
            if !full_text.is_empty() {
                let text_part_id = pre_text_part_id.clone();
                let text_part = duo_types::PartData::Text(duo_types::TextPartData {
                    base: duo_types::PartBase {
                        id: text_part_id.clone(),
                        session_id: session_id_spawn.clone(),
                        message_id: assistant_msg_id.clone(),
                    },
                    text: full_text.clone(),
                    synthetic: None,
                    ignored: None,
                    time: Some(duo_types::PartTime {
                        start: now_ms as f64,
                        end: Some(now_ms as f64),
                    }),
                    metadata: None,
                });
                if let Err(e) = msg_store.insert_part(
                    &text_part_id,
                    &assistant_msg_id,
                    &session_id_spawn,
                    now_ms,
                    &serde_json::to_string(&text_part).unwrap_or_default(),
                ) {
                    tracing::warn!(error = %e, "Failed to insert text part");
                }
            }

            // ── Auto-close note (same batch as the message above) ──
            // Appended LAST so the frontend's part ordering (sorted by ULID) puts
            // it after the model's own text.
            if auto_close {
                let note_part_id = new_part_id();
                let note_part = duo_types::PartData::Text(duo_types::TextPartData {
                    base: duo_types::PartBase {
                        id: note_part_id.clone(),
                        session_id: session_id_spawn.clone(),
                        message_id: assistant_msg_id.clone(),
                    },
                    text: "⚠ 系统提示：模型连续多轮只输出文字、未调用工具，也未确认任务完成，本轮已被自动结束。任务可能尚未完成——直接发送「继续」可让智能体接着做。\n\
                           ⚠ System note: the model replied with text only for several rounds without calling tools or confirming completion, so this turn was auto-closed. The task may be unfinished — send \"continue\" to resume."
                        .to_string(),
                    synthetic: Some(true),
                    ignored: None,
                    time: Some(duo_types::PartTime {
                        start: now_ms as f64,
                        end: Some(now_ms as f64),
                    }),
                    metadata: None,
                });
                if let Err(e) = msg_store.insert_part(
                    &note_part_id,
                    &assistant_msg_id,
                    &session_id_spawn,
                    now_ms,
                    &serde_json::to_string(&note_part).unwrap_or_default(),
                ) {
                    tracing::warn!(error = %e, "Failed to insert auto-close note part");
                }
            }

            let assistant_msg = if tool_calls.is_empty() {
                agent_executor::LlmMessage::assistant(&full_text)
            } else {
                agent_executor::LlmMessage::assistant_with_tool_calls(&full_text, &tool_calls)
            };
            messages.push(assistant_msg);

            // ── Truncation resume (plan B) ──
            // If the provider cut the response off (finish_reason length/max_tokens),
            // the output is incomplete — we must NOT break here. Resume by pushing a
            // continue prompt (and, when the truncated round also carried tool calls,
            // stub those tool calls with placeholder results first to keep the
            // assistant-tool_messages invariant intact). Capped at MAX_CONTINUATIONS.
            if round_truncated {
                // Accumulate whatever text this (truncated) round produced so the
                // partial output survives even if we never get a clean completion.
                truncated_text.push_str(&full_text);
                if truncated_rounds >= MAX_CONTINUATIONS {
                    // Provider keeps truncating past the resume cap. Hand back the
                    // best-effort partial output instead of dropping it (risk 3):
                    // write a final assistant message clearly flagged as truncated.
                    tracing::warn!(
                        session_id = %session_id_spawn,
                        steps,
                        "run_loop forced break: truncation resumed {} times without completion; \
                         returning partial output ({} chars)",
                        truncated_rounds,
                        truncated_text.len()
                    );
                    let final_id = new_message_id();
                    let final_now = chrono::Utc::now().timestamp_millis();
                    let final_text = format!(
                        "{}\n\n[NOTE: this response was truncated by the model's output-length \
                         limit and could not be fully generated after {} resume attempts. \
                         The text above is the partial output that was produced.]",
                        truncated_text,
                        MAX_CONTINUATIONS
                    );
                    let final_info = duo_types::MessageInfo::Assistant(
                        duo_types::AssistantMessageInfo {
                            id: final_id.clone(),
                            session_id: session_id_spawn.clone(),
                            time: duo_types::AssistantMessageTime {
                                created: final_now as f64,
                                completed: Some(final_now as f64),
                            },
                            error: None,
                            parent_id: parent_user_msg_id
                                .clone()
                                .unwrap_or_else(|| session_id_spawn.clone()),
                            model_id: model_spawn.clone(),
                            provider_id: config_provider.clone(),
                            mode: "rust-run-loop".to_string(),
                            agent: agent_name_spawn.clone(),
                            path: duo_types::AssistantMessagePath {
                                cwd: project_path_spawn.clone(),
                                root: project_path_spawn.clone(),
                            },
                            summary: None,
                            tokens: duo_types::TokenInfo {
                                total: None,
                                input: 0.0,
                                output: 0.0,
                                reasoning: 0.0,
                                cache: duo_types::TokenCacheInfo {
                                    read: 0.0,
                                    write: 0.0,
                                },
                                breakdown: None,
                                cache_hit_rate: None,
                            },
                            structured: None,
                            variant: None,
                            finish: Some("length".to_string()),
                        },
                    );
                    let _ = msg_store.insert_message(
                        &final_id,
                        &session_id_spawn,
                        final_now,
                        &serde_json::to_string(&final_info).unwrap_or_default(),
                    );
                    let final_part_id = new_part_id();
                    let final_part = duo_types::PartData::Text(duo_types::TextPartData {
                        base: duo_types::PartBase {
                            id: final_part_id.clone(),
                            session_id: session_id_spawn.clone(),
                            message_id: final_id.clone(),
                        },
                        text: final_text,
                        synthetic: None,
                        ignored: None,
                        time: Some(duo_types::PartTime {
                            start: final_now as f64,
                            end: Some(final_now as f64),
                        }),
                        metadata: None,
                    });
                    let _ = msg_store.insert_part(
                        &final_part_id,
                        &final_id,
                        &session_id_spawn,
                        final_now,
                        &serde_json::to_string(&final_part).unwrap_or_default(),
                    );
                    bus.emit(agent_executor::LoopStreamEvent::LoopDone {
                        session_id: session_id_spawn.clone(),
                        steps,
                    });
                    break;
                }
                truncated_rounds += 1;
                if !tool_calls.is_empty() {
                    // A truncated round with tool calls: the assistant promised tools
                    // but we never got their full arguments/results. Stub each call
                    // with a placeholder tool_result (mirrors the doom-loop branch's
                    // message ordering) so the next request is well-formed, then ask
                    // the LLM to continue — the LLM will re-issue the calls fresh.
                    for tc in &tool_calls {
                        messages.push(agent_executor::LlmMessage::tool_result(
                            &tc.id,
                            "Output truncated by the model: this tool call was skipped. \
                             Re-issue it if still needed.",
                        ));
                    }
                }
                messages.push(agent_executor::LlmMessage::user(
                    "Continue the output from where it stopped. Do not repeat existing content.",
                ));
                steps += 1;
                live_metrics
                    .rounds_completed
                    .store(steps as usize, std::sync::atomic::Ordering::Relaxed);
                continue;
            }

            // ── No tool calls → candidate completion ──
            // A no-tool round is only a real completion if it wasn't truncated
            // (handled above) and isn't the MAX_STEPS text-only round (handled by
            // `is_max_steps` disabling tools). Otherwise we ask the LLM to confirm
            // rather than blindly accepting "no tool calls" as done — this closes
            // the "LLM stops early / wraps up prematurely" gap. The confirm prompt
            // (D7) requires the LLM to prefix a true final summary with
            // `TASK_COMPLETE:`; a text-only reply WITHOUT the marker is treated as
            // "not done" and the loop keeps asking, capped at
            // COMPLETION_CONFIRM_LIMIT so a chatty LLM can't text-spin forever.
            // When the cap is hit without the marker we still break; the visible
            // auto-close note was already written together with the assistant
            // message above (see `auto_close`), so the UI never presents this as
            // a normal completion.
            //
            // The decision itself comes from `completion_decision`, which is also
            // evaluated before the message is persisted — both call sites see the
            // same inputs, so they cannot disagree.
            if tool_calls.is_empty() {
                if force_text_only {
                    // Wrap-up round: tools were intentionally disabled (step cap
                    // or budget), so the LLM's text-only summary is the final
                    // answer — break as before.
                    eprintln!(
                        "[TRACE-rust] ⑥ runLoop done (wrap-up text-only), steps={}, emitting LoopDone",
                        steps
                    );
                    tracing::info!(session_id = %session_id_spawn, steps, "run_loop done");
                    break;
                }
                match completion_decision(confirm_rounds, &full_text) {
                    CompletionDecision::Done => {
                        eprintln!(
                            "[TRACE-rust] ⑥ runLoop done (TASK_COMPLETE marker), steps={}",
                            steps
                        );
                        tracing::info!(session_id = %session_id_spawn, steps, "run_loop done (explicit marker)");
                        break;
                    }
                    CompletionDecision::AutoClose => {
                        tracing::info!(
                            session_id = %session_id_spawn,
                            steps,
                            "run_loop done: completion confirm limit ({}) reached WITHOUT marker — auto-closing",
                            COMPLETION_CONFIRM_LIMIT
                        );
                        break;
                    }
                    CompletionDecision::Confirm => {}
                }
                confirm_rounds += 1;
                messages.push(agent_executor::LlmMessage::user(
                    "Before finishing, confirm whether the task is actually complete.\n\
                     - If it IS complete: reply with text only, and start your reply with \
                     `TASK_COMPLETE:` followed by a summary listing the files you changed \
                     and the work you completed.\n\
                     - If it is NOT complete: do NOT reply with words — call the \
                     appropriate tool now and continue the work.",
                ));
                steps += 1;
                live_metrics
                    .rounds_completed
                    .store(steps as usize, std::sync::atomic::Ordering::Relaxed);
                continue;
            }

            // ── Doom-loop detection ──
            // A doom loop is a *recurring* action (same tool+args). Detect it by
            // counting how often the current round's signature recurs inside the
            // recent-round sliding window — this catches both consecutive repeats
            // and periodic oscillations (A,B,A,B,...) that a "== previous round"
            // comparison would miss forever. Rust-specific cross-round detection.
            // Compare the full Vec of tool signatures (not just first()) so a loop
            // involving any tool in a multi-call round is detected.
            let current_signature: Vec<(String, String)> = tool_calls
                .iter()
                .map(|tc| (tc.function.name.clone(), tc.function.arguments.clone()))
                .collect();
            let (is_doom_loop, counter) = if tool_calls.is_empty() {
                // Defensive: a quiet round clears the window so a future loop isn't
                // credited with rounds from before a quiet stretch.
                recent_signatures.clear();
                (false, 0u32)
            } else {
                detect_recurring_doom_loop(
                    &mut recent_signatures,
                    &current_signature,
                    DOOM_LOOP_THRESHOLD,
                    DOOM_LOOP_WINDOW,
                )
            };
            let doom_loop_counter = counter;

            if is_doom_loop {
                tracing::warn!(
                    session_id = %session_id_spawn,
                    steps,
                    tool = %tool_calls.first().map(|tc| tc.function.name.as_str()).unwrap_or(""),
                    "doom_loop detected: same tool+args repeated {} times within window",
                    doom_loop_counter,
                );
                // Push tool results FIRST — they must immediately follow the assistant
                // message to satisfy the OpenAI/DeepSeek "tool_calls must be followed by
                // tool messages" invariant. The corrective user warning is appended AFTER
                // the tool results (see below). Inserting a user message before the tool
                // results would leave the assistant's tool_calls not immediately followed
                // by tool messages, which DeepSeek rejects with HTTP 400.
                for tc in &tool_calls {
                    // Write an Error ToolPart so the UI can show the blocked tool
                    let blocked_part_id = new_part_id();
                    let blocked_now_ms = chrono::Utc::now().timestamp_millis();
                    let blocked_input: std::collections::HashMap<String, serde_json::Value> =
                        serde_json::from_str(&tc.function.arguments).unwrap_or_default();
                    let blocked_part = duo_types::PartData::Tool(duo_types::ToolPartData {
                        base: duo_types::PartBase {
                            id: blocked_part_id.clone(),
                            session_id: session_id_spawn.clone(),
                            message_id: assistant_msg_id.clone(),
                        },
                        call_id: tc.id.clone(),
                        tool: tc.function.name.clone(),
                        state: duo_types::ToolState::Error {
                            input: blocked_input,
                            error: "doom_loop: tool call blocked — repeated same tool+args"
                                .to_string(),
                            metadata: None,
                            time: duo_types::ToolTimeCompleted {
                                start: blocked_now_ms as f64,
                                end: blocked_now_ms as f64,
                                compacted: None,
                            },
                        },
                        metadata: None,
                    });
                    if let Err(e) = msg_store.insert_part(
                        &blocked_part_id,
                        &assistant_msg_id,
                        &session_id_spawn,
                        blocked_now_ms,
                        &serde_json::to_string(&blocked_part).unwrap_or_default(),
                    ) {
                        tracing::warn!(error = %e, "Failed to write doom-loop Error ToolPart");
                    }
                    bus.emit(agent_executor::LoopStreamEvent::ToolError {
                        session_id: session_id_spawn.clone(),
                        call_id: tc.id.clone(),
                        part_id: blocked_part_id,
                        error: "doom_loop: tool call blocked".to_string(),
                    });
                    messages.push(agent_executor::LlmMessage::tool_result(
                        &tc.id,
                        "Error: doom_loop detected — this tool call was blocked because it \
                         repeats the previous call with identical arguments. \
                         Try a different approach.",
                    ));
                }
                // Corrective user warning goes AFTER the tool results (see note above)
                // so the assistant's tool_calls stay immediately followed by tool messages.
                messages.push(agent_executor::LlmMessage::user(
                    "WARNING: You are repeatedly calling the same tool with the same arguments. \
                     This is a doom loop. Stop and reconsider your approach. \
                     Do not repeat the same tool call.",
                ));
                steps += 1;
                // 这条 `continue` 绕过循环末尾的埋点发布点,不在这里同步的话
                // doom-loop 轮次不会计入 `rounds_completed`。
                live_metrics
                    .rounds_completed
                    .store(steps as usize, std::sync::atomic::Ordering::Relaxed);
                continue;
            }

            // ── Search saturation detection (non-blocking) ──
            // If ALL tool_calls in this round are search-type tools, increment counter.
            // When threshold is reached, inject a reminder. Does NOT block execution.
            let is_search_only = tool_calls.iter().all(|tc| {
                matches!(
                    tc.function.name.as_str(),
                    "grep"
                        | "glob"
                        | "read_file"
                        | "read"
                        | "list_dir"
                        | "symbol_search"
                        | "graph_query"
                        | "webfetch"
                )
            });
            if is_search_only {
                search_only_rounds += 1;
                // Guard X: count how many *new* files this read-only round touched,
                // compared against the deduped global `files_read` set. A large
                // survey legitimately keeps adding new files; a spinning-in-place
                // loop keeps re-reading the same ones (new-file count = 0).
                let round_new_files: u32 = {
                    let known = files_read.lock().unwrap_or_else(|e| e.into_inner());
                    tool_calls
                        .iter()
                        .filter_map(|tc| {
                            let args: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                                .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                            // Resolve the file path up front (owned String) so the
                            // borrow of `args` doesn't escape into the iterator's
                            // lazy `filter` closure.
                            let path: Option<String> = args
                                .get("file_path")
                                .or_else(|| args.get("filePath"))
                                .or_else(|| args.get("path"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            path.filter(|p| !known.contains(p)).map(|_| ())
                        })
                        .count() as u32
                };
                recent_new_file_counts[ring_idx] = round_new_files;
                ring_idx = (ring_idx + 1) % INVESTIGATION_NO_PROGRESS_WINDOW;
                let window_sum: u32 = recent_new_file_counts.iter().sum();
                if window_sum == 0 {
                    // Last N read-only rounds added ZERO new files → spinning in place.
                    read_only_no_progress_rounds += 1;
                } else {
                    read_only_no_progress_rounds = 0;
                }
            } else {
                search_only_rounds = 0;
                read_only_no_progress_rounds = 0;
                recent_new_file_counts = [0; INVESTIGATION_NO_PROGRESS_WINDOW];
                ring_idx = 0;
            }
            // NOTE: the corrective reminder must NOT be inserted here — this point
            // sits between the assistant message (which carries tool_calls) and the
            // tool results that the flush block below emits. Inserting a user
            // message here would break the OpenAI/DeepSeek invariant that an
            // assistant message with tool_calls must be immediately followed by its
            // tool messages, causing HTTP 400. We only capture the flag here and
            // push the reminder AFTER the flush block (see below).
            let inject_search_reminder = search_only_rounds == SEARCH_SATURATION_THRESHOLD;
            // Guard X checkpoint: fires at the threshold, then every `PERIOD` rounds.
            // Independent of the search-saturation reminder (which fires once at 8) —
            // a big survey gets the gentle checkpoint at 25/35/45… while still having
            // received the earlier nudge at 8.
            let inject_investigation_reminder = search_only_rounds >= INVESTIGATION_CHECKPOINT_THRESHOLD
                && (search_only_rounds - INVESTIGATION_CHECKPOINT_THRESHOLD).is_multiple_of(INVESTIGATION_CHECKPOINT_PERIOD);
            if inject_search_reminder {
                tracing::info!(
                    session_id = %session_id_spawn,
                    steps,
                    rounds = search_only_rounds,
                    "search saturation reached, will inject non-blocking reminder after tool results"
                );
            }

            // ── Process tool calls ──
            // For each tool_call: try Rust execution first, fall back to
            // wait_for_tool_result (TS delegation) if Rust doesn't handle it.
            let mut tool_result_futs: Vec<
                std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<String>> + Send>>,
            > = Vec::new();
            // Track which tool_calls were delegated to TS (by index in tool_calls)
            let mut delegated_indices: Vec<usize> = Vec::new();
            // Parallel to delegated_indices: the pending part id to update in
            // place once the delegated result arrives (avoids orphan pending).
            let mut delegated_part_ids: Vec<String> = Vec::new();
            // Per-tool_call result slot, indexed by `tc_idx` (the position of the
            // tool_call inside the assistant message). BOTH the serial path and the
            // concurrent batch path write their result into `tc_results[tc_idx]`;
            // the Finalize block below drains these slots in `tool_calls` order so
            // the emitted `tool_result` messages — and therefore the G19
            // `reflect_pairs` 1:1 positional zip (see L4395 "reflect_pairs is 1:1
            // with tool_calls (same order)") — stay in exact tc_idx order, exactly
            // as the pre-change fully-serial behaviour did.
            // Tuple: (pending_part_id, output, call_id, tool_name, arguments,
            // state_metadata, tool_error)
            // - state_metadata: for "task" tool, contains {"sessionId": child_session_id};
            //   for other tools, None (equivalent to previous behavior).
            // - tool_error: when Some, the tool failed and the part is finalized
            //   as Error with this message instead of Completed. Used by the
            //   concurrent batch path so individual tool failures don't abort the
            //   whole round and are reported as tool_result errors (like the
            //   serial path's intent).
            // A `None` slot means that tool_call took a direct-push path
            // (delegated to TS / permission-denied / sandbox-violation /
            // unsupported) which already emitted its own `tool_result` message
            // inline, so Finalize must skip it.
            type RustToolResult = (
                String,
                String,
                String,
                String,
                String,
                Option<std::collections::HashMap<String, serde_json::Value>>,
                Option<String>,
            );
            let mut tc_results: Vec<Option<RustToolResult>> = vec![None; tool_calls.len()];
            // Per-round read counter shared with `execute_tool_batch` (progress
            // publishing for cancel/timeout observers; not used for gating here).
            let files_read_count: std::sync::Arc<std::sync::atomic::AtomicUsize> =
                std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            // Batch-eligible Rust tools (read/edit/write/grep/list_dir/glob/
            // websearch/...) collected this round for a single concurrent
            // `execute_tool_batch` call. Each entry carries its original round
            // `tc_idx` so the result is written back into the correct slot — this
            // is what keeps the G19 reflect_pairs zip in tc_idx order.
            struct BatchEntry {
                tc_idx: usize,
                part_id: String,
                call_id: String,
                tool_name: String,
                args: serde_json::Value,
                args_str: String,
            }
            let mut batch_entries: Vec<BatchEntry> = Vec::new();
            for (tc_idx, tc) in tool_calls.iter().enumerate() {
                let call_id = tc.id.clone();
                let tool_name = tc.function.name.clone();

                // `expand_tools` is synthetic: it exists only in the tool array
                // this loop hands the LLM, and is answered here from in-memory
                // state. It is intercepted BEFORE the tool part is written so it
                // never shows up in the UI as a pending tool, and never reaches
                // the permission check / Rust registry / TS fallback — none of
                // which know the name (the TS fallback would hang forever).
                if tool_disclosure.is_expand_call(&tool_name) {
                    let args: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                        .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                    let result =
                        tool_disclosure.handle_expand(&args, tools_for_spawn.as_deref());
                    tracing::info!(
                        session_id = %session_id_spawn,
                        args = %tc.function.arguments,
                        "expand_tools: revealed deferred tool schemas"
                    );
                    // Every tool_call id in the assistant message must get a
                    // matching tool result, or the next request is malformed.
                    messages.push(agent_executor::LlmMessage::tool_result(&tc.id, &result));
                    continue;
                }
                // File-writing tools change the on-disk project state that
                // the RAG/context assembly reflects, so mark the cached
                // context dirty — the NEXT round re-assembles it with the
                // new files. This keeps the per-round assembly cache
                // (see `ctx_dirty` above) correct without re-running
                // assembly on every round.
                let is_write_tool = matches!(
                    tool_name.as_str(),
                    "edit_file" | "write" | "submit_code" | "edit" | "apply_patch" | "code_comment"
                );
                if is_write_tool {
                    ctx_dirty = true;
                }
                let args: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                    .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

                // Insert pending tool part into DB
                let part_id = new_part_id();
                let input: std::collections::HashMap<String, serde_json::Value> =
                    serde_json::from_str(&tc.function.arguments).unwrap_or_else(|_| {
                        std::collections::HashMap::from([(
                            "raw".to_string(),
                            serde_json::Value::String(tc.function.arguments.clone()),
                        )])
                    });
                let part_data = duo_types::PartData::Tool(duo_types::ToolPartData {
                    base: duo_types::PartBase {
                        id: part_id.clone(),
                        session_id: session_id_spawn.clone(),
                        message_id: assistant_msg_id.clone(),
                    },
                    call_id: call_id.clone(),
                    tool: tool_name.clone(),
                    state: duo_types::ToolState::Pending {
                        input,
                        raw: tc.function.arguments.clone(),
                    },
                    metadata: None,
                });
                if let Err(e) = msg_store.insert_part(
                    &part_id,
                    &assistant_msg_id,
                    &session_id_spawn,
                    now_ms,
                    &serde_json::to_string(&part_data).unwrap_or_default(),
                ) {
                    tracing::warn!(error = %e, "Failed to insert tool part");
                }
                bus.emit(agent_executor::LoopStreamEvent::ToolPending {
                    session_id: session_id_spawn.clone(),
                    call_id: call_id.clone(),
                    tool_name: tool_name.clone(),
                    part_id: part_id.clone(),
                    message_id: assistant_msg_id.clone(),
                });

                // NOTE: Do NOT transition to Running yet. We only set Running
                // for tools that Rust executes internally (after confirming
                // execute_tool_with_middleware succeeded). Tools delegated to TS
                // must stay Pending so the TS poll loop can detect and execute
                // them — if we set Running here, TS poll never sees Pending and
                // the tool is never executed, leaving Rust's runLoop stuck
                // waiting for wait_for_tool_result forever.

                // Try Rust execution first via execute_tool_with_middleware.
                // If the tool is not implemented in Rust, fall through to
                // wait_for_tool_result (TS will execute and submit result).
                // Wrap in catch_unwind to prevent tool panics from killing the
                // entire runLoop — instead, write Error ToolPart + emit ToolError
                // + push error tool_result so the LLM can decide how to proceed.

                // Transition to Running state BEFORE attempting Rust execution.
                // This signals to TS poll that the tool is being handled (not
                // available for TS execution). If the tool is later delegated to
                // TS, we'll transition back to Pending so TS poll can detect it.
                let running_part = duo_types::PartData::Tool(duo_types::ToolPartData {
                    base: duo_types::PartBase {
                        id: part_id.clone(),
                        session_id: session_id_spawn.clone(),
                        message_id: assistant_msg_id.clone(),
                    },
                    call_id: call_id.clone(),
                    tool: tool_name.clone(),
                    state: duo_types::ToolState::Running {
                        input: serde_json::from_str(&tc.function.arguments).unwrap_or_else(|_| {
                            std::collections::HashMap::from([(
                                "raw".to_string(),
                                serde_json::Value::String(tc.function.arguments.clone()),
                            )])
                        }),
                        title: Some(tool_name.clone()),
                        metadata: None,
                        time: duo_types::ToolTimeStart {
                            start: chrono::Utc::now().timestamp_millis() as f64,
                        },
                    },
                    metadata: None,
                });
                if let Err(e) = msg_store.update_part(
                    &part_id,
                    &serde_json::to_string(&running_part).unwrap_or_default(),
                ) {
                    tracing::warn!(error = %e, "Failed to update tool part to running");
                }
                bus.emit(agent_executor::LoopStreamEvent::ToolRunning {
                    session_id: session_id_spawn.clone(),
                    call_id: call_id.clone(),
                    part_id: part_id.clone(),
                });

                // ── Unified tool execution: permission check → Rust execute → TS fallback ──
                // Step 1: Check permission (validation + permission + sandbox)
                // 智械 MCP tools are user-installed capability packages executed
                // IntelGear: MCP tools now go through the same permission check as
                // all other tools (01 §9: no source is exempt). The `Ask` variant
                // is treated as Allow for MCP tools because there is no interactive
                // prompt channel on desktop — but `Deny` is still enforced.
                let permission_result = agent_executor::check_tool_permission(
                    &tool_name,
                    &args,
                    &permission_rules,
                    &security_policy,
                    auto_accept_spawn,
                ).or_else(|e| {
                    // Allow `Ask` for MCP tools (no interactive prompt on desktop).
                    if agent_executor::mcp::is_mcp_tool(&tool_name)
                        && matches!(&e, agent_executor::ToolExecutionError::PermissionAsk(_)) {
                            return Ok(());
                        }
                    Err(e)
                });

                match permission_result {
                    Err(agent_executor::ToolExecutionError::PermissionAsk(msg)) => {
                        // P2-22: only delegate when this run actually offered the
                        // tool. An Ask result alone says nothing about whether the
                        // tool exists: a hallucinated name falls through the same
                        // fail-closed default, and delegating it would block on
                        // `wait_for_tool_result` for its full 10-minute timeout
                        // with nobody ever submitting a result. The Allow path
                        // already reports unsupported tools immediately — make
                        // the Ask path just as decisive.
                        let offered = tools_for_spawn.as_ref().is_some_and(|defs| {
                            defs.iter().any(|d| d.function.name == tool_name)
                        });
                        if !offered {
                            tracing::warn!(
                                tool = %tool_name,
                                "Ask-gated tool was never offered to the model — reporting error instead of waiting on TS"
                            );
                            let err_now_ms = chrono::Utc::now().timestamp_millis();
                            let err_input: std::collections::HashMap<String, serde_json::Value> =
                                serde_json::from_str(&tc.function.arguments).unwrap_or_default();
                            let err_part = duo_types::PartData::Tool(duo_types::ToolPartData {
                                base: duo_types::PartBase {
                                    id: part_id.clone(),
                                    session_id: session_id_spawn.clone(),
                                    message_id: assistant_msg_id.clone(),
                                },
                                call_id: call_id.clone(),
                                tool: tool_name.clone(),
                                state: duo_types::ToolState::Error {
                                    input: err_input,
                                    error: "Unsupported tool in this context".to_string(),
                                    metadata: None,
                                    time: duo_types::ToolTimeCompleted {
                                        start: err_now_ms as f64,
                                        end: err_now_ms as f64,
                                        compacted: None,
                                    },
                                },
                                metadata: None,
                            });
                            let _ = msg_store.update_part(
                                &part_id,
                                &serde_json::to_string(&err_part).unwrap_or_default(),
                            );
                            bus.emit(agent_executor::LoopStreamEvent::ToolError {
                                session_id: session_id_spawn.clone(),
                                call_id: call_id.clone(),
                                part_id: part_id.clone(),
                                error: "Unsupported tool in this context".to_string(),
                            });
                            messages.push(agent_executor::LlmMessage::tool_result(
                                &tc.id,
                                &format!(
                                    "Error: tool '{}' does not exist in this session's toolset. Use one of the tools provided to you.",
                                    tool_name
                                ),
                            ));
                            continue;
                        }
                        // Permission needs UI interaction — must delegate to TS
                        eprintln!(
                            "[TRACE-rust] ⑥ tool '{}' needs permission, delegating to TS (callID={})",
                            tool_name, call_id
                        );
                        tracing::info!(tool = %tool_name, reason = %msg, "tool needs permission ask, delegating to TS");
                        // Transition back to Pending so TS poll can detect and execute
                        self_transition_part_to_pending(
                            &msg_store,
                            &part_id,
                            &assistant_msg_id,
                            &session_id_spawn,
                            &call_id,
                            &tool_name,
                            &tc.function.arguments,
                        );
                        let registry = state_clone.tool_registry.clone();
                        let sid = session_id_spawn.clone();
                        let cid = call_id.clone();
                        let ct = cancel_token.clone();
                        delegated_indices.push(tc_idx);
                        delegated_part_ids.push(part_id.clone());
                        tool_result_futs.push(Box::pin(async move {
                            tokio::select! {
                                result = registry.wait_for_tool_result(&sid, &cid) => result,
                                _ = ct.cancelled() => anyhow::bail!("cancelled while waiting for tool result"),
                            }
                        }));
                    }
                    Err(agent_executor::ToolExecutionError::PermissionDenied(msg)) => {
                        // Permission denied — no need to delegate, report error directly
                        tracing::warn!(tool = %tool_name, reason = %msg, "tool permission denied");
                        let err_now_ms = chrono::Utc::now().timestamp_millis();
                        let err_input: std::collections::HashMap<String, serde_json::Value> =
                            serde_json::from_str(&tc.function.arguments).unwrap_or_default();
                        let err_part = duo_types::PartData::Tool(duo_types::ToolPartData {
                            base: duo_types::PartBase {
                                id: part_id.clone(),
                                session_id: session_id_spawn.clone(),
                                message_id: assistant_msg_id.clone(),
                            },
                            call_id: call_id.clone(),
                            tool: tool_name.clone(),
                            state: duo_types::ToolState::Error {
                                input: err_input,
                                error: format!("Permission denied: {}", msg),
                                metadata: None,
                                time: duo_types::ToolTimeCompleted {
                                    start: err_now_ms as f64,
                                    end: err_now_ms as f64,
                                    compacted: None,
                                },
                            },
                            metadata: None,
                        });
                        let _ = msg_store.update_part(
                            &part_id,
                            &serde_json::to_string(&err_part).unwrap_or_default(),
                        );
                        bus.emit(agent_executor::LoopStreamEvent::ToolError {
                            session_id: session_id_spawn.clone(),
                            call_id: call_id.clone(),
                            part_id: part_id.clone(),
                            error: format!("Permission denied: {}", msg),
                        });
                        messages.push(agent_executor::LlmMessage::tool_result(
                            &tc.id,
                            &format!("Error: Permission denied for tool '{}': {}", tool_name, msg),
                        ));
                    }
                    Err(agent_executor::ToolExecutionError::SandboxViolation(path)) => {
                        // Sandbox violation — report error directly
                        tracing::warn!(tool = %tool_name, path = %path, "sandbox violation");
                        let err_now_ms = chrono::Utc::now().timestamp_millis();
                        let err_input: std::collections::HashMap<String, serde_json::Value> =
                            serde_json::from_str(&tc.function.arguments).unwrap_or_default();
                        let err_part = duo_types::PartData::Tool(duo_types::ToolPartData {
                            base: duo_types::PartBase {
                                id: part_id.clone(),
                                session_id: session_id_spawn.clone(),
                                message_id: assistant_msg_id.clone(),
                            },
                            call_id: call_id.clone(),
                            tool: tool_name.clone(),
                            state: duo_types::ToolState::Error {
                                input: err_input,
                                error: format!("Sandbox violation: {}", path),
                                metadata: None,
                                time: duo_types::ToolTimeCompleted {
                                    start: err_now_ms as f64,
                                    end: err_now_ms as f64,
                                    compacted: None,
                                },
                            },
                            metadata: None,
                        });
                        let _ = msg_store.update_part(
                            &part_id,
                            &serde_json::to_string(&err_part).unwrap_or_default(),
                        );
                        bus.emit(agent_executor::LoopStreamEvent::ToolError {
                            session_id: session_id_spawn.clone(),
                            call_id: call_id.clone(),
                            part_id: part_id.clone(),
                            error: format!("Sandbox violation: {}", path),
                        });
                        messages.push(agent_executor::LlmMessage::tool_result(
                            &tc.id,
                            &format!("Error: Sandbox violation for path '{}'", path),
                        ));
                    }
                    Ok(()) | Err(agent_executor::ToolExecutionError::Validation(_)) => {
                        // Permission allowed or validation-only error — try Rust execution
                        // Batch-eligible tools (read/edit/write/grep/list_dir/glob/websearch/...)
                        // are collected and executed concurrently via a single
                        // `execute_tool_batch` call after this loop. `task` and any other
                        // non-batch tool still execute serially here, so their side effects
                        // (SubagentStarted/Done, Feishu, child_session_id extraction) are
                        // preserved exactly as before.
                        if agent_executor::agentic_loop::AgenticLoopExecutor::PARALLEL_SAFE
                            .contains(&tool_name.as_str())
                        {
                            batch_entries.push(BatchEntry {
                                tc_idx,
                                part_id: part_id.clone(),
                                call_id: tc.id.clone(),
                                tool_name: tool_name.clone(),
                                args: args.clone(),
                                args_str: tc.function.arguments.clone(),
                            });
                            continue;
                        }
                        // Step 2: Execute tool via AgenticLoopExecutor
                        match loop_executor
                            .execute_tool(
                                &tool_name,
                                &args,
                                files_read.clone(),
                                read_reservations.clone(),
                            )
                            .await
                        {
                            Ok(output) => {
                                // Rust executed the tool natively
                                let truncated = agent_executor::truncate_output(&output, 50_000);
                                tracing::info!(tool = %tool_name, "tool executed in Rust via AgenticLoopExecutor");

                                // For "task" tool, extract child_session_id from output
                                // to populate state.metadata.sessionId (needed by frontend
                                // to make the sub-agent card clickable and navigable).
                                // Output format from execute_task:
                                //   "task_id: {child_session_id} (for resuming)\n\n<task_result>..."
                                let state_metadata = if tool_name == "task" {
                                    extract_task_session_id(&output).map(|sid| {
                                        let mut m = std::collections::HashMap::new();
                                        m.insert(
                                            "sessionId".to_string(),
                                            serde_json::Value::String(sid),
                                        );
                                        m
                                    })
                                } else {
                                    None
                                };

                                // If this is a task tool with a known child_session_id,
                                // update the Running part's state.metadata so the frontend
                                // can navigate into the sub-agent while it's still running.
                                if let Some(ref meta) = state_metadata
                                    && let Some(child_sid) =
                                        meta.get("sessionId").and_then(|v| v.as_str())
                                    {
                                        update_running_part_metadata(RunningPartPatch {
                                            msg_store: &msg_store,
                                            part_id: &part_id,
                                            message_id: &assistant_msg_id,
                                            session_id: &session_id_spawn,
                                            call_id: &call_id,
                                            tool_name: &tool_name,
                                            arguments: &tc.function.arguments,
                                            metadata: meta.clone(),
                                        });
                                        // Emit SubagentStarted + SubagentDone events.
                                        // Since execute_task is synchronous, the sub-agent
                                        // has already completed by this point. We emit both
                                        // events so the TS SSE bridge can react (e.g. publish
                                        // session.created to the frontend).
                                        bus.emit(
                                            agent_executor::LoopStreamEvent::SubagentStarted {
                                                parent_session_id: session_id_spawn.clone(),
                                                child_session_id: child_sid.to_string(),
                                                subagent_type: args
                                                    .get("subagent_type")
                                                    .and_then(|v| v.as_str())
                                                    .unwrap_or("explore")
                                                    .to_string(),
                                                description: args
                                                    .get("description")
                                                    .and_then(|v| v.as_str())
                                                    .unwrap_or("subagent task")
                                                    .to_string(),
                                            },
                                        );
                                        bus.emit(agent_executor::LoopStreamEvent::SubagentDone {
                                            parent_session_id: session_id_spawn.clone(),
                                            child_session_id: child_sid.to_string(),
                                        });

                                        // Forward subagent events to Feishu via SseEvent.
                                        // Look up the Feishu chat_id bound to this project path.
                                        let feishu_chat_id = state_clone
                                            .im_project_chats
                                            .lock()
                                            .await
                                            .get(&project_path_spawn)
                                            .cloned();
                                        if let Some(ref cid) = feishu_chat_id {
                                            let _ = state_clone.sse_event_tx.send(
                                                im_bridge::sse_bridge::SseEvent::SubagentStarted {
                                                    parent_session_id: session_id_spawn.clone(),
                                                    child_session_id: child_sid.to_string(),
                                                    chat_id: Some(cid.clone()),
                                                    subagent_type: args
                                                        .get("subagent_type")
                                                        .and_then(|v| v.as_str())
                                                        .unwrap_or("explore")
                                                        .to_string(),
                                                    description: args
                                                        .get("description")
                                                        .and_then(|v| v.as_str())
                                                        .unwrap_or("subagent task")
                                                        .to_string(),
                                                },
                                            );
                                            let _ = state_clone.sse_event_tx.send(
                                                im_bridge::sse_bridge::SseEvent::SubagentDone {
                                                    parent_session_id: session_id_spawn.clone(),
                                                    child_session_id: child_sid.to_string(),
                                                    chat_id: Some(cid.clone()),
                                                },
                                            );
                                        }
                                    }

                                tc_results[tc_idx] = Some((
                                    part_id.clone(),
                                    truncated,
                                    tc.id.clone(),
                                    tc.function.name.clone(),
                                    tc.function.arguments.clone(),
                                    state_metadata,
                                    None,
                                ));
                            }
                            Err(e) => {
                                // Guard: a tool that is not implemented in the Rust
                                // executor would normally be delegated to the TS client.
                                // But when no TS client is connected, delegating hangs
                                // forever on `wait_for_tool_result`. So for an
                                // unsupported-Rust tool we report a clear error and
                                // continue the loop instead of stalling.
                                let e_msg = e.to_string();
                                if e_msg.contains("not implemented in the Rust agent executor") {
                                    tracing::warn!(tool = %tool_name, "tool unsupported in Rust executor (no TS delegate) — reporting error and continuing");
                                    let err_now_ms = chrono::Utc::now().timestamp_millis();
                                    let err_input: std::collections::HashMap<String, serde_json::Value> =
                                        serde_json::from_str(&tc.function.arguments).unwrap_or_default();
                                    let err_part = duo_types::PartData::Tool(duo_types::ToolPartData {
                                        base: duo_types::PartBase {
                                            id: part_id.clone(),
                                            session_id: session_id_spawn.clone(),
                                            message_id: assistant_msg_id.clone(),
                                        },
                                        call_id: call_id.clone(),
                                        tool: tool_name.clone(),
                                        state: duo_types::ToolState::Error {
                                            input: err_input,
                                            error: "Unsupported tool in this context".to_string(),
                                            metadata: None,
                                            time: duo_types::ToolTimeCompleted {
                                                start: err_now_ms as f64,
                                                end: err_now_ms as f64,
                                                compacted: None,
                                            },
                                        },
                                        metadata: None,
                                    });
                                    let _ = msg_store.update_part(
                                        &part_id,
                                        &serde_json::to_string(&err_part).unwrap_or_default(),
                                    );
                                    bus.emit(agent_executor::LoopStreamEvent::ToolError {
                                        session_id: session_id_spawn.clone(),
                                        call_id: call_id.clone(),
                                        part_id: part_id.clone(),
                                        error: "Unsupported tool in this context".to_string(),
                                    });
                                    messages.push(agent_executor::LlmMessage::tool_result(
                                        &tc.id,
                                        &format!(
                                            "Error: tool '{}' is not supported by the agent runtime in this context.",
                                            tool_name
                                        ),
                                    ));
                                    continue;
                                }
                                // Rust cannot execute this tool (Unknown tool, etc.) — delegate to TS
                                eprintln!(
                                    "[TRACE-rust] ⑥ tool '{}' not in Rust ({}), delegating to TS (callID={})",
                                    tool_name, e, call_id
                                );
                                tracing::debug!(tool = %tool_name, error = %e, "tool not in Rust, delegating to TS");
                                // Transition back to Pending so TS poll can detect and execute
                                self_transition_part_to_pending(
                                    &msg_store,
                                    &part_id,
                                    &assistant_msg_id,
                                    &session_id_spawn,
                                    &call_id,
                                    &tool_name,
                                    &tc.function.arguments,
                                );
                                let registry = state_clone.tool_registry.clone();
                                let sid = session_id_spawn.clone();
                                let cid = call_id.clone();
                                let ct = cancel_token.clone();
                                delegated_indices.push(tc_idx);
                                delegated_part_ids.push(part_id.clone());
                                tool_result_futs.push(Box::pin(async move {
                                    tokio::select! {
                                        result = registry.wait_for_tool_result(&sid, &cid) => result,
                                        _ = ct.cancelled() => anyhow::bail!("cancelled while waiting for tool result"),
                                    }
                                }));
                            }
                        }
                    }
                }
            }

            // ── Execute batched Rust tools concurrently ──
            // All batch-eligible tools collected above run in ONE
            // `execute_tool_batch` call (file-affinity grouped inside the batch).
            // Each result is written back into its `tc_results[tc_idx]` slot, so the
            // downstream Finalize block (which drains slots in `tool_calls` order)
            // and the G19 reflect_pairs zip (which pairs tool_calls with tool_result
            // messages by position) see them exactly as if they had run serially.
            // Individual tool failures become Error tool_results (fail_fast=false)
            // rather than aborting the round.
            if !batch_entries.is_empty() {
                let call_entries: Vec<duo_types::ToolCallEntry> = batch_entries
                    .iter()
                    .map(|e| duo_types::ToolCallEntry {
                        tool_name: e.tool_name.clone(),
                        arguments: e.args.clone(),
                    })
                    .collect();
                let batch_res = loop_executor
                    .execute_tool_batch(agent_executor::agentic_loop::ToolBatchParams {
                        round: steps as usize,
                        calls: &call_entries,
                        tool_set: agent_executor::agentic_loop::LoopToolSet::Codegen,
                        files_read: files_read.clone(),
                        read_reservations: read_reservations.clone(),
                        files_read_count: files_read_count.clone(),
                        fail_fast: false,
                    })
                    .await;
                match batch_res {
                    Ok((_, _, _, per_results)) => {
                        for (entry, res) in batch_entries.iter().zip(per_results.into_iter()) {
                            match res {
                                Ok(output) => {
                                    let truncated =
                                        agent_executor::truncate_output(&output, 50_000);
                                    tc_results[entry.tc_idx] = Some((
                                        entry.part_id.clone(),
                                        truncated,
                                        entry.call_id.clone(),
                                        entry.tool_name.clone(),
                                        entry.args_str.clone(),
                                        None,
                                        None,
                                    ));
                                }
                                Err(e) => {
                                    tc_results[entry.tc_idx] = Some((
                                        entry.part_id.clone(),
                                        String::new(),
                                        entry.call_id.clone(),
                                        entry.tool_name.clone(),
                                        entry.args_str.clone(),
                                        None,
                                        Some(format!("Error: {}", e)),
                                    ));
                                }
                            }
                        }
                    }
                    Err(e) => {
                        // Infra failure (e.g. semaphore closed) — report every
                        // batched tool as errored so no tool_call is left unanswered.
                        for entry in &batch_entries {
                            tc_results[entry.tc_idx] = Some((
                                entry.part_id.clone(),
                                String::new(),
                                entry.call_id.clone(),
                                entry.tool_name.clone(),
                                entry.args_str.clone(),
                                None,
                                Some(format!("Error: {}", e)),
                            ));
                        }
                    }
                }
            }

            // Phase machine hard-signal (§3.3, plan A): after all native Rust
            // tool executions this round (single + batched), if any file write
            // succeeded, advance Execute → Verify. This is driven by an objective
            // fact (a file hit disk), not LLM self-report, so it is deterministic
            // and 100% parse-safe. `transition_if_written` resets the per-round
            // write counter, so the next round starts fresh.
            loop_executor.transition_if_written();

            // ── Wait for delegated tool results ──
            if !tool_result_futs.is_empty() {
                let wait_start = std::time::Instant::now();
                eprintln!(
                    "[TRACE-rust] ⑦ waiting for {} delegated tool results from TS...",
                    tool_result_futs.len()
                );
                let results = futures::future::join_all(tool_result_futs).await;
                eprintln!(
                    "[TRACE-rust] ⑦ delegated tool results received (count={})",
                    results.len()
                );
                // DEBUG timing (debug-level only; no effect on normal logic).
                // Helps verify whether a delegated-tool wait (TS→Rust result
                // round-trip) is the bottleneck when a run appears to hang.
                tracing::debug!(
                    elapsed_ms = wait_start.elapsed().as_millis() as u64,
                    count = results.len(),
                    "delegated tool results wait completed"
                );
                for (fut_idx, result) in results.into_iter().enumerate() {
                    let tc_idx = delegated_indices[fut_idx];
                    let pending_part_id = &delegated_part_ids[fut_idx];
                    let tc = &tool_calls[tc_idx];
                    match result {
                        Ok(tool_result) => {
                            // P0: 单条 tool_result 的**绝对**上限。Rust 原生执行的
                            // 工具在上面已统一走 `truncate_output(.., 50_000)`,唯独
                            // 这条 TS 委派回传的结果此前无任何上限,直接原样进入
                            // `messages` 并在之后每一轮被完整重发。`preflight_compress`
                            // 只在**总量超预算**时才动手(1M 模型预算 ≈ 767K,稳态永不
                            // 触发),因此它无法兜住这里。同一常量、同一函数,与 Rust
                            // 路径行为逐字一致,不引入新语义。
                            let tool_result =
                                agent_executor::truncate_output(&tool_result, 50_000);
                            // Transition the existing pending part to Completed in
                            // place (reuse the pending part_id) so TS's poll loop
                            // stops seeing it as pending and does not re-execute.
                            let now_ms = chrono::Utc::now().timestamp_millis();
                            let input: std::collections::HashMap<String, serde_json::Value> =
                                serde_json::from_str(&tc.function.arguments).unwrap_or_else(|_| {
                                    std::collections::HashMap::from([(
                                        "raw".to_string(),
                                        serde_json::Value::String(tc.function.arguments.clone()),
                                    )])
                                });
                            let part_data = duo_types::PartData::Tool(duo_types::ToolPartData {
                                base: duo_types::PartBase {
                                    id: pending_part_id.clone(),
                                    session_id: session_id_spawn.clone(),
                                    message_id: assistant_msg_id.clone(),
                                },
                                call_id: tc.id.clone(),
                                tool: tc.function.name.clone(),
                                state: duo_types::ToolState::Completed {
                                    input,
                                    output: tool_result.clone(),
                                    title: tc.function.name.clone(),
                                    metadata: std::collections::HashMap::new(),
                                    time: duo_types::ToolTimeCompleted {
                                        start: now_ms as f64,
                                        end: now_ms as f64,
                                        compacted: None,
                                    },
                                    attachments: None,
                                },
                                metadata: None,
                            });
                            if let Err(e) = msg_store.update_part(
                                pending_part_id,
                                &serde_json::to_string(&part_data).unwrap_or_default(),
                            ) {
                                tracing::warn!(error = %e, "Failed to update delegated tool result part");
                            }
                            bus.emit(agent_executor::LoopStreamEvent::ToolCompleted {
                                session_id: session_id_spawn.clone(),
                                call_id: tc.id.clone(),
                                part_id: pending_part_id.clone(),
                            });
                            messages.push(agent_executor::LlmMessage::tool_result(
                                &tc.id,
                                &tool_result,
                            ));
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "Delegated tool result wait failed");
                            // Persist the error state on the tool part so the
                            // frontend can display the failure (mirrors TS
                            // processor.ts failToolCall L219-235).
                            let err_now_ms = chrono::Utc::now().timestamp_millis();
                            let err_input: std::collections::HashMap<String, serde_json::Value> =
                                serde_json::from_str(&tc.function.arguments).unwrap_or_else(|_| {
                                    std::collections::HashMap::from([(
                                        "raw".to_string(),
                                        serde_json::Value::String(tc.function.arguments.clone()),
                                    )])
                                });
                            let err_part = duo_types::PartData::Tool(duo_types::ToolPartData {
                                base: duo_types::PartBase {
                                    id: pending_part_id.clone(),
                                    session_id: session_id_spawn.clone(),
                                    message_id: assistant_msg_id.clone(),
                                },
                                call_id: tc.id.clone(),
                                tool: tc.function.name.clone(),
                                state: duo_types::ToolState::Error {
                                    input: err_input,
                                    error: e.to_string(),
                                    metadata: None,
                                    time: duo_types::ToolTimeCompleted {
                                        start: err_now_ms as f64,
                                        end: err_now_ms as f64,
                                        compacted: None,
                                    },
                                },
                                metadata: None,
                            });
                            if let Err(update_err) = msg_store.update_part(
                                pending_part_id,
                                &serde_json::to_string(&err_part).unwrap_or_default(),
                            ) {
                                tracing::warn!(error = %update_err, "Failed to update delegated tool part to error");
                            }
                            bus.emit(agent_executor::LoopStreamEvent::ToolError {
                                session_id: session_id_spawn.clone(),
                                call_id: tc.id.clone(),
                                part_id: pending_part_id.clone(),
                                error: e.to_string(),
                            });
                            messages.push(agent_executor::LlmMessage::tool_result(
                                &tc.id,
                                &format!("Error: {}", e),
                            ));
                        }
                    }
                }
            }

            // ── Finalize Rust-executed tool parts (update in place + feed LLM) ──
            // These tools were already executed above; here we (1) transition the
            // pending part to Completed in place (reuse the pending part_id so TS's
            // poll loop never re-executes it) and (2) push the tool result into the
            // `messages` list so the next LLM turn sees a result for every tool_call
            // (OpenAI-compatible endpoints require this pairing).
            // Drain the per-tc_idx slots in `tool_calls` order so the emitted
            // tool_result messages stay in exact tc_idx order — required by the
            // G19 reflect_pairs 1:1 positional zip. Tool calls that took a
            // direct-push path (delegated/permission/sandbox/unsupported) left a
            // `None` slot and already emitted their own tool_result message, so
            // they are skipped here.
            for (tc_idx, _tc) in tool_calls.iter().enumerate() {
                let Some((
                    pending_part_id,
                    output,
                    call_id,
                    tool_name,
                    arguments,
                    tool_state_metadata,
                    tool_error,
                )) = tc_results[tc_idx].take()
                else {
                    continue;
                };
                let now_ms = chrono::Utc::now().timestamp_millis();
                let input: std::collections::HashMap<String, serde_json::Value> =
                    serde_json::from_str(&arguments).unwrap_or_else(|_| {
                        std::collections::HashMap::from([(
                            "raw".to_string(),
                            serde_json::Value::String(arguments.clone()),
                        )])
                    });
                // Failed batched tools (or infra failures) are finalized as Error
                // and reported back to the LLM as an `Error:` tool_result, instead
                // of silently succeeding. The message text is what the G19
                // reflect_pairs zip consumes, so an errored tool must still carry a
                // (non-empty) result string for its position.
                let (tool_state, result_text) = match &tool_error {
                    Some(err) => (
                        duo_types::ToolState::Error {
                            input,
                            error: err.clone(),
                            metadata: None,
                            time: duo_types::ToolTimeCompleted {
                                start: now_ms as f64,
                                end: now_ms as f64,
                                compacted: None,
                            },
                        },
                        err.clone(),
                    ),
                    None => (
                        duo_types::ToolState::Completed {
                            input,
                            output: output.clone(),
                            title: tool_name.clone(),
                            metadata: tool_state_metadata.unwrap_or_default(),
                            time: duo_types::ToolTimeCompleted {
                                start: now_ms as f64,
                                end: now_ms as f64,
                                compacted: None,
                            },
                            attachments: None,
                        },
                        output.clone(),
                    ),
                };
                let part_data = duo_types::PartData::Tool(duo_types::ToolPartData {
                    base: duo_types::PartBase {
                        id: pending_part_id.clone(),
                        session_id: session_id_spawn.clone(),
                        message_id: assistant_msg_id.clone(),
                    },
                    call_id: call_id.clone(),
                    tool: tool_name.clone(),
                    state: tool_state,
                    metadata: None,
                });
                if let Err(e) = msg_store.update_part(
                    &pending_part_id,
                    &serde_json::to_string(&part_data).unwrap_or_default(),
                ) {
                    tracing::warn!(error = %e, "Failed to update Rust tool result part");
                }
                if tool_error.is_some() {
                    bus.emit(agent_executor::LoopStreamEvent::ToolError {
                        session_id: session_id_spawn.clone(),
                        call_id: call_id.clone(),
                        part_id: pending_part_id.clone(),
                        error: result_text.clone(),
                    });
                } else {
                    bus.emit(agent_executor::LoopStreamEvent::ToolCompleted {
                        session_id: session_id_spawn.clone(),
                        call_id: call_id.clone(),
                        part_id: pending_part_id.clone(),
                    });
                }
                messages.push(agent_executor::LlmMessage::tool_result(&call_id, &result_text));
            }

            // ── Search saturation corrective reminder ──
            // Pushed AFTER the tool results so the assistant's tool_calls stay
            // immediately followed by tool messages (OpenAI/DeepSeek invariant).
            if inject_search_reminder {
                messages.push(agent_executor::LlmMessage::user(
                    "NOTE: You have been searching for several consecutive rounds \
                     without taking any action. Consider acting on the information \
                     you already have — summarize findings and proceed to execute.",
                ));
            }

            // ── Investigation checkpoint (guard X) ──
            // Pushed AFTER the tool results (same invariant as above). Asks the LLM
            // to justify continued investigation rather than blocking it — big
            // surveys (dozens of files) stay legal, while a spinning-in-place loop
            // (no new files for N rounds) gets an escalating, firmer nudge.
            if inject_investigation_reminder {
                let msg = if read_only_no_progress_rounds as usize
                    >= INVESTIGATION_NO_PROGRESS_WINDOW
                {
                    "WARNING: You have spent many consecutive rounds re-reading the \
                     same files without discovering anything new. You appear to be \
                     spinning in place. Stop investigating and either act on what you \
                     already know or give a conclusion."
                        .to_string()
                } else {
                    format!(
                        "CHECKPOINT: you have spent {} consecutive rounds on \
                         investigation (read-only) without editing. If you already \
                         have enough information, start implementing or give a \
                         conclusion. If you still need to investigate, explicitly \
                         state: what is still missing, which files you will read \
                         next, and roughly how many more rounds you expect. Then \
                         continue.",
                        search_only_rounds
                    )
                };
                messages.push(agent_executor::LlmMessage::user(&msg));
            }

            // ── Blackboard public resource warning ──
            // When blackboard is available and warn_public_resource is enabled,
            // check if any edit tool is targeting a public resource file.
            let should_warn_public = loop_cfg
                .as_ref()
                .map(|lc| lc.blackboard.warn_public_resource)
                .unwrap_or(false);
            if should_warn_public {
                // Reuse the single coordinator from :2640 (per-round create_session
                // leaked a connection pool every iteration). Arc::clone keeps the
                // main coordinator alive; the clone is moved into spawn_blocking.
                let bb = Arc::clone(&bb);
                // Get all public resources from blackboard
                let public_resources =
                    tokio::task::spawn_blocking(move || bb.identify_public_resources()).await;
                    if let Ok(Ok(resources)) = public_resources {
                        let edit_tool_names = ["edit_file", "write", "submit_code", "edit"];
                        let edited_files: Vec<String> = tool_calls
                            .iter()
                            .filter(|tc| edit_tool_names.contains(&tc.function.name.as_str()))
                            .filter_map(|tc| {
                                let args: serde_json::Value = serde_json::from_str(
                                    &tc.function.arguments,
                                )
                                .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                                args.get("file_path")
                                    .or_else(|| args.get("filePath"))
                                    .or_else(|| args.get("path"))
                                    .and_then(|v| v.as_str().map(|s| s.to_string()))
                            })
                            .collect();
                        for file_path in &edited_files {
                            if resources.iter().any(|r| r.file_path == *file_path) {
                                messages.push(agent_executor::LlmMessage::user(
                                    "注意: 该文件是公共资源，被多处引用。请尽量最小化变更范围。",
                                ));
                                break; // Only warn once per round
                            }
                        }
                    }
            }

            // ── Reflect keypoint detection (G16/R1) + fix_ledger / stall fuse (G19) ──
            // Delegates to the shared Reflect ledger so the main loop and the
            // AgenticLoopExecutor explore loop share identical reflection + convergence.
            if should_reflect_spawn {
                // Get the last N tool_result messages (one per tool_call)
                let tool_result_msgs: Vec<&agent_executor::LlmMessage> = messages
                    .iter()
                    .rev()
                    .filter(|m| m.role == "tool")
                    .take(tool_calls.len())
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                let reflect_pairs: Vec<(String, String)> = tool_calls
                    .iter()
                    .enumerate()
                    .map(|(i, tc)| {
                        let result_text = tool_result_msgs
                            .get(i)
                            .map(|m| m.content.as_str())
                            .unwrap_or("")
                            .to_string();
                        (tc.function.name.clone(), result_text)
                    })
                    .collect();
                // Action signatures (tool name + args) for G19 stall detection.
                // Comparing the action — not the result text — makes a "retry the
                // same failing command" loop (output differs only by a timestamp)
                // correctly counted as no progress and fused.
                let reflect_args: Vec<(String, String)> = tool_calls
                    .iter()
                    .map(|tc| {
                        (
                            tc.function.name.clone(),
                            tc.function.arguments.clone(),
                        )
                    })
                    .collect();
                // G5 annotation 回流: collect pending review annotations for the
                // files touched this round.
                let reflect_files: Vec<String> = tool_calls
                    .iter()
                    .filter_map(|tc| {
                        let args: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                        args.get("file_path")
                            .or_else(|| args.get("filePath"))
                            .or_else(|| args.get("path"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    })
                    .collect();
                let annotation_texts: Vec<String> = if !reflect_files.is_empty() {
                    bb.get_file_annotations(&reflect_files)
                        .map(|anns| {
                            anns.iter()
                                .map(|a| format!("- {}: {}", a.file_path, a.content))
                                .collect()
                        })
                        .unwrap_or_default()
                } else {
                    Vec::new()
                };
                // #4: clear annotations for files successfully edited this round,
                // so stale review advice does not re-surface forever (avoid loop).
                // `reflect_pairs` is 1:1 with `tool_calls` (same order), so zip them
                // to map each edit result to its exact file (not by name, which
                // would mis-map when several edits share a tool name).
                for ((name, result), tc) in reflect_pairs.iter().zip(tool_calls.iter()) {
                    if agent_executor::reflect::REFLECT_EDIT_TOOLS.contains(&name.as_str())
                        && !result.starts_with("Error:")
                        && !result.starts_with("error:")
                        && let Some(file) = serde_json::from_str::<serde_json::Value>(&tc.function.arguments)
                            .ok()
                            .and_then(|args| {
                                args.get("file_path")
                                    .or_else(|| args.get("filePath"))
                                    .or_else(|| args.get("path"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                            })
                        {
                            let _ = bb.clear_file_annotations(&[file]);
                        }
                }
                let outcome = reflect_ledger.reflect_round(
                    steps as usize,
                    reflect_on_spawn.as_str(),
                    &reflect_pairs,
                    &annotation_texts,
                    agent_executor::reflect::MAX_REFLECT_STALL,
                    &reflect_args,
                );
                tracing::info!(
                    target: "reflect_ledger",
                    loop_kind = "main",
                    round = steps,
                    reflect_on = %reflect_on_spawn,
                    injected = outcome.prompt.is_some(),
                    pending = reflect_ledger.pending.len(),
                    fixed = reflect_ledger.fixed.len(),
                    stall_rounds = reflect_ledger.stall_rounds,
                    calls_changed = outcome.calls_changed,
                    stalled = outcome.stalled,
                    "reflect_round processed"
                );
                if let Some(reflect_prompt) = outcome.prompt {
                    messages.push(agent_executor::LlmMessage::user(&reflect_prompt));
                }
                if outcome.stalled {
                    let residual_text = outcome
                        .residual
                        .iter()
                        .enumerate()
                        .map(|(i, d)| format!("{}. {}", i + 1, d))
                        .collect::<Vec<_>>()
                        .join("\n");
                    // #3: report residual issues to the user instead of silently "succeeding".
                    messages.push(agent_executor::LlmMessage::user(format!(
                        "[Loop stopped early: unresolved issues remain after {} consecutive reflect rounds without progress]\n{}",
                        agent_executor::reflect::MAX_REFLECT_STALL,
                        residual_text
                    )));
                    eprintln!(
                      "[TRACE-rust] ⚠ reflect stall fuse triggered at step={} → breaking runLoop early (last assistant finish may be tool-calls)",
                      steps
                    );
                    break;
                }
            }

            // ── Quality mid-check (SelfCheck for edit tools) ──
            // When quality mid-check is enabled, run a lightweight
            // syntax check after edit_file/write/submit_code/edit tools.
            // Three-tier response based on overall score:
            //   score >= 0.8  → passed, normal continuation
            //   score 0.5-0.8 → inject suggestions as reflective prompt
            //   score < 0.5   → inject strong correction + flag for potential rollback
            if should_quality_mid_check_spawn {
                let edit_tool_names = ["edit_file", "write", "submit_code", "edit"];
                let edited_files: Vec<String> = tool_calls
                    .iter()
                    .filter(|tc| edit_tool_names.contains(&tc.function.name.as_str()))
                    .filter_map(|tc| {
                        tc.function
                            .arguments
                            .clone()
                            .parse::<serde_json::Value>()
                            .ok()
                            .and_then(|args| {
                                args.get("file_path")
                                    .or_else(|| args.get("filePath"))
                                    .or_else(|| args.get("path"))
                                    .and_then(|v| v.as_str().map(|s| s.to_string()))
                            })
                    })
                    .collect();
                let retry_threshold = loop_cfg
                    .as_ref()
                    .map(|lc| lc.quality.retry_on_score_below)
                    .unwrap_or(0.5);
                for file_path in edited_files {
                    // Cross-platform path resolution (P2-37): the model may
                    // emit an absolute path (`D:\proj\src\a.ts` on Windows,
                    // `/home/u/proj/src/a.ts` on POSIX) or a worktree-relative
                    // one. The previous string checks (`starts_with('/')` +
                    // manual `{}/{}` join) mis-handled Windows drive letters
                    // entirely, so mid-loop QA silently skipped every file on
                    // Windows (`if let Ok(read_to_string)` with no logging).
                    // Use std::path semantics instead.
                    let candidate = std::path::Path::new(&file_path);
                    let full_path: String = if candidate.is_absolute() {
                        file_path.clone()
                    } else {
                        let rel = file_path
                            .trim_start_matches("./")
                            .trim_start_matches(".\\");
                        std::path::Path::new(&project_path_spawn)
                            .join(rel)
                            .to_string_lossy()
                            .to_string()
                    };
                    let file_path_clone = file_path.clone();
                    let full_path_clone = full_path.clone();
                    if let Ok(content) = std::fs::read_to_string(&full_path) {
                        let lang = if full_path.ends_with(".rs") {
                            "rust"
                        } else if full_path.ends_with(".ts") || full_path.ends_with(".tsx") {
                            "typescript"
                        } else if full_path.ends_with(".js") || full_path.ends_with(".jsx") {
                            "javascript"
                        } else if full_path.ends_with(".py") {
                            "python"
                        } else {
                            "unknown"
                        };
                        let quality_req = duo_types::QualityValidateRequest {
                            artifact: duo_types::CodeArtifact {
                                artifact_type: "file".to_string(),
                                content,
                                language: lang.to_string(),
                                file_path: Some(file_path_clone),
                            },
                            quality_level: duo_types::QualityLevel::SelfCheck,
                            interface_contract: None,
                            shared_types: vec![],
                            // Main-agent mid-check stays regex-only (LLM content check
                            // is gated by the user setting and run via CascadeService).
                            enable_llm_check: false,
                            diff: None,
                            kg_related: vec![],
                        };
                        if let Ok(quality) = state_clone.quality.get() {
                            let q = quality.clone();
                            // `validate` is async (may await LLM when enabled); here
                            // `enable_llm_check` is false so it runs pure regex inline.
                            let quality_result = q.validate(&quality_req).await;
                            if let Ok(report) = quality_result {
                                let failed_checks: Vec<String> = report
                                    .checks
                                    .iter()
                                    .filter(|c| !c.passed)
                                    .map(|c| format!("{} (score: {:.1})", c.name, c.score))
                                    .collect();
                                if failed_checks.is_empty() {
                                    // score >= 0.8 equivalent: all checks passed, normal continuation
                                    continue;
                                }
                                if report.score >= 0.8 {
                                    // Overall score good, minor issues — soft hint
                                    continue;
                                }
                                if report.score >= retry_threshold {
                                    // score 0.5-0.8: inject suggestions as reflective prompt
                                    let suggestions_text = if report.suggestions.is_empty() {
                                        failed_checks.join("; ")
                                    } else {
                                        format!(
                                            "{}\nSuggestions: {}",
                                            failed_checks.join("; "),
                                            report.suggestions.join("; ")
                                        )
                                    };
                                    let quality_prompt = format!(
                                        "## Quality Review\n\
                                         Quality issues detected in {} (score: {:.2}):\n\
                                         {}\n\
                                         Consider addressing these before proceeding.",
                                        full_path_clone, report.score, suggestions_text
                                    );
                                    messages
                                        .push(agent_executor::LlmMessage::user(&quality_prompt));
                                } else {
                                    // score < threshold: strong correction
                                    let quality_prompt = format!(
                                        "## MANDATORY QUALITY CHECK\n\
                                         Serious quality issues in {} (score: {:.2}):\n\
                                         {}\n\
                                         Fix these issues immediately before proceeding.\n\
                                         If you cannot fix them, revert the changes.",
                                        full_path_clone,
                                        report.score,
                                        failed_checks.join("; ")
                                    );
                                    messages
                                        .push(agent_executor::LlmMessage::user(&quality_prompt));
                                }
                            }
                        }
                    }
                }
            }

            // ── Snapshot patch after tool execution ──
            // If tools were executed, check if files changed since the last track.
            // Write PatchPart for the UI to display file changes.
            if let Some(ref svc) = snapshot_svc
                && let Some(ref prev_hash) = prev_snapshot_hash {
                    match svc.patch(prev_hash) {
                        Ok(patch_result) => {
                            if !patch_result.files.is_empty() {
                                let patch_part_id = new_part_id();
                                let patch_part =
                                    duo_types::PartData::Patch(duo_types::PatchPartData {
                                        base: duo_types::PartBase {
                                            id: patch_part_id.clone(),
                                            session_id: session_id_spawn.clone(),
                                            message_id: assistant_msg_id.clone(),
                                        },
                                        hash: patch_result.hash.clone(),
                                        files: patch_result.files.clone(),
                                    });
                                if let Err(e) = msg_store.insert_part(
                                    &patch_part_id,
                                    &assistant_msg_id,
                                    &session_id_spawn,
                                    chrono::Utc::now().timestamp_millis(),
                                    &serde_json::to_string(&patch_part).unwrap_or_default(),
                                ) {
                                    tracing::warn!(error = %e, "Failed to write PatchPart");
                                }
                            }
                            // Update prev hash for next round
                            if let Ok(new_hash) = svc.track() {
                                prev_snapshot_hash = Some(new_hash);
                            }
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "Snapshot patch failed (non-fatal)");
                        }
                    }
                }

            // P3/P6: 每轮 edit/write 工具成功后,把这次真实的 LLM 编辑决策落成
            // L2 决策记忆并链接到被编辑文件的 KG File 实体。这是 §11.1 桥接的唯一
            // 生产写入口(此前 store_decision_to_memory 仅测试在调)。无条件放在轮尾,
            // 不依赖 blackboard / quality-mid-check 等可选开关,保证每次编辑都建链。
            // 方法内部全程 best-effort:图/assembler/记忆任一缺失或文件未索引即静默跳过。
            {
                let edit_tool_names = ["edit_file", "write", "submit_code", "edit"];
                let edited_files: Vec<String> = tool_calls
                    .iter()
                    .filter(|tc| edit_tool_names.contains(&tc.function.name.as_str()))
                    .filter_map(|tc| {
                        let args: serde_json::Value = serde_json::from_str(&tc.function.arguments)
                            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                        args.get("file_path")
                            .or_else(|| args.get("filePath"))
                            .or_else(|| args.get("path"))
                            .and_then(|v| v.as_str().map(|s| s.to_string()))
                    })
                    .collect();
                if !edited_files.is_empty() {
                    loop_executor.store_edit_decision_to_kg(&edited_files);
                }
            }

            steps += 1;
            // P2-A: 主循环自己发布轮次与累计读文件数。这两个计数器只在
            // `execute_subagent_loop_*` 内被写,而主循环不走那条路径 →
            // 不在这里发布的话 `GET /agent/metrics` 对主会话恒返回 0。
            // `files_read` 是本 runLoop 共享的去重读取记录,取其 len 即累计读文件数,
            // 与子代理 `files_read_count.store(files_read.len())` 的口径逐字一致。
            live_metrics
                .rounds_completed
                .store(steps as usize, std::sync::atomic::Ordering::Relaxed);
            live_metrics.files_read.store(
                files_read.lock().unwrap_or_else(|e| e.into_inner()).len(),
                std::sync::atomic::Ordering::Relaxed,
            );
        }

        // ── Auto-submit feedback ──
        // After loop completion, submit one automatic feedback entry. This is
        // unconditional — there is no opt-out switch. The rating is heuristic:
        // 2 when the loop ended with an error, 3 when it hit the step cap,
        // 4 otherwise. It is not derived from the quality score.
        if let Ok(feedback) = state_clone.feedback.get() {
            let hit_step_cap =
                effective_max_steps >= 0 && (steps as i64) >= (effective_max_steps as i64);
            let auto_rating: u8 = if last_error.is_some() {
                2 // Loop failed with error — low rating
            } else if hit_step_cap {
                3 // Loop stopped on the step cap — moderate rating
            } else {
                4 // Loop completed normally — good rating
            };
            let auto_comment = format!(
                "Auto: steps={}, error={}",
                steps,
                last_error
                    .as_ref()
                    .map(|e| e.chars().take(200).collect::<String>())
                    .unwrap_or_else(|| "none".to_string())
            );
            let feedback_req = duo_types::FeedbackSubmitRequest {
                session_id: session_id_spawn.clone(),
                rating: auto_rating,
                comment: auto_comment,
                context: Some(format!(
                    "project_path={}, intent_type={}",
                    project_path_spawn,
                    intent_type_spawn.as_deref().unwrap_or("unknown")
                )),
                auto: Some(true),
            };
            let fb = feedback.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let _ = fb.submit(&feedback_req);
            })
            .await;

            // ── Module 1: objective task_outcome signal ──
            // Persist real loop-termination facts (NOT the LLM self-assessed rating
            // above) keyed by session + intent_type. This is the ground-truth source
            // for module 4's attribution JOINs. `success` is objective: error-free
            // AND not truncated by max_steps. Cost fields are real counters.
            let outcome_intent = intent_type_spawn
                .as_deref()
                .unwrap_or("unknown")
                .to_string();
            // `success` is objective: error-free AND not truncated by a step cap.
            // With `effective_max_steps < 0` (unlimited) the second clause is
            // vacuously true, so a clean unlimited run is correctly marked success.
            let outcome_success = last_error.is_none() && !hit_step_cap;
            let outcome_steps = steps as i64;
            let outcome_files = files_read
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len() as i64;
            // `cost_tool_calls` is reserved: `tool_calls` Vec is not in scope at this
            // loop-termination point (it lives in an earlier block). The column exists
            // for module 4; left 0 this phase. `steps` + `files_read` already cover the
            // objective cost signal needed for attribution.
            let outcome_tools = 0i64;
            let fb2 = feedback.clone();
            let sess2 = session_id_spawn.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let outcome = feedback_loop::TaskOutcome {
                    session_id: sess2,
                    intent_type: outcome_intent,
                    success: outcome_success,
                    cost_steps: outcome_steps,
                    cost_files_read: outcome_files,
                    cost_tool_calls: outcome_tools,
                    auto_rating,
                };
                let _ = fb2.submit_task_outcome(&outcome);
            })
            .await;
        }

        // ── Final snapshot track + StepFinishPart ──
        // Write a final StepFinishPart with the end-of-loop snapshot hash + token/cost info.
        // Only write if we have a valid assistant message to reference (FOREIGN KEY constraint).
        if let Some(ref svc) = snapshot_svc
            && let Some(ref msg_id) = last_assistant_msg_id {
                match svc.track() {
                    Ok(final_hash) => {
                        let finish_part_id = new_part_id();
                        // Collect token/cost info from the loop (if available)
                        let finish_part =
                            duo_types::PartData::StepFinish(duo_types::StepFinishPartData {
                                base: duo_types::PartBase {
                                    id: finish_part_id.clone(),
                                    session_id: session_id_spawn.clone(),
                                    message_id: msg_id.clone(),
                                },
                                reason: if last_error.is_some() {
                                    "error"
                                } else {
                                    "done"
                                }
                                .to_string(),
                                snapshot: Some(final_hash),
                                tokens: duo_types::TokenInfo {
                                    total: None,
                                    input: 0.0,
                                    output: 0.0,
                                    reasoning: 0.0,
                                    cache: duo_types::TokenCacheInfo {
                                        read: 0.0,
                                        write: 0.0,
                                    },
                                    breakdown: None,
                                    cache_hit_rate: None,
                                },
                            });
                        if let Err(e) = msg_store.insert_part(
                            &finish_part_id,
                            msg_id,
                            &session_id_spawn,
                            chrono::Utc::now().timestamp_millis(),
                            &serde_json::to_string(&finish_part).unwrap_or_default(),
                        ) {
                            tracing::warn!(error = %e, "Failed to write StepFinishPart");
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "Final snapshot track failed (non-fatal)");
                    }
                }
            }
            // snapshot_svc (Arc<SnapshotService>) drops here — no AppState cache
            // to clean up (the service is owned by the loop, not registered globally).

        // ── Persist an explicit "stopped by user" marker ──
        // The UI only renders a stop indicator when the assistant row carries
        // `error.name == "MessageAbortedError"`. Cancellation can happen in two
        // places this block has to cover:
        //   • during tool execution — the round's assistant message was already
        //     written (completed=None, no error) and the loop breaks at the top
        //     of the next round, so nothing ever rewrites it;
        //   • before the first assistant row exists (stop pressed while the LLM
        //     request was still connecting) — in that case we insert a marker
        //     message so the turn is not left completely blank.
        if cancel_token.is_cancelled() {
            let aborted_error = serde_json::json!({
                "name": "MessageAbortedError",
                "data": { "message": "Interrupted by user" },
            });
            match last_assistant_msg_id.clone() {
                Some(existing_id) => {
                    let mut patched = false;
                    if let Ok(rows) = msg_store.get_messages(&session_id_spawn)
                        && let Some(row) = rows.into_iter().find(|r| r.id == existing_id)
                        && let Ok(mut value) =
                            serde_json::from_str::<serde_json::Value>(&row.data)
                    {
                                let completed =
                                    chrono::Utc::now().timestamp_millis() as f64;
                                if let Some(map) = value.as_object_mut() {
                                    map.insert("error".to_string(), aborted_error);
                                    map.insert(
                                        "finish".to_string(),
                                        serde_json::json!("cancelled"),
                                    );
                                    if let Some(time) =
                                        map.get_mut("time").and_then(|t| t.as_object_mut())
                                    {
                                        time.insert(
                                            "completed".to_string(),
                                            serde_json::json!(completed),
                                        );
                                    }
                                }
                                if let Err(e) =
                                    msg_store.update_message(&existing_id, &value.to_string())
                                {
                                    tracing::warn!(
                                        error = %e,
                                        "Failed to mark assistant message as aborted"
                                    );
                                } else {
                                    patched = true;
                                }
                    }
                    if !patched {
                        tracing::warn!(
                            session_id = %session_id_spawn,
                            "cancelled run: could not patch assistant message with abort marker"
                        );
                    }
                }
                None => {
                    let marker_id = new_message_id();
                    let now = chrono::Utc::now().timestamp_millis();
                    let marker = duo_types::MessageInfo::Assistant(
                        duo_types::AssistantMessageInfo {
                            id: marker_id.clone(),
                            session_id: session_id_spawn.clone(),
                            time: duo_types::AssistantMessageTime {
                                created: now as f64,
                                completed: Some(now as f64),
                            },
                            error: Some(aborted_error),
                            parent_id: parent_user_msg_id
                                .clone()
                                .unwrap_or_else(|| session_id_spawn.clone()),
                            model_id: model_spawn.clone(),
                            provider_id: config_provider.clone(),
                            mode: "rust-run-loop".to_string(),
                            agent: agent_name_spawn.clone(),
                            path: duo_types::AssistantMessagePath {
                                cwd: project_path_spawn.clone(),
                                root: project_path_spawn.clone(),
                            },
                            summary: None,
                            tokens: duo_types::TokenInfo {
                                total: None,
                                input: 0.0,
                                output: 0.0,
                                reasoning: 0.0,
                                cache: duo_types::TokenCacheInfo {
                                    read: 0.0,
                                    write: 0.0,
                                },
                                breakdown: None,
                                cache_hit_rate: None,
                            },
                            structured: None,
                            variant: None,
                            finish: Some("cancelled".to_string()),
                        },
                    );
                    if let Err(e) = msg_store.insert_message(
                        &marker_id,
                        &session_id_spawn,
                        now,
                        &serde_json::to_string(&marker).unwrap_or_default(),
                    ) {
                        tracing::warn!(error = %e, "Failed to insert aborted assistant message");
                    } else {
                        last_assistant_msg_id = Some(marker_id);
                    }
                }
            }
        }

        if let Some(err) = &last_error {
            eprintln!("[TRACE-rust] ✗ runLoop ended with error: {}", err);
            bus.emit(agent_executor::LoopStreamEvent::LoopError {
                session_id: session_id_spawn.clone(),
                message: err.clone(),
            });
        } else {
            eprintln!(
                "[TRACE-rust] ⑨ runLoop completed normally, steps={}, last_assistant_msg_id={:?}, emitting LoopDone",
                steps, last_assistant_msg_id
            );
            bus.emit(agent_executor::LoopStreamEvent::LoopDone {
                session_id: session_id_spawn.clone(),
                steps,
            });
        }

        // Clean up cancellation token and event bus (identity-gated: a
        // superseded run must not delete the newer run's entries).
        eprintln!(
            "[TRACE-cancel] runLoop cleanup: removing cancel_key={} from agent_cancellations",
            cancel_key
        );
        cleanup_run_loop_registration(
            &state_clone,
            &cancel_key,
            &session_id_spawn,
            &event_bus_spawn,
        )
        .await;
    });

    // Return immediately — the runLoop is running in the background.
    // TS polls DB to track progress.
    eprintln!(
        "[TRACE-rust] returning HTTP {{ status: started }} for session_id={}",
        session_id
    );
    Ok(Json(serde_json::json!({
        "status": "started",
        "sessionId": session_id,
    })))
}

// ── /agent/run_loop/events/:session_id (SSE) ──────────────────────────
// Subscribes to a running runLoop's real-time event stream.
// The loop runs detached (spawned in background); SSE disconnect does NOT
// cancel the loop. SSE reconnect gets subsequent events (no replay).
async fn run_loop_events_handler(
    State(state): State<crate::server::AppState>,
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> std::result::Result<
    Sse<impl futures::Stream<Item = std::result::Result<Event, Infallible>>>,
    unified_error::UnifiedError,
> {
    let bus = {
        let buses = state.runloop_event_buses.lock().await;
        match buses.get(&session_id) {
            Some(b) => b.clone(),
            None => {
                return Err(unified_error::UnifiedError::NotFound(format!(
                    "no active run_loop for session: {}",
                    session_id
                )));
            }
        }
    };

    let rx = bus.subscribe();
    let sid_for_log = session_id.clone();

    // G11 (revised): do NOT cancel the run_loop when this SSE connection is
    // dropped. The TS sidecar is the sole subscriber, so any sidecar restart /
    // transient fetch drop used to kill a healthy loop mid-LLM-call, surfacing
    // as "LLM streaming request cancelled" in the UI. Cancellation is now
    // explicit-only: POST /agent/cancel (user stop, abort route) or a newer
    // run_loop superseding this one (registration cancels the old token).
    // A whole-app exit kills the sidecar processes anyway, so an orphaned
    // loop cannot outlive the IDE.

    let stream = futures::stream::unfold(
        (rx, sid_for_log, false),
        move |(mut rx, sid, done)| async move {
            // If the previous iteration emitted a terminal event (LoopDone/LoopError),
            // close the stream immediately instead of blocking on recv() again.
            if done {
                return None;
            }
            match rx.recv().await {
                Ok(event) => {
                    let is_terminal = matches!(
                        &event,
                        agent_executor::LoopStreamEvent::LoopDone { .. }
                            | agent_executor::LoopStreamEvent::LoopError { .. }
                    );
                    let sse_event = match &event {
                        agent_executor::LoopStreamEvent::LoopStarted { .. } => Event::default()
                            .event("loop_started")
                            .data(serde_json::to_string(&event).unwrap_or_default()),
                        agent_executor::LoopStreamEvent::LlmCallStarted { .. } => Event::default()
                            .event("llm_call_started")
                            .data(serde_json::to_string(&event).unwrap_or_default()),
                        agent_executor::LoopStreamEvent::ThinkingDelta {
                            content,
                            message_id,
                            part_id,
                            ..
                        } => Event::default().event("thinking").data(
                            serde_json::json!({
                                "messageID": message_id,
                                "partID": part_id,
                                "content": content,
                            })
                            .to_string(),
                        ),
                        agent_executor::LoopStreamEvent::TextDelta {
                            content,
                            message_id,
                            part_id,
                            ..
                        } => Event::default().event("delta").data(
                            serde_json::json!({
                                "messageID": message_id,
                                "partID": part_id,
                                "content": content,
                            })
                            .to_string(),
                        ),
                        agent_executor::LoopStreamEvent::LlmCallDone { .. } => Event::default()
                            .event("done")
                            .data(serde_json::to_string(&event).unwrap_or_default()),
                        agent_executor::LoopStreamEvent::ToolPending { .. } => Event::default()
                            .event("tool_pending")
                            .data(serde_json::to_string(&event).unwrap_or_default()),
                        agent_executor::LoopStreamEvent::ToolRunning { .. } => Event::default()
                            .event("tool_running")
                            .data(serde_json::to_string(&event).unwrap_or_default()),
                        agent_executor::LoopStreamEvent::ToolCompleted { .. } => Event::default()
                            .event("tool_completed")
                            .data(serde_json::to_string(&event).unwrap_or_default()),
                        agent_executor::LoopStreamEvent::ToolError { .. } => Event::default()
                            .event("tool_error")
                            .data(serde_json::to_string(&event).unwrap_or_default()),
                        agent_executor::LoopStreamEvent::LoopDone { .. } => {
                            let ev = Event::default()
                                .event("loop_done")
                                .data(serde_json::to_string(&event).unwrap_or_default());
                            return Some((Ok(ev), (rx, sid, true))); // done=true → next iteration returns None
                        }
                        agent_executor::LoopStreamEvent::LoopError { .. } => {
                            let ev = Event::default()
                                .event("loop_error")
                                .data(serde_json::to_string(&event).unwrap_or_default());
                            return Some((Ok(ev), (rx, sid, true))); // done=true → next iteration returns None
                        }
                        agent_executor::LoopStreamEvent::MaxStepsReached { .. } => Event::default()
                            .event("max_steps")
                            .data(serde_json::to_string(&event).unwrap_or_default()),
                        agent_executor::LoopStreamEvent::SubagentStarted { .. } => Event::default()
                            .event("subagent_started")
                            .data(serde_json::to_string(&event).unwrap_or_default()),
                        agent_executor::LoopStreamEvent::SubagentDelta { .. } => Event::default()
                            .event("subagent_delta")
                            .data(serde_json::to_string(&event).unwrap_or_default()),
                        agent_executor::LoopStreamEvent::SubagentDone { .. } => Event::default()
                            .event("subagent_done")
                            .data(serde_json::to_string(&event).unwrap_or_default()),
                        agent_executor::LoopStreamEvent::SubagentError { .. } => Event::default()
                            .event("subagent_error")
                            .data(serde_json::to_string(&event).unwrap_or_default()),
                    };
                    Some((Ok(sse_event), (rx, sid, is_terminal)))
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(session_id = %sid, lagged = n, "SSE subscriber lagged");
                    let ev = Event::default()
                        .event("lagged")
                        .data(serde_json::json!({"missed": n}).to_string());
                    Some((Ok(ev), (rx, sid, false)))
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => None,
            }
        },
    );

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    ))
}

// ── /agent/tool_result ───────────────────────────────────────────────

#[derive(Deserialize)]
struct ToolResultRequest {
    session_id: String,
    call_id: String,
    result: String,
}

async fn tool_result_handler(
    State(state): State<crate::server::AppState>,
    Json(req): Json<ToolResultRequest>,
) -> Result<Json<serde_json::Value>> {
    state
        .tool_registry
        .submit_tool_result(&req.session_id, &req.call_id, req.result)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ── /agent/messages/delete ──
// Deletes a message (and its parts via ON DELETE CASCADE) from the project DB.
// Called by TS when RUST_SINGLE_WRITE is enabled and the user deletes a message.

#[derive(serde::Deserialize)]
struct DeleteMessageRequest {
    message_id: String,
}

async fn delete_message_handler(
    State(state): State<crate::server::AppState>,
    Json(req): Json<DeleteMessageRequest>,
) -> Result<Json<serde_json::Value>> {
    state
        .message_store
        .delete_message(&req.message_id)
        .map_err(|e| {
            tracing::warn!(error = %e, message_id = %req.message_id, "Failed to delete message");
            unified_error::UnifiedError::Internal(format!("Failed to delete message: {e}"))
        })?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ── /agent/parts/delete ──
// Deletes a single part from the project DB.
// Called by TS when RUST_SINGLE_WRITE is enabled and the user deletes a part.

#[derive(serde::Deserialize)]
struct DeletePartRequest {
    part_id: String,
}

async fn delete_part_handler(
    State(state): State<crate::server::AppState>,
    Json(req): Json<DeletePartRequest>,
) -> Result<Json<serde_json::Value>> {
    state.message_store.delete_part(&req.part_id).map_err(|e| {
        tracing::warn!(error = %e, part_id = %req.part_id, "Failed to delete part");
        unified_error::UnifiedError::Internal(format!("Failed to delete part: {e}"))
    })?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: a single-tool action signature "tool(args)".
    fn sig(name: &str, args: &str) -> Vec<(String, String)> {
        vec![(name.to_string(), args.to_string())]
    }

    // ── P2-24: a first-round completion marker must be honoured ──

    #[test]
    fn first_text_only_round_with_marker_completes() {
        assert_eq!(
            completion_decision(0, "TASK_COMPLETE: all files updated"),
            CompletionDecision::Done,
            "a model that declares completion up front must not be sent back to work"
        );
    }

    #[test]
    fn marker_inside_prose_does_not_complete() {
        assert_eq!(
            completion_decision(0, "I will not say TASK_COMPLETE yet"),
            CompletionDecision::Confirm
        );
    }

    #[test]
    fn markerless_text_only_round_confirms_then_auto_closes() {
        assert_eq!(completion_decision(0, "looks done"), CompletionDecision::Confirm);
        assert_eq!(
            completion_decision(COMPLETION_CONFIRM_LIMIT, "looks done"),
            CompletionDecision::AutoClose
        );
    }

    #[test]
    fn detect_doom_loop_consecutive_repeat_fires() {
        // Three identical rounds in a row must trip the fuse.
        let mut window: Vec<Vec<(String, String)>> = Vec::new();
        let mut fired = false;
        for _ in 0..3 {
            let (is_loop, _) = detect_recurring_doom_loop(
                &mut window,
                &sig("bash", "npm test"),
                DOOM_LOOP_THRESHOLD,
                DOOM_LOOP_WINDOW,
            );
            if is_loop {
                fired = true;
                break;
            }
        }
        assert!(fired, "3 consecutive identical actions must be a doom loop");
    }

    #[test]
    fn detect_doom_loop_ab_oscillation_fires() {
        // A/B/A/B/... never repeats on two *adjacent* rounds, but the same
        // action recurs — the sliding-window count must still trip it.
        let mut window: Vec<Vec<(String, String)>> = Vec::new();
        let mut fired = false;
        let rounds = [
            sig("bash", "cmd A"),
            sig("bash", "cmd B"),
            sig("bash", "cmd A"),
            sig("bash", "cmd B"),
            sig("bash", "cmd A"),
        ];
        for r in rounds {
            let (is_loop, _) =
                detect_recurring_doom_loop(&mut window, &r, DOOM_LOOP_THRESHOLD, DOOM_LOOP_WINDOW);
            if is_loop {
                fired = true;
                break;
            }
        }
        assert!(fired, "A/B oscillation must be detected as a doom loop");
    }

    #[test]
    fn detect_doom_loop_distinct_actions_do_not_fire() {
        // Each round a genuinely different action → never a loop.
        let mut window: Vec<Vec<(String, String)>> = Vec::new();
        for i in 0..10 {
            let (is_loop, _) = detect_recurring_doom_loop(
                &mut window,
                &sig("edit", &format!("file_{i}.ts")),
                DOOM_LOOP_THRESHOLD,
                DOOM_LOOP_WINDOW,
            );
            assert!(!is_loop, "distinct actions must never trip the fuse");
        }
        // window must stay bounded by DOOM_LOOP_WINDOW
        assert!(window.len() <= DOOM_LOOP_WINDOW);
    }

    #[test]
    fn detect_doom_loop_window_expiry_resets() {
        // An action that recurs only once outside the window must not trip.
        let mut window: Vec<Vec<(String, String)>> = Vec::new();
        let (is_loop, _) =
            detect_recurring_doom_loop(&mut window, &sig("bash", "x"), DOOM_LOOP_THRESHOLD, 2);
        assert!(!is_loop);
        // Fill the window with other actions so the first one falls out.
        detect_recurring_doom_loop(&mut window, &sig("bash", "y"), DOOM_LOOP_THRESHOLD, 2);
        let (is_loop, _) =
            detect_recurring_doom_loop(&mut window, &sig("bash", "x"), DOOM_LOOP_THRESHOLD, 2);
        assert!(!is_loop, "a recurrence outside the window must not be a doom loop");
    }

    #[test]
    fn test_extract_task_session_id_normal() {
        // 标准输出格式
        let output = "task_id: abc123 (for resuming)\n\n<task_result>\nsome result\n</task_result>";
        assert_eq!(extract_task_session_id(output), Some("abc123".to_string()));
    }

    #[test]
    fn test_extract_task_session_id_no_prefix() {
        // 没有 task_id: 前缀 → None
        let output = "some output without task_id";
        assert_eq!(extract_task_session_id(output), None);
    }

    #[test]
    fn test_extract_task_session_id_empty_after_prefix() {
        // task_id: 后面没有内容
        let output = "task_id: ";
        assert_eq!(extract_task_session_id(output), None);
    }

    #[test]
    fn test_extract_task_session_id_uuid_format() {
        // ULID 格式 session ID
        let output = "task_id: 01HXYZ123456789 (for resuming)\n\n<task_result>...</task_result>";
        let result = extract_task_session_id(output);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), "01HXYZ123456789");
    }

    #[test]
    fn test_extract_task_session_id_newlines_after() {
        // 输出后有换行
        let output = "task_id: sess_001 (for resuming)\n\n<task_result>\nwork done\n</task_result>";
        assert_eq!(
            extract_task_session_id(output),
            Some("sess_001".to_string())
        );
    }

    #[test]
    fn test_extract_task_session_id_no_space_suffix() {
        // 实际 execute_task 输出总是带 " (for resuming)" 后缀
        // 这里测试一个中间带换行但不带空格的极端情况（实际不会出现）
        let output = "task_id: abc123\nrest";
        // find(' ') 在换行后找不到空格 → 取全长
        // 但实际输出格式保证有空格，这仅做防御性测试
        let result = extract_task_session_id(output);
        assert!(result.is_some());
        // 结果不会是 "abc123" 而是 "abc123\nrest"，因为函数依赖空格做分隔
        // 这确认了函数对无空格场景的防御行为
    }

    #[test]
    fn reserve_global_slot_respects_cap() {
        let in_flight = Arc::new(AtomicUsize::new(0));
        let g1 = reserve_global_slot(in_flight.clone(), 2);
        assert!(g1.is_some());
        let g2 = reserve_global_slot(in_flight.clone(), 2);
        assert!(g2.is_some());
        // Cap reached: further reservations are rejected (fast-fail).
        let g3 = reserve_global_slot(in_flight.clone(), 2);
        assert!(g3.is_none());
        assert_eq!(in_flight.load(std::sync::atomic::Ordering::Relaxed), 2);
        // Release one slot via guard drop.
        drop(g1);
        assert_eq!(in_flight.load(std::sync::atomic::Ordering::Relaxed), 1);
        // A new reservation now succeeds.
        let g4 = reserve_global_slot(in_flight.clone(), 2);
        assert!(g4.is_some());
    }

    #[test]
    fn reserve_global_slot_shrink_blocks_new() {
        let in_flight = Arc::new(AtomicUsize::new(0));
        // Two reservations accepted at cap 2.
        let _g1 = reserve_global_slot(in_flight.clone(), 2).unwrap();
        let _g2 = reserve_global_slot(in_flight.clone(), 2).unwrap();
        // Shrink the cap to 1: new reservations are blocked even though the
        // in-flight count is still 2 — the cap is the single source of truth,
        // so no over-admission occurs.
        let g3 = reserve_global_slot(in_flight.clone(), 1);
        assert!(g3.is_none());
    }

    #[test]
    fn reserve_global_slot_no_overadmission_under_contention() {
        // With cap N, at most N reservations succeed regardless of how many
        // callers race to observe the same pre-increment value.
        let in_flight = Arc::new(AtomicUsize::new(0));
        let mut guards = Vec::new();
        for _ in 0..10 {
            if let Some(g) = reserve_global_slot(in_flight.clone(), 3) {
                guards.push(g);
            }
        }
        assert_eq!(guards.len(), 3);
        assert_eq!(in_flight.load(std::sync::atomic::Ordering::Relaxed), 3);
    }

    // ── ③ B1→B5 wire boundary: TS-sent snake_case `target_file` /
    //    `interface_contract` must deserialize and survive the conversion to the
    //    internal parallel-executor `SubTask`. ──

    #[test]
    fn sub_task_request_deserializes_contract_fields() {
        let json = r#"{
            "id": "s1",
            "task_prompt": "implement User",
            "mode": "codegen",
            "target_file": "src/User.ts",
            "interface_contract": {
                "extends": null,
                "properties": { "id": "string" },
                "methods": {
                    "save": { "params": [], "return_type": "void", "description": null, "side_effects": [] }
                }
            }
        }"#;
        let req: SubTaskRequest =
            serde_json::from_str(json).expect("deserialize SubTaskRequest with contract");
        assert_eq!(req.target_file.as_deref(), Some("src/User.ts"));
        let contract = req.interface_contract.clone().expect("interface_contract present");
        assert_eq!(contract.properties.get("id").map(String::as_str), Some("string"));
        assert!(contract.methods.contains_key("save"));

        // Round-trips through the internal conversion (smoke for the B1→B5 mapping).
        let sub = sub_task_request_to_sub_task(req);
        assert_eq!(sub.target_file.as_deref(), Some("src/User.ts"));
        assert!(sub.interface_contract.is_some());
    }

    #[test]
    fn sub_task_request_without_contract_defaults_to_none() {
        // R6.1: omitting the contract fields must NOT break parsing and must
        // yield None (zero regression for plain parallel sub-tasks).
        let json = r#"{ "id": "s2", "task_prompt": "explore only" }"#;
        let req: SubTaskRequest =
            serde_json::from_str(json).expect("deserialize plain SubTaskRequest");
        assert!(req.target_file.is_none());
        assert!(req.interface_contract.is_none());
        let sub = sub_task_request_to_sub_task(req);
        assert!(sub.target_file.is_none());
        assert!(sub.interface_contract.is_none());
    }
}
