//! Feishu REST API client for sending messages and interactive cards.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::bridge::{ModelInfo, ProjectInfo};
use crate::config::FeishuConfig;
use crate::feishu::auth::FeishuAuthProvider;
use serde::Deserialize;

/// Hard byte ceiling for any single outbound message body (P2-47).
///
/// The Feishu IM API rejects oversized bodies outright, and an agent reply has
/// no natural bound — a long build log used to make every send fail with an
/// opaque API error instead of delivering a truncated-but-useful message.
/// The truncation is char-boundary safe (no multibyte panic) and appends a
/// visible marker so the recipient knows content was cut.
pub const MAX_MESSAGE_BODY_BYTES: usize = 30_000;

/// Clamp `text` to [`MAX_MESSAGE_BODY_BYTES`] on a char boundary.
pub fn clamp_message_text(text: &str) -> String {
    clamp_to(text, MAX_MESSAGE_BODY_BYTES)
}

/// Clamp `text` to `limit` bytes on a char boundary.
///
/// Leaves generous room for the marker itself (the marker is ~50 bytes and
/// multibyte re-flooring can shave a few more), then re-floors: subtracting
/// bytes can land inside a multibyte char again. With this headroom the result
/// stays within `limit`, so clamping is idempotent.
fn clamp_to(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let cut = text.floor_char_boundary(limit).saturating_sub(128);
    let cut = text.floor_char_boundary(cut);
    format!(
        "{}\n\n[... message truncated: {} of {} bytes]",
        &text[..cut],
        cut,
        text.len()
    )
}

/// Byte budget [`card_body`] reserves for the JSON scaffolding of the minimal
/// fallback card. Well above the ~80 bytes it actually needs, so the result is
/// guaranteed to stay under [`MAX_MESSAGE_BODY_BYTES`].
const MINIMAL_CARD_OVERHEAD: usize = 128;

/// Wrap already-clamped `text` in the smallest valid interactive card.
fn minimal_card(text: &str) -> String {
    serde_json::json!({
        "elements": [{ "tag": "div", "text": { "tag": "plain_text", "content": text } }]
    })
    .to_string()
}

/// Serialize an interactive card to a body that fits
/// [`MAX_MESSAGE_BODY_BYTES`], shrinking its longest text fields until it does.
///
/// Only string leaves are truncated — the card structure and its buttons are
/// never touched — so an oversized status/completion card (a long build log in
/// the body) is delivered truncated instead of being rejected outright by the
/// Feishu API, which was the previous behaviour for every card path (P2-47).
pub fn card_body(card: &serde_json::Value) -> String {
    let mut card = card.clone();
    // Each pass at least halves the longest string, so the loop converges; the
    // bound is a guard against a pathological card (e.g. millions of tiny
    // strings) spinning forever.
    for _ in 0..32 {
        let serialized = card.to_string();
        if serialized.len() <= MAX_MESSAGE_BODY_BYTES {
            return serialized;
        }
        if !shrink_longest_string(&mut card) {
            // Nothing shrinkable left (a card made of numbers / booleans /
            // empty strings). Clamping the serialized JSON here would append
            // the truncation marker after the closing brace and the API would
            // reject the whole body — replace the card with a minimal valid
            // one whose text is the clamped original.
            return minimal_card(&clamp_to(
                &serialized,
                MAX_MESSAGE_BODY_BYTES.saturating_sub(MINIMAL_CARD_OVERHEAD),
            ));
        }
    }
    minimal_card(&clamp_to(
        &card.to_string(),
        MAX_MESSAGE_BODY_BYTES.saturating_sub(MINIMAL_CARD_OVERHEAD),
    ))
}

/// Halve the longest string leaf inside `value`. Returns `false` when the value
/// contains no non-empty string.
fn shrink_longest_string(value: &mut serde_json::Value) -> bool {
    fn longest(value: &serde_json::Value) -> usize {
        match value {
            serde_json::Value::String(s) => s.chars().count(),
            serde_json::Value::Array(items) => items.iter().map(longest).max().unwrap_or(0),
            serde_json::Value::Object(map) => map.values().map(longest).max().unwrap_or(0),
            _ => 0,
        }
    }
    fn shrink(value: &mut serde_json::Value, target: usize) -> bool {
        match value {
            serde_json::Value::String(s) => {
                if s.chars().count() == target && target > 0 {
                    let kept: String = s.chars().take((target / 2).max(1)).collect();
                    *s = format!("{kept}\n[... truncated ...]");
                    true
                } else {
                    false
                }
            }
            serde_json::Value::Array(items) => items.iter_mut().any(|i| shrink(i, target)),
            serde_json::Value::Object(map) => map.values_mut().any(|v| shrink(v, target)),
            _ => false,
        }
    }
    let target = longest(value);
    target > 0 && shrink(value, target)
}

