//! LLM client module — OpenAI-compatible API call layer.
//!
//! Re-exports [`LlmConfig`], [`LlmResponse`], [`TokenUsage`] from `duo_types`
//! and adds request/message types + the async [`call_llm`] function.
//!
//! # Retry behaviour
//!
//! [`call_llm`] retries transient failures (429, 5xx, quota errors like
//! Xunfei's `NotEnoughCvError`) with exponential backoff up to
//! [`max_attempts`] total attempts. Non-retryable errors (4xx client errors
//! except 429) fail immediately.

use std::pin::Pin;
use std::sync::OnceLock;

use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use tracing::Instrument;

use config_manager::feature_flags;
use duo_types::timeouts;
use prompt_template::PromptTemplate;
use security_design::sanitize::sanitize_tool_output;

/// Check if the given text contains any known context-window overflow keyword.
///
/// This is the single source of truth for overflow detection across all providers.
/// Merges the 4xx list (14 keywords, the most complete) with the 5xx additions.
/// Used by `is_retryable_error`, `call_llm_stream`, and `agent.rs` overflow detection.
///
/// Mirrors TS `OVERFLOW_PATTERNS` (packages/duoduo/src/provider/error.ts L8-31).
/// TS uses 22 regex patterns; Rust uses substring matching (`contains`) which
/// covers the same provider error messages. Patterns with `\d+` are matched
/// by their non-numeric prefix (e.g. `maximum prompt length is` matches
/// `maximum prompt length is 8192`).
pub fn is_context_overflow_error_text(text: &str) -> bool {
    let lower = text.to_lowercase();
    // Xunfei Spark
    lower.contains("range of input length")
        || lower.contains("input length should be")
        || lower.contains("invalidparameter") && lower.contains("range of input")
        || lower.contains("input token limit")
    // Generic fallback
        || lower.contains("context_length_exceeded")
        || lower.contains("context length exceeded")
    // OpenAI / OpenRouter / DeepSeek / vLLM
        || lower.contains("context window")
        || lower.contains("exceeds the context window")
        || lower.contains("maximum context length")
        || lower.contains("context length is only")
        || lower.contains("input length") && lower.contains("exceeds") && lower.contains("context length")
    // Anthropic
        || lower.contains("too many tokens")
        || lower.contains("prompt is too long")
        || lower.contains("reduce the length of the messages")
    // Groq / GitHub Copilot
        || lower.contains("token limit")
        || lower.contains("exceeds the limit of")
    // Amazon Bedrock
        || lower.contains("input is too long for requested model")
    // Google Gemini
        || lower.contains("input token count") && lower.contains("exceeds the maximum")
    // xAI Grok
        || lower.contains("maximum prompt length is")
    // llama.cpp
        || lower.contains("exceeds the available context size")
    // LM Studio
        || lower.contains("greater than the context length")
    // MiniMax
        || lower.contains("context window exceeds limit")
    // Kimi / Moonshot
        || lower.contains("exceeded model token limit")
    // HTTP 413
        || lower.contains("request entity too large")
    // Ollama
        || lower.contains("prompt too long") && lower.contains("exceeded") && lower.contains("context length")
    // Mistral
        || lower.contains("too large for model") && lower.contains("maximum context length")
    // z.ai
        || lower.contains("model_context_window_exceeded")
}

// ── Re-export from duo_types ────────────────────────────────────────

pub use duo_types::{LlmConfig, LlmResponse, TokenUsage, ToolCall, ToolChoice, ToolDefinition};

// ── Local types (OpenAI chat-completions request shape) ─────────────

/// Request body sent to an OpenAI-compatible `/chat/completions` endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[derive(Default)]
pub struct LlmRequest {
    pub model: String,
    pub messages: Vec<LlmMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    /// Tools available for the LLM to call (function calling).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<duo_types::ToolDefinition>>,
    /// Tool choice configuration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<duo_types::ToolChoice>,
    /// Response format for structured output (e.g. {"type":"json_schema","json_schema":{...}}).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<serde_json::Value>,
    /// Top-K sampling parameter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_k: Option<u32>,
    /// Top-P (nucleus) sampling parameter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
    /// Extra body fields merged into the request JSON (e.g. providerOptions).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_body: Option<serde_json::Value>,
}


/// A single message in the chat-completions conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmMessage {
    pub role: String, // "system" | "user" | "assistant" | "tool"
    pub content: String,
    /// Tool calls from the assistant (for multi-turn tool calling).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<duo_types::ToolCall>>,
    /// Tool call ID (for tool result messages).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Prompt-caching control (Anthropic `cache_control`, DeepSeek prefix cache, etc.).
    /// Forwarded as-is into the upstream request when present; `None` = no caching hint.
    /// Added so caching can actually reach the provider (previously dropped on the
    /// Rust path because it only lived in TS-side `providerOptions`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<serde_json::Value>,
    /// Reasoning chain content (DeepSeek Reasoner `reasoning_content`, OpenAI `reasoning`
    /// interleaved field, etc.). Forwarded as-is into the upstream request when present;
    /// `None` = no reasoning content. Lets the Rust path preserve and echo the model's
    /// thinking trace across multi-turn calls.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

impl LlmMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system".into(),
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            cache_control: None,
            reasoning_content: None,
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            cache_control: None,
            reasoning_content: None,
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: "assistant".into(),
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            cache_control: None,
            reasoning_content: None,
        }
    }

    /// Create an assistant message with tool calls.
    pub fn assistant_with_tool_calls(content: &str, tool_calls: &[duo_types::ToolCall]) -> Self {
        Self {
            role: "assistant".to_string(),
            content: content.to_string(),
            tool_calls: if tool_calls.is_empty() {
                None
            } else {
                Some(tool_calls.to_vec())
            },
            tool_call_id: None,
            cache_control: None,
            reasoning_content: None,
        }
    }

    /// Create a tool result message.
    pub fn tool_result(tool_call_id: &str, content: &str) -> Self {
        Self {
            role: "tool".to_string(),
            content: content.to_string(),
            tool_calls: None,
            tool_call_id: Some(tool_call_id.to_string()),
            cache_control: None,
            reasoning_content: None,
        }
    }
}

// ── Streaming types (SSE chunk shape) ────────────────────────────────

/// A chunk emitted during streaming LLM response.
#[derive(Debug)]
pub enum LlmStreamChunk {
    /// A thinking/reasoning content delta from the LLM (e.g. DeepSeek `reasoning_content`).
    Thinking { content: String },
    /// A content delta (partial text) from the LLM.
    Delta { content: String },
    /// The stream has completed. Carries the full assembled response.
    Done(LlmResponse),
    /// An error occurred during streaming.
    Error(unified_error::UnifiedError),
}

/// SSE chunk JSON shape for streaming responses.
#[derive(Debug, Clone, Deserialize)]
struct StreamChunk {
    choices: Vec<StreamChoice>,
    model: Option<String>,
    usage: Option<StreamUsage>,
}

#[derive(Debug, Clone, Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
    finish_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct StreamDelta {
    content: Option<String>,
    /// Reasoning/thinking content (DeepSeek/Qwen/Kimi use `reasoning_content`).
    #[serde(default, alias = "reasoning_text")]
    reasoning_content: Option<String>,
    /// Tool calls in streaming delta (OpenAI format: index-based incremental).
    #[serde(default)]
    tool_calls: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Deserialize)]
struct StreamUsage {
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
    total_tokens: Option<u32>,
    prompt_cache_hit_tokens: Option<u32>,
    prompt_cache_miss_tokens: Option<u32>,
    /// DeepSeek `usage.reasoning_tokens` (reported at stream end).
    #[serde(default)]
    reasoning_tokens: Option<u32>,
    /// OpenAI format: `prompt_tokens_details.cached_tokens`
    #[serde(default)]
    prompt_tokens_details: Option<StreamUsageDetails>,
    /// OpenAI format: `completion_tokens_details.reasoning_tokens`
    #[serde(default)]
    completion_tokens_details: Option<CompletionTokensDetails>,
}

#[derive(Debug, Clone, Deserialize)]
struct StreamUsageDetails {
    cached_tokens: Option<u32>,
}

/// OpenAI `completion_tokens_details` (carries `reasoning_tokens`).
#[derive(Debug, Clone, Deserialize, Default)]
struct CompletionTokensDetails {
    #[serde(default)]
    reasoning_tokens: Option<u32>,
}

// ── Raw JSON response shape (OpenAI chat-completions) ───────────────

/// Top-level wrapper returned by the API.
#[derive(Debug, Clone, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<Choice>,
    model: String,
    usage: Usage,
}

#[derive(Debug, Clone, Deserialize)]
struct Choice {
    message: ChoiceMessage,
    finish_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ChoiceMessage {
    content: Option<String>,
    /// Tool calls from the LLM response.
    #[serde(default)]
    tool_calls: Option<Vec<duo_types::ToolCall>>,
}

#[derive(Debug, Clone, Deserialize)]
struct Usage {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
    /// DeepSeek / OpenAI-compatible KV-cache accounting. `default` so providers
    /// that omit these fields (or name them differently) don't break parsing.
    #[serde(default)]
    prompt_cache_hit_tokens: u32,
    #[serde(default)]
    prompt_cache_miss_tokens: u32,
    /// DeepSeek `usage.reasoning_tokens`. `default` so providers that omit it
    /// don't break parsing.
    #[serde(default)]
    reasoning_tokens: u32,
}

// ── API error response shape ────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
struct ApiErrorResponse {
    error: Option<ApiError>,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiError {
    message: Option<String>,
    #[allow(dead_code)]
    r#type: Option<String>,
    #[allow(dead_code)]
    code: Option<String>,
}

// ── Public API ──────────────────────────────────────────────────────

/// Shared HTTP client for LLM API calls.
/// Created once and reused across all calls for connection pooling and TLS session reuse.
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn get_http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // Overall request timeout — includes connect + write + read.
            .timeout(timeouts::LLM_REQUEST_TIMEOUT)
            // Connection-phase timeout — fail fast if the endpoint is unreachable
            // instead of blocking for the OS-default (often 120+ seconds).
            .connect_timeout(timeouts::LLM_CONNECT_TIMEOUT)
            // Evict idle connections after 90s so dead connections (dropped by
            // NAT/firewall during long runs) are never reused.
            .pool_idle_timeout(timeouts::LLM_POOL_IDLE_TIMEOUT)
            // Max idle connections per host — keep the pool small to reduce
            // the chance of picking a stale connection.
            .pool_max_idle_per_host(timeouts::LLM_POOL_MAX_IDLE_PER_HOST)
            // TCP keepalive probes every 30s — detect dead connections early
            // instead of waiting for the OS TCP timeout (typically 2+ hours).
            .tcp_keepalive(timeouts::LLM_TCP_KEEPALIVE)
            .build()
            .expect("Failed to build HTTP client for LLM requests")
    })
}

