//! LLM related types.

use serde::{Deserialize, Serialize};

use crate::agent::ToolCall;

// ─── LLM Types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmExecuteRequest {
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// Project root path — used to query the knowledge graph for code context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    pub provider: String,
    /// Environment variable name holding the API key (e.g. "OPENAI_API_KEY").
    /// Resolved at call time via `std::env::var(api_key_env)`. Mutually exclusive with `api_key`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
    /// Direct API key value. When provided, the key is stored in a process-level
    /// env var (`DUO_LLM_API_KEY_RESOLVED`) and referenced via `api_key_env`.
    /// Prefer `api_key` when the value is known directly (e.g. from UI config).
    /// Serialized with masking for security (only first 4 and last 4 chars visible).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(
        rename = "baseURL",
        alias = "baseUrl",
        skip_serializing_if = "Option::is_none"
    )]
    pub base_url: Option<String>,
    #[serde(default = "default_model_id")]
    pub default_model_id: String,
    /// Maximum context window in tokens for the configured model.
    /// Used by the agentic loop to proactively trim messages before sending.
    /// When `None` (default), no context-window-based pruning is performed.
    /// Example values: Xunfei Spark = 202745, GPT-4 = 128000, Claude = 200000
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    /// Max output tokens per LLM call (e.g. DeepSeek = 8192, GPT-4 = 4096).
    /// Overrides the hardcoded 32768 in agentic_loop when set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    /// API key for embedding generation (OpenAI text-embedding-3-small).
    /// When None, falls back to `api_key`. When both are None, embedding
    /// generation is skipped and vector search degrades to FTS5 + Jaccard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_api_key: Option<String>,
    /// Embedding model id. Defaults to "text-embedding-3-small" when None.
    /// Must match `embedding_dim` (e.g. 1536 for text-embedding-3-small).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_model: Option<String>,
    /// Embedding vector dimension. Defaults to 1536 when None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_dim: Option<u32>,
    /// Maximum number of concurrent agents across all projects.
    /// When None, defaults to the Semaphore capacity (currently 5).
    /// Used by the runLoop handler to acquire a permit before spawning.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrent_agents: Option<u32>,
    /// Maximum number of subagents that a single agent can spawn concurrently.
    /// When None, defaults to 3. Used by the task/subagent executor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrent_subagents: Option<u32>,
    /// Maximum LLM API call retry attempts (excluding context-overflow errors).
    /// When None, defaults to 3 (matching timeouts::MAX_ATTEMPTS).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_retry_attempts: Option<u32>,
    /// Per-round tool-call concurrency inside a single agent loop.
    /// When None, the agent-executor default (4, temporary) is used. Clamped to
    /// [1, 16] on the backend; the frontend must also clamp the input to 16.
    /// Orthogonal to `max_concurrent_subagents` / `max_concurrent_agents`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_concurrency: Option<u32>,
    /// [LLM-05] Ordered fallback model IDs tried when the primary model is
    /// unavailable (network unreachable, retryable API errors exhausted, or
    /// model-not-found). Same provider endpoint/key are reused; only the
    /// `model` field of the request changes. When None/empty, no cross-model
    /// fallback is performed (previous behavior).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_models: Option<Vec<String>>,
    /// Sampling temperature override for all agent/executor LLM calls.
    /// None => use the code default (0.0, deterministic). User setting wins
    /// over the code default; the DUODUO_LLM_TEMPERATURE env var wins over both.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// Whether to enable the model's thinking/reasoning mode. None => enabled
    /// by default (per product decision: works on supporting models, degrades
    /// silently on models that reject the reasoning_effort parameter).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_thinking: Option<bool>,
    /// Thinking/reasoning effort level sent as `reasoning_effort` in the LLM
    /// request's extra_body. None => "high" (per product decision: maximum
    /// reasoning for correctness; degrades silently on models that reject the
    /// parameter). Accepts "low" | "medium" | "high".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_effort: Option<String>,
}