/// Build the HTTP client used for every outbound Feishu call (P1-32).
///
/// `reqwest::Client::new()` has NO timeouts: a hung TLS handshake or a stalled
/// response blocked the WS event loop / the ACK re-delivery timer indefinitely.
/// Connect 10s + overall 30s matches the desktop LLM client's ladder and keeps
/// interactive replies snappy.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_else(|e| {
            // `build()` only fails when the TLS backend cannot be initialised —
            // in which case `Client::new()` panics as well. Log it rather than
            // silently continuing with a client whose timeouts were lost
            // (P1-32).
            tracing::error!(error = %e, "failed to build Feishu HTTP client; falling back to default");
            reqwest::Client::new()
        })
}

/// Chat IDs the Feishu bot has ever been in contact with — recorded when an
/// inbound message or a bot-entered event is seen. Used to onboard (push the
/// welcome card) on config save **without** depending on the chat-listing API,
/// which (a) requires the `im:chat` permission and (b) cannot enumerate P2P
/// (single) chats at all. This is a process-global registry so it survives the
/// bridge restart that every config save triggers (keyed by chat_id only).
static KNOWN_CHAT_IDS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Record a chat_id the bot has interacted with (idempotent, ignores empty).
pub fn record_chat_id(chat_id: &str) {
    if chat_id.is_empty() {
        return;
    }
    if let Ok(mut set) = KNOWN_CHAT_IDS.lock() {
        set.insert(chat_id.to_string());
    }
}

/// All chat_ids the bot has interacted with so far (P2P + group).
pub fn known_chat_ids() -> Vec<String> {
    KNOWN_CHAT_IDS
        .lock()
        .map(|s| s.iter().cloned().collect())
        .unwrap_or_default()
}

/// Chat IDs that have already received the onboarding welcome card, so we do
/// not re-send it on every inbound message. Mirrors `KNOWN_CHAT_IDS` in shape.
static WELCOMED_CHAT_IDS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Mark a chat as already welcomed (idempotent, ignores empty).
pub fn mark_welcomed(chat_id: &str) {
    if chat_id.is_empty() {
        return;
    }
    if let Ok(mut set) = WELCOMED_CHAT_IDS.lock() {
        set.insert(chat_id.to_string());
    }
}

/// Whether a chat has already been sent the onboarding welcome card.
pub fn has_been_welcomed(chat_id: &str) -> bool {
    WELCOMED_CHAT_IDS
        .lock()
        .map(|s| s.contains(chat_id))
        .unwrap_or(false)
}

/// Mint the `uuid` de-duplication key for one outbound message.
///
/// Feishu caps the field at 50 characters, so a plain UUID v4 (36 chars) is
/// used verbatim instead of a prefixed/compound identifier.
fn make_dedup_key() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Attach the de-duplication key to an outbound send-message body (pure).
fn with_dedup_key(mut body: serde_json::Value, key: &str) -> serde_json::Value {
    if let Some(fields) = body.as_object_mut() {
        fields.insert("uuid".to_string(), serde_json::Value::String(key.to_string()));
    }
    body
}

/// Whether a Feishu send-message API response indicates success.
///
/// Centralizes the `code != 0` success criterion so every `send_*` method
/// tests the same branch. Pure core of the `send_*` error paths.
pub(crate) fn is_send_success(code: i64) -> bool {
    code == 0
}

/// Feishu API client for outbound message operations.
#[derive(Clone)]
pub struct FeishuApiClient {
    config: FeishuConfig,
    auth: FeishuAuthProvider,
    http: reqwest::Client,
    /// Optional shared ACK tracker for critical status cards.
    pending_ack: Option<Arc<Mutex<PendingAckMap>>>,
}

/// Response from the send-message API.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct SendMessageResponse {
    code: i64,
    msg: Option<String>,
    /// The message_id, used later for PATCH (update_card).
    data: Option<SendMessageData>,
}

/// The `data` field of SendMessageResponse.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct SendMessageData {
    /// Message ID for PATCH updates (update_card).
    message_id: Option<String>,
}

/// Timeout (seconds) before an unconfirmed critical card is re-delivered.
pub const ACK_TIMEOUT_SECS: u64 = 15;
/// Interval (seconds) the re-delivery timer scans the pending-ACK map.
pub const ACK_SCAN_INTERVAL_SECS: u64 = 5;
/// Maximum number of re-delivery attempts before the entry is dropped.
pub const ACK_MAX_ATTEMPTS: u32 = 3;

/// A pending outbound card awaiting confirmation (or re-delivery).
///
/// Keyed by the Feishu `message_id` inside the shared `PendingAckMap`.
pub struct PendingAck {
    pub chat_id: String,
    /// The interactive card payload, reused for idempotent PATCH re-delivery.
    pub card: serde_json::Value,
    pub attempts: u32,
    /// When the next re-delivery check should fire.
    pub deadline: Instant,
}