/// Shared HTTP client for **streaming** LLM API calls.
///
/// Uses `read_timeout` (per-chunk) instead of a flat `timeout` so that
/// long-running streams stay alive as long as chunks keep arriving.
///
/// Connection health is ensured via:
/// - `connect_timeout`: fail fast on unreachable endpoints
/// - `pool_idle_timeout`: evict stale connections that may have been
///   silently dropped by NAT/firewall during long-running sessions
/// - `tcp_keepalive`: detect dead connections proactively
/// - `timeout`: overall upper bound (5 min) as a safety net so a stream
///   that never delivers any chunk cannot hang indefinitely
static HTTP_CLIENT_STREAM: OnceLock<reqwest::Client> = OnceLock::new();

fn get_http_client_stream() -> &'static reqwest::Client {
    HTTP_CLIENT_STREAM.get_or_init(|| {
        reqwest::Client::builder()
            // Per-chunk idle timeout — if no SSE chunk arrives within 120s,
            // the stream is considered dead and the read is terminated.
            .read_timeout(timeouts::LLM_STREAM_READ_TIMEOUT)
            // Connection-phase timeout — fail fast on unreachable endpoints.
            .connect_timeout(timeouts::LLM_CONNECT_TIMEOUT)
            // Overall request timeout (safety net). 5 min is generous for
            // streaming — normal streams produce chunks every few seconds.
            // This prevents indefinite hangs when the server never sends
            // any data at all (e.g. dead connection reused from pool).
            .timeout(timeouts::LLM_STREAM_TIMEOUT)
            // Evict idle connections after 90s — prevents reuse of connections
            // silently dropped by NAT/firewall during 1-2h sessions.
            .pool_idle_timeout(timeouts::LLM_POOL_IDLE_TIMEOUT)
            .pool_max_idle_per_host(timeouts::LLM_POOL_MAX_IDLE_PER_HOST)
            // TCP keepalive every 30s — proactively detect dead connections.
            .tcp_keepalive(timeouts::LLM_TCP_KEEPALIVE)
            .build()
            .expect("Failed to build streaming HTTP client for LLM requests")
    })
}

/// Classify an HTTP status code and response body as retryable or not.
///
/// Retryable conditions:
///   - HTTP 429 (rate limited)
///   - HTTP 5xx (server error)
///   - Body contains known quota/token errors (Xunfei NotEnoughCvError, code 11210, etc.)
fn is_retryable_error(status: reqwest::StatusCode, body: &[u8]) -> bool {
    let code = status.as_u16();

    // 429 Too Many Requests is always retryable
    if code == 429 {
        return true;
    }

    // 408 Request Timeout is retryable
    if code == 408 {
        return true;
    }

    // 5xx server errors are transient, but check body for known non-retryable signals
    if code >= 500 {
        if let Ok(text) = std::str::from_utf8(body) {
            let lower = text.to_lowercase();
            // Authentication/authorization errors in 5xx body are not retryable
            if lower.contains("invalid_api_key")
                || lower.contains("invalid_api_key_error")
                || lower.contains("authentication_error")
                || lower.contains("permission_denied")
            {
                return false;
            }
            // Context overflow in 5xx body is also not retryable — the same
            // request would fail again; the caller must compress before retrying.
            if is_context_overflow_error_text(text) {
                return false;
            }
        }
        return true;
    }

    // 4xx (non-429/408): only retry for specific transient quota/overload patterns
    // that some providers incorrectly return as 4xx.
    //
    // P2-1: HTTP 402 Payment Required is a HARD billing failure (OpenAI's
    // insufficient_quota arrives as 402). Retrying burns requests with zero
    // chance of success. Transient quota providers (Xunfei) surface their
    // retryable quota errors via 429 or body keywords on non-402 codes, which
    // are unaffected by this gate.
    if code == 402 {
        return false;
    }

    if let Ok(text) = std::str::from_utf8(body) {
        let lower = text.to_lowercase();
        // Context window overflow errors — these are deterministic: the same
        // request will always fail. The caller must compress messages before retrying.
        let is_context_overflow = is_context_overflow_error_text(text);

        if is_context_overflow {
            return false;
        }

        if lower.contains("notenoughcv")
            || lower.contains("not enough cv")
            || lower.contains("11210")
            || lower.contains("10010")
            || lower.contains("10012") // Xunfei: when NOT accompanied by overflow keywords, this is an engine internal error (retryable). When combined with "range of input length" / "invalidparameter", it is caught as context overflow above (non-retryable).
            || lower.contains("10050") // Xunfei: engine internal error (retryable) unless accompanied by context overflow keywords above.
            || lower.contains("engineinternalerror")
            || lower.contains("recvfromengineerror")
            || lower.contains("engine busy")
            || lower.contains("system is busy")
            || lower.contains("try again later")
            || lower.contains("tokens.total")
            || lower.contains("business.total")
            || lower.contains("insufficient_quota")
            || lower.contains("capacity_exceeded")
            || lower.contains("rate_limit")
            || lower.contains("too many requests")
            || lower.contains("overloaded")
        {
            return true;
        }
    }

    false
}

/// Compute the delay for a given retry attempt (0-indexed) using exponential backoff.
fn retry_delay_ms(attempt: u32) -> u64 {
    let delay =
        timeouts::RETRY_INITIAL_DELAY_MS * (timeouts::RETRY_BACKOFF_FACTOR as u64).pow(attempt);
    delay.min(timeouts::RETRY_MAX_DELAY_MS)
}

/// Whether this status represents provider backpressure (quota / rate limiting)
/// rather than a generic transient failure.
fn is_rate_limited(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 429 | 503)
}

/// Delay for a rate-limited attempt: `RATE_LIMIT_RETRY_INITIAL_DELAY_MS` doubled
/// per attempt, capped at `RETRY_MAX_DELAY_MS` (5s → 10s → 20s …). Callers prefer
/// an upstream `Retry-After` hint when the provider supplied one.
fn rate_limit_delay_ms(attempt: u32) -> u64 {
    let delay = timeouts::RATE_LIMIT_RETRY_INITIAL_DELAY_MS
        * (timeouts::RETRY_BACKOFF_FACTOR as u64).pow(attempt);
    delay.min(timeouts::RETRY_MAX_DELAY_MS)
}

/// The retry decision for a failed attempt: `(total attempts allowed, sleep ms
/// before the next one)`.
///
/// Single source of truth for EVERY retry site in this module. Keeping budget
/// and delay in one function is what prevents a new error class from being
/// plumbed into some call sites and silently missed in others.
///
/// `status` is `None` for transport-level failures (no HTTP response at all);
/// those always use the generic ladder.
///
/// Rate-limited responses (429 / 503) get a wider ladder because provider quota
/// windows (TPM/RPM) reset on the order of tens of seconds, which the short
/// generic ladder cannot outlast:
///   - budget is `max(max_attempts, RATE_LIMIT_MAX_ATTEMPTS)` — never *lower*
///     than the caller's configured budget, so raising `max_retry_attempts` is
///     not silently downgraded for the responses that need retries the most;
///   - delay starts at `RATE_LIMIT_RETRY_INITIAL_DELAY_MS` and doubles,
///     preferring an upstream `Retry-After` hint when present.
///
/// The hint is capped at `RETRY_MAX_DELAY_MS`: a gateway may advertise a window
/// far longer than the per-call budget (e.g. `Retry-After: 3600`), and sleeping
/// that out verbatim would overrun `ROUND_TIMEOUT` / `LLM_STREAM_TIMEOUT` and
/// surface to the user as a timeout instead of a rate-limit error.
fn retry_policy(
    status: Option<reqwest::StatusCode>,
    attempt: u32,
    max_attempts: u32,
    retry_after: Option<u64>,
) -> (u32, u64) {
    if !status.is_some_and(is_rate_limited) {
        return (max_attempts, retry_delay_ms(attempt));
    }
    let budget = max_attempts.max(timeouts::RATE_LIMIT_MAX_ATTEMPTS);
    let delay = retry_after
        .unwrap_or_else(|| rate_limit_delay_ms(attempt))
        .min(timeouts::RETRY_MAX_DELAY_MS);
    (budget, delay)
}

/// Parse an upstream `Retry-After` header into milliseconds.
///
/// Honors the delta-seconds form (`Retry-After: 30` → 30_000 ms), which is what
/// every major LLM provider emits. HTTP-date form is intentionally not parsed
/// here: it is effectively never sent by LLM gateways, and supporting it would
/// require an extra `httpdate` dependency. When the header is absent or
/// unparseable this returns `None`, and the TS retry layer falls back to its own
/// exponential backoff — identical to the prior behavior.
fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    value.parse::<u64>().ok().map(|secs| secs.saturating_mul(1000))
}

/// Recursively iterate through a JSON value to ensure object keys are traversed.
/// The current `serde_json::json!` macro already produces `BTreeMap`-ordered
/// output, so this function is a **no-op safety net** for future scenarios
/// where tool definitions may come from non-deterministic sources.
fn ensure_sorted_json_keys(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (_, v) in map.iter_mut() {
                ensure_sorted_json_keys(v);
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr.iter_mut() {
                ensure_sorted_json_keys(v);
            }
        }
        _ => {}
    }
}

