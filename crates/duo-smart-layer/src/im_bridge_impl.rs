//! SmartLayerBridge implementation for duo-smart-layer.
//!
//! This file implements the `im_bridge::SmartLayerBridge` trait,
//! bridging IM commands to the smart-layer's internal subsystems.
//!
//! Key implementation details:
//! - `clarify_intent`: Uses `IntentClarifier` to determine the user's intent.
//! - `execute_agent`: Delegates to `AgentExecutor` for LLM-based tasks.
//! - SSE events: Connected to a broadcast channel for real-time notifications.

use async_trait::async_trait;
use duo_types::IntentClarifyRequest;
use duo_utils::sync::MutexPoisonRecover;
use im_bridge::bridge::{FeishuCardAction, ModelInfo, ProjectInfo, SmartLayerBridge};
use im_bridge::sse_bridge::SseEvent;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use agent_executor::AgenticLoopExecutor;

use crate::server::AppState;

/// Mask an API key for safe logging: show "***" + last 4 chars.
/// Empty strings return "(empty)".
fn mask_api_key(key: &str) -> String {
    if key.is_empty() {
        return "(empty)".to_string();
    }
    if key.len() <= 4 {
        return format!("***{}", key);
    }
    format!("***...{}", &key[key.len() - 4..])
}

/// Reset the per-chat conversation context for a brand new conversation.
///
/// Pure state operation (no network, no `AppState`): drops the prompt that
/// was stashed while waiting for project / model selection so it cannot be
/// resurrected by a later `select_project` / `select_model`, and forgets the
/// previous duoduo session id. Project binding is intentionally **not**
/// touched — "new session" changes the conversation, not the working dir.
///
/// Defined as a module-level free function (not an `impl` method) so it can be
/// unit-tested with two bare `Mutex<HashMap>`s, without constructing an
/// `AppState` (which requires heavy async subsystem initialization).
fn reset_conversation_context(
    pending_prompts: &std::sync::Mutex<std::collections::HashMap<String, std::collections::VecDeque<String>>>,
    sessions: &std::sync::Mutex<std::collections::HashMap<String, String>>,
    chat_id: &str,
) -> Option<String> {
    duo_utils::sync::lock(pending_prompts).remove(chat_id);
    duo_utils::sync::lock(sessions).remove(chat_id)
}

/// Max parked prompts per chat (P1-15). Fixed value: beyond this the OLDEST
/// parked prompt is dropped, keeping the newest context relevant.
const PENDING_PROMPTS_CAP: usize = 5;

/// Park a prompt for a chat (queue, bounded — drops the oldest when full).
fn feishu_pending_prompt_push(chat_id: &str, prompt: &str) {
    let mut map = feishu_state().pending_prompts.lock_recover();
    let q = map.entry(chat_id.to_string()).or_default();
    if q.len() >= PENDING_PROMPTS_CAP {
        q.pop_front();
    }
    q.push_back(prompt.to_string());
}

/// Pop the oldest parked prompt for a chat.
fn feishu_pending_prompt_pop(chat_id: &str) -> Option<String> {
    feishu_state()
        .pending_prompts
        .lock_recover()
        .get_mut(chat_id)
        .and_then(|q| q.pop_front())
}

/// Put a popped prompt back at the FRONT (only used when launching it failed,
/// so it is retried by the next selection/consume — never silently lost).
fn feishu_pending_prompt_unpop(chat_id: &str, prompt: &str) {
    let mut map = feishu_state().pending_prompts.lock_recover();
    let q = map.entry(chat_id.to_string()).or_default();
    q.push_front(prompt.to_string());
    while q.len() > PENDING_PROMPTS_CAP {
        q.pop_back();
    }
}

struct FeishuProjectToken {
    chat_id: String,
    project_path: String,
    expires_at: std::time::Instant,
}

/// Resolve a `FeishuCardAction` into a concrete plan, performing all
/// network-free guards up front (missing token, expired token, token/chat
/// mismatch, empty prompt). Returned as a `CardActionPlan` so the imperative
/// handler can stay thin and this decision logic is unit-testable without an
/// `AppState`.
#[derive(Debug)]
enum CardActionPlan {
    SelectProject { project_path: String },
    SubmitPrompt { prompt: String },
    SubmitPromptEmpty,
    SwitchProject,
    SelectModel { provider: String, model_id: String },
    NewSession,
    ViewStatus,
    AbortTask,
    Unknown,
}

/// Pure classifier: maps `action.action` to a `CardActionPlan`, validating
/// `select_project` tokens against `tokens` and the `submit_prompt` payload.
///
/// Errors (as `Err(&str)`) represent guard failures that should surface to the
/// user; the caller wraps them in `anyhow`. Returns `Ok(CardActionPlan::Unknown)`
/// for unrecognized action types (matches the prior `_ => Ok(String::new())`
/// fallthrough semantics).
fn classify_card_action(
    action: &FeishuCardAction,
    tokens: &std::collections::HashMap<String, FeishuProjectToken>,
    now: std::time::Instant,
) -> Result<CardActionPlan, &'static str> {
    match action.action.as_str() {
        "select_project" => {
            let token = action
                .project_token
                .as_ref()
                .ok_or("missing project token")?;
            let token_value = tokens
                .get(token)
                .ok_or("项目选择已过期，请重新发送 /project")?;
            if token_value.expires_at <= now {
                return Err("项目选择已过期，请重新发送 /project");
            }
            if token_value.chat_id != action.chat_id {
                return Err("项目选择 token 与当前会话不匹配，请重新发送 /project");
            }
            Ok(CardActionPlan::SelectProject {
                project_path: token_value.project_path.clone(),
            })
        }
        "submit_prompt" => {
            let prompt = action
                .prompt
                .as_ref()
                .ok_or("submit_prompt: missing prompt input")?;
            if prompt.trim().is_empty() {
                return Ok(CardActionPlan::SubmitPromptEmpty);
            }
            Ok(CardActionPlan::SubmitPrompt {
                prompt: prompt.clone(),
            })
        }
        "switch_project" => Ok(CardActionPlan::SwitchProject),
        "select_model" => {
            let provider = action
                .model_provider
                .clone()
                .ok_or("缺少模型 provider")?;
            let model_id = action.model_id.clone().ok_or("缺少模型 ID")?;
            Ok(CardActionPlan::SelectModel {
                provider,
                model_id,
            })
        }
        "new_session" => Ok(CardActionPlan::NewSession),
        "view_status" => Ok(CardActionPlan::ViewStatus),
        "abort_task" => Ok(CardActionPlan::AbortTask),
        _ => Ok(CardActionPlan::Unknown),
    }
}