/// Shared map of pending ACKs. Guarded by a std `Mutex` (brief critical
/// sections only — never held across an `.await`).
pub type PendingAckMap = HashMap<String, PendingAck>;

/// Build the interactive project selection card payload (pure).
pub(crate) fn build_project_selection_card(
    chat_id: &str,
    projects: &[ProjectInfo],
) -> serde_json::Value {
    let mut elements = vec![serde_json::json!({
        "tag": "div",
        "text": {
            "tag": "lark_md",
            "content": "请选择要操作的项目。飞书任务必须先绑定项目。"
        }
    })];

    if projects.is_empty() {
        elements.push(serde_json::json!({
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": "暂无可选项目。请先在 IDE 中打开项目并创建一次对话，然后重新发送任意消息即可唤起本卡片。"
            }
        }));
    } else {
        for chunk in projects.chunks(4) {
            let actions: Vec<serde_json::Value> = chunk
                .iter()
                .map(|project| serde_json::json!({
                    "tag": "button",
                    "text": { "tag": "plain_text", "content": format!("📂 {}", project.name) },
                    "value": {
                        "action": "select_project",
                        "project_token": project.token,
                        "chat_id": chat_id
                    },
                    "type": "default"
                }))
                .collect();
            elements.push(serde_json::json!({
                "tag": "action",
                "actions": actions
            }));
        }
    }

    elements.push(serde_json::json!({
        "tag": "note",
        "elements": [{
            "tag": "plain_text",
            "content": "路径已脱敏。没有目标项目时，请先在 IDE 打开项目。"
        }]
    }));

    serde_json::json!({
        "config": { "wide_screen_mode": true },
        "header": {
            "title": { "tag": "plain_text", "content": "📁 选择项目" },
            "template": "blue"
        },
        "elements": elements
    })
}

/// Build the interactive model selection card payload (pure).
///
/// Mirrors `build_project_selection_card`: one button per model, chunked in
/// rows of four, each button carrying `{ action: "select_model",
/// model_provider, model_id, chat_id }` so the WS dispatcher can route the
/// callback back into `handle_feishu_card_action`.
pub(crate) fn build_model_selection_card(
    chat_id: &str,
    models: &[ModelInfo],
) -> serde_json::Value {
    let mut elements = vec![serde_json::json!({
        "tag": "div",
        "text": {
            "tag": "lark_md",
            "content": "请选择执行任务使用的模型。选中的模型会同步到桌面端。"
        }
    })];

    if models.is_empty() {
        elements.push(serde_json::json!({
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": "暂无可选模型。请先在桌面端配置模型，然后重新发送任意消息即可唤起本卡片。"
            }
        }));
    } else {
        for chunk in models.chunks(4) {
            let actions: Vec<serde_json::Value> = chunk
                .iter()
                .map(|m| serde_json::json!({
                    "tag": "button",
                    "text": { "tag": "plain_text", "content": m.display_name.clone() },
                    "value": {
                        "action": "select_model",
                        "model_provider": m.provider_id,
                        "model_id": m.model_id,
                        "chat_id": chat_id
                    },
                    "type": "default"
                }))
                .collect();
            elements.push(serde_json::json!({
                "tag": "action",
                "actions": actions
            }));
        }
    }

    elements.push(serde_json::json!({
        "tag": "note",
        "elements": [{
            "tag": "plain_text",
            "content": "路径已脱敏。选择模型后直接发送消息即可开始任务。"
        }]
    }));

    serde_json::json!({
        "config": { "wide_screen_mode": true },
        "header": {
            "title": { "tag": "plain_text", "content": "🤖 选择模型" },
            "template": "blue"
        },
        "elements": elements
    })
}

/// Build the task status card payload (pure).
pub(crate) fn build_task_status_card(
    chat_id: &str,
    title: &str,
    content: &str,
) -> serde_json::Value {
    serde_json::json!({
        "config": { "wide_screen_mode": true },
        "header": {
            "title": { "tag": "plain_text", "content": title },
            "template": "blue"
        },
        "elements": [
            {
                "tag": "div",
                "text": { "tag": "lark_md", "content": content }
            },
            {
                "tag": "action",
                "actions": [
                    {
                        "tag": "button",
                        "text": { "tag": "plain_text", "content": "📊 查看状态" },
                        "value": { "action": "view_status", "chat_id": chat_id },
                        "type": "default"
                    },
                    {
                        "tag": "button",
                        "text": { "tag": "plain_text", "content": "🛑 中止当前任务" },
                        "value": { "action": "abort_task", "chat_id": chat_id },
                        "type": "danger"
                    }
                ]
            }
        ]
    })
}