/// Env-driven LLM request overrides for benchmark parity experiments.
///
/// - `DUODUO_LLM_TEMPERATURE`: when parseable as f32, overrides the hardcoded
///   loop temperature (e.g. "0" aligns duoduo with SWE-agent baseline runs).
/// - `DUODUO_LLM_EXTRA_BODY`: when a valid JSON object, its top-level keys are
///   merged into the outgoing API request body root (e.g.
///   `{"reasoning_effort":"none"}` disables DeepSeek's default thinking).
///
/// Returns `(temperature_override, extra_body)`; both `None` when the env vars
/// are unset/invalid, leaving default behaviour untouched.
pub fn env_llm_overrides() -> (Option<f32>, Option<serde_json::Value>) {
    let temp = std::env::var("DUODUO_LLM_TEMPERATURE")
        .ok()
        .and_then(|s| s.trim().parse::<f32>().ok())
        .filter(|t| (0.0..=2.0).contains(t));
    let extra = std::env::var("DUODUO_LLM_EXTRA_BODY")
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .filter(|v| v.is_object());
    if std::env::var_os("DUODUO_LLM_EXTRA_BODY").is_some() && extra.is_none() {
        tracing::warn!("DUODUO_LLM_EXTRA_BODY is set but not a valid JSON object, ignored");
    }
    (temp, extra)
}

/// Serialize an [`LlmRequest`] into a JSON value, merging `extra_body` fields
/// at the root level so provider-specific options (e.g. Anthropic `thinking`)
/// appear as top-level keys. The `extra_body` wrapper key itself is stripped.
fn build_request_json(request: &LlmRequest) -> serde_json::Value {
    // Security: mask secrets in tool-result content before it leaves for the
    // external LLM API. Only `role == "tool"` messages are sanitized; user /
    // assistant / system text is left intact. We clone the request so the
    // in-memory copy (used by loop logic and UI display) keeps the original.
    let mut sanitized = request.clone();
    for msg in &mut sanitized.messages {
        if msg.role == "tool" {
            // Mask secrets, then wrap in a data-only fence so injected
            // instructions inside tool output (e.g. fetched web pages) cannot
            // impersonate system/user directives. Only `<`, `>`, `&` are escaped
            // so JSON/code in tool results stays parseable by the model.
            let masked = sanitize_tool_output(&msg.content);
            msg.content = format!("<duoduo_tool_output>\n{}\n</duoduo_tool_output>", PromptTemplate::escape_xml_meta(&masked));
        }
    }

    let mut json = serde_json::to_value(&sanitized)
        .unwrap_or_else(|_| serde_json::json!({"model": &sanitized.model, "messages": []}));
    if let Some(obj) = json.as_object_mut()
        && let Some(extra) = obj.remove("extra_body")
            && let Some(extra_obj) = extra.as_object() {
                for (k, v) in extra_obj {
                    obj.entry(k.clone()).or_insert(v.clone());
                }
            }
    json
}

/// Send a chat-completion request to an OpenAI-compatible LLM endpoint.
///
/// `api_url` — full endpoint URL (e.g. `http://localhost:11434/v1/chat/completions`).
/// `api_key` — optional bearer token; when `None` the Authorization header is omitted.
///
/// # Retry behaviour
///
/// Transient errors (429, 5xx, quota/token exhaustion) are automatically retried
/// with exponential backoff up to [`max_attempts`] total attempts. Non-retryable errors
/// (4xx client errors except 429) fail immediately without retrying.
///
/// # Errors
/// - Returns an error if the API is unreachable or the request times out after all retries.
/// - Returns a descriptive error for non-2xx responses that are not retryable.
/// - Returns an error if the response body cannot be parsed.
pub async fn call_llm(
    api_url: &str,
    api_key: Option<&str>,
    request: &LlmRequest,
    cancel_token: tokio_util::sync::CancellationToken,
    max_attempts: u32,
) -> Result<LlmResponse, unified_error::UnifiedError> {
    let client = get_http_client();
    let call_start = std::time::Instant::now();

    let mut last_error: Option<unified_error::UnifiedError> = None;
    // Latest upstream `Retry-After` hint (ms), captured from the most recent
    // retryable HTTP response. Carried out of `call_llm` via `UnifiedError::RateLimited`
    // so the TS retry layer converges on the provider's suggested backoff instead
    // of guessing its own delay — closing the full-chain timing loop.
    let mut last_retry_after_ms: Option<u64> = None;

    for attempt in 0..max_attempts.max(timeouts::RATE_LIMIT_MAX_ATTEMPTS) {
        tracing::info!(
            attempt,
            model = %request.model,
            url = %api_url,
            "Sending LLM API request..."
        );

        // Build request JSON with extra_body merged at root level
        let mut req_json = build_request_json(request);

        // Canonicalize tool parameter JSON keys (no-op safety net)
        if feature_flags::canonicalize_tools()
            && let Some(tools) = req_json.get_mut("tools").and_then(|t| t.as_array_mut()) {
                for tool in tools.iter_mut() {
                    if let Some(params) = tool
                        .get_mut("function")
                        .and_then(|f| f.get_mut("parameters"))
                    {
                        ensure_sorted_json_keys(params);
                    }
                }
            }

        let mut http_req = client.post(api_url).json(&req_json);

        if let Some(key) = api_key
            && !key.is_empty() {
                http_req = http_req.bearer_auth(key);
            }

        // Cancelable send (G10): abort the in-flight HTTP request when the loop's
        // cancellation token is triggered. Without this, `.send()` blocks until the
        // server responds even after the run was cancelled.
        let resp = match tokio::select! {
            r = http_req.send() => r,
            _ = cancel_token.cancelled() => {
                return Err(unified_error::UnifiedError::LlmApi {
                    message: "LLM request cancelled".to_string(),
                    status_code: None,
                    retryable: false,
                });
            }
        } {
            Ok(r) => r,
            Err(e) => {
                // Network-level error — retryable
                last_error = Some(unified_error::UnifiedError::Unavailable(format!(
                    "Failed to reach LLM API at {}: {} (elapsed: {}s)",
                    api_url,
                    e,
                    call_start.elapsed().as_secs()
                )));
                let (budget, delay) = retry_policy(None, attempt, max_attempts, None);
                if attempt + 1 < budget {
                    tracing::warn!(
                        attempt,
                        delay_ms = delay,
                        elapsed_secs = call_start.elapsed().as_secs(),
                        "LLM request failed (network), retrying..."
                    );
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_millis(delay)) => {}
                        _ = cancel_token.cancelled() => {
                            return Err(unified_error::UnifiedError::LlmApi {
                                message: "LLM request cancelled during retry delay".to_string(),
                                status_code: None,
                                retryable: false,
                            });
                        }
                    }
                    continue;
                }
                break;
            }
        };

        let status = resp.status();
        tracing::info!(
            attempt,
            status = status.as_u16(),
            elapsed_secs = call_start.elapsed().as_secs(),
            "LLM API response status received"
        );
        // Read the Retry-After hint before `resp.bytes()` moves `resp`.
        let retry_after = parse_retry_after(resp.headers());
        let body_bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(e) => {
                last_error = Some(unified_error::UnifiedError::LlmApi {
                    message: format!("Failed to read LLM API response body: {}", e),
                    status_code: Some(status.as_u16()),
                    retryable: true,
                });
                let (budget, delay) = retry_policy(Some(status), attempt, max_attempts, retry_after);
                if attempt + 1 < budget && is_retryable_error(status, &[]) {
                    tracing::warn!(
                        attempt,
                        delay_ms = delay,
                        "Failed to read response body, retrying..."
                    );
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_millis(delay)) => {}
                        _ = cancel_token.cancelled() => {
                            return Err(unified_error::UnifiedError::LlmApi {
                                message: "LLM request cancelled during retry delay".to_string(),
                                status_code: None,
                                retryable: false,
                            });
                        }
                    }
                    continue;
                }
                break;
            }
        };

        if !status.is_success() {
            // Emit the raw response body so operators can see the provider's
            // actual rejection reason. Some providers (e.g. xunfei) return a
            // non-standard body on 403 that `ApiErrorResponse` cannot parse, so
            // it would otherwise be collapsed to the generic "Forbidden". The
            // body is server-side text (not client secrets) and is truncated by
            // character count (not byte slice) to avoid UTF-8 boundary panics and
            // log flooding. Recorded via tracing so it lands in the on-disk log
            // file regardless of whether the error is subsequently retried.
            let raw = String::from_utf8_lossy(&body_bytes);
            let total_chars = raw.chars().count();
            let truncated = if total_chars > 1024 {
                format!(
                    "{}…[truncated, total {} chars]",
                    raw.chars().take(1024).collect::<String>(),
                    total_chars
                )
            } else {
                raw.into_owned()
            };
            tracing::warn!(
                attempt,
                status = status.as_u16(),
                response_body = %truncated,
                "LLM API returned non-success status; raw response body below"
            );

            // Attempt to extract a human-readable error from the API response.
            let detail = serde_json::from_slice::<ApiErrorResponse>(&body_bytes)
                .ok()
                .and_then(|e| e.error)
                .and_then(|e| e.message)
                .unwrap_or_else(|| {
                    status
                        .canonical_reason()
                        .unwrap_or("Unknown error")
                        .to_string()
                });

            // P2-1: status-specific user guidance — a bare status code gives
            // the user no path to fix the underlying problem (bad key vs.
            // empty balance vs. no model access). The detail is appended so
            // no information is lost.
            let status_num = status.as_u16();
            let guidance = match status_num {
                401 => "——API Key 无效或已过期，请在设置中重新配置",
                402 => "——账户余额不足，请前往服务商充值",
                403 => "——无权访问该模型，请检查 Key 权限或模型名称",
                _ => "",
            };
            let error_msg = format!(
                "LLM API returned HTTP {}{}: {}",
                status_num, guidance, detail
            );

            // Capture the upstream Retry-After hint (if any) on every retryable
            // HTTP response. Only overwrite when present, so a later 5xx without a
            // hint does not clobber a prior 429's `Retry-After` (the final error keeps
            // the most recent explicit hint).
            if is_retryable_error(status, &body_bytes)
                && let Some(delay) = retry_after {
                    // P2-2: cap the hint handed to TS at 60s — an absurd
                    // upstream `Retry-After` must not schedule a days-later
                    // retry on the TS side (which caps at the same value).
                    last_retry_after_ms = Some(delay.min(60_000));
                }

            let (budget, delay) = retry_policy(Some(status), attempt, max_attempts, retry_after);
            if is_retryable_error(status, &body_bytes) && attempt + 1 < budget {
                tracing::warn!(
                    attempt,
                    delay_ms = delay,
                    status = status.as_u16(),
                    elapsed_secs = call_start.elapsed().as_secs(),
                    "LLM API returned retryable error, retrying..."
                );
                last_error = Some(unified_error::UnifiedError::LlmApi {
                    message: error_msg,
                    status_code: Some(status.as_u16()),
                    retryable: true,
                });
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_millis(delay)) => {}
                    _ = cancel_token.cancelled() => {
                        return Err(unified_error::UnifiedError::LlmApi {
                            message: "LLM request cancelled during retry delay".to_string(),
                            status_code: None,
                            retryable: false,
                        });
                    }
                }
                continue;
            }

            // Non-retryable or exhausted retries. When the provider supplied a
            // Retry-After hint on a retryable failure, surface it as `RateLimited`
            // so the TS retry layer honors the suggested backoff (full-chain time
            // consistency) rather than starting its own 2s exponential curve.
            let retryable = is_retryable_error(status, &body_bytes);
            let final_err = match (last_retry_after_ms, retryable) {
                (Some(delay), true) => unified_error::UnifiedError::RateLimited {
                    message: error_msg,
                    retry_after_ms: Some(delay),
                },
                _ => unified_error::UnifiedError::LlmApi {
                    message: error_msg,
                    status_code: Some(status.as_u16()),
                    retryable,
                },
            };
            // Silent degradation for models that reject the thinking/reasoning
            // parameter: strip `reasoning_effort` from extra_body and retry once.
            // Triggered only on HTTP 400 whose body mentions reasoning/thinking/
            // parameter — every other error path is unaffected.
            if is_thinking_param_error(&final_err)
                && let Some(obj) = request.extra_body.as_ref().and_then(|v| v.as_object())
                    && obj.contains_key("reasoning_effort") {
                        let mut nb = obj.clone();
                        nb.remove("reasoning_effort");
                        let mut nb_req = request.clone();
                        nb_req.extra_body =
                            if nb.is_empty() { None } else { Some(serde_json::Value::Object(nb)) };
                        tracing::warn!(
                            model = %request.model,
                            "Model rejected reasoning_effort; retrying without thinking mode"
                        );
                        return Box::pin(call_llm(
                            api_url,
                            api_key,
                            &nb_req,
                            cancel_token,
                            max_attempts,
                        ))
                        .await;
                    }
            return Err(final_err);
        }

        let chat_resp: ChatCompletionResponse = match serde_json::from_slice(&body_bytes) {
            Ok(r) => r,
            Err(e) => {
                // Parse failure — not retryable
                return Err(unified_error::UnifiedError::LlmApi {
                    message: format!(
                        "Failed to parse LLM API response as chat-completion JSON ({} bytes): {}",
                        body_bytes.len(),
                        e
                    ),
                    status_code: None,
                    retryable: false,
                });
            }
        };

        let content = chat_resp
            .choices
            .first()
            .and_then(|c| c.message.content.clone())
            .ok_or_else(|| unified_error::UnifiedError::LlmApi {
                message: "LLM API returned no content in choices".to_string(),
                status_code: None,
                retryable: false,
            })?;

        let finish_reason = chat_resp
            .choices
            .first()
            .and_then(|c| c.finish_reason.clone());

        tracing::info!(
            elapsed_ms = call_start.elapsed().as_millis() as u64,
            model = %chat_resp.model,
            prompt_tokens = chat_resp.usage.prompt_tokens,
            completion_tokens = chat_resp.usage.completion_tokens,
            total_tokens = chat_resp.usage.total_tokens,
            "LLM API response received successfully"
        );

        return Ok(LlmResponse {
            content,
            reasoning_content: None, // Non-streaming path: reasoning content is not separately tracked
            model_id: Some(chat_resp.model),
            token_usage: TokenUsage {
                prompt_tokens: chat_resp.usage.prompt_tokens,
                completion_tokens: chat_resp.usage.completion_tokens,
                total_tokens: chat_resp.usage.total_tokens,
                prompt_cache_hit_tokens: Some(chat_resp.usage.prompt_cache_hit_tokens),
                prompt_cache_miss_tokens: Some(chat_resp.usage.prompt_cache_miss_tokens),
                reasoning_tokens: if chat_resp.usage.reasoning_tokens > 0 {
                    Some(chat_resp.usage.reasoning_tokens)
                } else {
                    None
                },
            },
            finish_reason,
            tool_calls: chat_resp
                .choices
                .first()
                .and_then(|c| c.message.tool_calls.clone()),
        });
    }

    // All retries exhausted — return the last recorded error
    Err(
        last_error.unwrap_or_else(|| unified_error::UnifiedError::LlmApi {
            message: format!(
                "LLM request failed after {} attempts (elapsed: {}s)",
                max_attempts,
                call_start.elapsed().as_secs()
            ),
            status_code: None,
            retryable: true,
        }),
    )
}

