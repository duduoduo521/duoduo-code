//! Feishu WebSocket long-connection client.
//!
//! Implements the full pbbp2 protocol lifecycle:
//! 1. Fetch WS config via REST API (`/callback/ws/endpoint`)
//! 2. Connect WebSocket to the returned URL
//! 3. Send pbbp2-encoded heartbeat frames at the configured interval
//! 4. Receive and dispatch control/data frames
//! 5. Auto-reconnect on disconnect with backoff

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use futures::{SinkExt, StreamExt};

use tokio::net::TcpStream;
use tokio::sync::RwLock;
use tokio::time::{Instant, sleep, timeout};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tokio_tungstenite::tungstenite::Message;

use crate::bridge::{FeishuCardAction, NEEDS_MODEL_MARKER, NEEDS_PROJECT_MARKER, SmartLayerBridge};
use crate::config::FeishuConfig;
use crate::feishu::api::{FeishuApiClient, PendingAckMap};
use crate::feishu::proto::*;

/// Maximum length for IM text responses (Feishu limit ~30KB, keep safe at 10KB).
const IM_MAX_RESPONSE_LEN: usize = 10_240;

/// Half-open connection guard: if no frame (event, control, or pong) is
/// received within this window, the connection is presumed dead even though
/// the TCP socket has not been closed, and we force a reconnect.
///
/// Feishu pushes a heartbeat/pong roughly every ~20s, so 90s gives a safe
/// margin over three missed beats before declaring the link stale.
const HEARTBEAT_TIMEOUT_SECS: u64 = 90;

/// Floor for the server-supplied ping interval (P2-53): `tokio::time::interval`
/// panics on a zero period, so untrusted `ping_interval = 0` must be clamped.
const MIN_PING_INTERVAL_SECS: u64 = 1;

/// Truncate a response string for safe IM delivery.
pub(crate) fn truncate_im_response(text: &str) -> String {
    if text.len() <= IM_MAX_RESPONSE_LEN {
        return text.to_string();
    }
    // Floor the cut to a UTF-8 char boundary: byte-index slicing on
    // multi-byte (Chinese) text would otherwise panic. Uses the stable
    // `str::floor_char_boundary` inherent method (Rust 1.87+).
    let cut = text.floor_char_boundary(IM_MAX_RESPONSE_LEN);
    // Prefer breaking at the last newline inside the window for readability.
    let cut = text[..cut].rfind('\n').unwrap_or(cut);
    format!(
        "{}...\n\n📝 (响应过长已截断，完整内容 {} 字符)",
        &text[..cut],
        text.chars().count()
    )
}