/// Build the task-completed card payload (pure).
///
/// Deliberately omits the "view status" / "abort task" action row that
/// `build_task_status_card` carries: once the task is finished there is
/// nothing to abort, and the completion summary is the terminal state of that
/// conversation — keeping dead controls would only confuse the user.
pub(crate) fn build_task_completed_card(
    title: &str,
    content: &str,
) -> serde_json::Value {
    serde_json::json!({
        "config": { "wide_screen_mode": true },
        "header": {
            "title": { "tag": "plain_text", "content": title },
            "template": "green"
        },
        "elements": [
            {
                "tag": "div",
                "text": { "tag": "lark_md", "content": content }
            }
        ]
    })
}

/// Shared control action row (switch project / view status / abort task).
///
/// Single source of truth for the operation buttons carried by both the
/// persistent control card and the onboarding welcome card, so the two can
/// never drift apart in action names or `chat_id` plumbing.
fn control_action_row(chat_id: &str) -> serde_json::Value {
    serde_json::json!({
        "tag": "action",
        "actions": [
            {
                "tag": "button",
                "text": { "tag": "plain_text", "content": "📂 切换项目" },
                "value": { "action": "switch_project", "chat_id": chat_id },
                "type": "default"
            },
            {
                "tag": "button",
                "text": { "tag": "plain_text", "content": "🆕 新建会话" },
                "value": { "action": "new_session", "chat_id": chat_id },
                "type": "default"
            },
            {
                "tag": "button",
                "text": { "tag": "plain_text", "content": "📊 查看状态" },
                "value": { "action": "view_status", "chat_id": chat_id },
                "type": "default"
            },
            {
                "tag": "button",
                "text": { "tag": "plain_text", "content": "🛑 中止任务" },
                "value": { "action": "abort_task", "chat_id": chat_id },
                "type": "danger"
            }
        ]
    })
}

/// Build the persistent operation control card payload (pure).
pub(crate) fn build_control_card(chat_id: &str) -> serde_json::Value {
    serde_json::json!({
        "config": { "wide_screen_mode": true },
        "header": {
            "title": { "tag": "plain_text", "content": "🛠️ 操作面板" },
            "template": "blue"
        },
        "elements": [
            {
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": "项目已绑定。你可以切换项目、新建会话、查看状态或中止当前任务。"
                }
            },
            control_action_row(chat_id)
        ]
    })
}

/// Build the onboarding welcome card payload (pure).
///
/// Sent proactively right after Feishu credentials are saved (broadcast to
/// every chat the bot is in) and whenever the bot enters a new chat, so
/// users immediately see what they can do through Feishu — without having
/// to guess or type anything first.
pub(crate) fn build_welcome_card(chat_id: &str) -> serde_json::Value {
    serde_json::json!({
        "config": { "wide_screen_mode": true },
        "header": {
            "title": { "tag": "plain_text", "content": "👋 IDE 已接入飞书" },
            "template": "turquoise"
        },
        "elements": [
            {
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": "飞书助手已就绪，你可以：\n**1. 直接发消息下任务** — 任意文字都会作为自然语言任务发给 IDE 执行\n**2. 绑定项目** — 首次执行任务前，点击下方「切换项目」选择目标项目\n**3. 自动跟踪进度** — 任务开始 / 排队 / 完成 / 失败都会推送状态卡片\n**4. 随时掌控** — 通过下方按钮新建会话、查看状态或中止正在执行的任务"
                }
            },
            { "tag": "hr" },
            control_action_row(chat_id),
            {
                "tag": "note",
                "elements": [{
                    "tag": "plain_text",
                    "content": "先「切换项目」绑定项目，然后直接发消息即可开始第一个任务。"
                }]
            }
        ]
    })
}

impl FeishuApiClient {
    /// Create a new API client.
    pub fn new(config: FeishuConfig) -> Self {
        let auth = FeishuAuthProvider::new(config.clone());
        Self {
            config,
            auth,
            http: http_client(),
            pending_ack: None,
        }
    }

    /// until confirmed (via `update_card`). No behavior change when `None`.
    pub fn with_ack_tracker(mut self, tracker: Arc<Mutex<PendingAckMap>>) -> Self {
        self.pending_ack = Some(tracker);
        self
    }