/// [LLM-05] Decide whether an error from the current model justifies switching
/// to a fallback model.
///
/// Fallback triggers:
/// - `Unavailable` (network unreachable after all retries)
/// - `LlmApi { retryable: true }` (429/5xx/quota exhausted after all retries)
/// - Model-not-found style rejections: HTTP 404, or 400/403 whose message
///   mentions "model" (providers reject unknown model IDs this way)
///
/// Never falls back on: cancellation, context-window overflow (handled by the
/// caller's compression loop — a different model would not fix an oversized
/// prompt deterministically), or other non-retryable client errors (e.g. 401
/// auth failures would fail identically on every model).
fn should_fallback_model(err: &unified_error::UnifiedError) -> bool {
    match err {
        unified_error::UnifiedError::Unavailable(_) => true,
        unified_error::UnifiedError::LlmApi {
            message,
            status_code,
            retryable,
        } => {
            let lower = message.to_lowercase();
            if lower.contains("cancelled") || lower.contains("context window overflow") {
                return false;
            }
            if *retryable {
                return true;
            }
            // P2-3: a 400/403 from the PRIMARY model often means THAT model
            // cannot serve the request (e.g. tools incompatible, no access) —
            // exactly the situation a fallback exists for. The old
            // message-contains-"model" requirement broke the chain for the
            // most common fallback trigger. cancelled / context overflow are
            // still excluded above (switching models cannot fix either).
            matches!(status_code, Some(400) | Some(403) | Some(404))
        }
        _ => false,
    }
}

/// Returns true when the error is an HTTP 400 whose body indicates the provider
/// rejected the `reasoning_effort` (thinking) parameter. Used to silently
/// degrade: on such models we retry once with `reasoning_effort` stripped.
fn is_thinking_param_error(err: &unified_error::UnifiedError) -> bool {
    if let unified_error::UnifiedError::LlmApi {
        message,
        status_code,
        ..
    } = err
        && *status_code == Some(400) {
            let lower = message.to_lowercase();
            return lower.contains("reasoning")
                || lower.contains("thinking")
                || lower.contains("parameter")
                || lower.contains("invalid");
        }
    false
}

/// [LLM-05] Like [`call_llm`], but when the primary model is unavailable
/// (see [`should_fallback_model`]) each model in `fallback_models` is tried
/// in order against the same endpoint/key. Empty list ⇒ identical to
/// [`call_llm`].
pub async fn call_llm_with_fallback(
    api_url: &str,
    api_key: Option<&str>,
    request: &LlmRequest,
    cancel_token: tokio_util::sync::CancellationToken,
    max_attempts: u32,
    fallback_models: &[String],
) -> Result<LlmResponse, unified_error::UnifiedError> {
    let primary_err =
        match call_llm(api_url, api_key, request, cancel_token.clone(), max_attempts).await {
            Ok(resp) => return Ok(resp),
            Err(e) => e,
        };
    if fallback_models.is_empty()
        || cancel_token.is_cancelled()
        || !should_fallback_model(&primary_err)
    {
        return Err(primary_err);
    }
    let mut last_err = primary_err;
    for fb_model in fallback_models {
        if fb_model == &request.model {
            continue; // Skip a fallback identical to the model that just failed.
        }
        if cancel_token.is_cancelled() {
            return Err(last_err);
        }
        tracing::warn!(
            primary = %request.model,
            fallback = %fb_model,
            error = %last_err,
            "[LLM-05] Primary model unavailable — falling back to next model"
        );
        let mut fb_req = request.clone();
        fb_req.model = fb_model.clone();
        match call_llm(api_url, api_key, &fb_req, cancel_token.clone(), max_attempts).await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                if !should_fallback_model(&e) {
                    return Err(e);
                }
                last_err = e;
            }
        }
    }
    Err(last_err)
}

/// [LLM-05] Like [`call_llm_stream`], but with cross-model fallback for the
/// connection-establishment phase (mid-stream errors after a successful
/// connection are surfaced as `LlmStreamChunk::Error`, unchanged).
pub async fn call_llm_stream_with_fallback(
    api_url: &str,
    api_key: Option<&str>,
    request: &LlmRequest,
    cancel_token: CancellationToken,
    max_attempts: u32,
    fallback_models: &[String],
) -> Result<Pin<Box<dyn Stream<Item = LlmStreamChunk> + Send>>, unified_error::UnifiedError> {
    let primary_err = match call_llm_stream(
        api_url,
        api_key,
        request,
        cancel_token.clone(),
        max_attempts,
    )
    .await
    {
        Ok(stream) => return Ok(stream),
        Err(e) => e,
    };
    if fallback_models.is_empty()
        || cancel_token.is_cancelled()
        || !should_fallback_model(&primary_err)
    {
        return Err(primary_err);
    }
    let mut last_err = primary_err;
    for fb_model in fallback_models {
        if fb_model == &request.model {
            continue;
        }
        if cancel_token.is_cancelled() {
            return Err(last_err);
        }
        tracing::warn!(
            primary = %request.model,
            fallback = %fb_model,
            error = %last_err,
            "[LLM-05] Primary model unavailable — falling back to next model (stream)"
        );
        let mut fb_req = request.clone();
        fb_req.model = fb_model.clone();
        match call_llm_stream(api_url, api_key, &fb_req, cancel_token.clone(), max_attempts).await {
            Ok(stream) => return Ok(stream),
            Err(e) => {
                if !should_fallback_model(&e) {
                    return Err(e);
                }
                last_err = e;
            }
        }
    }
    Err(last_err)
}