/// Process-wide Feishu conversation state (P2-48).
///
/// `SmartLayerBridgeImpl` is reconstructed on **every** configuration save
/// (`im_runtime::start_or_restart`), so per-instance storage silently threw
/// away each chat's project binding, session id and pending prompt — and with
/// them the tokens embedded in already-delivered selection cards, which then
/// failed with "项目选择已过期" even though the user had just clicked them.
///
/// Lifting every map to the process keeps them alive across bridge restarts,
/// the same treatment `im_bridge::feishu::ws::global_event_dedup` gives the
/// event-dedup table.
struct FeishuState {
    /// Mutable project path for agent execution.
    project_path: Mutex<String>,
    /// Rate limiting: per-chat timestamp of the last launched agent task.
    last_agent_call: Mutex<HashMap<String, Instant>>,
    /// Session context: per-chat recent messages for multi-turn conversation.
    chat_history: Mutex<HashMap<String, Vec<String>>>,
    /// chat_id -> selected project path.
    project_bindings: Mutex<HashMap<String, String>>,
    /// Project-selection token -> token metadata.
    project_tokens: Mutex<HashMap<String, FeishuProjectToken>>,
    /// chat_id -> prompts parked while awaiting project / model selection.
    /// P1-15: a VecDeque (bounded) instead of a single slot — the old
    /// unconditional `insert` silently discarded every parked message but the
    /// latest one.
    pending_prompts: Mutex<HashMap<String, std::collections::VecDeque<String>>>,
    /// chat_id -> duoduo session id.
    sessions: Mutex<HashMap<String, String>>,
}

fn feishu_state() -> &'static FeishuState {
    static STATE: LazyLock<FeishuState> = LazyLock::new(|| FeishuState {
        project_path: Mutex::new(
            std::env::var(duo_types::env_keys::im::DEFAULT_PROJECT_PATH)
                .unwrap_or_else(|_| ".".to_string()),
        ),
        last_agent_call: Mutex::new(HashMap::new()),
        chat_history: Mutex::new(HashMap::new()),
        project_bindings: Mutex::new(HashMap::new()),
        project_tokens: Mutex::new(HashMap::new()),
        pending_prompts: Mutex::new(HashMap::new()),
        sessions: Mutex::new(HashMap::new()),
    });
    &STATE
}

/// Minimum interval between agent calls per chat.
const AGENT_RATE_LIMIT_MS: u64 = 5_000;
/// Number of recent messages to retain per chat for context.
const CHAT_HISTORY_SIZE: usize = 5;

/// Reject an agent launch that comes too soon after the previous one for this
/// chat. Returns the cooldown notice to relay to the user.
///
/// This is the **single gate** for every path that can start an agent task:
/// text messages, card `select_project` / `select_model` callbacks, and the
/// replay of a prompt that was parked while a selection was pending. Guarding
/// them at the caller instead left the card callbacks unlimited (P2-51).
fn check_agent_rate_limit(chat_id: &str) -> Result<(), String> {
    let now = Instant::now();
    let mut last = duo_utils::sync::lock(&feishu_state().last_agent_call);
    if let Some(prev) = last.get(chat_id) {
        let elapsed = now.duration_since(*prev);
        if elapsed.as_millis() < AGENT_RATE_LIMIT_MS as u128 {
            let wait_ms = AGENT_RATE_LIMIT_MS - elapsed.as_millis() as u64;
            return Err(format!("⏳ Agent 冷却中，请 {} 秒后再试", (wait_ms as f64 / 1000.0).ceil()));
        }
    }
    last.insert(chat_id.to_string(), now);
    // Stale entries would otherwise grow without bound.
    last.retain(|_, t| now.duration_since(*t).as_secs() < 60);
    Ok(())
}

/// SmartLayerBridge implementation backed by `AppState`.
///
/// Holds no per-chat state of its own — see [`feishu_state`].
pub struct SmartLayerBridgeImpl {
    state: AppState,
}

impl SmartLayerBridgeImpl {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }

/// Render a project path for display: `~`-prefix the home dir, otherwise
/// show only the trailing `.../filename` so long absolute paths stay compact.
fn display_path(path: &str) -> String {
        let home = std::env::var("HOME").unwrap_or_default();
        if !home.is_empty() && path.starts_with(&home) {
            return path.replacen(&home, "~", 1);
        }
        std::path::Path::new(path)
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| format!(".../{}", s))
            .unwrap_or_else(|| path.to_string())
    }

    /// Wait until the task identified by `session_id` finishes running on the
    /// project, so the final assistant message can be fetched safely.
    async fn await_task_complete(
        coordinator: &crate::project_tasks::ProjectTaskCoordinator,
        project_path: &str,
        session_id: &str,
    ) {
        const MAX_WAIT_SECS: u64 = 30 * 60;

        // Phase 1: wait until our task is observed as running.
        let mut waited: u64 = 0;
        loop {
            let status = coordinator.status().await;
            if status
                .running
                .iter()
                .any(|task| task.task_id == session_id && task.project_path == project_path)
            {
                break;
            }
            if waited >= MAX_WAIT_SECS {
                tracing::warn!(
                    session_id,
                    "Feishu task never observed running (may have finished fast); will still attempt reply fetch"
                );
                break;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
            waited += 2;
        }

        // Phase 2: wait until it is no longer running.
        let mut waited: u64 = 0;
        loop {
            let status = coordinator.status().await;
            if !status
                .running
                .iter()
                .any(|task| task.task_id == session_id)
            {
                return;
            }
            if waited >= MAX_WAIT_SECS {
                tracing::warn!(session_id, "Feishu task completion wait timed out");
                return;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
            waited += 2;
        }
    }

    async fn start_feishu_prompt(&self, chat_id: &str, prompt: &str) -> anyhow::Result<String> {
        let project_path = {
            feishu_state().project_bindings
                .lock_recover()
                .get(chat_id)
                .cloned()
        };
        let Some(project_path) = project_path else {
            feishu_pending_prompt_push(chat_id, prompt);
            return Ok(format!(
                "📁 {}，我已暂存这条消息，请在下方的项目选择卡片中点选。",
                im_bridge::bridge::NEEDS_PROJECT_MARKER
            ));
        };

        let client = crate::duoduo_client::DuoduoSessionClient::from_injected_credentials()?;

        // Resolve the model to run the task with. The globally configured model
        // (shared single source of truth with the desktop) is used when present;
        // otherwise the user must pick one via the model-selection card before
        // the task can start.
        let model = client.get_global_model().await.ok().flatten();
        let Some(model) = model else {
            feishu_pending_prompt_push(chat_id, prompt);
            return Ok(format!(
                "🤖 {}，我已暂存这条消息，请在下方的模型选择卡片中点选。",
                im_bridge::bridge::NEEDS_MODEL_MARKER
            ));
        };

        // P2-51: the single gate for launching an agent task. Every path that
        // can start one funnels through here — plain text, the card
        // `select_project` / `select_model` callbacks, and the replay of a
        // prompt parked while a selection was pending — so the cooldown is
        // enforced here rather than per caller. Checking it in
        // `handle_feishu_text` only left the card callbacks unlimited: a user
        // could spam a project-selection button and queue one agent run per
        // click.
        check_agent_rate_limit(chat_id).map_err(anyhow::Error::msg)?;

        // Persistent session per chat: reuse the existing Feishu session so the
        // conversation accumulates in ONE desktop session (instead of a new
        // fragmented session per message). This makes Feishu messages appear
        // exactly like typing into the AI input box — they land in the same
        // ongoing conversation and render as normal user bubbles.
        let title = format!("飞书会话·{}", Self::display_path(&project_path));
        // P1-15: atomic per-chat claim. The old check-then-get spanned an
        // await (create_session), so two messages more than 5s apart could
        // BOTH pass the rate gate and create two sessions for one chat —
        // splitting the conversation. The first claimer inserts a placeholder
        // under the same lock that reads, creates, then publishes the real id;
        // the loser polls briefly for the published id.
        const CREATING: &str = "__creating__";
        // B16: the loser's wait must be bounded. If the winner panics (the
        // ws.rs panic isolation swallows it before the Err-branch cleanup
        // runs) the placeholder would stay `__creating__` forever and this
        // chat would poll — and hold its serial gate — indefinitely. 100 ×
        // 300ms = 30s, well past create_session's own 10s HTTP timeout.
        const CREATING_POLL_MAX: usize = 100;
        let mut session_id = {
            let state = feishu_state();
            let mut poll_waits = 0usize;
            loop {
                let claim = {
                    let mut m = duo_utils::sync::lock(&state.sessions);
                    match m.get(chat_id).cloned() {
                        Some(sid) if sid == CREATING => None,
                        Some(sid) => Some(sid),
                        None => {
                            m.insert(chat_id.to_string(), CREATING.to_string());
                            Some(String::new())
                        }
                    }
                };
                match claim {
                    Some(sid) if sid.is_empty() => {
                        match client.create_session(&project_path, &title).await {
                            Ok(sid) => {
                                duo_utils::sync::lock(&state.sessions)
                                    .insert(chat_id.to_string(), sid.clone());
                                break sid;
                            }
                            Err(e) => {
                                // Release the placeholder so a later message
                                // can claim and retry — never leave it stuck.
                                let mut m = duo_utils::sync::lock(&state.sessions);
                                if m.get(chat_id).map(|s| s == CREATING).unwrap_or(false) {
                                    m.remove(chat_id);
                                }
                                return Err(e);
                            }
                        }
                    }
                    Some(sid) => break sid,
                    None => {
                        poll_waits += 1;
                        if poll_waits > CREATING_POLL_MAX {
                            // Stale placeholder — the winner died before it
                            // could publish or clean up. Clear it so the next
                            // message can claim and retry.
                            let mut m = duo_utils::sync::lock(&state.sessions);
                            if m.get(chat_id).map(|s| s == CREATING).unwrap_or(false) {
                                m.remove(chat_id);
                            }
                            return Err(anyhow::anyhow!(
                                "session creation timed out waiting for a concurrent claim; please retry"
                            ));
                        }
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                }
            }
        };

        let coordinator = self.state.project_tasks.clone();

        // Serialize: wait for any running task on this project to release before
        // sending, so prompt_async's fail-fast /task/acquire never 409s. Retry a
        // few times if a 409 slips through (cross-chat same-project race), and
        // recreate the session once if it vanished on the Node side (404).
        let prompt_id = format!("feishu-{}", uuid::Uuid::new_v4());
        let mut send_attempts: u32 = 0;
        loop {
            match client
                .send_prompt_async(
                    &project_path,
                    &session_id,
                    prompt,
                    &prompt_id,
                    Some(model.clone()),
                )
                .await
            {
                Ok(true) => break,
                Ok(false) => {
                    // 409 conflict — previous task still holding the project lock.
                    send_attempts += 1;
                    if send_attempts >= 5 {
                        return Err(anyhow::anyhow!("项目任务繁忙，请稍后重试"));
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
                Err(e) => {
                    // If the persistent session expired on the Node side (e.g. the
                    // user deleted it), recreate it once and retry.
                    if send_attempts == 0 && e.to_string().contains("404") {
                        let sid = client.create_session(&project_path, &title).await?;
                        feishu_state().sessions
                            .lock_recover()
                            .insert(chat_id.to_string(), sid.clone());
                        session_id = sid;
                        send_attempts = 1;
                        continue;
                    }
                    return Err(e);
                }
            }
        }

        let _ = self.state.sse_event_tx.send(SseEvent::AgentTaskStarted {
            session_id: session_id.clone(),
            chat_id: Some(chat_id.to_string()),
            summary: format!("项目: {}\n{}", Self::display_path(&project_path), prompt),
        });

        // Background: wait for the task to finish, then fetch the LLM reply and
        // push it back to Feishu as a normal chat message (so the answer shows
        // up in the conversation, not just a status card).
        {
            let sse_tx = self.state.sse_event_tx.clone();
            let client_for_reply = client.clone();
            let session_id_reply = session_id.clone();
            let chat_id_reply = chat_id.to_string();
            let project_path_reply = project_path.clone();
            let coordinator_reply = coordinator.clone();
            tokio::spawn(async move {
                Self::await_task_complete(
                    &coordinator_reply,
                    &project_path_reply,
                    &session_id_reply,
                )
                .await;
                // Give the session a moment to persist the final assistant message.
                tokio::time::sleep(Duration::from_secs(1)).await;
                match client_for_reply.fetch_assistant_reply(&session_id_reply).await {
                    Ok(reply) if !reply.trim().is_empty() => {
                        let _ = sse_tx.send(SseEvent::FeishuReply {
                            chat_id: chat_id_reply,
                            text: reply,
                        });
                    }
                    Ok(_) => {
                        tracing::info!(
                            session_id = %session_id_reply,
                            "Feishu reply fetch returned empty; skipping push"
                        );
                    }
                    // P1-15: a failed fetch used to abandon the reply after a
                    // single warn — the agent's answer was permanently lost to
                    // the chat. Retry 3×5s (fixed values, same cadence as the
                    // pending-ACK timer) before giving up with an error log.
                    Err(e) => {
                        let mut last = e;
                        let mut delivered = false;
                        let mut empty_reply = false;
                        for _ in 0..3u32 {
                            tokio::time::sleep(Duration::from_secs(5)).await;
                            match client_for_reply.fetch_assistant_reply(&session_id_reply).await {
                                Ok(reply) if !reply.trim().is_empty() => {
                                    let _ = sse_tx.send(SseEvent::FeishuReply {
                                        chat_id: chat_id_reply,
                                        text: reply,
                                    });
                                    delivered = true;
                                    break;
                                }
                                Ok(_) => {
                                    empty_reply = true;
                                    break;
                                }
                                Err(e2) => last = e2,
                            }
                        }
                        // Log only the actual outcome — a recovered delivery
                        // must not be reported as "not delivered".
                        if delivered {
                            // success — no log needed
                        } else if empty_reply {
                            tracing::warn!(
                                session_id = %session_id_reply,
                                "Feishu reply fetch returned empty after retries; nothing to push"
                            );
                        } else {
                            tracing::error!(
                                error = %last,
                                session_id = %session_id_reply,
                                "Failed to fetch Feishu reply after 3 retries — agent answer not delivered"
                            );
                        }
                    }
                }
            });
        }

        Ok(format!(
            "🔄 任务已开始\n项目: {}\nSession: `{}`",
            Self::display_path(&project_path),
            session_id
        ))
    }
}

#[async_trait]
impl SmartLayerBridge for SmartLayerBridgeImpl {
    /// Clarify the user's intent and return a structured result.
    fn clarify_intent_result(&self, text: &str) -> anyhow::Result<duo_types::ClarificationResult> {
        let req = IntentClarifyRequest {
            user_input: text.to_string(),
            project_context: None,
            user_id: None,
        };
        self.state.intent.get()?.clarify(&req)
    }

    async fn handle_feishu_text(&self, chat_id: &str, text: &str) -> anyhow::Result<String> {
        // No rate-limit check here on purpose: `start_feishu_prompt` owns it,
        // and it is the only thing that actually launches a task (P2-51).

        if feishu_state()
            .project_bindings
            .lock_recover()
            .contains_key(chat_id)
        {
            return self.start_feishu_prompt(chat_id, text).await;
        }

        feishu_pending_prompt_push(chat_id, text);
        Ok(format!(
            "📁 {}。我已暂存这条消息，请在下方的项目选择卡片中点选。",
            im_bridge::bridge::NEEDS_PROJECT_MARKER
        ))
    }

    async fn handle_feishu_project(
        &self,
        chat_id: &str,
        path: Option<&str>,
    ) -> anyhow::Result<String> {
        let Some(path) = path else {
            return Ok("📁 请在项目选择卡片中选择项目。".to_string());
        };
        feishu_state().project_bindings
            .lock_recover()
            .insert(chat_id.to_string(), path.to_string());
        // A project switch invalidates the previous persistent session (it was
        // bound to the old project), so drop it and let the next prompt create
        // a fresh persistent session for the newly-bound project.
        duo_utils::sync::lock(&feishu_state().sessions).remove(chat_id);
        feishu_state().project_path
            .lock_recover()
            .clone_from(&path.to_string());
        self.state
            .im_project_chats
            .lock()
            .await
            .insert(path.to_string(), chat_id.to_string());

        let pending_prompt = feishu_pending_prompt_pop(chat_id);
        if let Some(prompt) = pending_prompt {
            // P1-15: on launch failure, put the parked prompt back at the
            // front of the queue — the next selection / message retries it
            // instead of silently losing it (the token was already consumed
            // and the binding already written, so a hard `?` lost it forever).
            match self.start_feishu_prompt(chat_id, &prompt).await {
                Ok(started) => Ok(format!(
                    "✅ 已绑定项目: {}\n\n{}",
                    Self::display_path(path),
                    started
                )),
                Err(e) => {
                    feishu_pending_prompt_unpop(chat_id, &prompt);
                    Ok(format!(
                        "✅ 已绑定项目: {}\n\n⚠️ 暂存任务启动失败（已保留，稍后重试）：{}",
                        Self::display_path(path),
                        e
                    ))
                }
            }
        } else {
            Ok(format!("✅ 已绑定项目: {}", Self::display_path(path)))
        }
    }

    async fn handle_feishu_card_action(&self, action: FeishuCardAction) -> anyhow::Result<String> {
        // Resolve the action up front (pure, network-free guards). `select_project`
        // tokens are consumed once, so remove it from the map here for that branch.
        let plan = {
            let mut tokens = duo_utils::sync::lock(&feishu_state().project_tokens);
            let plan = classify_card_action(&action, &tokens, std::time::Instant::now())
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            if let CardActionPlan::SelectProject { .. } = &plan
                && let Some(token) = &action.project_token {
                    tokens.remove(token);
                }
            plan
        };

        match plan {
            CardActionPlan::SubmitPromptEmpty => {
                Ok("⚠️ 请输入需求描述".to_string())
            }
            CardActionPlan::SelectProject { project_path } => {
                self.handle_feishu_project(&action.chat_id, Some(&project_path))
                    .await
            }
            CardActionPlan::SubmitPrompt { prompt } => {
                // Route through handle_feishu_text (same as natural language)
                self.handle_feishu_text(&action.chat_id, &prompt).await
            }
            CardActionPlan::SwitchProject => {
                // User wants to switch project — send project selection card
                self.handle_feishu_project(&action.chat_id, None).await
            }
            CardActionPlan::SelectModel { provider, model_id } => {
                // P0-7: whitelist check — the (provider, model) pair must come
                // from the same source the model-selection card was built from
                // (`/provider` list for the bound project). A stale or forged
                // card value is rejected BEFORE it can overwrite the shared
                // global config (an invalid model would break every session's
                // LLM requests with no auto-recovery).
                let available = match self.list_models(&action.chat_id).await {
                    Ok(m) => m,
                    Err(e) => {
                        return Ok(format!(
                            "⚠️ 无法校验模型选择（{}）。请确认已绑定项目后重试。",
                            e
                        ));
                    }
                };
                let valid = available
                    .iter()
                    .any(|m| m.provider_id == provider && m.model_id == model_id);
                if !valid {
                    return Ok(format!(
                        "⚠️ 模型不可用: {}/{} 不在当前可选列表中，请重新点击「切换模型」选择。",
                        provider, model_id
                    ));
                }
                // Persist the selection into the shared global config (single
                // source of truth for desktop + every Feishu chat). Await the
                // write so the task launch below reads the freshly-saved model
                // instead of racing a fire-and-forget write and re-prompting.
                let client =
                    crate::duoduo_client::DuoduoSessionClient::from_injected_credentials()?;
                client
                    .set_global_model(&provider, &model_id)
                    .await
                    .map_err(|e| anyhow::anyhow!("保存模型选择失败: {}", e))?;

                // If a prompt was stashed while waiting for the model, run it now.
                let pending = feishu_pending_prompt_pop(&action.chat_id);
                let reply = match pending {
                    Some(prompt) => {
                        // P1-15: on launch failure, put the parked prompt back
                        // at the front of the queue instead of losing it.
                        match self.start_feishu_prompt(&action.chat_id, &prompt).await {
                            Ok(started) => format!(
                                "✅ 已选择模型: {}/{}\n\n{}",
                                provider, model_id, started
                            ),
                            Err(e) => {
                                feishu_pending_prompt_unpop(&action.chat_id, &prompt);
                                format!(
                                    "✅ 已选择模型: {}/{}\n\n⚠️ 暂存任务启动失败（已保留，稍后重试）：{}",
                                    provider, model_id, e
                                )
                            }
                        }
                    }
                    None => format!(
                        "✅ 已选择模型: {}/{}。直接发送消息即可执行任务。",
                        provider, model_id
                    ),
                };
                Ok(reply)
            }
            CardActionPlan::NewSession => {
                // Start a fresh conversation for this chat: drop the persistent
                // chat -> session mapping so the next message creates a brand-new
                // duoduo session (see `start_feishu_prompt`, which creates one
                // whenever the map has no entry). The old session stays intact
                // on the desktop for history. If a task is still running in the
                // old session, abort it first so its completion card doesn't
                // land in the middle of the new conversation.
                //
                // Drop the whole per-chat conversation context, not just the
                // session mapping: a prompt parked while waiting for project /
                // model selection would otherwise be resurrected by the next
                // `select_project` / `select_model` (see the two
                // `feishu_pending_prompts.remove(...)` consumers at
                // `handle_feishu_project` and `select_model`) and silently
                // execute an abandoned instruction right after the user asked
                // for a fresh start. Project binding is deliberately kept —
                // "new session" changes the conversation, not the working dir.
                let old = reset_conversation_context(
                    &feishu_state().pending_prompts,
                    &feishu_state().sessions,
                    &action.chat_id,
                );
                if let Some(old_session) = old {
                    let project = feishu_state()
                        .project_bindings
                        .lock_recover()
                        .get(&action.chat_id)
                        .cloned();
                    if let Some(project) = project
                        && let Ok(client) =
                            crate::duoduo_client::DuoduoSessionClient::from_injected_credentials()
                            && let Err(e) = client.abort_session(&project, &old_session).await {
                                tracing::debug!(error = %e, session = %old_session, "abort old session on new_session (likely idle, ignored)");
                            }
                    Ok(format!(
                        "🆕 已开启新会话（旧会话 `{}` 已归档，可在桌面端查看历史）。直接发送消息即可开始。",
                        old_session
                    ))
                } else {
                    Ok("🆕 已就绪，直接发送消息即可开启新会话。".to_string())
                }
            }
            CardActionPlan::ViewStatus => self.get_feishu_status(&action.chat_id).await,
            CardActionPlan::AbortTask => self.abort_feishu_task(&action.chat_id).await,
            CardActionPlan::Unknown => Ok(String::new()),
        }
    }

    async fn abort_feishu_task(&self, chat_id: &str) -> anyhow::Result<String> {
        let project = feishu_state()
            .project_bindings
            .lock_recover()
            .get(chat_id)
            .cloned();
        let session = duo_utils::sync::lock(&feishu_state().sessions).get(chat_id).cloned();
        match (project, session) {
            (Some(project), Some(session)) => {
                let client =
                    crate::duoduo_client::DuoduoSessionClient::from_injected_credentials()?;
                client.abort_session(&project, &session).await?;
                Ok(format!("🛑 已中止当前飞书任务\nSession: `{}`", session))
            }
            _ => Ok("当前没有可中止的飞书任务".to_string()),
        }
    }

    async fn get_feishu_status(&self, chat_id: &str) -> anyhow::Result<String> {
        let project = feishu_state()
            .project_bindings
            .lock_recover()
            .get(chat_id)
            .cloned();
        let session = duo_utils::sync::lock(&feishu_state().sessions).get(chat_id).cloned();
        let task_status = self.state.project_tasks.status().await;
        let queue_text = if let Some(project_path) = project.as_ref() {
            let running = task_status
                .running
                .iter()
                .find(|task| &task.project_path == project_path)
                .map(|task| task.summary.clone().unwrap_or_else(|| task.task_id.clone()));
            let queued = task_status
                .queued
                .iter()
                .filter(|task| &task.project_path == project_path)
                .count();
            match running {
                Some(summary) => format!("\n当前运行: {}\n排队任务: {}", summary, queued),
                None => format!("\n当前运行: 无\n排队任务: {}", queued),
            }
        } else {
            String::new()
        };
        Ok(format!(
            "项目: {}\nSession: {}{}",
            project
                .map(|p| Self::display_path(&p))
                .unwrap_or_else(|| "未绑定".to_string()),
            session.unwrap_or_else(|| "未创建".to_string()),
            queue_text
        ))
    }

    async fn list_ide_projects(&self, chat_id: &str) -> anyhow::Result<Vec<ProjectInfo>> {
        let client = crate::duoduo_client::DuoduoSessionClient::from_injected_credentials()?;
        let projects = client.list_projects_from_sessions().await?;
        let mut out = Vec::with_capacity(projects.len());
        let mut tokens = duo_utils::sync::lock(&feishu_state().project_tokens);
        let now = std::time::Instant::now();
        tokens.retain(|_, value| value.expires_at > now);
        for project in projects {
            let token = uuid::Uuid::new_v4().to_string();
            tokens.insert(
                token.clone(),
                FeishuProjectToken {
                    chat_id: chat_id.to_string(),
                    project_path: project.path.clone(),
                    expires_at: now + std::time::Duration::from_secs(10 * 60),
                },
            );
            out.push(ProjectInfo {
                token,
                name: project.name,
            });
        }
        // NOTE: do NOT seed `feishu_pending_prompts` with an empty-string entry
        // when no IDE projects are open. Doing so would later be pulled out by
        // `handle_feishu_project` / `select_model` (the two `remove` consumers)
        // and fed to `start_feishu_prompt` as an empty task, firing a pointless
        // agent call. A real prompt waiting for a project is already stashed by
        // `handle_feishu_text` / `start_feishu_prompt` with its actual text.
        Ok(out)
    }

    async fn list_models(&self, chat_id: &str) -> anyhow::Result<Vec<ModelInfo>> {
        // Models are listed per bound project (the `/provider` endpoint is
        // directory-scoped). Without a bound project there is nothing to list.
        let project_path = feishu_state()
            .project_bindings
            .lock_recover()
            .get(chat_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("未绑定项目，请先选择项目"))?;
        let client = crate::duoduo_client::DuoduoSessionClient::from_injected_credentials()?;
        client.list_models(&project_path).await
    }

    /// Execute an AI agent prompt asynchronously.
    ///
    /// Delegates to `AgentExecutor` for LLM-based task execution.
    /// Injects memory & knowledge-graph context before execution,
    /// consistent with the `/agent/execute` HTTP endpoint in `agent.rs`.
    /// Returns the agent's response content.
    async fn execute_agent(&self, prompt: &str) -> anyhow::Result<String> {
        if !self.state.executor.with_llm() {
            return Err(anyhow::anyhow!(
                "LLM 未配置。请在桌面端或 IM 设置中配置模型后再试。"
            ));
        }

        // Register with scheduler for lifecycle tracking
        let scheduler = self.state.scheduler.clone();
        let desc = format!(
            "IM agent: {}",
            &prompt[..prompt.floor_char_boundary(100)]
        );
        let task = tokio::task::spawn_blocking(move || {
            scheduler.submit(
                &desc,
                agent_scheduler::TaskPriority::Normal,
                Some("im-agent"),
                None,
            )
        })
        .await??;
        let task_id = task.id.clone();

        // Resolve project_path from mutable state (switchable via /project).
        let project_path = duo_utils::sync::lock(&feishu_state().project_path).clone();
        let has_project = project_path != ".";
        let pp_for_agent = project_path.clone();

        // Inject memory context into the prompt for Agent mode.
        // Mirrors the logic in agent.rs::execute() to bring IM-initiated Agent
        // requests to parity with HTTP-initiated ones.
        let context_builder = self.state.context.clone();
        let prompt_owned = prompt.to_string();
        // M5 (8-1): bound the blocking assembly at 25s (same fixed value as
        // the HTTP assembly sites) — a huge repo must not stall the IM agent
        // past the point of usefulness; degrade to context-free instead.
        let assembled_result = match tokio::time::timeout(
            std::time::Duration::from_secs(25),
            tokio::task::spawn_blocking(move || {
                let budget = 2000; // Budget for memory context injection
                if has_project {
                    context_builder.assemble_with_project(&prompt_owned, budget, Some(&project_path))
                } else {
                    context_builder.assemble(&prompt_owned, budget)
                }
            }),
        )
        .await
        {
            Ok(joined) => joined.unwrap_or_else(|e| {
                tracing::warn!(error = %e, "Context assembly spawn_blocking panicked");
                Err(anyhow::anyhow!("{} - context assembly", e))
            }),
            Err(_) => {
                tracing::warn!("Context assembly timed out after 25s; degrading to context-free");
                Err(anyhow::anyhow!("context assembly timed out (25s)"))
            }
        };

        let final_prompt = match assembled_result {
            Ok(assembled) => {
                if !assembled.assembled_context.is_empty() {
                    let mut vars = std::collections::HashMap::new();
                    vars.insert("assembled_context", assembled.assembled_context.as_str());
                    vars.insert("original_prompt", prompt);
                    context_builder::normalize_code_blocks(
                        &prompt_template::registry::get("context.inject")
                            .expect("invariant: 'context.inject' template is registered at startup in prompt-template registry")
                            .render(&vars),
                    )
                } else {
                    prompt.to_string()
                }
            }
            Err(e) => {
                // Context injection failure should not block the agent execution
                tracing::warn!(error = %e, "Failed to assemble memory context for IM Agent mode");
                prompt.to_string()
            }
        };

        // Use AgenticLoopExecutor for read+analyze capability (matches web version).
        let agentic_loop = AgenticLoopExecutor::new((*self.state.executor).clone(), &pp_for_agent)
            .with_security_policy(self.state.security_policy.clone())
            .with_context_builder(self.state.context.clone())
            .with_tool_concurrency(
                self.state
                    .executor
                    .get_llm_config()
                    .tool_concurrency
                    .unwrap_or(agent_executor::DEFAULT_TOOL_CONCURRENCY as u32),
            )
            .with_permission_rules(self.state.permission_rules.as_ref().clone())
            .with_gears(agent_executor::intel_gear::load_gears_from_env().payloads)
            .with_skill_catalog(agent_executor::intel_gear::load_gears_from_env().skill_catalog)
            .with_interactive(false);

        // system_prompt = template-rendered assembled context (memory injection),
        // task_prompt = original user prompt.
        let system_prompt = final_prompt;
        let task_prompt = prompt.to_string();

        let result = agentic_loop
            .execute_explore_loop(&system_prompt, &task_prompt)
            .await
            .map_err(|e| anyhow::anyhow!("{}", e));

        // Update scheduler lifecycle
        let sched = self.state.scheduler.clone();
        let tid = task_id.clone();
        match &result {
            Ok(_) => {
                let _ = tokio::task::spawn_blocking(move || sched.complete(&tid)).await;
            }
            Err(e) => {
                let reason = format!("{}", e);
                let _ = tokio::task::spawn_blocking(move || sched.fail(&tid, &reason)).await;
            }
        }

        result
    }

    /// Execute agent with chat_id for rate limiting and multi-turn context.
    async fn execute_agent_with_chat(&self, prompt: &str, chat_id: &str) -> anyhow::Result<String> {
        // Same single gate as `start_feishu_prompt` — one cooldown
        // implementation, not two copies that can drift.
        check_agent_rate_limit(chat_id).map_err(anyhow::Error::msg)?;

        // L7: Session context — inject recent chat history into prompt
        let history_prelude = {
            let history = duo_utils::sync::lock(&feishu_state().chat_history);
            let msgs = history.get(chat_id);
            msgs.map(|m| {
                m.iter()
                    .enumerate()
                    .map(|(i, msg)| format!("## Context (previous message {}):\n{}", i + 1, msg))
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
        };

        let augmented_prompt = match history_prelude {
            Some(ref ctx) if !ctx.is_empty() => {
                format!("{}\n\n## Current request:\n{}", ctx, prompt)
            }
            _ => prompt.to_string(),
        };

        let result = self.execute_agent(&augmented_prompt).await;

        // Store this interaction in chat history (trim to CHAT_HISTORY_SIZE)
        {
            let mut history = duo_utils::sync::lock(&feishu_state().chat_history);
            let entry = history.entry(chat_id.to_string()).or_default();
            entry.push(format!(
                "Q: {}\nA: {}",
                prompt,
                result
                    .as_ref()
                    .map(|s| s.chars().take(500).collect::<String>())
                    .unwrap_or_else(|_| "error".into())
            ));
            while entry.len() > CHAT_HISTORY_SIZE {
                entry.remove(0);
            }
            // Clean up chats with no recent activity (>10 min)
            history.retain(|_, msgs| !msgs.is_empty());
        }

        result
    }

    /// Set the LLM configuration or project path.
    fn set_llm_config(&self, key: &str, value: &str) {
        match key {
            "project_path" => {
                if !value.is_empty() {
                    let mut pp = duo_utils::sync::lock(&feishu_state().project_path);
                    *pp = value.to_string();
                    tracing::info!(value = %value, "Project path updated via IM bridge");
                }
            }
            "provider" | "api_key" | "model_id" | "context_window" | "max_output_tokens" => {
                // Retrieve current config, apply the single-field update, then write back.
                // This avoids needing to pass all fields at once via IM.
                let mut current = self.state.executor.get_llm_config();
                match key {
                    "provider" => current.provider = value.to_string(),
                    "api_key" => {
                        // Store the API key directly in LlmConfig.api_key.
                        // No longer uses unsafe { std::env::set_var() } — the key
                        // is resolved by execute_prompt via config.api_key directly.
                        if !value.is_empty() {
                            current.api_key = Some(value.to_string());
                            // Dual-write: persist to OS keyring for survival across restarts.
                            // Keyring is the primary persistence layer; LlmConfig.api_key
                            // is the runtime in-memory copy.
                            if let Err(e) =
                                crate::secure_store::store_api_key(&current.provider, value)
                            {
                                tracing::warn!(
                                    provider = %current.provider,
                                    error = %e,
                                    "Failed to persist API key to keyring (key is still in memory for this session)"
                                );
                            }
                        } else {
                            current.api_key = None;
                            // Key cleared — also remove from keyring
                            if let Err(e) = crate::secure_store::delete_api_key(&current.provider) {
                                tracing::warn!(
                                    provider = %current.provider,
                                    error = %e,
                                    "Failed to delete API key from keyring"
                                );
                            }
                        }
                    }
                    "model_id" => current.default_model_id = value.to_string(),
                    "context_window" => {
                        if let Ok(cw) = value.parse::<u32>() {
                            current.context_window = Some(cw);
                        } else {
                            tracing::warn!(
                                "Invalid context_window value '{}', expected positive integer",
                                value
                            );
                            current.context_window = None;
                        }
                    }
                    "max_output_tokens" => {
                        if let Ok(v) = value.parse::<u32>() {
                            current.max_output_tokens = Some(v);
                        } else {
                            tracing::warn!(
                                "Invalid max_output_tokens value '{}', expected positive integer",
                                value
                            );
                            current.max_output_tokens = None;
                        }
                    }
                    _ => unreachable!(),
                }
                self.state.executor.set_llm_config(current);

                // Trigger duoduo sync (fire-and-forget).
                // For per-field IM bridge calls, each invocation safely attempts sync:
                // sync_to_duoduo internally checks api_key/base_url availability.
                let sync_config = self.state.executor.get_llm_config();
                tokio::spawn(crate::duoduo_sync::sync_to_duoduo(sync_config));

                // Mask api_key in log output to prevent credential leakage.
                let log_value = if key == "api_key" {
                    mask_api_key(value)
                } else {
                    value.to_string()
                };
                tracing::info!(key = %key, value = %log_value, "LLM config updated via IM bridge");
            }
            _ => {
                tracing::warn!(key = %key, "Unknown LLM config key via IM bridge");
            }
        }
    }

    /// Check if LLM is configured.
    fn is_llm_configured(&self) -> bool {
        self.state.executor.with_llm()
    }

    /// Subscribe to SSE events for push notifications.
    ///
    /// Returns a receiver from the AppState's broadcast channel.
    /// Events are produced by agent/quality status changes and consumed
    /// by IM adapters (Feishu) to push notifications to users.
    fn subscribe_events(&self) -> tokio::sync::broadcast::Receiver<SseEvent> {
        self.state.sse_event_tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds two bare `Mutex<HashMap>`s standing in for the per-chat state
    /// without any `AppState` (which is impossible to construct in a unit test).
    fn fresh_state() -> (
        std::sync::Mutex<std::collections::HashMap<String, std::collections::VecDeque<String>>>,
        std::sync::Mutex<std::collections::HashMap<String, String>>,
    ) {
        (
            std::sync::Mutex::new(std::collections::HashMap::new()),
            std::sync::Mutex::new(std::collections::HashMap::new()),
        )
    }

    /// P1-15: test helper — park a prompt through the same bounded-queue
    /// semantics the production code uses.
    fn park(pending: &std::sync::Mutex<std::collections::HashMap<String, std::collections::VecDeque<String>>>, chat: &str, prompt: &str) {
        duo_utils::sync::lock(pending)
            .entry(chat.to_string())
            .or_default()
            .push_back(prompt.to_string());
    }

    #[test]
    fn reset_conversation_context_clears_pending_and_session() {
        let (pending, sessions) = fresh_state();
        park(&pending, "chatA", "帮我重构登录");
        duo_utils::sync::lock(&sessions).insert("chatA".into(), "sess-123".into());

        let old = reset_conversation_context(
            &pending,
            &sessions,
            "chatA",
        );

        assert_eq!(old.as_deref(), Some("sess-123"));
        assert!(duo_utils::sync::lock(&pending).get("chatA").is_none());
        assert!(duo_utils::sync::lock(&sessions).get("chatA").is_none());
        assert!(duo_utils::sync::lock(&pending).is_empty());
        assert!(duo_utils::sync::lock(&sessions).is_empty());
    }

    #[test]
    fn reset_conversation_context_is_targeted_per_chat() {
        let (pending, sessions) = fresh_state();
        park(&pending, "chatA", "A 的待办");
        park(&pending, "chatB", "B 的待办");
        duo_utils::sync::lock(&sessions).insert("chatA".into(), "sess-A".into());
        duo_utils::sync::lock(&sessions).insert("chatB".into(), "sess-B".into());

        let old = reset_conversation_context(
            &pending,
            &sessions,
            "chatA",
        );

        assert_eq!(old.as_deref(), Some("sess-A"));
        // chatA cleared
        assert!(duo_utils::sync::lock(&pending).get("chatA").is_none());
        assert!(duo_utils::sync::lock(&sessions).get("chatA").is_none());
        // chatB untouched
        assert_eq!(
            duo_utils::sync::lock(&pending)
                .get("chatB")
                .and_then(|q| q.front().map(|s| s.as_str())),
            Some("B 的待办")
        );
        assert_eq!(
            duo_utils::sync::lock(&sessions).get("chatB").map(|s| s.as_str()),
            Some("sess-B")
        );
    }

    #[test]
    fn reset_conversation_context_returns_none_when_absent() {
        let (pending, sessions) = fresh_state();

        let old = reset_conversation_context(
            &pending,
            &sessions,
            "never-seen",
        );

        assert!(old.is_none());
        assert!(duo_utils::sync::lock(&pending).is_empty());
        assert!(duo_utils::sync::lock(&sessions).is_empty());
    }

    /// Regression guard: the parked prompt must not be resurrected by a later
    /// project/model selection. Asserts the core invariant `reset` fulfils:
    /// after clearing, the pending map no longer holds the abandoned instruction.
    #[test]
    fn reset_conversation_context_drops_abandoned_prompt() {
        let (pending, sessions) = fresh_state();
        park(&pending, "chatA", "用户已放弃的旧指令");

        reset_conversation_context(&pending, &sessions, "chatA");

        // A subsequent select_project-style consumer would find nothing to run.
        let resurrected = duo_utils::sync::lock(&pending).remove("chatA");
        assert!(resurrected.is_none());
    }

    // ---- mask_api_key --------------------------------------------------

    #[test]
    fn mask_api_key_handles_empty_and_short_and_long() {
        assert_eq!(mask_api_key(""), "(empty)");
        assert_eq!(mask_api_key("ab"), "***ab");
        assert_eq!(mask_api_key("1234"), "***1234");
        assert_eq!(mask_api_key("sk-abcdefghij"), "***...ghij");
    }

    // ---- check_agent_rate_limit (P2-51) --------------------------------

    /// The cooldown lives on the single launch path, so a card callback cannot
    /// bypass it by skipping `handle_feishu_text`.
    #[test]
    fn rate_limit_blocks_a_second_launch_inside_the_window() {
        let chat = "rate_limit_test_chat";
        duo_utils::sync::lock(&feishu_state().last_agent_call).remove(chat);

        assert!(check_agent_rate_limit(chat).is_ok(), "first launch passes");
        assert!(
            check_agent_rate_limit(chat).is_err(),
            "second launch inside the cooldown must be rejected"
        );

        duo_utils::sync::lock(&feishu_state().last_agent_call).remove(chat);
    }

    #[test]
    fn rate_limit_budget_is_per_chat() {
        let (a, b) = ("rate_limit_chat_a", "rate_limit_chat_b");
        {
            let mut last = duo_utils::sync::lock(&feishu_state().last_agent_call);
            last.remove(a);
            last.remove(b);
        }
        assert!(check_agent_rate_limit(a).is_ok());
        assert!(
            check_agent_rate_limit(b).is_ok(),
            "a different chat has its own budget"
        );
        {
            let mut last = duo_utils::sync::lock(&feishu_state().last_agent_call);
            last.remove(a);
            last.remove(b);
        }
    }

    // ---- feishu_state survives a bridge rebuild (P2-48) ----------------

    /// `im_runtime::start_or_restart` builds a brand-new
    /// `SmartLayerBridgeImpl` on every config save. Per-instance storage used to
    /// drop every binding, session and selection token at that moment.
    #[test]
    fn feishu_state_is_process_global_not_per_instance() {
        let chat = "rebuild_test_chat";
        let before = feishu_state() as *const FeishuState;
        {
            let mut bindings = duo_utils::sync::lock(&feishu_state().project_bindings);
            bindings.insert(chat.to_string(), "/proj".to_string());
        }

        // A "rebuilt" bridge reads the very same storage — no AppState needed.
        let after = feishu_state() as *const FeishuState;
        assert_eq!(before, after, "state must be process-global");
        assert_eq!(
            duo_utils::sync::lock(&feishu_state().project_bindings)
                .get(chat)
                .map(String::as_str),
            Some("/proj"),
            "the binding must survive a bridge rebuild"
        );

        duo_utils::sync::lock(&feishu_state().project_bindings).remove(chat);
    }

    // ---- display_path --------------------------------------------------

    #[test]
    fn display_path_tildifies_home_prefix() {
        unsafe {
            std::env::set_var("HOME", "/home/duoduo");
        }
        assert_eq!(SmartLayerBridgeImpl::display_path("/home/duoduo/work/app"), "~/work/app");
        unsafe {
            std::env::remove_var("HOME");
        }
    }

    #[test]
    fn display_path_ellipsizes_unmatched_path() {
        // With HOME unset, non-home paths fall back to ".../<filename>".
        unsafe {
            std::env::remove_var("HOME");
        }
        assert_eq!(SmartLayerBridgeImpl::display_path("/abs/deep/project"), ".../project");
        assert_eq!(SmartLayerBridgeImpl::display_path("/justfile"), ".../justfile");
    }

    // ---- classify_card_action (dispatch + guards) ----------------------

    fn token_map_with(chat_id: &str, token: &str, path: &str, expires_at: std::time::Instant) -> std::collections::HashMap<String, FeishuProjectToken> {
        let mut m = std::collections::HashMap::new();
        m.insert(
            token.to_string(),
            FeishuProjectToken {
                chat_id: chat_id.to_string(),
                project_path: path.to_string(),
                expires_at,
            },
        );
        m
    }

    #[test]
    fn classify_select_project_valid_maps_to_plan() {
        let now = std::time::Instant::now();
        let tokens = token_map_with("chatA", "tok1", "/proj", now + std::time::Duration::from_secs(60));
        let action = FeishuCardAction {
            action: "select_project".into(),
            chat_id: "chatA".into(),
            project_token: Some("tok1".into()),
            prompt: None,
            model_provider: None,
            model_id: None,
            message_id: None,
        };
        let plan = classify_card_action(&action, &tokens, now).unwrap();
        match plan {
            CardActionPlan::SelectProject { project_path } => assert_eq!(project_path, "/proj"),
            _ => panic!("expected SelectProject"),
        }
    }

    #[test]
    fn classify_select_project_missing_token_errors() {
        let tokens = std::collections::HashMap::new();
        let action = FeishuCardAction {
            action: "select_project".into(),
            chat_id: "chatA".into(),
            project_token: None,
            prompt: None,
            model_provider: None,
            model_id: None,
            message_id: None,
        };
        assert!(classify_card_action(&action, &tokens, std::time::Instant::now()).is_err());
    }

    #[test]
    fn classify_select_project_unknown_token_errors() {
        let tokens = std::collections::HashMap::new();
        let action = FeishuCardAction {
            action: "select_project".into(),
            chat_id: "chatA".into(),
            project_token: Some("nope".into()),
            prompt: None,
            model_provider: None,
            model_id: None,
            message_id: None,
        };
        let err = classify_card_action(&action, &tokens, std::time::Instant::now()).unwrap_err();
        assert!(err.contains("已过期"));
    }

    #[test]
    fn classify_select_project_expired_token_errors() {
        let now = std::time::Instant::now();
        let tokens = token_map_with("chatA", "tok1", "/proj", now - std::time::Duration::from_secs(1));
        let action = FeishuCardAction {
            action: "select_project".into(),
            chat_id: "chatA".into(),
            project_token: Some("tok1".into()),
            prompt: None,
            model_provider: None,
            model_id: None,
            message_id: None,
        };
        let err = classify_card_action(&action, &tokens, now).unwrap_err();
        assert!(err.contains("已过期"));
    }

    #[test]
    fn classify_select_project_chat_mismatch_errors() {
        let now = std::time::Instant::now();
        let tokens = token_map_with("chatA", "tok1", "/proj", now + std::time::Duration::from_secs(60));
        let action = FeishuCardAction {
            action: "select_project".into(),
            chat_id: "chatB".into(), // mismatch
            project_token: Some("tok1".into()),
            prompt: None,
            model_provider: None,
            model_id: None,
            message_id: None,
        };
        let err = classify_card_action(&action, &tokens, now).unwrap_err();
        assert!(err.contains("不匹配"));
    }

    #[test]
    fn classify_submit_prompt_nonempty_maps_to_plan() {
        let action = FeishuCardAction {
            action: "submit_prompt".into(),
            chat_id: "chatA".into(),
            project_token: None,
            prompt: Some("重构登录模块".into()),
            model_provider: None,
            model_id: None,
            message_id: None,
        };
        match classify_card_action(&action, &std::collections::HashMap::new(), std::time::Instant::now()).unwrap() {
            CardActionPlan::SubmitPrompt { prompt } => assert_eq!(prompt, "重构登录模块"),
            _ => panic!("expected SubmitPrompt"),
        }
    }

    #[test]
    fn classify_submit_prompt_empty_is_soft_warning() {
        let action = FeishuCardAction {
            action: "submit_prompt".into(),
            chat_id: "chatA".into(),
            project_token: None,
            prompt: Some("   ".into()),
            model_provider: None,
            model_id: None,
            message_id: None,
        };
        match classify_card_action(&action, &std::collections::HashMap::new(), std::time::Instant::now()).unwrap() {
            CardActionPlan::SubmitPromptEmpty => {}
            _ => panic!("expected SubmitPromptEmpty"),
        }
    }

    #[test]
    fn classify_submit_prompt_missing_payload_errors() {
        let action = FeishuCardAction {
            action: "submit_prompt".into(),
            chat_id: "chatA".into(),
            project_token: None,
            prompt: None,
            model_provider: None,
            model_id: None,
            message_id: None,
        };
        let err = classify_card_action(&action, &std::collections::HashMap::new(), std::time::Instant::now()).unwrap_err();
        assert!(err.contains("missing prompt"));
    }

    #[test]
    fn classify_routes_unknown_action_to_unknown() {
        for a in ["switch_project", "new_session", "view_status", "abort_task"] {
            let action = FeishuCardAction {
                action: a.into(),
                chat_id: "chatA".into(),
                project_token: None,
                prompt: None,
                model_provider: None,
                model_id: None,
                message_id: None,
            };
            let plan = classify_card_action(&action, &std::collections::HashMap::new(), std::time::Instant::now()).unwrap();
            assert!(
                matches!(
                    plan,
                    CardActionPlan::SwitchProject
                        | CardActionPlan::NewSession
                        | CardActionPlan::ViewStatus
                        | CardActionPlan::AbortTask
                ),
                "action {a} mapped to {plan:?}"
            );
        }
    }

    #[test]
    fn classify_unknown_action_type_is_unknown() {
        let action = FeishuCardAction {
            action: "bogus".into(),
            chat_id: "chatA".into(),
            project_token: None,
            prompt: None,
            model_provider: None,
            model_id: None,
            message_id: None,
        };
        assert!(matches!(
            classify_card_action(&action, &std::collections::HashMap::new(), std::time::Instant::now()).unwrap(),
            CardActionPlan::Unknown
        ));
    }

    #[test]
    fn classify_select_model_missing_provider_or_id_errors() {
        let base = FeishuCardAction {
            action: "select_model".into(),
            chat_id: "chatA".into(),
            project_token: None,
            prompt: None,
            model_provider: None,
            model_id: None,
            message_id: None,
        };
        assert!(classify_card_action(&base, &std::collections::HashMap::new(), std::time::Instant::now()).is_err());

        let with_provider = FeishuCardAction {
            model_provider: Some("openai".into()),
            message_id: None,
            ..base.clone()
        };
        assert!(classify_card_action(&with_provider, &std::collections::HashMap::new(), std::time::Instant::now()).is_err());

        let full = FeishuCardAction {
            model_provider: Some("openai".into()),
            model_id: Some("gpt-4".into()),
            message_id: None,
            ..base
        };
        match classify_card_action(&full, &std::collections::HashMap::new(), std::time::Instant::now()).unwrap() {
            CardActionPlan::SelectModel { provider, model_id } => {
                assert_eq!(provider, "openai");
                assert_eq!(model_id, "gpt-4");
            }
            _ => panic!("expected SelectModel"),
        }
    }
}