    /// IM-02: shared Feishu sender with bounded exponential-backoff retry so a
    /// transient network blip, HTTP 5xx, or rate-limit (429) doesn't permanently
    /// drop an outbound message. Permanent 4xx client errors are NOT retried.
    async fn send_message_raw(&self, body: serde_json::Value) -> anyhow::Result<SendMessageResponse> {
        const MAX_ATTEMPTS: u32 = 5;
        let mut backoff = Duration::from_millis(400);
        let mut last_err: Option<anyhow::Error> = None;

        // P2-46: idempotency key. Feishu de-duplicates on `uuid` — requests
        // carrying the same value succeed at most once within an hour — so
        // retrying after "the server wrote the message but the response was
        // lost" becomes a no-op instead of a duplicate reply.
        //
        // It must be minted *outside* the retry loop: a fresh value per attempt
        // would make every retry a distinct message and defeat the whole point.
        let body = with_dedup_key(body, &make_dedup_key());

        for attempt in 0..MAX_ATTEMPTS {
            let token = match self.auth.get_token().await {
                Ok(t) => t,
                Err(e) => {
                    last_err = Some(e);
                    if attempt + 1 < MAX_ATTEMPTS {
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(Duration::from_secs(30));
                    }
                    continue;
                }
            };
            let send_result = self
                .http
                .post(self.config.send_message_url())
                .query(&[("receive_id_type", "chat_id")])
                .header("Authorization", format!("Bearer {}", token))
                .json(&body)
                .send()
                .await;
            match send_result {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                        last_err = Some(anyhow::anyhow!("feishu send http status {}", status));
                    } else {
                        match resp.json::<SendMessageResponse>().await {
                            Ok(parsed) => return Ok(parsed),
                            Err(e) => last_err = Some(e.into()),
                        }
                    }
                }
                Err(e) => last_err = Some(e.into()),
            }
            if attempt + 1 < MAX_ATTEMPTS {
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("feishu send failed after retries")))
    }

    /// Send a plain text message to a chat.
    pub async fn send_text_message(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        // P2-47: never send an oversized body — clamp instead of failing.
        let text = &clamp_message_text(text);
        let content = serde_json::json!({ "text": text }).to_string();

        let resp = self
            .send_message_raw(serde_json::json!({
                "receive_id": chat_id,
                "msg_type": "text",
                "content": content
            }))
            .await?;

        if !is_send_success(resp.code) {
            tracing::error!(code = resp.code, msg = ?resp.msg, "Feishu send message failed");
            anyhow::bail!(
                "Feishu send message error: code={}, msg={}",
                resp.code,
                resp.msg.unwrap_or_default()
            );
        }

        Ok(())
    }
    /// Send an interactive project selection card.
    pub async fn send_project_selection_card(
        &self,
        chat_id: &str,
        projects: &[ProjectInfo],
    ) -> anyhow::Result<()> {
        let card = build_project_selection_card(chat_id, projects);

        let resp = self
            .send_message_raw(serde_json::json!({
                "receive_id": chat_id,
                "msg_type": "interactive",
                "content": card_body(&card)
            }))
            .await?;

        if !is_send_success(resp.code) {
            anyhow::bail!(
                "Feishu send project card error: code={}, msg={}",
                resp.code,
                resp.msg.unwrap_or_default()
            );
        }

        Ok(())
    }

    /// Send an interactive model selection card.
    pub async fn send_model_selection_card(
        &self,
        chat_id: &str,
        models: &[ModelInfo],
    ) -> anyhow::Result<()> {
        let card = build_model_selection_card(chat_id, models);

        let resp = self
            .send_message_raw(serde_json::json!({
                "receive_id": chat_id,
                "msg_type": "interactive",
                "content": card_body(&card)
            }))
            .await?;

        if !is_send_success(resp.code) {
            anyhow::bail!(
                "Feishu send model card error: code={}, msg={}",
                resp.code,
                resp.msg.unwrap_or_default()
            );
        }

        Ok(())
    }

    /// Core interactive-card sender: auth + POST + success check.
    ///
    /// Returns the raw Feishu response so callers can inspect `data.message_id`
    /// (e.g. for ACK re-delivery of actionable cards).
    async fn send_interactive_card(
        &self,
        chat_id: &str,
        card: serde_json::Value,
    ) -> anyhow::Result<SendMessageResponse> {
        let resp = self
            .send_message_raw(serde_json::json!({
                "receive_id": chat_id,
                "msg_type": "interactive",
                "content": card_body(&card)
            }))
            .await?;

        if !is_send_success(resp.code) {
            anyhow::bail!(
                "Feishu send card error: code={}, msg={}",
                resp.code,
                resp.msg.unwrap_or_default()
            );
        }

        Ok(resp)
    }

    pub async fn send_task_status_card(
        &self,
        chat_id: &str,
        title: &str,
        content: &str,
    ) -> anyhow::Result<()> {
        let card = build_task_status_card(chat_id, title, content);
        let resp = self.send_interactive_card(chat_id, card.clone()).await?;

        // Register the card for ACK re-delivery if a tracker is attached.
        // Keyed by Feishu `message_id`; confirmed/removed via the card
        // action callback (`open_message_id`) or expired after N attempts.
        if let Some(tracker) = &self.pending_ack
            && let Some(mid) = resp.data.as_ref().and_then(|d| d.message_id.clone())
        {
            let mut map = duo_utils::sync::lock(tracker);
            map.insert(
                mid,
                PendingAck {
                    chat_id: chat_id.to_string(),
                    card,
                    attempts: 0,
                    deadline: Instant::now() + Duration::from_secs(ACK_TIMEOUT_SECS),
                },
            );
        }

        Ok(())
    }

    /// Send the terminal task-completed card.
    ///
    /// Unlike `send_task_status_card` this card has NO action buttons — the
    /// task is finished, so "abort" / "view status" are meaningless — and
    /// therefore needs no ACK tracking.
    pub async fn send_task_completed_card(
        &self,
        chat_id: &str,
        title: &str,
        content: &str,
    ) -> anyhow::Result<()> {
        let card = build_task_completed_card(title, content);
        self.send_interactive_card(chat_id, card).await?;
        Ok(())
    }

    /// Send a persistent operation control card.
    ///
    /// Offers card-only entry points for switching project, viewing status and
    /// aborting the current task — so users never need to type slash commands.
    pub async fn send_control_card(&self, chat_id: &str) -> anyhow::Result<()> {
        let card = build_control_card(chat_id);

        let resp = self
            .send_message_raw(serde_json::json!({
                "receive_id": chat_id,
                "msg_type": "interactive",
                "content": card_body(&card)
            }))
            .await?;

        if !is_send_success(resp.code) {
            anyhow::bail!(
                "Feishu send control card error: code={}, msg={}",
                resp.code,
                resp.msg.unwrap_or_default()
            );
        }

        Ok(())
    }

    /// Send the onboarding welcome card to a chat.
    ///
    /// Fired proactively after Feishu credentials are saved and whenever the
    /// bot enters a new chat, so users discover the available card actions
    /// without typing anything first.
    pub async fn send_welcome_card(&self, chat_id: &str) -> anyhow::Result<()> {
        let card = build_welcome_card(chat_id);

        let resp = self
            .send_message_raw(serde_json::json!({
                "receive_id": chat_id,
                "msg_type": "interactive",
                "content": card_body(&card)
            }))
            .await?;

        if !is_send_success(resp.code) {
            tracing::error!(
                code = resp.code,
                msg = ?resp.msg,
                chat_id = %chat_id,
                "[DIAG] Feishu rejected welcome card: code={}, msg={}",
                resp.code,
                resp.msg.clone().unwrap_or_default()
            );
            anyhow::bail!(
                "Feishu send welcome card error: code={}, msg={}",
                resp.code,
                resp.msg.unwrap_or_default()
            );
        }
        tracing::info!(chat_id = %chat_id, code = resp.code, "[DIAG] Feishu welcome card send success");

        Ok(())
    }

    /// Get a reference to the auth provider (for WS client).
    pub fn auth(&self) -> &FeishuAuthProvider {
        &self.auth
    }

    /// Update an existing card message via PATCH.
    /// Falls back to sending a new text message if the PATCH fails.
    pub async fn update_card(
        &self,
        message_id: &str,
        chat_id: &str,
        card: &serde_json::Value,
    ) -> anyhow::Result<()> {
        let url = format!(
            "{}/open-apis/im/v1/messages/{}",
            self.config.api_base(), message_id
        );
        let token = self.auth.get_token().await?;
        let result = self
            .http
            .patch(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({ "content": card_body(&card) }))
            .send()
            .await;

        match result {
            Ok(resp) if resp.status().is_success() => {
                tracing::debug!(message_id = %message_id, "Card updated via PATCH");
                Ok(())
            }
            _ => {
                tracing::warn!(message_id = %message_id, "update_card PATCH failed, falling back to send text");
                self.send_text_message(chat_id, "Card update unavailable — see latest results above.")
                    .await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression (P2-47): an oversized interactive card must be delivered
    /// truncated, not rejected — and the truncation must keep the card valid
    /// JSON with its buttons intact.
    #[test]
    fn oversized_card_body_is_truncated_and_keeps_structure() {
        let card = serde_json::json!({
            "schema": "2.0",
            "body": { "elements": [
                { "tag": "div", "text": { "tag": "plain_text", "content": "汉".repeat(40_000) } },
                { "tag": "action", "actions": [ { "tag": "button", "value": { "kind": "select_project" } } ] }
            ]}
        });
        let body = card_body(&card);
        assert!(
            body.len() <= MAX_MESSAGE_BODY_BYTES,
            "card body must fit the API limit, got {} bytes",
            body.len()
        );
        let parsed: serde_json::Value =
            serde_json::from_str(&body).expect("a truncated card must stay valid JSON");
        let rendered = parsed.to_string();
        assert!(
            rendered.contains("select_project"),
            "buttons must survive truncation"
        );
        assert!(
            rendered.contains("truncated"),
            "a truncation marker must be visible to the user"
        );
    }

    #[test]
    fn clamp_message_text_passes_short_text_through() {
        assert_eq!(clamp_message_text("short"), "short");
    }

    #[test]
    fn clamp_message_text_truncates_oversize_on_char_boundary() {
        // Multibyte content: a naive byte slice would panic (P2-47).
        let long = "汉字内容测试".repeat(20_000);
        let clamped = clamp_message_text(&long);
        assert!(clamped.len() <= MAX_MESSAGE_BODY_BYTES + 200);
        assert!(clamped.contains("truncated"), "must carry a truncation marker");
        // The result must still be valid UTF-8 (it is a String by construction)
        // and the original head must be preserved.
        assert!(clamped.starts_with("汉字内容测试"));
    }

    #[test]
    fn clamp_message_text_is_idempotent_on_marker_length() {
        let long = "x".repeat(MAX_MESSAGE_BODY_BYTES * 3);
        let once = clamp_message_text(&long);
        let twice = clamp_message_text(&once);
        assert_eq!(once, twice, "clamping an already-clamped message must be a no-op");
    }

    /// Regression (P2-47, follow-up): a card with nothing to shrink (no non-empty
    /// string — only numbers here) used to be clamped *as JSON text*, putting the
    /// truncation marker after the closing brace. The API rejects an unparsable
    /// body, so the message was lost instead of truncated.
    #[test]
    fn unshrinkable_card_stays_valid_json() {
        let card = serde_json::json!({
            "data": (0..20_000).map(|i| i as f64).collect::<Vec<_>>()
        });
        assert!(card.to_string().len() > MAX_MESSAGE_BODY_BYTES);
        assert!(
            !shrink_longest_string(&mut card.clone()),
            "a card with no strings must be reported as unshrinkable"
        );

        let body = card_body(&card);
        assert!(
            body.len() <= MAX_MESSAGE_BODY_BYTES,
            "fallback card must fit the API limit, got {} bytes",
            body.len()
        );
        serde_json::from_str::<serde_json::Value>(&body)
            .expect("the fallback body must still be valid JSON");
    }

    fn project(n: usize) -> ProjectInfo {
        ProjectInfo {
            token: format!("tok_{n}"),
            name: format!("proj-{n}"),
        }
    }

    /// All `action`-tagged element rows of a card.
    fn action_rows(card: &serde_json::Value) -> Vec<&serde_json::Value> {
        card["elements"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["tag"] == "action")
            .collect()
    }

    #[test]
    fn project_card_empty_list_shows_hint_and_no_buttons() {
        let card = build_project_selection_card("oc_1", &[]);
        assert!(action_rows(&card).is_empty());
        let text = card.to_string();
        assert!(text.contains("暂无可选项目"));
        // Card-only flow: no slash-command mention anywhere.
        assert!(!text.contains("/project"));
    }

    #[test]
    fn project_card_chunks_buttons_by_four() {
        let projects: Vec<ProjectInfo> = (0..5).map(project).collect();
        let card = build_project_selection_card("oc_1", &projects);
        let rows = action_rows(&card);
        assert_eq!(rows.len(), 2, "5 projects → rows of 4 + 1");
        assert_eq!(rows[0]["actions"].as_array().unwrap().len(), 4);
        assert_eq!(rows[1]["actions"].as_array().unwrap().len(), 1);
        // Every button carries the select_project action and the chat_id.
        for row in rows {
            for b in row["actions"].as_array().unwrap() {
                assert_eq!(b["value"]["action"], "select_project");
                assert_eq!(b["value"]["chat_id"], "oc_1");
                assert!(b["value"]["project_token"].is_string());
            }
        }
    }

    #[test]
    fn model_card_chunks_and_carries_select_model_action() {
        let models: Vec<ModelInfo> = (0..5)
            .map(|n| ModelInfo {
                provider_id: format!("p{n}"),
                model_id: format!("m{n}"),
                display_name: format!("p{n}/m{n}"),
            })
            .collect();
        let card = build_model_selection_card("oc_m", &models);
        let rows = action_rows(&card);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["actions"].as_array().unwrap().len(), 4);
        assert_eq!(rows[1]["actions"].as_array().unwrap().len(), 1);
        for row in rows {
            for b in row["actions"].as_array().unwrap() {
                assert_eq!(b["value"]["action"], "select_model");
                assert_eq!(b["value"]["chat_id"], "oc_m");
                assert!(b["value"]["model_provider"].is_string());
                assert!(b["value"]["model_id"].is_string());
            }
        }
    }

    #[test]
    fn model_card_empty_list_shows_hint_and_no_buttons() {
        let card = build_model_selection_card("oc_0", &[]);
        assert!(action_rows(&card).is_empty());
        assert!(card.to_string().contains("暂无可选模型"));
    }

    #[test]
    fn known_and_welcomed_registries_track_chat_ids() {
        let before = known_chat_ids();
        record_chat_id("oc_track");
        assert!(known_chat_ids().iter().any(|c| c == "oc_track"));
        // Already-present id is idempotent (no duplicate).
        record_chat_id("oc_track");
        assert_eq!(
            known_chat_ids().iter().filter(|c| *c == "oc_track").count(),
            1
        );
        // Empty ids are ignored.
        record_chat_id("");
        assert!(!known_chat_ids().iter().any(|c| c.is_empty()));
        // Welcomed dedup.
        assert!(!has_been_welcomed("oc_track"));
        mark_welcomed("oc_track");
        assert!(has_been_welcomed("oc_track"));
        // Cleanup so other tests don't see this chat.
        if let Ok(mut s) = KNOWN_CHAT_IDS.lock() {
            s.remove("oc_track");
        }
        if let Ok(mut s) = WELCOMED_CHAT_IDS.lock() {
            s.remove("oc_track");
        }
        let _ = before;
    }

    #[test]
    fn welcome_card_carries_full_control_action_row() {
        let card = build_welcome_card("oc_w");
        let rows = action_rows(&card);
        assert_eq!(rows.len(), 1);
        let kinds: Vec<&str> = rows[0]["actions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["value"]["action"].as_str().unwrap())
            .collect();
        // Welcome card exposes the exact same operations as the control card.
        assert_eq!(kinds, ["switch_project", "new_session", "view_status", "abort_task"]);
        for b in rows[0]["actions"].as_array().unwrap() {
            assert_eq!(b["value"]["chat_id"], "oc_w");
        }
        // Onboarding copy explains the message-as-task entry point.
        let text = card.to_string();
        assert!(text.contains("直接发消息下任务"));
    }

    #[test]
    fn control_card_has_four_actions_with_danger_abort() {
        let card = build_control_card("oc_2");
        let rows = action_rows(&card);
        assert_eq!(rows.len(), 1);
        let buttons = rows[0]["actions"].as_array().unwrap();
        let kinds: Vec<&str> = buttons
            .iter()
            .map(|b| b["value"]["action"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["switch_project", "new_session", "view_status", "abort_task"]);
        assert_eq!(buttons[3]["type"], "danger");
        for b in buttons {
            assert_eq!(b["value"]["chat_id"], "oc_2");
        }
    }

    #[test]
    fn task_status_card_carries_title_content_and_actions() {
        let card = build_task_status_card("oc_3", "🚀 已提交", "Pipeline ID: `p-1`");
        assert_eq!(card["header"]["title"]["content"], "🚀 已提交");
        assert_eq!(card["elements"][0]["text"]["content"], "Pipeline ID: `p-1`");
        let rows = action_rows(&card);
        assert_eq!(rows.len(), 1);
        let kinds: Vec<&str> = rows[0]["actions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["value"]["action"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["view_status", "abort_task"]);
    }

    #[test]
    fn completed_card_has_no_action_buttons() {
        let card = build_task_completed_card("✅ 任务完成", "summary");
        assert_eq!(card["header"]["title"]["content"], "✅ 任务完成");
        assert_eq!(card["header"]["template"], "green");
        // A finished task must not expose "abort" / "view status" controls.
        let has_action = card["elements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|el| el["tag"] == "action");
        assert!(!has_action, "completed card must not carry action buttons");
    }

    #[test]
    fn cards_use_interactive_wide_screen_config() {
        for card in [
            build_project_selection_card("oc", &[project(0)]),
            build_control_card("oc"),
            build_task_status_card("oc", "t", "c"),
        ] {
            assert_eq!(card["config"]["wide_screen_mode"], true);
            assert!(card["header"]["title"]["content"].is_string());
        }
    }

    // ---------- P2-46: outbound de-duplication ----------

    #[test]
    fn dedup_key_fits_feishus_fifty_char_limit() {
        let key = make_dedup_key();
        assert!(!key.is_empty());
        assert!(key.len() <= 50, "Feishu rejects a `uuid` longer than 50 chars");
    }

    #[test]
    fn dedup_keys_are_unique_per_message() {
        // Reusing a key across *different* messages would drop one of them.
        let keys: std::collections::HashSet<String> =
            (0..100).map(|_| make_dedup_key()).collect();
        assert_eq!(keys.len(), 100);
    }

    #[test]
    fn outbound_message_body_carries_the_dedup_key() {
        let body = serde_json::json!({ "receive_id": "oc_1", "msg_type": "text" });
        let sent = with_dedup_key(body, "dedup-1");
        assert_eq!(sent["uuid"], "dedup-1");
        // The original fields survive — the key is added, not substituted.
        assert_eq!(sent["receive_id"], "oc_1");
        assert_eq!(sent["msg_type"], "text");
    }

    #[test]
    fn dedup_key_is_stable_across_retries() {
        // The whole point: a retry replays the *same* body, hence the same key,
        // so Feishu collapses it instead of delivering twice.
        let key = make_dedup_key();
        let first = with_dedup_key(serde_json::json!({ "msg_type": "text" }), &key);
        let retry = with_dedup_key(first.clone(), &key);
        assert_eq!(first["uuid"], retry["uuid"]);
    }

    #[test]
    fn send_success_only_on_zero_code() {
        // Pure core of every `send_*` error branch: only code == 0 succeeds.
        assert!(is_send_success(0));
        assert!(!is_send_success(1));
        assert!(!is_send_success(-1));
        assert!(!is_send_success(50001));
    }
}