/// Send a streaming chat-completion request to an OpenAI-compatible LLM endpoint.
///
/// Same retry behaviour as [`call_llm`] for the initial HTTP connection.
/// Once the connection is established and SSE stream begins, the function
/// returns a `Stream<Item = LlmStreamChunk>` that the caller can poll for
/// real-time content deltas.
///
/// # SSE format
///
/// The API sends chunks in `data: {json}\n\n` format.
/// `data: [DONE]\n\n` signals the end of the stream.
pub async fn call_llm_stream(
    api_url: &str,
    api_key: Option<&str>,
    request: &LlmRequest,
    cancel_token: CancellationToken,
    max_attempts: u32,
) -> Result<Pin<Box<dyn Stream<Item = LlmStreamChunk> + Send>>, unified_error::UnifiedError> {
    let llm_span = tracing::info_span!("llm_call");
    async {
        let client = get_http_client_stream();
        let call_start = std::time::Instant::now();

        let mut last_error: Option<unified_error::UnifiedError> = None;
        // Mirror of `call_llm`: carry the latest upstream `Retry-After` hint out
        // via `UnifiedError::RateLimited` so the SSE path's TS retry layer honors
        // the provider's suggested backoff (full-chain time consistency).
        let mut last_retry_after_ms: Option<u64> = None;

        for attempt in 0..max_attempts.max(timeouts::RATE_LIMIT_MAX_ATTEMPTS) {
            // Check cancellation before each retry attempt — bail out immediately
            // if the caller (e.g. agentic_loop timeout or user abort) has requested cancellation.
            if cancel_token.is_cancelled() {
                tracing::info!("Streaming LLM request cancelled before attempt {}", attempt);
                return Err(unified_error::UnifiedError::LlmApi {
                    message: "LLM streaming request cancelled by caller".to_string(),
                    status_code: None,
                    retryable: false,
                });
            }
            tracing::info!(
            attempt,
            model = %request.model,
            url = %api_url,
            "Sending streaming LLM API request..."
            );

            // Build request JSON with extra_body merged at root level
            let mut req_json = build_request_json(request);

            // Canonicalize tool parameter JSON keys (no-op safety net)
            if feature_flags::canonicalize_tools()
                && let Some(tools) = req_json.get_mut("tools").and_then(|t| t.as_array_mut()) {
                    for tool in tools.iter_mut() {
                        if let Some(params) = tool
                            .get_mut("function")
                            .and_then(|f| f.get_mut("parameters"))
                        {
                            ensure_sorted_json_keys(params);
                        }
                    }
                }

            let mut http_req = client.post(api_url).json(&req_json);

            if let Some(key) = api_key
                && !key.is_empty() {
                    http_req = http_req.bearer_auth(key);
                }

            // Cancelable send (G10): abort the in-flight HTTP request when the loop's
            // cancellation token is triggered.
            let resp = match tokio::select! {
                r = http_req.send() => r,
                _ = cancel_token.cancelled() => {
                    return Err(unified_error::UnifiedError::LlmApi {
                        message: "LLM streaming request cancelled".to_string(),
                        status_code: None,
                        retryable: false,
                    });
                }
            } {
                Ok(r) => r,
                Err(e) => {
                    last_error = Some(unified_error::UnifiedError::Unavailable(format!(
                        "Failed to reach LLM API at {}: {} (elapsed: {}s)",
                        api_url,
                        e,
                        call_start.elapsed().as_secs()
                    )));
                    let (budget, delay) = retry_policy(None, attempt, max_attempts, None);
                    if attempt + 1 < budget {
                        tracing::warn!(
                            attempt,
                            delay_ms = delay,
                            elapsed_secs = call_start.elapsed().as_secs(),
                            "Streaming LLM request failed (network), retrying..."
                        );
                        tokio::select! {
                            _ = tokio::time::sleep(std::time::Duration::from_millis(delay)) => {}
                            _ = cancel_token.cancelled() => {
                                return Err(unified_error::UnifiedError::LlmApi {
                                    message: "LLM streaming request cancelled during retry delay".to_string(),
                                    status_code: None,
                                    retryable: false,
                                });
                            }
                        }
                        continue;
                    }
                    break;
                }
            };

            let status = resp.status();
            tracing::info!(
                attempt,
                status = status.as_u16(),
                elapsed_secs = call_start.elapsed().as_secs(),
                "Streaming LLM API response status received"
            );

            // Non-success status: read the body to classify, then retry or fail.
            if !status.is_success() {
                // Read the Retry-After hint before `resp.bytes()` moves `resp`.
                let retry_after = parse_retry_after(resp.headers());
                let body_bytes = resp.bytes().await.unwrap_or_default();
                let detail = serde_json::from_slice::<ApiErrorResponse>(&body_bytes)
                    .ok()
                    .and_then(|e| e.error)
                    .and_then(|e| e.message)
                    .unwrap_or_else(|| {
                        status
                            .canonical_reason()
                            .unwrap_or("Unknown error")
                            .to_string()
                    });

                // Detect context-window overflow errors from the response body.
                // When detected, annotate the error message so the caller (agentic_loop)
                // can trigger progressive compression and retry.
                let body_text = std::str::from_utf8(&body_bytes).unwrap_or("");
                let is_context_overflow = is_context_overflow_error_text(body_text);

                let error_msg = if is_context_overflow {
                    format!(
                        "LLM API context window overflow (HTTP {}): {}",
                        status.as_u16(),
                        detail
                    )
                } else {
                    format!("LLM API returned HTTP {}: {}", status.as_u16(), detail)
                };

                // Capture the upstream Retry-After hint (if any) on every retryable
                // HTTP response. Only overwrite when present, so a later 5xx without a
                // hint does not clobber a prior 429's `Retry-After` (the final error keeps
                // the most recent explicit hint).
                if is_retryable_error(status, &body_bytes)
                    && let Some(delay) = retry_after {
                        // P2-2: cap at 60s (see the call_llm twin comment).
                        last_retry_after_ms = Some(delay.min(60_000));
                    }

                let (budget, delay) = retry_policy(Some(status), attempt, max_attempts, retry_after);
                if is_retryable_error(status, &body_bytes) && attempt + 1 < budget {
                    tracing::warn!(
                        attempt,
                        delay_ms = delay,
                        status = status.as_u16(),
                        elapsed_secs = call_start.elapsed().as_secs(),
                        "Streaming LLM API returned retryable error, retrying..."
                    );
                    last_error = Some(unified_error::UnifiedError::LlmApi {
                        message: error_msg,
                        status_code: Some(status.as_u16()),
                        retryable: true,
                    });
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_millis(delay)) => {}
                        _ = cancel_token.cancelled() => {
                            return Err(unified_error::UnifiedError::LlmApi {
                                message: "LLM streaming request cancelled during retry delay".to_string(),
                                status_code: None,
                                retryable: false,
                            });
                        }
                    }
                    continue;
                }

                // Context overflow errors are non-retryable at the transport level
                // (same request would fail again), but the caller can compress and retry.
                let retryable = if is_context_overflow {
                    false
                } else {
                    is_retryable_error(status, &body_bytes)
                };

                // When the provider supplied a Retry-After hint on a retryable failure,
                // surface it as `RateLimited` so the TS retry layer honors the suggested
                // backoff (full-chain time consistency) rather than starting its own 2s
                // exponential curve.
                let final_err = match (last_retry_after_ms, retryable) {
                    (Some(delay), true) => unified_error::UnifiedError::RateLimited {
                        message: error_msg,
                        retry_after_ms: Some(delay),
                    },
                    _ => unified_error::UnifiedError::LlmApi {
                        message: error_msg,
                        status_code: Some(status.as_u16()),
                        retryable,
                    },
                };
                // Silent degradation for models that reject the thinking/reasoning
                // parameter: strip `reasoning_effort` from extra_body and retry once.
                // Triggered only on HTTP 400 mentioning reasoning/thinking/parameter.
                if is_thinking_param_error(&final_err)
                    && let Some(obj) = request.extra_body.as_ref().and_then(|v| v.as_object())
                        && obj.contains_key("reasoning_effort") {
                            let mut nb = obj.clone();
                            nb.remove("reasoning_effort");
                            let mut nb_req = request.clone();
                            nb_req.extra_body =
                                if nb.is_empty() { None } else { Some(serde_json::Value::Object(nb)) };
                            tracing::warn!(
                                model = %request.model,
                                "Model rejected reasoning_effort; retrying without thinking mode"
                            );
                            return Box::pin(call_llm_stream(
                                api_url,
                                api_key,
                                &nb_req,
                                cancel_token,
                                max_attempts,
                            ))
                            .await;
                        }
                return Err(final_err);
            }

            // Success — build the SSE-parsing stream.
            let byte_stream = resp.bytes_stream();

            let stream = spawn_sse_parser(byte_stream, request.model.clone(), cancel_token);
            return Ok(stream);
        }

        // All retries exhausted
        Err(
            last_error.unwrap_or_else(|| unified_error::UnifiedError::LlmApi {
                message: format!(
                    "Streaming LLM request failed after {} attempts (elapsed: {}s)",
                    max_attempts,
                    call_start.elapsed().as_secs()
                ),
                status_code: None,
                retryable: true,
            }),
        )
    }
    .instrument(llm_span)
    .await
}