/// Decode a Feishu card action callback payload into a `FeishuCardAction`.
///
/// Feishu nests `action` under `event.event` (with the card message id at
/// `event.event.open_message_id`); flat payload variants carry them at the
/// top level. Returns `None` when no `action.value` object is present.
/// `chat_id` may be empty — callers must guard before dispatching.
pub(crate) fn decode_card_action(event: &serde_json::Value) -> Option<FeishuCardAction> {
    let action_value = event
        .get("event")
        .and_then(|e| e.get("action"))
        .and_then(|a| a.get("value"))
        .and_then(|v| v.as_object())
        .or_else(|| {
            event
                .get("action")
                .and_then(|a| a.get("value"))
                .and_then(|v| v.as_object())
        })?;

    // Parse form_value (input/textarea values from card)
    let form_value = event
        .get("event")
        .and_then(|e| e.get("action"))
        .and_then(|a| a.get("form_value"))
        .and_then(|v| v.as_object())
        .or_else(|| {
            event
                .get("action")
                .and_then(|a| a.get("form_value"))
                .and_then(|v| v.as_object())
        });

    let prompt = form_value
        .and_then(|fv| fv.get("prompt_input"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // open_message_id is the Feishu message ID of the card itself, needed
    // for PATCH-based card updates and pending-ACK confirmation.
    let message_id = event
        .get("event")
        .and_then(|e| e.get("open_message_id"))
        .and_then(|v| v.as_str())
        .or_else(|| event.get("open_message_id").and_then(|v| v.as_str()))
        .map(|s| s.to_string());

    Some(FeishuCardAction {
        chat_id: action_value
            .get("chat_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        action: action_value
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        project_token: action_value
            .get("project_token")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        model_provider: action_value
            .get("model_provider")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        model_id: action_value
            .get("model_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        prompt,
        message_id,
    })
}

// ---------- pure decision / parsing cores (unit-tested) ----------

/// Extract `(chat_id, message_text)` from an `im.message.receive_v1` event.
///
/// Returns `None` for any non-message event or when `event` is absent. The
/// inner `content` is a JSON string; if it parses, its `text` field is used,
/// otherwise the raw content string is returned verbatim. Pure core of
/// `handle_event`.
#[allow(dead_code)]
pub(crate) fn extract_im_message(event: &serde_json::Value) -> Option<(String, String)> {
    let event_type = event
        .get("header")
        .and_then(|h| h.get("event_type"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if event_type != "im.message.receive_v1" {
        return None;
    }
    let event_data = event.get("event")?;
    let chat_id = event_data
        .get("message")
        .and_then(|m| m.get("chat_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let raw = event_data
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let text = if let Ok(content) = serde_json::from_str::<serde_json::Value>(raw) {
        content
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or(raw)
            .to_string()
    } else {
        raw.to_string()
    };
    Some((chat_id, text))
}

/// Event types that mean "the bot just became reachable in a new chat":
/// user opened a P2P chat with the bot, or the bot was added to a group.
/// Each of these triggers a proactive welcome card.
const WELCOME_EVENT_TYPES: [&str; 3] = [
    "p2p_chat_create",
    "im.chat.access_event.bot_p2p_chat_entered_v1",
    "im.chat.member.bot.added_v1",
];

/// Extract the chat_id of a "bot entered a new chat" event, or `None` for
/// any other event type. Pure core of the welcome-card dispatch in
/// `handle_event`.
pub(crate) fn extract_welcome_chat(event: &serde_json::Value) -> Option<String> {
    let event_type = event
        .get("header")
        .and_then(|h| h.get("event_type"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !WELCOME_EVENT_TYPES.contains(&event_type) {
        return None;
    }
    event
        .get("event")
        .and_then(|e| e.get("chat_id"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Whether an event payload is a Feishu interactive card action callback
/// (`card.action.trigger`). Pure core of the `handle_data_frame` dispatch so
/// card actions are routed to `handle_card_action` regardless of the frame
/// `type` header (Feishu may deliver them as either `type: "event"` or
/// `type: "card"` frames).
pub(crate) fn is_card_action_event(event: &serde_json::Value) -> bool {
    event
        .get("header")
        .and_then(|h| h.get("event_type"))
        .and_then(|v| v.as_str())
        .map(|t| t == "card.action.trigger")
        .unwrap_or(false)
}

/// Outcome of resolving a data frame (single or multi-frame reassembled).
#[derive(Debug, PartialEq)]
pub(crate) enum DataFrameOutcome {
    /// Not an event/card frame — ignored by the dispatcher.
    Ignore,
    /// Multi-frame message still awaiting more fragments.
    Pending,
    /// Fully assembled and JSON-parsed event payload.
    Event(serde_json::Value),
    /// Assembled payload failed JSON parsing.
    ParseError,
}

/// P1-16: sliding-window counter for parse errors (60s window, threshold 10).
/// Both values are fixed behaviors, not configuration: they only govern log
/// escalation, never control flow.
static PARSE_ERROR_WINDOW: LazyLock<Mutex<(std::time::Instant, u32)>> =
    LazyLock::new(|| Mutex::new((std::time::Instant::now(), 0)));

fn parse_error_tick() {
    let mut w = duo_utils::sync::lock(&PARSE_ERROR_WINDOW);
    if w.0.elapsed() > std::time::Duration::from_secs(60) {
        *w = (std::time::Instant::now(), 0);
    }
    w.1 += 1;
    if w.1 == 10 {
        tracing::error!(
            count = w.1,
            window_secs = 60,
            "Feishu parse errors spiking: ≥10 unparseable frames in the last minute (each acked to stop redelivery) — check provider payload format"
        );
    }
}

/// Resolve a data frame into a parsed event, handling single/multi-frame
/// reassembly and JSON parse errors. Pure core of `handle_data_frame`.
pub(crate) fn resolve_data_frame(
    msg_type: &str,
    sum: usize,
    seq: usize,
    trace_id: &str,
    payload: Vec<u8>,
    cache: &mut FrameCache,
    message_id: &str,
) -> DataFrameOutcome {
    if msg_type != MESSAGE_TYPE_EVENT && msg_type != MESSAGE_TYPE_CARD {
        return DataFrameOutcome::Ignore;
    }
    let merged = if sum <= 1 {
        Some(payload)
    } else {
        cache.merge(
            message_id.to_string(),
            sum,
            seq,
            trace_id.to_string(),
            payload,
        )
    };
    let payload_bytes = match merged {
        Some(data) => data,
        None => return DataFrameOutcome::Pending,
    };
    let payload_str = String::from_utf8_lossy(&payload_bytes);
    match serde_json::from_str(&payload_str) {
        Ok(v) => DataFrameOutcome::Event(v),
        Err(_) => DataFrameOutcome::ParseError,
    }
}

/// Control-frame classification. Pure core of `handle_control_frame`.
#[derive(Debug, PartialEq)]
pub(crate) enum ControlKind {
    Ping,
    Pong,
    Handshake,
    Unknown,
}

pub(crate) fn classify_control(msg_type: &Option<String>) -> ControlKind {
    match msg_type.as_deref() {
        Some(MESSAGE_TYPE_PING) => ControlKind::Ping,
        Some(MESSAGE_TYPE_PONG) => ControlKind::Pong,
        Some(s) if s == HEADER_KEY_HANDSHAKE_STATUS => ControlKind::Handshake,
        _ => ControlKind::Unknown,
    }
}

/// Parse an optional updated `PingInterval` from a pong frame payload.
pub(crate) fn parse_pong_interval(payload: &[u8]) -> Option<u64> {
    if payload.is_empty() {
        return None;
    }
    let s = String::from_utf8_lossy(payload);
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    v.get("PingInterval").and_then(|v| v.as_u64())
}

/// A single outbound message decided by `plan_card_action`.
#[derive(Debug, PartialEq)]
#[allow(clippy::enum_variant_names)]
pub(crate) enum CardPlan {
    SendText(String),
    SendControlCard,
    SendProjectSelectionCard(Vec<crate::bridge::ProjectInfo>),
}

/// Decide which outbound messages a card-action reply produces, without I/O.
///
/// `project_list` is only consulted for the `switch_project` branch: `Ok`
/// triggers a fresh project-selection card, `Err` produces a failure text.
/// Pure core of `handle_card_action`.
pub(crate) fn plan_card_action(
    action_kind: &str,
    reply: &str,
    project_list: Result<&[crate::bridge::ProjectInfo], &String>,
) -> Vec<CardPlan> {
    match action_kind {
        "select_project" => {
            let mut out = vec![CardPlan::SendText(reply.to_string())];
            if !reply.contains("❌") {
                out.push(CardPlan::SendControlCard);
            }
            out
        }
        "switch_project" => match project_list {
            Ok(projects) => vec![CardPlan::SendProjectSelectionCard(projects.to_vec())],
            Err(e) => vec![CardPlan::SendText(format!("❌ 获取项目列表失败: {}", e))],
        },
        _ => {
            if reply.is_empty() {
                vec![]
            } else {
                vec![CardPlan::SendText(reply.to_string())]
            }
        }
    }
}

/// Decision result for an inbound text dispatch. Pure core of `dispatch_text`.
pub(crate) struct TextDispatch {
    pub needs_project: bool,
    pub text: String,
}

pub(crate) fn plan_text_dispatch(result: &str) -> TextDispatch {
    TextDispatch {
        needs_project: result.contains(NEEDS_PROJECT_MARKER),
        text: truncate_im_response(result),
    }
}

/// WS config returned by the Feishu endpoint API.
#[derive(Debug, serde::Deserialize)]
struct WsEndpointResponse {
    code: i64,
    data: Option<WsEndpointData>,
    msg: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct WsEndpointData {
    #[serde(rename = "URL")]
    url: String,
    #[serde(rename = "ClientConfig")]
    client_config: WsClientConfig,
}

#[derive(Debug, serde::Deserialize)]
struct WsClientConfig {
    #[serde(rename = "PingInterval")]
    ping_interval: u64,
}

/// Parsed WS connection parameters.
#[derive(Debug, Clone)]
struct WsConnectionInfo {
    connect_url: String,
    service_id: u64,
    ping_interval_secs: u64,
}

#[cfg(test)]
impl WsConnectionInfo {
    /// Build a minimal connection-info for integration tests.
    fn test_new(service_id: u64, ping_interval_secs: u64) -> Self {
        Self {
            connect_url: String::new(),
            service_id,
            ping_interval_secs,
        }
    }
}

/// Multi-frame message reassembly cache.
///
/// Feishu may split large event payloads across multiple frames with
/// the same `message_id`, identified by `sum` (total frames) and
/// `seq` (0-based index).
/// One accumulated multi-frame event payload.
///
/// `buffer[sum]` collects each fragment by its 0-based `seq`; `trace_id` is
/// forwarded from the envelope for diagnostics; `created_at` drives TTL eviction.
type FrameBuffer = (Vec<Option<Vec<u8>>>, String, Instant);

/// Hard cap on the number of *in-flight* (still-fragmenting) messages the
/// cache will hold simultaneously. Feishu splits large payloads across many
/// frames; without a bound a malicious or pathological burst of partial
/// messages could grow the map without limit within the 10s TTL window.
///
/// Only *finished* reassembly buffers (all fragments received) count toward
/// eviction pressure — an in-flight message is never dropped, because its
/// missing fragments can never arrive once the buffer is gone. The cap is a
/// backstop against unbounded growth, not a normal-execution limit.
const MAX_FRAME_CACHE_ENTRIES: usize = 1000;

pub(crate) struct FrameCache {
    /// message_id → accumulated fragments
    fragments: HashMap<String, FrameBuffer>,
}

impl FrameCache {
    fn new() -> Self {
        Self {
            fragments: HashMap::new(),
        }
    }

    /// Whether every fragment of this buffer has arrived.
    fn is_complete(buffer: &FrameBuffer) -> bool {
        buffer.0.iter().all(|f| f.is_some())
    }

    /// Merge a received frame payload. Returns `Some(merged_bytes)` when
    /// all fragments are collected, or `None` if more are pending.
    fn merge(
        &mut self,
        message_id: String,
        sum: usize,
        seq: usize,
        trace_id: String,
        data: Vec<u8>,
    ) -> Option<Vec<u8>> {
        let entry = self.fragments.entry(message_id.clone()).or_insert_with(|| {
            let mut buf = Vec::with_capacity(sum);
            buf.resize_with(sum, || None);
            (buf, trace_id, Instant::now())
        });

        if seq < entry.0.len() {
            entry.0[seq] = Some(data);
        }

        // Check if all fragments received
        if Self::is_complete(entry) {
            let parts: Vec<Vec<u8>> = entry
                .0
                .drain(..)
                .map(|f| f.expect("invariant: is_complete() checked above so every fragment is Some"))
                .collect();
            self.fragments.remove(&message_id);
            let total_len: usize = parts.iter().map(|p| p.len()).sum();
            let mut merged = Vec::with_capacity(total_len);
            for part in parts {
                merged.extend_from_slice(&part);
            }
            Some(merged)
        } else {
            None
        }
    }

    /// Enforce the hard capacity cap. **Only fully-reassembled buffers are
    /// evicted**; an in-flight (still-fragmenting) message must never be
    /// dropped, otherwise its missing fragments can never complete it and the
    /// event is silently lost.
    fn enforce_capacity(&mut self) {
        while self.fragments.len() > MAX_FRAME_CACHE_ENTRIES {
            // Prefer evicting the oldest *complete* buffer (insertion order).
            if let Some(oldest_complete) = self
                .fragments
                .iter()
                .find(|(_, buf)| Self::is_complete(buf))
                .map(|(k, _)| k.clone())
            {
                self.fragments.remove(&oldest_complete);
            } else {
                // Nothing complete to evict: every held message is still
                // arriving. Stop rather than lose an in-flight reassembly.
                break;
            }
        }
    }

    /// Remove entries older than 10 seconds.
    fn evict_expired(&mut self) {
        self.evict_older_than(Instant::now() - Duration::from_secs(10));
    }

    /// Remove entries created at or before `cutoff` (testable core of
    /// `evict_expired`).
    fn evict_older_than(&mut self, cutoff: Instant) {
        self.fragments
            .retain(|_, (_, _, created)| *created > cutoff);
    }

    /// Total tracked message buffers (test/diagnostics helper).
    #[cfg(test)]
    fn len(&self) -> usize {
        self.fragments.len()
    }

    /// Hard cap value (test/diagnostics helper).
    #[cfg(test)]
    fn capacity(&self) -> usize {
        MAX_FRAME_CACHE_ENTRIES
    }
}

/// Per-connection deduplication set for inbound Feishu events.
///
/// Feishu delivers events **at-least-once**: on a reconnect or a network blip
/// it may redeliver an event whose ACK was already sent but whose business
/// side (IDE task / card reply) had not completed. Without dedup the same
/// `prompt` would be executed twice or the same card action fired twice.
///
/// The implementation reuses the exact TTL pattern of `FrameCache`: each seen
/// `event_id` is recorded with its `Instant`, and entries older than 10s are
/// evicted on the same cadence as frame fragments. This caps memory and lets a
/// genuinely new event that reuses an old id through after the window.
/// Dedup TTL. Must exceed the longest reconnect backoff (60s) so a
/// redelivery on a fresh connection is still recognized (P2-45).
const DEDUP_TTL: Duration = Duration::from_secs(300);

pub(crate) struct EventDedup {
    seen: HashMap<String, Instant>,
}

/// Process-wide dedup state shared by every WS connection (P2-45).
///
/// A per-connection table loses its memory on reconnect: an event that was
/// dispatched but whose ACK was lost with the dying socket is re-delivered on
/// the fresh connection, which now has an empty table — so the agent runs the
/// same prompt twice. Keying the table on the process makes the TTL window
/// span reconnects.
pub(crate) fn global_event_dedup() -> &'static Mutex<EventDedup> {
    static DEDUP: LazyLock<Mutex<EventDedup>> = LazyLock::new(|| Mutex::new(EventDedup::new()));
    &DEDUP
}

impl EventDedup {
    fn new() -> Self {
        Self {
            seen: HashMap::new(),
        }
    }

    /// Record `event_id`. Returns `true` if this is the first time we see it
    /// (caller should dispatch), or `false` if it was already seen within the
    /// TTL window (caller should skip business dispatch). The id is always
    /// recorded so a repeated redelivery is consistently suppressed.
    fn seen(&mut self, event_id: &str) -> bool {
        if self.seen.contains_key(event_id) {
            return false;
        }
        self.seen.insert(event_id.to_string(), Instant::now());
        true
    }

    /// Remove entries older than the dedup TTL.
    ///
    /// The window must comfortably exceed the reconnect backoff (up to 60s):
    /// a redelivery that arrives on a new connection after a long outage still
    /// has to be recognized as a duplicate.
    fn evict_expired(&mut self) {
        self.evict_older_than(Instant::now() - DEDUP_TTL);
    }

    /// Testable core of `evict_expired`: drop entries at or before `cutoff`.
    fn evict_older_than(&mut self, cutoff: Instant) {
        self.seen.retain(|_, created| *created > cutoff);
    }
}

/// P1-11: per-chat serialization gates. Every spawned business handler takes
/// its chat's mutex before running, so messages in one chat execute strictly
/// in arrival order (previously they raced: a later message could finish
/// first) and a burst cannot interleave prompt launches within a chat.
/// Cross-chat remains fully parallel. Entries are tiny Arc'd mutexes, lazily
/// created; the map grows with distinct chats seen (bounded by usage).
static CHAT_SERIAL: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Best-effort chat-id extraction for per-chat serialization / panic replies.
/// Covers the payload shapes Feishu sends for IM events and card callbacks.
fn extract_chat_id(event: &serde_json::Value) -> Option<String> {
    for ptr in [
        "/event/chat_id",
        "/event/message/chat_id",
        "/event/open_chat_id",
        "/chat_id",
    ] {
        if let Some(v) = event.pointer(ptr).and_then(|v| v.as_str())
            && !v.is_empty()
        {
            return Some(v.to_string());
        }
    }
    None
}

/// Extract the Feishu event id used for deduplication.
///
/// Feishu wraps every callback in a standard envelope whose `header.event_id`
/// uniquely identifies the delivery. Returns `None` when the envelope shape is
/// unexpected so the caller can fall back to "always dispatch" rather than
/// silently dropping a real event.
fn extract_event_id(event: &serde_json::Value) -> Option<String> {
    event
        .get("header")
        .and_then(|h| h.get("event_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Cloneable business-dispatch context.
///
/// Split out of `FeishuWsClient` so inbound events can be handled on
/// spawned tasks: business handling (IDE task execution + REST replies)
/// can take seconds to minutes, and running it inline in the read loop
/// would stall the heartbeat timer and make Feishu drop the connection.
#[derive(Clone)]
struct Dispatcher {
    api: FeishuApiClient,
    bridge: Arc<dyn SmartLayerBridge>,
    /// Shared ACK tracker; used to confirm (remove) pending cards when the
    /// user interacts with a card (callback carries `open_message_id`).
    pending_ack: Option<Arc<Mutex<PendingAckMap>>>,
}

/// Feishu WebSocket client.
pub struct FeishuWsClient {
    config: FeishuConfig,
    shutdown: Arc<RwLock<bool>>,
    dispatcher: Dispatcher,
    /// Half-open guard: if no frame is received within this window the
    /// connection is declared dead and reconnected (see `HEARTBEAT_TIMEOUT_SECS`).
    heartbeat_timeout: Duration,
}

impl FeishuWsClient {
    /// Create a new Feishu WS client.
    pub fn new(
        config: FeishuConfig,
        api: FeishuApiClient,
        bridge: Arc<dyn SmartLayerBridge>,
        shutdown: Arc<RwLock<bool>>,
        pending_ack: Option<Arc<Mutex<PendingAckMap>>>,
    ) -> Self {
        Self {
            config,
            shutdown,
            dispatcher: Dispatcher {
                api,
                bridge,
                pending_ack,
            },
            heartbeat_timeout: Duration::from_secs(HEARTBEAT_TIMEOUT_SECS),
        }
    }

    /// Override the half-open connection timeout. The default is
    /// `HEARTBEAT_TIMEOUT_SECS` (90s); callers may lower it for constrained
    /// environments or tests.
    pub fn with_heartbeat_timeout(mut self, secs: u64) -> Self {
        self.heartbeat_timeout = Duration::from_secs(secs);
        self
    }

    /// Exponential reconnect backoff (cap + growth), single source of truth
    /// for NORMAL disconnect / connection-error retries. Panics are handled
    /// separately by the adapter (lib.rs) since `run` does not catch panics.
    // Shared by both the normal disconnect path (`run`) and the panic path
    // (`lib.rs`), so backoff behavior stays consistent across both.
    pub(crate) fn reconnect_backoff(retries: u32) -> Duration {
        // 2s base, doubles each attempt, capped at 60s to avoid runaway waits.
        let secs = (2u64 << retries.min(30)).min(60);
        Duration::from_secs(secs)
    }

    /// Start the WebSocket connection loop (blocking).
    /// Callers should `tokio::spawn` this.
    /// How many consecutive connect failures this client tolerates before
    /// handing control back to the adapter supervisor (P1-31).
    ///
    /// The supervisor owns the real fuse (`max_retries`, with the 60s healthy
    /// session reset). Previously this loop retried forever, so the
    /// supervisor's `handle.await` never returned and its fuse was
    /// unreachable — a persistently unreachable endpoint meant an infinite
    /// reconnect loop with no exit.
    pub(crate) const MAX_CONSECUTIVE_FAILURES: u32 = 3;

    /// A session that closed sooner than this is treated as a failed connect
    /// rather than a healthy close. The server can accept the handshake and
    /// immediately send Close/EOF (deleted app, revoked credentials, a broken
    /// LB); that path returned `Ok(())` and reset the failure counter, so the
    /// supervisor's fuse stayed unreachable and the client reconnected forever
    /// (P1-31).
    const MIN_HEALTHY_SESSION_SECS: u64 = 5;

    pub async fn run(&self) {
        tracing::info!("Feishu WS client starting");
        let mut retries: u32 = 0;
        let mut consecutive_failures: u32 = 0;

        loop {
            if *self.shutdown.read().await {
                tracing::info!("Feishu WS client shutting down");
                return;
            }

            match self.connect_and_serve().await {
                Ok(served_for) => {
                    if served_for.as_secs() < Self::MIN_HEALTHY_SESSION_SECS {
                        // Connected, then dropped almost immediately: count it
                        // as a failure so this mode also reaches the fuse.
                        retries = (retries + 1).min(8);
                        consecutive_failures += 1;
                        tracing::warn!(
                            served_secs = served_for.as_secs(),
                            consecutive_failures,
                            "Feishu WS closed immediately after connect"
                        );
                        if consecutive_failures >= Self::MAX_CONSECUTIVE_FAILURES {
                            tracing::error!(
                                consecutive_failures,
                                "Feishu WS: repeated short-lived connections — returning to supervisor"
                            );
                            return;
                        }
                    } else {
                        // Clean close after a healthy session: reset backoff so
                        // the next reconnect waits only the base interval.
                        tracing::warn!("Feishu WS connection closed, reconnecting...");
                        retries = 0;
                        consecutive_failures = 0;
                    }
                }
                Err(e) => {
                    tracing::error!(error = %e, "Feishu WS connection error");
                    retries = (retries + 1).min(8);
                    consecutive_failures += 1;
                    if consecutive_failures >= Self::MAX_CONSECUTIVE_FAILURES {
                        // P1-31: return so the supervisor's max_retries fuse is
                        // reachable. Without this the adapter loops forever.
                        tracing::error!(
                            consecutive_failures,
                            "Feishu WS: repeated connect failures — returning to supervisor"
                        );
                        return;
                    }
                }
            }

            let wait = Self::reconnect_backoff(retries);
            tracing::info!(retries, wait_secs = wait.as_secs(), "Feishu WS reconnect backoff");
            sleep(wait).await;
        }
    }

    /// Perform one full connect → serve → disconnect cycle, returning how long
    /// the connection was actually served (used to tell a healthy close from a
    /// server that drops the socket immediately — P1-31).
    async fn connect_and_serve(&self) -> anyhow::Result<std::time::Duration> {
        // 1. Fetch WS config
        let conn_info = self.fetch_ws_config().await?;
        // DEBUG, not INFO: this fires on EVERY reconnect and the URL is not
        // for human eyes — full endpoints in release logs are noise (P2-50).
        tracing::debug!(
            url = %conn_info.connect_url,
            ping_interval = conn_info.ping_interval_secs,
            "Fetched Feishu WS config"
        );

        // 2. Connect WebSocket
        let (ws_stream, _response) = connect_async(&conn_info.connect_url).await?;
        tracing::info!("Feishu WS connected");
        let served_from = std::time::Instant::now();
        self.serve_connection(ws_stream, &conn_info).await?;
        Ok(served_from.elapsed())
    }

    /// Serve an already-established WebSocket connection.
    ///
    /// Extracted from [`Self::connect_and_serve`] so integration tests can drive
    /// the full receive/dispatch/ACK loop against a local mock WS server without
    /// going through the real `fetch_ws_config` + TLS dial path.
    async fn serve_connection(
        &self,
        ws_stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
        conn_info: &WsConnectionInfo,
    ) -> anyhow::Result<()> {
        let (mut ws_sink, mut ws_stream) = ws_stream.split();

        // Ping timer — sends ping via the main loop's ws_sink.
        // The main loop sends a ping after every received message (line ~290).
        // For long idle periods, a dedicated timer-based ping would require
        // sharing ws_sink via Arc<Mutex<>>, which adds complexity. For now,
        // the per-message ping is sufficient for typical workloads.
        // P2-53: the server-supplied interval is untrusted input; a zero (or
        // absurdly small) value made `tokio::time::interval` panic and take the
        // whole adapter down. Clamp to a sane floor.
        let ping_interval =
            Duration::from_secs(conn_info.ping_interval_secs.max(MIN_PING_INTERVAL_SECS));
        let service_id = conn_info.service_id;

        // Message receive + dispatch loop with timer-based heartbeat
        let mut frame_cache = FrameCache::new();
        // P2-45: shared across connections (see `global_event_dedup`).
        let mut evict_counter: u32 = 0;
        let mut ping_timer = tokio::time::interval(ping_interval);
        ping_timer.tick().await; // skip the first immediate tick

        loop {
            tokio::select! {
                _ = async {
                    loop {
                        if *self.shutdown.read().await { break; }
                        sleep(Duration::from_millis(250)).await;
                    }
                } => {
                    tracing::info!("Feishu WS shutdown requested");
                    let _ = ws_sink.send(Message::Close(None)).await;
                    break;
                }
                msg = timeout(self.heartbeat_timeout, ws_stream.next()) => {
                    match msg {
                        // Connection produced a frame.
                        Ok(Some(Ok(frame))) => {
                            match frame {
                                Message::Binary(data) => {
                                    let frame = match decode_frame(&data) {
                                        Ok(f) => f,
                                        Err(e) => {
                                            tracing::warn!(error = %e, "Failed to decode pbbp2 frame");
                                            continue;
                                        }
                                    };

                                    match frame.method {
                                        FRAME_TYPE_CONTROL => {
                                            self.handle_control_frame(&frame).await;
                                        }
                                        FRAME_TYPE_DATA => {
                                            // Protocol requirement (official SDK parity):
                                            // fully-received data frames MUST be ACKed by
                                            // echoing the frame back with a {"code":200}
                                            // payload. Without the ACK, Feishu treats the
                                            // push as failed and re-delivers / degrades
                                            // the connection.
                                            if let Some(ack) = self.handle_data_frame(
                                                &frame,
                                                &mut frame_cache,
                                                global_event_dedup(),
                                            ) {
                                                let bytes = encode_frame(&ack);
                                                if ws_sink
                                                    .send(Message::Binary(bytes))
                                                    .await
                                                    .is_err()
                                                {
                                                    tracing::warn!("Failed to send data-frame ACK");
                                                    break;
                                                }
                                            }
                                        }
                                        _ => {
                                            tracing::warn!(method = frame.method, "Unknown frame method");
                                        }
                                    }

                                    // Periodic cache eviction
                                    evict_counter += 1;
                                    if evict_counter.is_multiple_of(100) {
                                        // Bound memory: drop finished reassembly
                                        // buffers that exceed the hard cap, and
                                        // expire stale in-flight buffers. Neither
                                        // path ever drops a live fragmenting message.
                                        frame_cache.enforce_capacity();
                                        frame_cache.evict_expired();
                                        duo_utils::sync::lock(global_event_dedup()).evict_expired();
                                    }
                                }
                                Message::Ping(data) => {
                                    // Respond with pong; also counts as activity.
                                    let _ = ws_sink.send(Message::Pong(data)).await;
                                }
                                Message::Pong(_) => {
                                    // Server answered our heartbeat — link alive.
                                }
                                Message::Close(_) => {
                                    tracing::info!("Feishu WS server closed connection");
                                    break;
                                }
                                Message::Text(_) | Message::Frame(_) => {}
                            }
                        }
                        // Read-side transport error → reconnect.
                        Ok(Some(Err(e))) => {
                            tracing::error!(error = %e, "Feishu WS read error");
                            break;
                        }
                        // Stream ended (server dropped) → reconnect.
                        Ok(None) => {
                            tracing::info!("Feishu WS stream ended");
                            break;
                        }
                        // Heartbeat timeout: no frame within HEARTBEAT_TIMEOUT_SECS.
                        // The TCP socket may still be "open" (half-open) but the
                        // link is dead; force a reconnect rather than block forever.
                        Err(_) => {
                            tracing::warn!(
                                timeout_secs = HEARTBEAT_TIMEOUT_SECS,
                                "Feishu WS heartbeat timeout (no frame received); reconnecting"
                            );
                            break;
                        }
                    }
                }
                _ = ping_timer.tick() => {
                    // Timer-based heartbeat: sends ping even during idle periods
                    let ping_frame = build_ping_frame(service_id);
                    let ping_bytes = encode_frame(&ping_frame);
                    if ws_sink.send(Message::Binary(ping_bytes)).await.is_err() {
                        tracing::warn!("Failed to send heartbeat ping");
                        break;
                    }
                }
            }
        }

        Ok(())
    }

    /// Fetch WS connection config from Feishu API.
    async fn fetch_ws_config(&self) -> anyhow::Result<WsConnectionInfo> {
        // Shared client: connect 10s + overall 30s (P1-32). `Client::new()` had
        // no connect timeout at all, so a half-open TCP handshake here blocked
        // the whole reconnect loop.
        let resp = crate::feishu::api::http_client()
            .post(self.config.ws_config_url())
            .json(&serde_json::json!({
                "AppID": self.config.app_id,
                "AppSecret": self.config.app_secret
            }))
            .header("locale", "zh")
            .timeout(Duration::from_secs(15))
            .send()
            .await?
            .json::<WsEndpointResponse>()
            .await?;

        if resp.code != ERROR_CODE_OK {
            anyhow::bail!(
                "Feishu WS config error: code={}, msg={}",
                resp.code,
                resp.msg.unwrap_or_default()
            );
        }

        let data = resp
            .data
            .ok_or_else(|| anyhow::anyhow!("Missing data in WS config response"))?;

        // Parse URL to extract the service_id query parameter
        let url = url::Url::parse(&data.url)?;
        let params: HashMap<String, String> = url.query_pairs().into_owned().collect();

        let service_id = params
            .get("service_id")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);

        Ok(WsConnectionInfo {
            connect_url: data.url,
            service_id,
            ping_interval_secs: data.client_config.ping_interval,
        })
    }

    /// Handle a control frame (pong, handshake response).
    async fn handle_control_frame(&self, frame: &pbbp2::Frame) {
        match classify_control(&get_header(frame, HEADER_KEY_TYPE)) {
            ControlKind::Ping => {
                // Server ping — we respond in the main loop
                tracing::trace!("Received server ping");
            }
            ControlKind::Pong => {
                // Pong may carry an updated ping interval in its payload
                if let Some(interval) = parse_pong_interval(&frame.payload) {
                    tracing::debug!(new_interval = interval, "Updated ping interval from pong");
                }
            }
            ControlKind::Handshake => {
                let status = get_header(frame, HEADER_KEY_HANDSHAKE_STATUS);
                let msg = get_header(frame, HEADER_KEY_HANDSHAKE_MSG);
                tracing::info!(status = ?status, msg = ?msg, "Handshake response");
            }
            ControlKind::Unknown => {
                let msg_type = get_header(frame, HEADER_KEY_TYPE);
                tracing::warn!(r#type = ?msg_type, "Unknown control frame type");
            }
        }
    }

    /// Handle a data frame (event or card callback).
    ///
    /// Returns the ACK frame to write back for fully-received event/card
    /// frames (protocol requirement), or `None` when nothing must be sent
    /// (fragment pending / ignored type / parse error). Business handling is
    /// spawned onto a separate task so this read loop — and therefore the
    /// heartbeat — is never blocked by slow IDE task execution.
    fn handle_data_frame(
        &self,
        frame: &pbbp2::Frame,
        cache: &mut FrameCache,
        dedup: &Mutex<EventDedup>,
    ) -> Option<pbbp2::Frame> {
        let headers_map: HashMap<String, String> = frame
            .headers
            .iter()
            .map(|h| (h.key.clone(), h.value.clone()))
            .collect();

        let msg_type = headers_map
            .get(HEADER_KEY_TYPE)
            .cloned()
            .unwrap_or_default();
        let message_id = headers_map
            .get(HEADER_KEY_MESSAGE_ID)
            .cloned()
            .unwrap_or_default();
        let sum: usize = headers_map
            .get(HEADER_KEY_SUM)
            .and_then(|v| v.parse().ok())
            .unwrap_or(1);
        let seq: usize = headers_map
            .get(HEADER_KEY_SEQ)
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let trace_id = headers_map
            .get(HEADER_KEY_TRACE_ID)
            .cloned()
            .unwrap_or_default();

        let outcome = resolve_data_frame(
            &msg_type,
            sum,
            seq,
            &trace_id,
            frame.payload.clone(),
            cache,
            &message_id,
        );

        match outcome {
            DataFrameOutcome::Ignore => {
                tracing::trace!(r#type = %msg_type, "Ignoring non-event data frame");
                None
            }
            DataFrameOutcome::Pending => None,
            DataFrameOutcome::ParseError => {
                // P1-16: ACK the frame even though it cannot be parsed. A
                // malformed frame is permanently malformed — withholding the
                // ACK makes Feishu redeliver it forever (at-least-once), which
                // produces an infinite error loop instead of losing one
                // unprocessable frame. A sliding-window counter escalates to a
                // single aggregated error when parse failures spike (bad
                // provider payload / protocol drift).
                parse_error_tick();
                tracing::error!(message_id = %message_id, "Failed to parse event JSON (acked to stop redelivery)");
                Some(build_ack_frame(frame, 0))
            }
            DataFrameOutcome::Event(event) => {
                tracing::debug!(
                    r#type = %msg_type,
                    message_id = %message_id,
                    trace_id = %trace_id,
                    "Received Feishu event"
                );
                // Deduplicate at-least-once redeliveries. Feishu re-sends an
                // event after a reconnect/blip if its ACK raced a slow business
                // side. We ACK regardless (so Feishu stops redelivering) but
                // skip dispatching a duplicate, keeping each prompt/card action
                // executed exactly once. Events without a recognizable
                // `header.event_id` are never suppressed (fail-open).
                if let Some(event_id) = extract_event_id(&event)
                    && !duo_utils::sync::lock(dedup).seen(&event_id)
                {
                    tracing::debug!(event_id = %event_id, "Duplicate event suppressed (not dispatched)");
                    return Some(build_ack_frame(frame, 0));
                }
                // Dispatch on a detached task: business handling can take
                // minutes (IDE task run + REST replies) and must not stall
                // the read/heartbeat loop.
                //
                // IMPORTANT: route by the *payload's* `header.event_type`, not
                // the frame `type` header. Feishu may deliver a
                // `card.action.trigger` either as a `type: "card"` frame OR a
                // `type: "event"` frame (with the event type inside the JSON).
                // Routing on the frame `type` alone pushed card actions that
                // arrive as `type: "event"` into `handle_event`, which ignores
                // `card.action.trigger` entirely — so `select_project` /
                // `submit_prompt` were silently dropped and project bindings
                // were never established (causing "still asks to pick a
                // project" after sending a message). Route card actions to
                // `handle_card_action` regardless of the frame `type`.
                let is_card_action = is_card_action_event(&event);
                let dispatcher = self.dispatcher.clone();
                tokio::spawn(async move {
                    // P1-11: serialize per chat before running the business
                    // handler (order guarantee within a chat), then isolate
                    // panics — a panicking handler used to vanish after the
                    // ACK was already sent, silently dropping the message.
                    let chat_key = extract_chat_id(&event)
                        .unwrap_or_else(|| format!("frame-{}", message_id));
                    let gate = {
                        let mut m = duo_utils::sync::lock(&CHAT_SERIAL);
                        m.entry(chat_key.clone())
                            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                            .clone()
                    };
                    let _gate = gate.lock().await;
                    let _ = &_gate;
                    let chat_for_panic = chat_key.clone();
                    let api_for_panic = dispatcher.api.clone();
                    let inner = tokio::spawn(async move {
                        if is_card_action {
                            dispatcher.handle_card_action(&event).await;
                        } else if msg_type == MESSAGE_TYPE_EVENT {
                            dispatcher.handle_event(&event).await;
                        } else {
                            dispatcher.handle_card_action(&event).await;
                        }
                    });
                    match inner.await {
                        Ok(()) => {}
                        Err(join_err) if join_err.is_panic() => {
                            tracing::error!(
                                chat_id = %chat_for_panic,
                                panic = %join_err,
                                "Feishu event handler panicked (event was already acked) — notifying the chat"
                            );
                            if let Err(send_err) = api_for_panic
                                .send_text_message(
                                    &chat_for_panic,
                                    "⚠️ 处理该消息时发生内部错误，请重试。",
                                )
                                .await
                            {
                                tracing::warn!(
                                    error = %send_err,
                                    "Failed to deliver the panic notice to the chat"
                                );
                            }
                        }
                        Err(_) => {}
                    }
                });
                // ACK immediately after successful decode, mirroring the
                // official SDKs (they ACK once the handler is invoked).
                Some(build_ack_frame(frame, 0))
            }
        }
    }
}

impl Dispatcher {
    /// Handle a received event (e.g. im.message.receive_v1).
    async fn handle_event(&self, event: &serde_json::Value) {
        let event_type = event
            .get("header")
            .and_then(|h| h.get("event_type"))
            .and_then(|v| v.as_str())
            .unwrap_or("<missing>");
        tracing::debug!(event_type = %event_type, "Feishu inbound event received");

        // Bot just entered a new chat (P2P opened / added to group):
        // record it and proactively send the onboarding welcome card so the
        // user sees the available operations without having to guess.
        if let Some(chat_id) = extract_welcome_chat(event) {
            crate::feishu::api::record_chat_id(&chat_id);
            tracing::info!(chat_id = %chat_id, "Welcome event matched — sending welcome card");
            match self.api.send_welcome_card(&chat_id).await {
                Ok(()) => {
                    crate::feishu::api::mark_welcomed(&chat_id);
                    tracing::info!(chat_id = %chat_id, "Welcome card sent OK (bot-entered)");
                }
                Err(e) => tracing::warn!(chat_id = %chat_id, error = %e, "Failed to send welcome card (bot-entered)"),
            }
            return;
        }
        let Some((chat_id, message_text)) = extract_im_message(event) else {
            tracing::debug!(
                event_type = %event_type,
                "Not a recognized message event — skipping welcome/text dispatch"
            );
            return;
        };
        // Remember every chat we've heard from. Single (P2P) chats cannot be
        // enumerated by Feishu's chat-listing API, so this registry is the only
        // reliable way to reach them — e.g. to onboard them on a later config
        // save.
        crate::feishu::api::record_chat_id(&chat_id);
        let already_welcomed = crate::feishu::api::has_been_welcomed(&chat_id);
        tracing::debug!(
            chat_id = %chat_id,
            already_welcomed = already_welcomed,
            text_preview = %message_text.chars().take(80).collect::<String>(),
            "Inbound message parsed"
        );
        // First time we hear from this chat, greet the user immediately so they
        // learn what the bot can do without waiting for a save. Deduped so we
        // don't re-send on every inbound message.
        if !already_welcomed {
            match self.api.send_welcome_card(&chat_id).await {
                Ok(()) => {
                    crate::feishu::api::mark_welcomed(&chat_id);
                    tracing::info!(chat_id = %chat_id, "Welcome card sent OK (first contact)");
                }
                Err(e) => tracing::warn!(
                    chat_id = %chat_id,
                    error = %e,
                    "Failed to send welcome card on first contact"
                ),
            }
        } else {
            tracing::info!(chat_id = %chat_id, "Chat already welcomed — skipping welcome card");
        }
        // P2-50: the full user message is private conversation content —
        // logging it at INFO leaks it into every log sink. Log only its
        // length at INFO; the full text stays available at TRACE for
        // debugging.
        tracing::info!(chat_id = %chat_id, text_len = message_text.chars().count(), "Received IM message");
        tracing::trace!(chat_id = %chat_id, text = %message_text, "IM message content");

        // All inbound text is treated as a natural-language task. Card-driven
        // operations (project selection / status / abort / switch project) are
        // handled via interactive card callbacks, never through slash commands.
        if let Err(e) = self.dispatch_text(&chat_id, &message_text).await {
            tracing::error!(error = %e, "Failed to dispatch IM message");
        }
    }

    /// Handle a card action callback.
    async fn handle_card_action(&self, event: &serde_json::Value) {
        let Some(action) = decode_card_action(event) else {
            return;
        };

        // Confirm the card: remove it from the pending-ACK map so the
        // re-delivery timer stops re-PATCHing it.
        if let (Some(tracker), Some(mid)) = (&self.pending_ack, &action.message_id) {
            duo_utils::sync::lock(tracker).remove(mid);
        }

        tracing::info!(action = %action.action, chat_id = %action.chat_id, has_prompt = action.prompt.is_some(), has_message_id = action.message_id.is_some(), "Card action received");

        if action.chat_id.is_empty() {
            tracing::warn!(action = %action.action, "Card action missing chat_id");
            return;
        }

        let chat_id = action.chat_id.clone();
        let action_kind = action.action.clone();

        match self.bridge.handle_feishu_card_action(action).await {
            Ok(reply) => {
                // Only the `switch_project` branch needs the live project list;
                // other branches ignore `project_list`.
                let project_list: Result<Vec<crate::bridge::ProjectInfo>, String> =
                    if action_kind == "switch_project" {
                        self.bridge
                            .list_ide_projects(&chat_id)
                            .await
                            .map_err(|e| e.to_string())
                    } else {
                        Ok(vec![])
                    };
                for plan in plan_card_action(&action_kind, &reply, project_list.as_deref()) {
                    let res = match plan {
                        CardPlan::SendText(t) => self.api.send_text_message(&chat_id, &t).await,
                        CardPlan::SendControlCard => self.api.send_control_card(&chat_id).await,
                        CardPlan::SendProjectSelectionCard(projects) => {
                            self.api
                                .send_project_selection_card(&chat_id, &projects)
                                .await
                        }
                    };
                    if let Err(e) = res {
                        tracing::error!(error = %e, "Failed to send card-action reply");
                    }
                }
                // A binding reply (e.g. project just bound) may also ask the
                // user to pick a model; surface the model card if so.
                self.maybe_send_model_card(&chat_id, &reply).await;
            }
            Err(e) => {
                tracing::error!(error = %e, "Card action failed");
                let _ = self
                    .api
                    .send_text_message(&chat_id, &format!("❌ 操作失败: {}", e))
                    .await;
            }
        }
    }

    /// If `reply` asks the user to pick a model (`NEEDS_MODEL_MARKER`),
    /// fetch the available models and push the model selection card. Pure
    /// routing helper mirroring the project-card path in `dispatch_text`.
    async fn maybe_send_model_card(&self, chat_id: &str, reply: &str) {
        if !reply.contains(NEEDS_MODEL_MARKER) {
            return;
        }
        match self.bridge.list_models(chat_id).await {
            Ok(models) => {
                if let Err(e) = self.api.send_model_selection_card(chat_id, &models).await {
                    tracing::error!(error = %e, chat_id = %chat_id, "Failed to send model selection card");
                }
            }
            Err(e) => {
                if let Err(e) = self
                    .api
                    .send_text_message(chat_id, &format!("❌ 获取模型列表失败: {}", e))
                    .await
                {
                    tracing::error!(error = %e, chat_id = %chat_id, "Failed to report model list error");
                }
            }
        }
    }

    /// Dispatch an inbound chat message as a natural-language task.
    ///
    /// All text from the user is treated as a task prompt. Card-driven
    /// operations (project selection / status / abort / switch) are handled
    /// exclusively via interactive card callbacks — no slash commands.
    async fn dispatch_text(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        match self.bridge.handle_feishu_text(chat_id, text).await {
            Ok(result) => {
                let plan = plan_text_dispatch(&result);
                self.api.send_text_message(chat_id, &plan.text).await?;
                if plan.needs_project {
                    match self.bridge.list_ide_projects(chat_id).await {
                        Ok(projects) => {
                            self.api.send_project_selection_card(chat_id, &projects).await?
                        }
                        Err(e) => {
                            self.api
                                .send_text_message(
                                    chat_id,
                                    &format!("❌ 获取项目列表失败: {}", e),
                                )
                                .await?;
                        }
                    }
                }
                // Model selection follows the same marker-driven pattern as the
                // project card above.
                self.maybe_send_model_card(chat_id, &result).await;
            }
            Err(e) => {
                self.api
                    .send_text_message(chat_id, &format!("❌ 执行失败: {}", e))
                    .await?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::{ModelInfo, ProjectInfo};
    use crate::feishu::api::{
        build_control_card, build_model_selection_card, build_project_selection_card,
        build_task_status_card,
    };
    use serde_json::json;

    // ---------- truncate_im_response ----------

    #[test]
    fn truncate_passes_short_text_through() {
        let text = "短响应，无需截断";
        assert_eq!(truncate_im_response(text), text);
    }

    #[test]
    fn truncate_cuts_long_ascii_at_newline() {
        // 200 lines x 100 bytes ≈ 20KB, well over the 10KB limit.
        let line = "x".repeat(99);
        let text = std::iter::repeat_n(line.as_str(), 200)
            .collect::<Vec<_>>()
            .join("\n");
        let out = truncate_im_response(&text);
        assert!(out.contains("已截断"));
        // Body before the marker must end at a full line (newline cut).
        let body = out.split("...").next().unwrap();
        assert!(body.len() < IM_MAX_RESPONSE_LEN);
        assert!(body.ends_with(&line));
    }

    #[test]
    fn truncate_does_not_panic_on_multibyte_boundary() {
        // 3-byte chars with no newline: 10240 % 3 == 1, so the naive
        // byte-index slice would land mid-char and panic (regression test).
        let text = "中".repeat(6000);
        let out = truncate_im_response(&text);
        assert!(out.contains("已截断"));
        assert!(out.contains("6000 字符"));
    }

    #[test]
    fn truncate_reports_char_count_not_bytes() {
        let text = format!("{}\n{}", "汉".repeat(4000), "字".repeat(4000));
        let out = truncate_im_response(&text);
        // 8001 chars total (incl. newline), not the ~24K byte count.
        assert!(out.contains("8001 字符"));
    }


    #[test]
    fn frame_cache_merges_out_of_order_fragments() {
        let mut cache = FrameCache::new();
        let mid = "m1".to_string();
        assert!(cache
            .merge(mid.clone(), 3, 2, "t".into(), b"C".to_vec())
            .is_none());
        assert!(cache
            .merge(mid.clone(), 3, 0, "t".into(), b"A".to_vec())
            .is_none());
        let merged = cache.merge(mid.clone(), 3, 1, "t".into(), b"B".to_vec());
        assert_eq!(merged.as_deref(), Some(b"ABC".as_slice()));
        // Completed entry must be evicted from the cache.
        assert!(cache.fragments.is_empty());
    }

    #[test]
    fn frame_cache_ignores_out_of_range_seq() {
        let mut cache = FrameCache::new();
        // seq beyond the declared sum must not panic nor complete the entry.
        assert!(cache
            .merge("m2".into(), 2, 5, "t".into(), b"X".to_vec())
            .is_none());
        assert_eq!(cache.fragments.len(), 1);
    }

    #[test]
    fn frame_cache_single_frame_completes_immediately() {
        let mut cache = FrameCache::new();
        let merged = cache.merge("m3".into(), 1, 0, "t".into(), b"solo".to_vec());
        assert_eq!(merged.as_deref(), Some(b"solo".as_slice()));
    }

    #[test]
    fn frame_cache_eviction_by_cutoff() {
        let mut cache = FrameCache::new();
        cache.merge("m4".into(), 2, 0, "t".into(), b"A".to_vec());
        // Cutoff in the past: entry is fresh, must survive.
        cache.evict_older_than(Instant::now() - Duration::from_secs(1));
        assert_eq!(cache.fragments.len(), 1);
        // Cutoff in the future: entry is older than cutoff, must be evicted.
        cache.evict_older_than(Instant::now() + Duration::from_secs(1));
        assert!(cache.fragments.is_empty());
    }

    // ---------- FrameCache 容量上限（海量分片边界） ----------

    /// 单条超大消息（远小于容量上限的 *message_id* 数）完整重组：单 message_id
    /// 的 300 帧只占 1 个缓存条目，验证大消息重组不受容量逻辑影响。
    #[test]
    fn frame_cache_single_large_message_reassembles_fully() {
        let mut cache = FrameCache::new();
        let mid = "big_msg".to_string();
        let sum = 300usize;
        // A legitimate JSON document whose UTF-8 bytes are sliced into `sum`
        // fragments. Reassembly must reproduce the original bytes exactly and
        // parse back into the same JSON value.
        let original = serde_json::json!({ "content": "LARGE_PAYLOAD_".repeat(200) }).to_string();
        let bytes = original.as_bytes();
        let chunk = bytes.len().div_ceil(sum).max(1);
        let mut final_outcome = None;
        for seq in 0..sum {
            let s = seq * chunk;
            let e = ((seq + 1) * chunk).min(bytes.len());
            let payload = bytes.get(s..e).unwrap_or(&[]).to_vec();
            let outcome = resolve_data_frame(
                "event",
                sum,
                seq,
                "trace",
                payload,
                &mut cache,
                &mid,
            );
            if matches!(outcome, DataFrameOutcome::Event(_)) {
                final_outcome = Some(outcome);
            } else {
                assert!(
                    matches!(outcome, DataFrameOutcome::Pending),
                    "seq={seq} incomplete fragment must stay Pending, got {outcome:?}"
                );
            }
        }
        match final_outcome.expect("large message must complete") {
            DataFrameOutcome::Event(v) => {
                // Reassembled JSON must equal the original document (no
                // truncation/reordering across 300 fragments).
                assert_eq!(v, serde_json::json!({ "content": "LARGE_PAYLOAD_".repeat(200) }));
            }
            other => panic!("expected complete Event, got {other:?}"),
        }
    }

    /// 边界（之前是真实 bug 来源）：当同时挂起的分片消息数超过硬上限时，
    /// `enforce_capacity` 必须 **只** 清理「已完成」的条目，绝不误删仍在分片
    /// 中的消息——否则那些消息的缺失帧永远无法补齐而被静默丢失。
    ///
    /// 构造：1005 个不同 message_id 的「未完成」单帧（sum=2 仅收到第 0 帧），
    /// 数量超过 MAX(1000)。完成后所有条目仍处于 Pending（未完成），因此
    /// `enforce_capacity` 不得删除任何一个；随后补齐第 1 帧，必须全部重组成功。
    #[test]
    fn frame_cache_capacity_does_not_drop_in_flight_messages() {
        let mut cache = FrameCache::new();
        let cap = cache.capacity();
        let total = cap + 5; // 超过容量上限
        // 阶段 1：每个 message_id 推第 0 帧（sum=2），全部保持 Pending。
        // head 是一段未闭合的 JSON 前缀；tail 是闭合后缀，二者拼接成合法 JSON。
        for i in 0..total {
            let mid = format!("incomplete_{i}");
            // head: `{"id":`  (prefix; tail closes it into valid JSON)
            let head = "{\"id\":".to_string();
            let outcome = resolve_data_frame(
                "event",
                2,
                0,
                "trace",
                head.into_bytes(),
                &mut cache,
                &mid,
            );
            assert!(matches!(outcome, DataFrameOutcome::Pending));
            // 周期性触发容量保护（与真实主循环一致，每 100 帧一次）。
            if i.is_multiple_of(100) {
                cache.enforce_capacity();
            }
        }
        assert_eq!(
            cache.len(),
            total,
            "in-flight messages must NOT be evicted even past the cap"
        );

        // 阶段 2：补齐每个 message_id 的第 1 帧，全部应当完整重组。
        let mut completed = 0usize;
        for i in 0..total {
            let mid = format!("incomplete_{i}");
            // tail: `<i>}`  → `{"id":<i>}`  (valid JSON → Event)
            let tail = format!("{i}}}");
            let outcome = resolve_data_frame(
                "event",
                2,
                1,
                "trace",
                tail.into_bytes(),
                &mut cache,
                &mid,
            );
            if matches!(outcome, DataFrameOutcome::Event(_)) {
                completed += 1;
            }
        }
        assert_eq!(
            completed, total,
            "every in-flight message must reassemble once its fragments arrive"
        );
    }

    /// 容量上限对「已完成」条目的清理：先塞满未完成条目，再持续插入已完成
    /// 单帧直到超过上限，`enforce_capacity` 应回收已完成条目，且挂起条目存活。
    #[test]
    fn frame_cache_capacity_evicts_completed_only() {
        let mut cache = FrameCache::new();
        let cap = cache.capacity();
        // 先放入 cap 个未完成 message_id（sum=2 仅第 0 帧）。
        for i in 0..cap {
            let mid = format!("pending_{i}");
            resolve_data_frame(
                "event",
                2,
                0,
                "trace",
                b"x".to_vec(),
                &mut cache,
                &mid,
            );
        }
        assert_eq!(cache.len(), cap);
        // 现在反复插入「已完成」单帧（sum=1），每插入后触发容量保护。
        for j in 0..(cap + 50) {
            let mid = format!("done_{j}");
            resolve_data_frame("event", 1, 0, "trace", b"y".to_vec(), &mut cache, &mid);
            cache.enforce_capacity();
        }
        // 容量被强制收敛到 <= cap+1（仅保留无法回收的挂起项）。
        assert!(
            cache.len() <= cap + 1,
            "cache must be bounded near the cap, got {}",
            cache.len()
        );
        // 所有「挂起」条目仍在（未被误删）。
        for i in 0..cap {
            assert!(
                cache.fragments.contains_key(&format!("pending_{i}")),
                "pending entry {i} must survive capacity eviction"
            );
        }
    }

    // ---------- reconnect_backoff ----------

    #[test]
    fn backoff_doubles_then_caps_at_60s() {
        let secs = |r| FeishuWsClient::reconnect_backoff(r).as_secs();
        assert_eq!(secs(0), 2);
        assert_eq!(secs(1), 4);
        assert_eq!(secs(2), 8);
        assert_eq!(secs(4), 32);
        assert_eq!(secs(5), 60);
        assert_eq!(secs(100), 60); // min(30) shift guard: no overflow
    }

    // ---------- decode_card_action ----------

    #[test]
    fn decode_nested_event_payload() {
        // Real Feishu shape: action nested under event.event.
        let event = json!({
            "header": { "event_type": "card.action.trigger" },
            "event": {
                "open_message_id": "om_123",
                "action": {
                    "value": {
                        "action": "select_project",
                        "chat_id": "oc_abc",
                        "project_token": "tok_1"
                    },
                    "form_value": { "prompt_input": "帮我修 bug" }
                }
            }
        });
        let a = decode_card_action(&event).expect("must decode");
        assert_eq!(a.action, "select_project");
        assert_eq!(a.chat_id, "oc_abc");
        assert_eq!(a.project_token.as_deref(), Some("tok_1"));
        assert_eq!(a.prompt.as_deref(), Some("帮我修 bug"));
        assert_eq!(a.message_id.as_deref(), Some("om_123"));
    }

    #[test]
    fn decode_flat_payload_fallback() {
        let event = json!({
            "open_message_id": "om_flat",
            "action": {
                "value": { "action": "abort_task", "chat_id": "oc_x" }
            }
        });
        let a = decode_card_action(&event).expect("must decode");
        assert_eq!(a.action, "abort_task");
        assert_eq!(a.chat_id, "oc_x");
        assert_eq!(a.project_token, None);
        assert_eq!(a.prompt, None);
        assert_eq!(a.message_id.as_deref(), Some("om_flat"));
    }

    #[test]
    fn decode_returns_none_without_action_value() {
        assert!(decode_card_action(&json!({})).is_none());
        assert!(decode_card_action(&json!({ "event": { "message": {} } })).is_none());
        // action.value present but not an object → None
        assert!(decode_card_action(&json!({ "action": { "value": "str" } })).is_none());
    }

    #[test]
    fn decode_keeps_empty_chat_id_for_caller_guard() {
        // chat_id missing → decoded with empty string; the dispatcher guards.
        let event = json!({ "event": { "action": { "value": { "action": "view_status" } } } });
        let a = decode_card_action(&event).expect("must decode");
        assert_eq!(a.action, "view_status");
        assert!(a.chat_id.is_empty());
    }

    // ---------- card build → callback decode round-trip ----------

    /// Collect every button `value` object from a card payload.
    fn button_values(card: &serde_json::Value) -> Vec<serde_json::Value> {
        card["elements"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["tag"] == "action")
            .flat_map(|e| e["actions"].as_array().unwrap().iter())
            .map(|b| b["value"].clone())
            .collect()
    }

    /// Wrap a button value into the nested Feishu callback shape.
    fn callback_for(value: serde_json::Value) -> serde_json::Value {
        json!({
            "header": { "event_type": "card.action.trigger" },
            "event": { "open_message_id": "om_rt", "action": { "value": value } }
        })
    }

    #[test]
    fn control_card_buttons_round_trip_through_decoder() {
        let card = build_control_card("oc_rt");
        let values = button_values(&card);
        let actions: Vec<String> = values
            .into_iter()
            .map(|v| {
                let a = decode_card_action(&callback_for(v)).expect("decodable");
                assert_eq!(a.chat_id, "oc_rt");
                assert_eq!(a.message_id.as_deref(), Some("om_rt"));
                a.action
            })
            .collect();
        assert_eq!(
            actions,
            ["switch_project", "new_session", "view_status", "abort_task"]
        );
    }

    #[test]
    fn project_card_buttons_round_trip_through_decoder() {
        let projects = vec![
            ProjectInfo {
                token: "tok_a".into(),
                name: "proj-a".into(),
            },
            ProjectInfo {
                token: "tok_b".into(),
                name: "proj-b".into(),
            },
        ];
        let card = build_project_selection_card("oc_rt", &projects);
        let values = button_values(&card);
        assert_eq!(values.len(), 2);
        for (v, tok) in values.into_iter().zip(["tok_a", "tok_b"]) {
            let a = decode_card_action(&callback_for(v)).expect("decodable");
            assert_eq!(a.action, "select_project");
            assert_eq!(a.chat_id, "oc_rt");
            assert_eq!(a.project_token.as_deref(), Some(tok));
        }
    }

    #[test]
    fn task_status_card_buttons_round_trip_through_decoder() {
        let card = build_task_status_card("oc_rt", "🚀 任务已提交", "内容");
        let actions: Vec<String> = button_values(&card)
            .into_iter()
            .map(|v| decode_card_action(&callback_for(v)).expect("decodable").action)
            .collect();
        assert_eq!(actions, ["view_status", "abort_task"]);
    }

    // ---------- NEEDS_PROJECT_MARKER contract ----------

    #[test]
    fn needs_project_marker_is_stable() {
        // ws.rs dispatch + duo-smart-layer replies both reference this
        // constant; this test locks the literal against accidental edits.
        assert_eq!(NEEDS_PROJECT_MARKER, "请先选择项目");
    }

    #[test]
    fn needs_model_marker_is_stable() {
        // Locks the model-selection marker literal (mirrors needs_project).
        assert_eq!(NEEDS_MODEL_MARKER, "请先选择模型");
    }

    // ---------- model card decode round-trip ----------

    #[test]
    fn model_card_buttons_round_trip_through_decoder() {
        let models = vec![
            ModelInfo {
                provider_id: "anthropic".into(),
                model_id: "claude-3-5-sonnet".into(),
                display_name: "anthropic/claude-3-5-sonnet".into(),
            },
            ModelInfo {
                provider_id: "openai".into(),
                model_id: "gpt-4o".into(),
                display_name: "openai/gpt-4o".into(),
            },
        ];
        let card = build_model_selection_card("oc_rt", &models);
        let values = button_values(&card);
        assert_eq!(values.len(), 2);
        for (v, (prov, mid)) in values
            .into_iter()
            .zip([("anthropic", "claude-3-5-sonnet"), ("openai", "gpt-4o")])
        {
            let a = decode_card_action(&callback_for(v)).expect("decodable");
            assert_eq!(a.action, "select_model");
            assert_eq!(a.chat_id, "oc_rt");
            assert_eq!(a.model_provider.as_deref(), Some(prov));
            assert_eq!(a.model_id.as_deref(), Some(mid));
        }
    }

    // ---------- decode_card_action model fields ----------

    #[test]
    fn decode_parses_model_fields() {
        let event = json!({
            "header": { "event_type": "card.action.trigger" },
            "event": {
                "open_message_id": "om_m",
                "action": {
                    "value": {
                        "action": "select_model",
                        "chat_id": "oc_y",
                        "model_provider": "anthropic",
                        "model_id": "claude-3-5-sonnet"
                    }
                }
            }
        });
        let a = decode_card_action(&event).expect("must decode");
        assert_eq!(a.action, "select_model");
        assert_eq!(a.model_provider.as_deref(), Some("anthropic"));
        assert_eq!(a.model_id.as_deref(), Some("claude-3-5-sonnet"));
        // Unrelated fields remain absent.
        assert_eq!(a.project_token, None);
    }

    #[test]
    fn decode_model_fields_default_to_none() {
        // A project-selection callback carries no model fields — they must be
        // None, not empty strings, so the select_model branch is not triggered.
        let event = json!({
            "event": { "action": { "value": { "action": "select_project", "chat_id": "oc_z", "project_token": "t" } } }
        });
        let a = decode_card_action(&event).expect("must decode");
        assert_eq!(a.model_provider, None);
        assert_eq!(a.model_id, None);
    }

    // ---------- extract_im_message ----------

    #[test]
    fn extract_message_parses_content_json_text() {
        let event = json!({
            "header": { "event_type": "im.message.receive_v1" },
            "event": { "message": {
                "chat_id": "oc_x",
                "content": "{\"text\": \"帮我修 bug\"}"
            } }
        });
        let (chat_id, text) = extract_im_message(&event).expect("message event");
        assert_eq!(chat_id, "oc_x");
        assert_eq!(text, "帮我修 bug");
    }

    #[test]
    fn extract_message_falls_back_to_raw_content_on_bad_json() {
        let event = json!({
            "header": { "event_type": "im.message.receive_v1" },
            "event": { "message": {
                "chat_id": "oc_y",
                "content": "not-json"
            } }
        });
        let (chat_id, text) = extract_im_message(&event).expect("message event");
        assert_eq!(chat_id, "oc_y");
        assert_eq!(text, "not-json");
    }

    #[test]
    fn extract_message_returns_none_for_non_message_event() {
        let event = json!({
            "header": { "event_type": "card.action.trigger" },
            "event": {}
        });
        assert!(extract_im_message(&event).is_none());
    }

    #[test]
    fn extract_message_returns_none_when_event_missing() {
        let event = json!({ "header": { "event_type": "im.message.receive_v1" } });
        assert!(extract_im_message(&event).is_none());
    }

    // ---------- extract_welcome_chat ----------

    #[test]
    fn welcome_chat_extracted_for_all_bot_entered_events() {
        for et in [
            "p2p_chat_create",
            "im.chat.access_event.bot_p2p_chat_entered_v1",
            "im.chat.member.bot.added_v1",
        ] {
            let event = json!({
                "header": { "event_type": et },
                "event": { "chat_id": "oc_new" }
            });
            assert_eq!(
                extract_welcome_chat(&event).as_deref(),
                Some("oc_new"),
                "event_type={et}"
            );
        }
    }

    #[test]
    fn welcome_chat_none_for_message_event_or_missing_chat_id() {
        let msg = json!({
            "header": { "event_type": "im.message.receive_v1" },
            "event": { "chat_id": "oc_x" }
        });
        assert!(extract_welcome_chat(&msg).is_none());
        let no_chat = json!({
            "header": { "event_type": "p2p_chat_create" },
            "event": {}
        });
        assert!(extract_welcome_chat(&no_chat).is_none());
    }

    // ---------- is_card_action_event ----------

    #[test]
    fn card_action_event_detected_from_event_type() {
        let ev = json!({
            "header": { "event_type": "card.action.trigger" },
            "event": { "action": { "value": { "action": "select_project" } } }
        });
        assert!(is_card_action_event(&ev));
    }

    #[test]
    fn card_action_event_false_for_message_and_welcome() {
        assert!(!is_card_action_event(&json!({
            "header": { "event_type": "im.message.receive_v1" },
            "event": {}
        })));
        assert!(!is_card_action_event(&json!({
            "header": { "event_type": "p2p_chat_create" },
            "event": {}
        })));
        // Missing header / event_type → never a card action.
        assert!(!is_card_action_event(&json!({ "event": {} })));
        assert!(!is_card_action_event(&json!({})));
    }

    // ---------- resolve_data_frame ----------

    #[test]
    fn resolve_ignores_non_event_card_type() {
        let mut cache = FrameCache::new();
        assert_eq!(
            resolve_data_frame("other", 1, 0, "", b"{}".to_vec(), &mut cache, "m"),
            DataFrameOutcome::Ignore
        );
    }

    #[test]
    fn resolve_single_frame_parses_event() {
        let mut cache = FrameCache::new();
        let payload = br#"{"event":{"message":{"chat_id":"oc"}}}"#.to_vec();
        match resolve_data_frame("event", 1, 0, "", payload, &mut cache, "m") {
            DataFrameOutcome::Event(v) => assert_eq!(v["event"]["message"]["chat_id"], "oc"),
            other => panic!("expected Event, got {:?}", other),
        }
    }

    #[test]
    fn resolve_single_frame_reports_parse_error() {
        let mut cache = FrameCache::new();
        assert_eq!(
            resolve_data_frame("card", 1, 0, "", b"not json".to_vec(), &mut cache, "m"),
            DataFrameOutcome::ParseError
        );
    }

    #[test]
    fn resolve_multi_frame_pending_until_complete() {
        let mut cache = FrameCache::new();
        // Two fragments that reassemble (by seq order) into a valid JSON object.
        // Integer value avoids the raw-string trailing-quote delimiter pitfall.
        let fragment1 = br##"1}"##.to_vec(); // seq=1
        assert_eq!(
            resolve_data_frame("card", 2, 1, "t", fragment1, &mut cache, "m"),
            DataFrameOutcome::Pending
        );
        let fragment0 = br##"{"a":"##.to_vec(); // seq=0
        match resolve_data_frame("card", 2, 0, "t", fragment0, &mut cache, "m") {
            DataFrameOutcome::Event(v) => assert_eq!(v["a"], 1),
            other => panic!("expected Event, got {:?}", other),
        }
    }

    // ---------- classify_control / parse_pong_interval ----------

    #[test]
    fn classify_control_frames() {
        assert_eq!(
            classify_control(&Some(MESSAGE_TYPE_PING.to_string())),
            ControlKind::Ping
        );
        assert_eq!(
            classify_control(&Some(MESSAGE_TYPE_PONG.to_string())),
            ControlKind::Pong
        );
        assert_eq!(
            classify_control(&Some(HEADER_KEY_HANDSHAKE_STATUS.to_string())),
            ControlKind::Handshake
        );
        assert_eq!(
            classify_control(&Some("weird".to_string())),
            ControlKind::Unknown
        );
        assert_eq!(classify_control(&None), ControlKind::Unknown);
    }

    #[test]
    fn parse_pong_interval_branches() {
        assert_eq!(parse_pong_interval(b""), None);
        assert_eq!(parse_pong_interval(b"not json"), None);
        assert_eq!(parse_pong_interval(b"{}"), None);
        assert_eq!(parse_pong_interval(br#"{"PingInterval":30}"#), Some(30));
    }

    // ---------- plan_card_action ----------

    fn plan(action: &str, reply: &str, list: Result<Vec<ProjectInfo>, String>) -> Vec<CardPlan> {
        plan_card_action(action, reply, list.as_deref())
    }

    #[test]
    fn plan_select_project_without_error_sends_text_and_control() {
        let out = plan("select_project", "已绑定", Ok(vec![]));
        assert_eq!(
            out,
            vec![
                CardPlan::SendText("已绑定".into()),
                CardPlan::SendControlCard
            ]
        );
    }

    #[test]
    fn plan_select_project_with_error_only_sends_text() {
        let out = plan("select_project", "❌ 失败", Ok(vec![]));
        assert_eq!(out, vec![CardPlan::SendText("❌ 失败".into())]);
    }

    #[test]
    fn plan_switch_project_ok_sends_selection_card() {
        let projects = vec![ProjectInfo {
            token: "t".into(),
            name: "p".into(),
        }];
        let out = plan("switch_project", "", Ok(projects.clone()));
        assert_eq!(out, vec![CardPlan::SendProjectSelectionCard(projects)]);
    }

    #[test]
    fn plan_switch_project_err_sends_failure_text() {
        let out = plan("switch_project", "", Err("boom".to_string()));
        assert_eq!(
            out,
            vec![CardPlan::SendText("❌ 获取项目列表失败: boom".into())]
        );
    }

    #[test]
    fn plan_other_action_with_reply_sends_text() {
        let out = plan("view_status", "状态ok", Ok(vec![]));
        assert_eq!(out, vec![CardPlan::SendText("状态ok".into())]);
    }

    #[test]
    fn plan_other_action_empty_reply_sends_nothing() {
        let out = plan("view_status", "", Ok(vec![]));
        assert!(out.is_empty());
    }

    // ---------- plan_text_dispatch ----------

    #[test]
    fn plan_text_dispatch_detects_marker_and_truncates() {
        let long = "中".repeat(6000);
        let result = format!("{}\n{}", NEEDS_PROJECT_MARKER, long);
        let plan = plan_text_dispatch(&result);
        assert!(plan.needs_project);
        assert!(plan.text.contains("已截断"));

        let plain = "普通回复";
        let p2 = plan_text_dispatch(plain);
        assert!(!p2.needs_project);
        assert_eq!(p2.text, plain);
    }

    // ---------- EventDedup ----------

    #[test]
    fn dedup_first_seen_is_new_then_duplicate_suppressed() {
        let mut d = EventDedup::new();
        assert!(d.seen("evt_1"), "first sighting must dispatch");
        assert!(!d.seen("evt_1"), "second sighting must be suppressed");
        // A different id is independent.
        assert!(d.seen("evt_2"), "different id is new");
        assert!(!d.seen("evt_2"));
    }

    #[test]
    fn dedup_entries_expire_after_ttl_window() {
        let mut d = EventDedup::new();
        assert!(d.seen("evt_x"));
        assert!(!d.seen("evt_x"));
        // Evict with a cutoff in the future → the entry is older → re-admitted.
        d.evict_older_than(Instant::now() + Duration::from_secs(1));
        assert!(d.seen("evt_x"), "id seen again after TTL eviction must dispatch");
    }

    #[test]
    fn dedup_eviction_keeps_recent_entries() {
        let mut d = EventDedup::new();
        assert!(d.seen("evt_recent"));
        // Cutoff in the past: the just-inserted entry is fresh and survives.
        d.evict_older_than(Instant::now() - Duration::from_secs(1));
        assert!(!d.seen("evt_recent"), "fresh entry is still considered seen");
    }

    // ---------- extract_event_id ----------

    #[test]
    fn extract_event_id_from_standard_envelope() {
        let ev = json!({
            "header": { "event_id": "evt_abc", "event_type": "im.message.receive_v1" },
            "event": { "message": { "content": "hi" } }
        });
        assert_eq!(extract_event_id(&ev).as_deref(), Some("evt_abc"));
    }

    #[test]
    fn extract_event_id_falls_back_to_none() {
        // No header, or header without event_id → never suppress (fail-open).
        assert_eq!(extract_event_id(&json!({ "event": {} })), None);
        assert_eq!(
            extract_event_id(&json!({ "header": { "event_type": "x" } })),
            None
        );
        assert_eq!(extract_event_id(&json!(null)), None);
    }

    // ---------- 并发时序正确性 ----------

    /// 模拟 at-least-once 投递：同一 event_id 在极短间隔内被多个 worker 并发处理。
    /// 不变量：无论并发度多高，业务派发（seen 返回 true）必须恰好发生一次。
    #[test]
    fn dedup_concurrent_same_event_id_dispatches_exactly_once() {
        let dedup = Arc::new(Mutex::new(EventDedup::new()));
        let event_id = "evt_concurrent";
        const WORKERS: usize = 16;
        const PER_WORKER: usize = 50;
        let mut handles = Vec::with_capacity(WORKERS);
        let dispatches = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        for _ in 0..WORKERS {
            let dedup = Arc::clone(&dedup);
            let dispatches = Arc::clone(&dispatches);
            handles.push(std::thread::spawn(move || {
                for _ in 0..PER_WORKER {
                    // 模拟真实飞书：每个投递都先判定去重再决定是否派发业务。
                    let should_dispatch = duo_utils::sync::lock(&dedup).seen(event_id);
                    if should_dispatch {
                        dispatches.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                    // 让出 CPU，制造线程交错，暴露潜在的数据竞争。
                    std::thread::yield_now();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(
            dispatches.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "concurrent at-least-once deliveries of one event_id must dispatch exactly once"
        );
    }

    /// P2-45: production uses the process-global table — a redelivered event
    /// after a reconnect must be suppressed, not re-dispatched. This asserts
    /// that policy at the type level: two "connections" (the same global
    /// table) see the first delivery only.
    #[test]
    fn dedup_survives_across_connections() {
        let conn_a = global_event_dedup();
        let conn_b = global_event_dedup();
        let event_id = format!("evt_reconnect_{}", std::process::id());

        assert!(duo_utils::sync::lock(conn_a).seen(&event_id));
        assert!(!duo_utils::sync::lock(conn_a).seen(&event_id));
        // The "new" connection shares the same table: the redelivery is
        // suppressed.
        assert!(!duo_utils::sync::lock(conn_b).seen(&event_id));
    }

    /// The primitive still supports isolated instances (used by tests and
    /// available if per-tenant tables are ever needed).
    #[test]
    fn dedup_instances_can_still_be_independent() {
        let conn_a = Arc::new(Mutex::new(EventDedup::new()));
        let conn_b = Arc::new(Mutex::new(EventDedup::new()));
        let event_id = "evt_reconnect";

        // 连接 A 多次收到（包括重连前的抖动重发）。
        assert!(duo_utils::sync::lock(&conn_a).seen(event_id));
        assert!(!duo_utils::sync::lock(&conn_a).seen(event_id));

        // 重连后连接 B 是全新实例：必须再次放行一次（飞书对该连接是新会话）。
        assert!(duo_utils::sync::lock(&conn_b).seen(event_id));
        assert!(!duo_utils::sync::lock(&conn_b).seen(event_id));

        // A 的后续重发仍被抑制（实例未被重置）。
        assert!(!duo_utils::sync::lock(&conn_a).seen(event_id));
    }

    /// 并发分片重组：多个 message_id 的分片同时写入同一个 FrameCache（飞书真实按
    /// seq 升序投递）。不变量：每个 message_id 重组出的 payload 必须完整、且与其它
    /// message_id 无交叉污染；并发只在「不同 message_id 交错到达」时发生（锁保护）。
    ///
    /// 分片 payload 为同一 JSON 字符串的连续字节切片（seq=0 为最前字节），合并后
    /// 必须还原出原始合法 JSON。
    #[test]
    fn frame_cache_concurrent_fragment_reassembly_is_isolated() {
        let cache = Arc::new(Mutex::new(FrameCache::new()));
        const MESSAGES: usize = 8;
        const FRAGMENTS: usize = 4; // sum = 4, seq 0..4
        // 原始 JSON 模板（每次迭代独立构造，避免跨线程 move）。
        let chunk_len = r#"{"event":"msg","seq":3,"ok":true}"#.len() / FRAGMENTS;
        let mut handles = Vec::with_capacity(MESSAGES);

        for m in 0..MESSAGES {
            let cache = Arc::clone(&cache);
            handles.push(std::thread::spawn(move || {
                let message_id = format!("msg_{m}");
                // 每个 message 用独立的 JSON（内容可相同，message_id 区分即可）。
                let full_json = r#"{"event":"msg","seq":3,"ok":true}"#.to_string();
                let mut completed: Option<DataFrameOutcome> = None;
                for seq in 0..FRAGMENTS {
                    let start = seq * chunk_len;
                    let end = if seq == FRAGMENTS - 1 {
                        full_json.len()
                    } else {
                        start + chunk_len
                    };
                    let payload = full_json.as_bytes()[start..end].to_vec();
                    let outcome = resolve_data_frame(
                        "event",
                        FRAGMENTS,
                        seq,
                        "trace",
                        payload,
                        &mut duo_utils::sync::lock(&cache),
                        &message_id,
                    );
                    if seq == FRAGMENTS - 1 {
                        completed = Some(outcome);
                    } else {
                        assert!(
                            matches!(outcome, DataFrameOutcome::Pending),
                            "incomplete frame must stay Pending"
                        );
                    }
                    std::thread::yield_now();
                }
                match completed.expect("last frame outcome captured") {
                    DataFrameOutcome::Event(v) => {
                        assert_eq!(
                            v,
                            serde_json::json!({"event":"msg","seq":3,"ok":true}),
                            "reassembly corrupted JSON for {message_id}"
                        );
                    }
                    other => panic!("expected complete Event for {message_id}, got {other:?}"),
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        // 所有 message_id 重组完毕，缓存应被 evict 清空（无残留 Pending）。
        let mut cache = duo_utils::sync::lock(&cache);
        cache.evict_expired();
        // 再次写入任意 message_id 不应读到任何旧残留（每个 message_id key 独立）。
        let probe = resolve_data_frame(
            "event",
            1,
            0,
            "trace",
            b"{\"k\":1}".to_vec(),
            &mut cache,
            "msg_0",
        );
        assert!(matches!(probe, DataFrameOutcome::Event(_)), "single-frame resolves immediately");
    }

    /// 乱序分片重组：单线程内 seq 乱序到达（网络抖动场景），验证缓存按 seq 槽位落位
    /// 而非按到达顺序，最后一帧补齐即得完整 Event（顺序无关）。
    #[test]
    fn frame_cache_out_of_order_reassembly_completes_on_last_fragment() {
        let mut cache = FrameCache::new();
        let message_id = "msg_ooo";
        let sum = 4usize;
        let full = r#"{"a":1,"b":2,"c":3}"#;
        let chunk = full.len() / sum;
        // 乱序：3,1,0,2
        let order = [3usize, 1, 0, 2];
        let mut final_outcome = None;
        for seq in order {
            let start = seq * chunk;
            let end = if seq == sum - 1 { full.len() } else { start + chunk };
            let payload = full.as_bytes()[start..end].to_vec();
            let outcome = resolve_data_frame(
                "event",
                sum,
                seq,
                "trace",
                payload,
                &mut cache,
                message_id,
            );
            // 只有最后到达（填满 buffer）的那一帧返回 Event。
            if matches!(outcome, DataFrameOutcome::Event(_)) {
                final_outcome = Some(outcome);
            } else {
                assert!(
                    matches!(outcome, DataFrameOutcome::Pending),
                    "non-final fragment must stay Pending"
                );
            }
        }
        match final_outcome.expect("reassembly must complete once all fragments arrive") {
            DataFrameOutcome::Event(v) => {
                assert_eq!(
                    v,
                    serde_json::json!({"a":1,"b":2,"c":3}),
                    "fragments must be concatenated by seq order into valid JSON"
                );
            }
            _ => panic!("expected Event on final fragment"),
        }
    }

    // ---------- 下游业务分支（纯逻辑核心） ----------

    /// `extract_im_message`：content 为嵌套 JSON 字符串时，提取其 `text` 字段。
    #[test]
    fn extract_im_message_nested_content_json() {
        let event = json!({
            "header": { "event_type": "im.message.receive_v1" },
            "event": {
                "message": {
                    "chat_id": "oc_x",
                    "content": "{\"text\":\"hello 世界\",\"foo\":1}"
                }
            }
        });
        assert_eq!(
            extract_im_message(&event),
            Some(("oc_x".to_string(), "hello 世界".to_string()))
        );
    }

    /// `extract_im_message`：content 非 JSON 时原样返回（不丢字符）。
    #[test]
    fn extract_im_message_raw_content_fallback() {
        let event = json!({
            "header": { "event_type": "im.message.receive_v1" },
            "event": {
                "message": {
                    "chat_id": "oc_y",
                    "content": "plain text without json"
                }
            }
        });
        assert_eq!(
            extract_im_message(&event),
            Some(("oc_y".to_string(), "plain text without json".to_string()))
        );
    }

    /// `decode_card_action`：飞书标准结构（action 在 event.action.value 下）正确提取。
    #[test]
    fn decode_card_action_nested_payload() {
        let event = json!({
            "header": { "event_type": "card.action.trigger" },
            "event": {
                "open_message_id": "om_1",
                "action": {
                    "value": {
                        "action": "select_project",
                        "project_token": "tok_a",
                        "chat_id": "oc_z"
                    },
                    "form_value": { "prompt_input": "my prompt" }
                }
            }
        });
        let a = decode_card_action(&event).expect("nested action parsed");
        assert_eq!(a.action, "select_project");
        assert_eq!(a.project_token.as_deref(), Some("tok_a"));
        assert_eq!(a.chat_id, "oc_z");
        assert_eq!(a.message_id.as_deref(), Some("om_1"));
        assert_eq!(a.prompt.as_deref(), Some("my prompt"));
    }

    /// `decode_card_action`：扁平结构（action.value 在顶层）正确提取。
    #[test]
    fn decode_card_action_flat_payload() {
        let event = json!({
            "header": { "event_type": "card.action.trigger" },
            "action": {
                "value": {
                    "action": "send",
                    "model_provider": "openai",
                    "model_id": "gpt"
                },
                "form_value": { "prompt_input": "do thing" }
            }
        });
        let a = decode_card_action(&event).expect("flat action parsed");
        assert_eq!(a.action, "send");
        assert_eq!(a.prompt.as_deref(), Some("do thing"));
        assert_eq!(a.model_provider.as_deref(), Some("openai"));
        assert_eq!(a.model_id.as_deref(), Some("gpt"));
    }

    /// `decode_card_action`：缺 action.value 时返回 None（不派发）。
    #[test]
    fn decode_card_action_none_when_no_action_value() {
        let no_value = json!({
            "header": { "event_type": "card.action.trigger" },
            "event": { "event": {} }
        });
        assert!(decode_card_action(&no_value).is_none());
        let no_action = json!({
            "header": { "event_type": "card.action.trigger" },
            "action": {}
        });
        assert!(decode_card_action(&no_action).is_none());
    }

    /// `plan_card_action` 三分支决策（自由函数核心）：
    /// select_project / switch_project / 其他。
    #[test]
    fn plan_card_action_three_branches() {
        let empty: &[crate::bridge::ProjectInfo] = &[];
        let fail = "boom".to_string();

        // 分支 1：select_project → SendText(reply) + 非失败则 SendControlCard
        assert_eq!(
            plan_card_action("select_project", "done", Ok(empty)),
            vec![CardPlan::SendText("done".into()), CardPlan::SendControlCard]
        );
        // 失败回复（含 ❌）不再追加控制卡片
        assert_eq!(
            plan_card_action("select_project", "❌ 失败", Ok(empty)),
            vec![CardPlan::SendText("❌ 失败".into())]
        );

        // 分支 2：switch_project → 项目列表成功则 SendProjectSelectionCard
        assert_eq!(
            plan_card_action("switch_project", "", Ok(empty)),
            vec![CardPlan::SendProjectSelectionCard(vec![])]
        );
        // 项目列表失败 → SendText(失败消息)
        assert_eq!(
            plan_card_action("switch_project", "", Err(&fail)),
            vec![CardPlan::SendText("❌ 获取项目列表失败: boom".into())]
        );

        // 分支 3：其他 action → 空 reply 返回空 vec，否则 SendText
        assert_eq!(plan_card_action("unknown", "", Ok(empty)), vec![]);
        assert_eq!(
            plan_card_action("send", "hi", Ok(empty)),
            vec![CardPlan::SendText("hi".into())]
        );
    }

    // ---------- 集成测试：本地 mock WS 服务端驱动 serve_connection ----------

    use async_trait::async_trait;
    use duo_types::common::{ClarificationResult, SuggestedMode};
    use tokio::sync::{broadcast, oneshot, RwLock};

    /// No-op bridge：所有业务调用立即返回，不发起真实网络请求，
    /// 用于验证 WS 协议层（收帧 → 解码 → ACK）而非业务逻辑本身。
    struct NoOpBridge;

    #[async_trait]
    impl crate::bridge::SmartLayerBridge for NoOpBridge {
        fn clarify_intent_result(&self, _text: &str) -> anyhow::Result<ClarificationResult> {
            Ok(ClarificationResult {
                intent_type: "chat".into(),
                confidence: 1.0,
                entities: vec![],
                ambiguities: vec![],
                suggested_mode: SuggestedMode::Chat,
            })
        }
        async fn execute_agent(&self, _prompt: &str) -> anyhow::Result<String> {
            Ok("noop".into())
        }
        fn set_llm_config(&self, _key: &str, _value: &str) {}
        fn is_llm_configured(&self) -> bool {
            true
        }
        fn subscribe_events(&self) -> broadcast::Receiver<crate::sse_bridge::SseEvent> {
            broadcast::channel(1).1
        }
    }

    /// 端到端验证：本地 mock WS 服务端推一个 event data frame，
    /// client 必须解码它并向服务端回 ACK（{"code":200}），随后服务端
    /// 关闭连接，client 的 `serve_connection` 应干净退出并返回 `Ok`。
    #[tokio::test]
    async fn serve_connection_event_frame_gets_acked_and_closes_cleanly() {
        // 1. 起本地 mock WS 服务端
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (ack_tx, mut ack_rx) = oneshot::channel::<()>();

        let server_handle = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();

            // 构造一个合法的 Feishu data frame（event 类型，payload 为 JSON 文本）
            let event = json!({
                "header": {
                    "event_id": "evt_integration_test",
                    "event_type": "im.message.receive_v1",
                    "create_time": "0"
                },
                "event": {
                    "message": {
                        "chat_id": "oc_integration_test",
                        "content": "{\"text\":\"hello\"}",
                        "message_type": "text"
                    }
                }
            });
            let frame = Frame {
                seq_id: 1,
                log_id: 1,
                service: 123,
                method: FRAME_TYPE_DATA,
                headers: vec![Header {
                    key: HEADER_KEY_TYPE.to_string(),
                    value: MESSAGE_TYPE_EVENT.to_string(),
                }],
                payload_encoding: "json".into(),
                payload_type: "event".into(),
                payload: event.to_string().into_bytes(),
                log_id_new: String::new(),
            };
            ws.send(Message::Binary(encode_frame(&frame))).await.unwrap();

            // 等待 client 回 ACK（data frame，payload 含 "code":200）
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
            let mut got_ack = false;
            while tokio::time::Instant::now() < deadline {
                match tokio::time::timeout(std::time::Duration::from_secs(2), ws.next()).await {
                    Ok(Some(Ok(Message::Binary(bytes)))) => {
                        if let Ok(ack) = decode_frame(&bytes) {
                            let payload = String::from_utf8_lossy(&ack.payload);
                            if payload.contains("\"code\":200") || payload.contains("\"code\": 200") {
                                got_ack = true;
                                let _ = ack_tx.send(());
                                break;
                            }
                        }
                    }
                    Ok(Some(Ok(Message::Ping(d)))) => {
                        let _ = ws.send(Message::Pong(d)).await;
                    }
                    Ok(Some(Ok(Message::Pong(_))))
                    | Ok(Some(Ok(Message::Text(_))))
                    | Ok(Some(Ok(Message::Frame(_)))) => {}
                    Ok(Some(Ok(Message::Close(_)))) => break,
                    Ok(Some(Err(_))) => break,
                    Ok(None) => break,
                    Err(_) => continue,
                }
            }
            // 关闭连接，让 client 的 serve_connection 正常退出
            let _ = ws.close(None).await;
            got_ack
        });

        // 2. 构造 client 并连接本地 mock 服务端
        let config = FeishuConfig {
            app_id: "test_app".into(),
            app_secret: "test_secret".into(),
            domain: "feishu".into(),
        };
        let api = crate::feishu::api::FeishuApiClient::new(config.clone());
        let bridge: Arc<dyn crate::bridge::SmartLayerBridge> = Arc::new(NoOpBridge);
        let shutdown = Arc::new(RwLock::new(false));
        let client = FeishuWsClient::new(
            config,
            api,
            bridge,
            shutdown,
            None,
        )
        .with_heartbeat_timeout(2);

        let (ws_client_stream, _resp) =
            tokio_tungstenite::connect_async(format!("ws://{}", addr))
                .await
                .expect("client should connect to local mock WS server");

        let conn_info = WsConnectionInfo::test_new(123, 1);
        let serve_handle = tokio::spawn(async move {
            client.serve_connection(ws_client_stream, &conn_info).await
        });

        // 3. 等待 ACK 收到（client 必须在 12s 内回 ACK）
        let ack_received = tokio::time::timeout(std::time::Duration::from_secs(12), &mut ack_rx)
            .await
            .expect("client should ACK the data frame within 12s")
            .is_ok();

        // 4. 等待 serve_connection 正常退出
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), serve_handle)
            .await
            .expect("serve_connection should finish after server close")
            .expect("join should not panic");
        assert!(
            result.is_ok(),
            "serve_connection must return Ok on clean server close"
        );
        assert!(ack_received, "client must ACK the inbound data frame");
        assert!(
            server_handle.await.unwrap(),
            "mock server should have observed the ACK"
        );
    }
}