impl Serialize for LlmConfig {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut field_count = 2; // provider + defaultModelId
        if self.api_key_env.is_some() {
            field_count += 1;
        }
        if self.api_key.is_some() {
            field_count += 1;
        }
        if self.base_url.is_some() {
            field_count += 1;
        }
        if self.context_window.is_some() {
            field_count += 1;
        }
        if self.max_output_tokens.is_some() {
            field_count += 1;
        }
        if self.embedding_api_key.is_some() {
            field_count += 1;
        }
        if self.max_concurrent_agents.is_some() {
            field_count += 1;
        }
        if self.max_concurrent_subagents.is_some() {
            field_count += 1;
        }
        if self.max_retry_attempts.is_some() {
            field_count += 1;
        }
        if self.tool_concurrency.is_some() {
            field_count += 1;
        }
        if self.fallback_models.is_some() {
            field_count += 1;
        }
        if self.temperature.is_some() {
            field_count += 1;
        }
        if self.enable_thinking.is_some() {
            field_count += 1;
        }
        if self.thinking_effort.is_some() {
            field_count += 1;
        }
        let mut state = serializer.serialize_struct("LlmConfig", field_count)?;
        state.serialize_field("provider", &self.provider)?;
        if let Some(ref env) = self.api_key_env {
            state.serialize_field("apiKeyEnv", env)?;
        }
        // Mask api_key for security: only show first 4 and last 4 chars
        if let Some(ref key) = self.api_key {
            let masked = if key.len() <= 8 {
                "***".to_string()
            } else {
                format!("{}***{}", &key[..4], &key[key.len() - 4..])
            };
            state.serialize_field("apiKey", &masked)?;
        }
        if let Some(ref url) = self.base_url {
            state.serialize_field("baseURL", url)?;
        }
        if let Some(ref cw) = self.context_window {
            state.serialize_field("contextWindow", cw)?;
        }
        if let Some(ref v) = self.max_output_tokens {
            state.serialize_field("maxOutputTokens", v)?;
        }
        if let Some(ref key) = self.embedding_api_key {
            let masked = if key.len() <= 8 {
                "***".to_string()
            } else {
                format!("{}***{}", &key[..4], &key[key.len() - 4..])
            };
            state.serialize_field("embeddingApiKey", &masked)?;
        }
        if let Some(ref v) = self.max_concurrent_agents {
            state.serialize_field("maxConcurrentAgents", v)?;
        }
        if let Some(ref v) = self.max_concurrent_subagents {
            state.serialize_field("maxConcurrentSubagents", v)?;
        }
        if let Some(ref v) = self.max_retry_attempts {
            state.serialize_field("maxRetryAttempts", v)?;
        }
        if let Some(ref v) = self.tool_concurrency {
            state.serialize_field("toolConcurrency", v)?;
        }
        if let Some(ref v) = self.fallback_models {
            state.serialize_field("fallbackModels", v)?;
        }
        if let Some(ref v) = self.temperature {
            state.serialize_field("temperature", v)?;
        }
        if let Some(ref v) = self.enable_thinking {
            state.serialize_field("enableThinking", v)?;
        }
        if let Some(ref v) = self.thinking_effort {
            state.serialize_field("thinkingEffort", v)?;
        }
        state.serialize_field("defaultModelId", &self.default_model_id)?;
        state.end()
    }
}

fn default_model_id() -> String {
    "gpt-4".to_string()
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider: String::new(),
            api_key_env: None,
            api_key: None,
            base_url: None,
            default_model_id: default_model_id(),
            context_window: None,
            max_output_tokens: None,
            embedding_api_key: None,
            embedding_model: None,
            embedding_dim: None,
            max_concurrent_agents: None,
            max_concurrent_subagents: None,
            max_retry_attempts: None,
            tool_concurrency: None,
            fallback_models: None,
            temperature: None,
            enable_thinking: None,
            thinking_effort: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmResponse {
    pub content: String,
    /// Reasoning/thinking content from reasoning models (DeepSeek/Qwen/Kimi `reasoning_content`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    pub token_usage: TokenUsage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    /// Tool calls from the LLM response (for function calling).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    /// Provider-reported prompt cache hit tokens (DeepSeek `prompt_cache_hit_tokens`
    /// or OpenAI `prompt_tokens_details.cached_tokens`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_cache_hit_tokens: Option<u32>,
    /// Provider-reported prompt cache miss tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_cache_miss_tokens: Option<u32>,
    /// Provider-reported reasoning/thinking tokens (DeepSeek `reasoning_tokens`
    /// or OpenAI `completion_tokens_details.reasoning_tokens`). `None` when the
    /// provider does not report it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u32>,
}