/// Parse a `bytes_stream()` into `LlmStreamChunk` items using a channel-based approach.
///
/// Spawns a task that reads from the byte stream, buffers SSE lines,
/// and sends parsed chunks through a `tokio::sync::mpsc` channel.
fn spawn_sse_parser(
    byte_stream: impl Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + 'static,
    model_fallback: String,
    cancel_token: CancellationToken,
) -> Pin<Box<dyn Stream<Item = LlmStreamChunk> + Send>> {
    let (tx, rx) = tokio::sync::mpsc::channel::<LlmStreamChunk>(64);

    tokio::spawn(async move {
        // If already cancelled before we even start, bail out immediately.
        if cancel_token.is_cancelled() {
            tracing::info!("SSE parser cancelled before starting");
            let _ = tx
                .send(LlmStreamChunk::Error(unified_error::UnifiedError::LlmApi {
                    message: "SSE stream cancelled by caller".to_string(),
                    status_code: None,
                    retryable: false,
                }))
                .await;
            return;
        }

        let mut buffer = String::new();
        let mut utf8_buf: Vec<u8> = Vec::new(); // Byte-level buffer for UTF-8 boundary handling
        let mut model_id: Option<String> = None;
        let mut total_content = String::new();
        let mut total_reasoning_content = String::new();
        let mut prompt_tokens: u32 = 0;
        let mut completion_tokens: u32 = 0;
        let mut total_tokens: u32 = 0;
        let mut prompt_cache_hit_tokens: Option<u32> = None;
        let mut prompt_cache_miss_tokens: Option<u32> = None;
        let mut reasoning_tokens: Option<u32> = None;
        let mut finish_reason: Option<String> = None;
        let mut tool_calls_accumulator: Vec<Option<duo_types::ToolCall>> = Vec::new();
        let mut byte_stream = Box::pin(byte_stream);

        loop {
            // Check cancellation before each iteration — exit immediately if cancelled.
            if cancel_token.is_cancelled() {
                tracing::info!("SSE parser cancelled during stream processing");
                let _ = tx
                    .send(LlmStreamChunk::Error(unified_error::UnifiedError::LlmApi {
                        message: "SSE stream cancelled by caller".to_string(),
                        status_code: None,
                        retryable: false,
                    }))
                    .await;
                return;
            }

            let chunk_result = tokio::select! {
                chunk = byte_stream.next() => chunk,
                _ = cancel_token.cancelled() => {
                    tracing::info!("SSE parser cancelled via select");
                    let _ = tx
                        .send(LlmStreamChunk::Error(unified_error::UnifiedError::LlmApi {
                            message: "SSE stream cancelled by caller".to_string(),
                            status_code: None,
                            retryable: false,
                        }))
                        .await;
                    return;
                }
            };

            let chunk_result = match chunk_result {
                Some(c) => c,
                None => break, // stream exhausted
            };
            let chunk = match chunk_result {
                Ok(b) => b,
                Err(e) => {
                    let _ = tx
                        .send(LlmStreamChunk::Error(unified_error::UnifiedError::LlmApi {
                            message: format!("Streaming read error: {}", e),
                            status_code: None,
                            retryable: false,
                        }))
                        .await;
                    return;
                }
            };

            // Append new bytes to the byte-level buffer
            utf8_buf.extend_from_slice(&chunk);

            // Try to decode as much valid UTF-8 as possible from the buffer
            let text = match std::str::from_utf8(&utf8_buf) {
                Ok(t) => {
                    // Entire buffer is valid UTF-8 — consume all
                    let text = t.to_string();
                    utf8_buf.clear();
                    text
                }
                Err(e) => {
                    let valid_up_to = e.valid_up_to();
                    if valid_up_to == 0 {
                        // Buffer starts with an incomplete UTF-8 sequence;
                        // keep accumulating bytes until we can decode
                        continue;
                    }
                    // Extract the valid UTF-8 prefix, retain the remaining bytes
                    let text = std::str::from_utf8(&utf8_buf[..valid_up_to])
                        .expect("valid_up_to guarantees valid UTF-8")
                        .to_string();
                    utf8_buf = utf8_buf[valid_up_to..].to_vec();
                    text
                }
            };
            buffer.push_str(&text);

            // Process complete lines
            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim().to_string();
                buffer = buffer[newline_pos + 1..].to_string();

                if line.is_empty() {
                    continue;
                }

                if let Some(data) = line.strip_prefix("data: ") {
                    let data = data.trim();

                    if data == "[DONE]" {
                        // Stream complete — assemble the final LlmResponse
                        let resolved_model = model_id.unwrap_or_else(|| model_fallback.clone());
                        tracing::info!(
                            model = %resolved_model,
                            total_chars = total_content.len(),
                            prompt_tokens,
                            completion_tokens,
                            total_tokens,
                            "Streaming LLM response complete"
                        );
                        let total_tool_calls: Vec<duo_types::ToolCall> =
                            tool_calls_accumulator.iter().flatten().cloned().collect();
                        let _ = tx
                            .send(LlmStreamChunk::Done(LlmResponse {
                                content: total_content.clone(),
                                reasoning_content: if total_reasoning_content.is_empty() {
                                    None
                                } else {
                                    Some(total_reasoning_content.clone())
                                },
                                model_id: Some(resolved_model),
                                token_usage: TokenUsage {
                                    prompt_tokens,
                                    completion_tokens,
                                    total_tokens,
                                    prompt_cache_hit_tokens,
                                    prompt_cache_miss_tokens,
                                    reasoning_tokens,
                                },
                                finish_reason: finish_reason.clone(),
                                tool_calls: if total_tool_calls.is_empty() {
                                    None
                                } else {
                                    Some(total_tool_calls)
                                },
                            }))
                            .await;
                        return; // Stream is done
                    }

                    // Parse as JSON
                    match serde_json::from_str::<StreamChunk>(data) {
                        Ok(chunk) => {
                            // Extract model if present
                            if let Some(ref m) = chunk.model {
                                model_id = Some(m.clone());
                            }

                            // Extract usage if present (some providers send it in the final chunk)
                            if let Some(ref u) = chunk.usage {
                                if let Some(v) = u.prompt_tokens {
                                    prompt_tokens = v;
                                }
                                if let Some(v) = u.completion_tokens {
                                    completion_tokens = v;
                                }
                                if let Some(v) = u.total_tokens {
                                    total_tokens = v;
                                }
                                // Cache metrics (DeepSeek / OpenAI prefix cache)
                                if let Some(v) = u.prompt_cache_hit_tokens {
                                    prompt_cache_hit_tokens = Some(v);
                                }
                                if let Some(v) = u.prompt_cache_miss_tokens {
                                    prompt_cache_miss_tokens = Some(v);
                                }
                                if let Some(ref details) = u.prompt_tokens_details
                                    && let Some(v) = details.cached_tokens {
                                        prompt_cache_hit_tokens = Some(v);
                                    }
                                // Reasoning tokens (DeepSeek `reasoning_tokens` at stream end)
                                if let Some(v) = u.reasoning_tokens {
                                    reasoning_tokens = Some(v);
                                }
                                // Reasoning tokens (OpenAI `completion_tokens_details.reasoning_tokens`)
                                if let Some(ref ctd) = u.completion_tokens_details
                                    && let Some(v) = ctd.reasoning_tokens {
                                        reasoning_tokens = Some(v);
                                    }
                            }

                            // Extract delta content
                            if let Some(choice) = chunk.choices.first() {
                                // Capture finish_reason
                                if let Some(ref fr) = choice.finish_reason {
                                    finish_reason = Some(fr.clone());
                                }

                                // Emit reasoning/thinking delta (DeepSeek/Qwen/Kimi `reasoning_content`)
                                if let Some(ref reasoning) = choice.delta.reasoning_content
                                    && !reasoning.is_empty() {
                                        total_reasoning_content.push_str(reasoning);
                                        let _ = tx
                                            .send(LlmStreamChunk::Thinking {
                                                content: reasoning.clone(),
                                            })
                                            .await;
                                    }

                                // Accumulate tool_calls deltas (OpenAI streaming format)
                                if let Some(ref tool_calls) = choice.delta.tool_calls {
                                    for tc in tool_calls {
                                        let index =
                                            tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0)
                                                as usize;

                                        while tool_calls_accumulator.len() <= index {
                                            tool_calls_accumulator.push(None);
                                        }

                                        let entry = &mut tool_calls_accumulator[index];

                                        // Deltas after the first one for a tool
                                        // call carry only `name` / `arguments`
                                        // fragments — append them to the entry
                                        // already open at this index.
                                        if let Some(open) = entry.as_mut() {
                                            let func = tc
                                                .get("function")
                                                .unwrap_or(&serde_json::Value::Null);
                                            if let Some(name) =
                                                func.get("name").and_then(|v| v.as_str())
                                            {
                                                open.function.name.push_str(name);
                                            }
                                            if let Some(args) =
                                                func.get("arguments").and_then(|v| v.as_str())
                                            {
                                                open.function.arguments.push_str(args);
                                            }
                                            continue;
                                        }

                                        // First delta at this index: seed the
                                        // entry from the fragments it carries.
                                        // 3-3: an empty first-delta id can never
                                        // be paired with a tool_result (provider
                                        // 400) — generate a stable id keyed on
                                        // the delta index so TS/recover/provider
                                        // all see the same identifier.
                                        let raw_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                        let id = if raw_id.is_empty() {
                                            format!("duo_gen_{index}")
                                        } else {
                                            raw_id.to_string()
                                        };
                                        let tc_type = tc
                                            .get("type")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("function")
                                            .to_string();
                                        let func = tc
                                            .get("function")
                                            .unwrap_or(&serde_json::Value::Null);
                                        let name = func
                                            .get("name")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        let args = func
                                            .get("arguments")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        *entry = Some(duo_types::ToolCall {
                                            id,
                                            r#type: tc_type,
                                            function: duo_types::FunctionCall {
                                                name,
                                                arguments: args,
                                            },
                                        });
                                    }
                                }

                                if let Some(ref content) = choice.delta.content {
                                    total_content.push_str(content);
                                    let _ = tx
                                        .send(LlmStreamChunk::Delta {
                                            content: content.clone(),
                                        })
                                        .await;
                                }
                            }
                        }
                        Err(e) => {
                            // Non-parseable data line — log and skip
                            tracing::debug!(
                                "SSE stream: skipping non-parseable data line: {:?} (error: {})",
                                data,
                                e
                            );
                        }
                    }
                }
                // Lines not starting with "data: " are ignored (e.g. SSE comments, event: lines)
            }
        }

        // Flush remaining bytes in UTF-8 buffer after stream closes.
        // Any leftover bytes that form valid UTF-8 should be appended to the line buffer.
        if !utf8_buf.is_empty() {
            match std::str::from_utf8(&utf8_buf) {
                Ok(t) => {
                    buffer.push_str(t);
                }
                Err(e) => {
                    let valid_up_to = e.valid_up_to();
                    if valid_up_to > 0 {
                        let t = std::str::from_utf8(&utf8_buf[..valid_up_to])
                            .expect("valid_up_to guarantees valid UTF-8");
                        buffer.push_str(t);
                        tracing::warn!(
                            "SSE stream: discarding {} trailing invalid UTF-8 bytes after flush",
                            utf8_buf.len() - valid_up_to
                        );
                    } else {
                        tracing::warn!(
                            "SSE stream: discarding {} trailing incomplete UTF-8 bytes after flush",
                            utf8_buf.len()
                        );
                    }
                }
            }
        }

        // If we reach here, the stream ended without a `[DONE]` marker.
        // This can happen with some providers. Emit Done with whatever we have.
        // P1-6 (3-1): the guard must also cover tool-calls-only and
        // reasoning-only streams — a tool_calls-only response leaves
        // `total_content` AND `buffer` empty, which previously discarded the
        // accumulated tool calls + finish_reason and failed the whole round.
        if !total_content.is_empty()
            || !buffer.is_empty()
            || !total_reasoning_content.is_empty()
            || tool_calls_accumulator.iter().any(|t| t.is_some())
            || finish_reason.is_some()
        {
            // Process any remaining lines in the buffer (in case the last line didn't end with \n)
            // This is a best-effort attempt to parse any remaining data lines.
            for line in buffer.lines() {
                let line = line.trim();
                if let Some(data) = line.strip_prefix("data: ") {
                    let data = data.trim();
                    if data != "[DONE]"
                        && let Ok(chunk) = serde_json::from_str::<StreamChunk>(data) {
                            if let Some(ref m) = chunk.model {
                                model_id = Some(m.clone());
                            }
                            if let Some(ref u) = chunk.usage {
                                if let Some(v) = u.prompt_tokens {
                                    prompt_tokens = v;
                                }
                                if let Some(v) = u.completion_tokens {
                                    completion_tokens = v;
                                }
                                if let Some(v) = u.total_tokens {
                                    total_tokens = v;
                                }
                            }
                            if let Some(choice) = chunk.choices.first() {
                                if let Some(ref fr) = choice.finish_reason {
                                    finish_reason = Some(fr.clone());
                                }
                                if let Some(ref reasoning) = choice.delta.reasoning_content
                                    && !reasoning.is_empty() {
                                        total_reasoning_content.push_str(reasoning);
                                        let _ = tx
                                            .send(LlmStreamChunk::Thinking {
                                                content: reasoning.clone(),
                                            })
                                            .await;
                                    }
                                // Accumulate tool_calls deltas in flush path (same logic as above)
                                if let Some(ref tool_calls) = choice.delta.tool_calls {
                                    for tc in tool_calls {
                                        let index =
                                            tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0)
                                                as usize;

                                        while tool_calls_accumulator.len() <= index {
                                            tool_calls_accumulator.push(None);
                                        }

                                        let entry = &mut tool_calls_accumulator[index];

                                        // Deltas after the first one for a tool
                                        // call carry only `name` / `arguments`
                                        // fragments — append them to the entry
                                        // already open at this index.
                                        if let Some(open) = entry.as_mut() {
                                            let func = tc
                                                .get("function")
                                                .unwrap_or(&serde_json::Value::Null);
                                            if let Some(name) =
                                                func.get("name").and_then(|v| v.as_str())
                                            {
                                                open.function.name.push_str(name);
                                            }
                                            if let Some(args) =
                                                func.get("arguments").and_then(|v| v.as_str())
                                            {
                                                open.function.arguments.push_str(args);
                                            }
                                            continue;
                                        }

                                        // First delta at this index: seed the
                                        // entry from the fragments it carries.
                                        // 3-3: an empty first-delta id can never
                                        // be paired with a tool_result (provider
                                        // 400) — generate a stable id keyed on
                                        // the delta index so TS/recover/provider
                                        // all see the same identifier.
                                        let raw_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                        let id = if raw_id.is_empty() {
                                            format!("duo_gen_{index}")
                                        } else {
                                            raw_id.to_string()
                                        };
                                        let tc_type = tc
                                            .get("type")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("function")
                                            .to_string();
                                        let func = tc
                                            .get("function")
                                            .unwrap_or(&serde_json::Value::Null);
                                        let name = func
                                            .get("name")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        let args = func
                                            .get("arguments")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        *entry = Some(duo_types::ToolCall {
                                            id,
                                            r#type: tc_type,
                                            function: duo_types::FunctionCall {
                                                name,
                                                arguments: args,
                                            },
                                        });
                                    }
                                }

                                if let Some(ref content) = choice.delta.content {
                                    total_content.push_str(content);
                                    let _ = tx
                                        .send(LlmStreamChunk::Delta {
                                            content: content.clone(),
                                        })
                                        .await;
                                }
                            }
                        }
                }
            }

            let resolved_model = model_id.unwrap_or_else(|| model_fallback.clone());
            let total_tool_calls: Vec<duo_types::ToolCall> =
                tool_calls_accumulator.into_iter().flatten().collect();
            tracing::warn!(
                "SSE stream ended without [DONE] marker, assembling response from accumulated deltas"
            );
            let _ = tx
                .send(LlmStreamChunk::Done(LlmResponse {
                    content: total_content,
                    reasoning_content: if total_reasoning_content.is_empty() {
                        None
                    } else {
                        Some(total_reasoning_content)
                    },
                    model_id: Some(resolved_model),
                    token_usage: TokenUsage {
                        prompt_tokens,
                        completion_tokens,
                        total_tokens,
                        prompt_cache_hit_tokens,
                        prompt_cache_miss_tokens,
                        reasoning_tokens,
                    },
                    finish_reason,
                    tool_calls: if total_tool_calls.is_empty() {
                        None
                    } else {
                        Some(total_tool_calls)
                    },
                }))
                .await;
        } else {
            let _ = tx
                .send(LlmStreamChunk::Error(unified_error::UnifiedError::LlmApi {
                    message: "SSE stream ended without data".to_string(),
                    status_code: None,
                    retryable: false,
                }))
                .await;
        }
    });

    Box::pin(tokio_stream::wrappers::ReceiverStream::new(rx))
}

#[cfg(test)]
mod fallback_tests {
    use super::*;

    fn llm_api(message: &str, status_code: Option<u16>, retryable: bool) -> unified_error::UnifiedError {
        unified_error::UnifiedError::LlmApi {
            message: message.to_string(),
            status_code,
            retryable,
        }
    }

    #[test]
    fn fallback_on_unavailable_and_retryable() {
        assert!(should_fallback_model(&unified_error::UnifiedError::Unavailable(
            "Failed to reach LLM API".into()
        )));
        assert!(should_fallback_model(&llm_api("HTTP 503", Some(503), true)));
    }

    #[test]
    fn fallback_on_model_not_found() {
        assert!(should_fallback_model(&llm_api("Not Found", Some(404), false)));
        assert!(should_fallback_model(&llm_api(
            "The model `gpt-x` does not exist",
            Some(400),
            false
        )));
    }

    #[test]
    fn no_fallback_on_cancel_overflow_or_auth() {
        assert!(!should_fallback_model(&llm_api(
            "LLM request cancelled",
            None,
            false
        )));
        assert!(!should_fallback_model(&llm_api(
            "LLM API context window overflow (HTTP 400): too long",
            Some(400),
            false
        )));
        assert!(!should_fallback_model(&llm_api(
            "Unauthorized",
            Some(401),
            false
        )));
        assert!(!should_fallback_model(&unified_error::UnifiedError::BadRequest(
            "bad".into()
        )));
    }

    #[tokio::test]
    async fn call_llm_with_fallback_empty_list_matches_call_llm() {
        // Unreachable endpoint + no fallback ⇒ same Unavailable error as call_llm.
        let req = LlmRequest {
            model: "primary".to_string(),
            ..Default::default()
        };
        let res = call_llm_with_fallback(
            "http://127.0.0.1:1/v1/chat/completions",
            None,
            &req,
            tokio_util::sync::CancellationToken::new(),
            1,
            &[],
        )
        .await;
        assert!(matches!(
            res,
            Err(unified_error::UnifiedError::Unavailable(_))
        ));
    }

    #[tokio::test]
    async fn call_llm_with_fallback_tries_next_model_then_reports_last_error() {
        // Both primary and fallback are unreachable ⇒ error must come from the
        // fallback attempt path (list exhausted), proving the switch happened.
        let req = LlmRequest {
            model: "primary".to_string(),
            ..Default::default()
        };
        let res = call_llm_with_fallback(
            "http://127.0.0.1:1/v1/chat/completions",
            None,
            &req,
            tokio_util::sync::CancellationToken::new(),
            1,
            &["primary".to_string(), "backup".to_string()],
        )
        .await;
        assert!(matches!(
            res,
            Err(unified_error::UnifiedError::Unavailable(_))
        ));
    }

    // P1-6 + P2-8(3-3): a tool_calls-only SSE stream that ends WITHOUT the
    // [DONE] marker must be assembled into LlmStreamChunk::Done (not an
    // error), with the empty first-delta id replaced by `duo_gen_{index}`.
    #[tokio::test]
    async fn sse_tool_calls_only_stream_without_done_yields_done() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let body = concat!(
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","type":"function","function":{"name":"read_file","arguments":"{\"path\":"}}]}}]}"#,
            "\n\n",
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.txt\"}"}}]}}]}"#,
            "\n\n",
            r#"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            "\n\n",
        );
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut buf = vec![0u8; 8192];
            let _ = sock.read(&mut buf).await.unwrap(); // request bytes (discarded)
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            sock.write_all(response.as_bytes()).await.unwrap();
        });

        let req = LlmRequest {
            model: "test-model".to_string(),
            ..Default::default()
        };
        let mut stream = call_llm_stream(
            &format!("http://{addr}/v1/chat/completions"),
            None,
            &req,
            tokio_util::sync::CancellationToken::new(),
            1,
        )
        .await
        .expect("connection must succeed");
        server.await.unwrap();

        use futures::StreamExt;
        let mut done: Option<LlmResponse> = None;
        while let Some(chunk) = stream.next().await {
            match chunk {
                LlmStreamChunk::Done(r) => {
                    done = Some(r);
                    break;
                }
                LlmStreamChunk::Error(e) => panic!("tool_calls-only stream must not error: {e:?}"),
                _ => {}
            }
        }
        let done = done.expect("stream must end with Done");
        assert_eq!(done.content, "");
        assert_eq!(done.finish_reason.as_deref(), Some("tool_calls"));
        let calls = done.tool_calls.expect("tool calls preserved");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "duo_gen_0", "empty first-delta id is generated");
        assert_eq!(calls[0].function.name, "read_file");
        assert_eq!(calls[0].function.arguments, r#"{"path":"a.txt"}"#);
    }
}

#[cfg(test)]
mod retry_tests {
    use super::*;

    #[test]
    fn is_retryable_429() {
        let status = reqwest::StatusCode::from_u16(429).unwrap();
        assert!(is_retryable_error(status, b""));
    }

    #[test]
    fn is_retryable_5xx() {
        for code in [500, 502, 503, 504] {
            let status = reqwest::StatusCode::from_u16(code).unwrap();
            assert!(
                is_retryable_error(status, b""),
                "HTTP {} should be retryable",
                code
            );
        }
    }

    /// A configured retry budget must never be *downgraded* for the responses
    /// that need retries the most (429/503 backpressure).
    #[test]
    fn rate_limited_budget_is_at_least_the_callers() {
        let limited = reqwest::StatusCode::from_u16(429).unwrap();
        let server_error = reqwest::StatusCode::from_u16(500).unwrap();

        for max_attempts in [1, 2, 3, 5, 10] {
            let (budget, _) = retry_policy(Some(limited), 0, max_attempts, None);
            assert!(
                budget >= max_attempts,
                "429 budget {} must be >= configured {}",
                budget,
                max_attempts
            );
            let (budget, _) = retry_policy(Some(server_error), 0, max_attempts, None);
            assert_eq!(budget, max_attempts, "500 keeps the caller's budget");
        }
    }

    /// 429 uses the slow ladder; a generic 5xx keeps the fast one.
    #[test]
    fn rate_limited_delay_is_longer_than_generic() {
        let limited = reqwest::StatusCode::from_u16(429).unwrap();
        let server_error = reqwest::StatusCode::from_u16(500).unwrap();

        assert!(retry_policy(Some(limited), 0, 3, None).1 > retry_policy(Some(server_error), 0, 3, None).1);
        // An upstream hint wins, but stays inside the per-call cap.
        assert_eq!(retry_policy(Some(limited), 0, 3, Some(120_000)).1, timeouts::RETRY_MAX_DELAY_MS);
    }

    /// A transport failure has no status → generic budget and ladder.
    #[test]
    fn transport_failure_uses_generic_policy() {
        assert_eq!(retry_policy(None, 0, 4, Some(60_000)), (4, timeouts::RETRY_INITIAL_DELAY_MS));
    }

    #[test]
    fn is_retryable_408() {
        let status = reqwest::StatusCode::from_u16(408).unwrap();
        assert!(is_retryable_error(status, b""));
    }

    #[test]
    fn is_not_retryable_400() {
        let status = reqwest::StatusCode::from_u16(400).unwrap();
        assert!(!is_retryable_error(status, b"invalid request"));
    }

    #[test]
    fn is_not_retryable_401() {
        let status = reqwest::StatusCode::from_u16(401).unwrap();
        assert!(!is_retryable_error(status, b""));
    }

    #[test]
    fn is_not_retryable_403() {
        let status = reqwest::StatusCode::from_u16(403).unwrap();
        assert!(!is_retryable_error(status, b"forbidden"));
    }

    #[test]
    fn is_retryable_quota_in_400() {
        let status = reqwest::StatusCode::from_u16(400).unwrap();
        assert!(is_retryable_error(status, b"NotEnoughCvError"));
        assert!(is_retryable_error(status, b"code: 11210"));
        assert!(is_retryable_error(status, b"tokens.total exceeded"));
        assert!(is_retryable_error(status, b"insufficient_quota"));
    }

    #[test]
    fn is_retryable_xunfei_10050() {
        let status_400 = reqwest::StatusCode::from_u16(400).unwrap();
        assert!(is_retryable_error(status_400, b"code: 10050"));
        // 10050 with context overflow keywords should NOT be retryable
        let status_500 = reqwest::StatusCode::from_u16(500).unwrap();
        assert!(!is_retryable_error(
            status_500,
            b"code: 10050 input token limit is 202745"
        ));
    }

    #[test]
    fn is_retryable_overloaded() {
        let status = reqwest::StatusCode::from_u16(400).unwrap();
        assert!(is_retryable_error(status, b"overloaded_error"));
        assert!(is_retryable_error(status, b"Overloaded"));
    }

    #[test]
    fn is_not_retryable_server_error_in_4xx_body() {
        // "server_error" and "api_error" in 4xx body should NOT be retryable
        // (R16 fix: removed overly broad body keywords for 4xx)
        let status_400 = reqwest::StatusCode::from_u16(400).unwrap();
        assert!(!is_retryable_error(status_400, b"server_error"));
        assert!(!is_retryable_error(
            status_400,
            b"api_error: upstream timeout"
        ));

        let status_403 = reqwest::StatusCode::from_u16(403).unwrap();
        assert!(!is_retryable_error(status_403, b"server_error"));
    }

    #[test]
    fn is_not_retryable_broad_quota_in_4xx() {
        // Bare "quota" keyword in 4xx body should NOT be retryable (too broad)
        let status_400 = reqwest::StatusCode::from_u16(400).unwrap();
        assert!(!is_retryable_error(status_400, b"quota"));
        assert!(!is_retryable_error(status_400, b"exceeded quota limit"));
        // But specific patterns like "insufficient_quota" should still be retryable
        assert!(is_retryable_error(status_400, b"insufficient_quota"));
    }

    #[test]
    fn is_not_retryable_5xx_with_auth_error() {
        // 5xx with auth error in body should NOT be retryable
        let status_500 = reqwest::StatusCode::from_u16(500).unwrap();
        assert!(!is_retryable_error(status_500, b"invalid_api_key"));
        assert!(!is_retryable_error(status_500, b"authentication_error"));
        assert!(!is_retryable_error(status_500, b"permission_denied"));
        // But generic 5xx without auth error is still retryable
        assert!(is_retryable_error(status_500, b"internal server error"));
    }

    #[test]
    fn retry_delay_initial() {
        // Initial delay is the configured floor (500ms). Intentional: lowered
        // from 2s to avoid adding 2s of latency on the first transient retry.
        assert_eq!(retry_delay_ms(0), timeouts::RETRY_INITIAL_DELAY_MS);
    }

    #[test]
    fn retry_delay_second() {
        assert_eq!(
            retry_delay_ms(1),
            timeouts::RETRY_INITIAL_DELAY_MS * timeouts::RETRY_BACKOFF_FACTOR as u64
        );
    }

    #[test]
    fn retry_delay_third() {
        assert_eq!(
            retry_delay_ms(2),
            timeouts::RETRY_INITIAL_DELAY_MS * (timeouts::RETRY_BACKOFF_FACTOR as u64).pow(2)
        );
    }

    #[test]
    fn retry_delay_capped_at_max() {
        assert_eq!(retry_delay_ms(10), timeouts::RETRY_MAX_DELAY_MS);
    }

    #[test]
    fn is_not_retryable_context_overflow() {
        // Context window overflow errors should NOT be retryable — the same
        // request would fail again. The caller (agentic_loop) must compress
        // messages before retrying.
        let status_400 = reqwest::StatusCode::from_u16(400).unwrap();
        assert!(!is_retryable_error(status_400, b"context_length_exceeded"));
        assert!(!is_retryable_error(
            status_400,
            b"This model's maximum context length is 4096 tokens"
        ));
        assert!(!is_retryable_error(
            status_400,
            b"too many tokens in the request"
        ));
        assert!(!is_retryable_error(status_400, b"token limit exceeded"));
        assert!(!is_retryable_error(
            status_400,
            b"maximum context length exceeded"
        ));

        // 5xx with context overflow should also not be retryable
        let status_500 = reqwest::StatusCode::from_u16(500).unwrap();
        assert!(!is_retryable_error(status_500, b"context_length_exceeded"));
        assert!(!is_retryable_error(status_500, b"too many tokens"));
    }
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;

    #[tokio::test]
    async fn test_call_llm_cancelled_before_send_returns_llm_api_err() {
        // G10: a cancelled token must abort the request before any network I/O,
        // returning a non-retryable LlmApi error (not a hung send).
        let token = tokio_util::sync::CancellationToken::new();
        token.cancel();
        let req = LlmRequest {
            model: "test-model".to_string(),
            ..Default::default()
        };
        let res = call_llm(
            "http://127.0.0.1:1/v1/chat/completions",
            None,
            &req,
            token,
            1,
        )
        .await;
        match res {
            Err(unified_error::UnifiedError::LlmApi { retryable, .. }) => {
                assert!(!retryable, "cancellation must be non-retryable");
            }
            other => panic!("expected LlmApi cancelled error, got {:?}", other),
        }
    }
}
