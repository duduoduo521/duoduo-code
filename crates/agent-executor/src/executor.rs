//! Agent executor: orchestrates LLM calls with configurable state.

/// Truncate a string to at most `max_bytes` bytes, respecting UTF-8 char boundaries.
fn truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    // Find the last valid char boundary at or before max_bytes
    let mut boundary = max_bytes;
    while boundary > 0 && !s.is_char_boundary(boundary) {
        boundary -= 1;
    }
    &s[..boundary]
}

use std::pin::Pin;
use std::sync::{Arc, Mutex};

use duo_types::{LlmConfig, LlmExecuteRequest, LlmResponse, TokenUsage};
use futures::Stream;
use quality_pipeline::LlmJudge;

use crate::llm::{LlmMessage, LlmRequest, LlmStreamChunk};
use duo_types::timeouts;
use tokio_util::sync::CancellationToken;

/// Core executor that holds optional LLM configuration behind a `Mutex`.
///
/// Phase 1: Rust side handles orchestration and state management only.
/// LLM calling is an optional capability — callers must configure it
/// via [`AgentExecutor::set_llm_config`] before executing prompts.
/// When no LLM is configured, `execute_prompt` returns an orchestration
/// placeholder instead of an error, aligning with architecture decision 8-1.
#[derive(Clone)]
pub struct AgentExecutor {
    llm_config: Arc<Mutex<Option<LlmConfig>>>,
    /// Optional prompt cache for request-hash-level deduplication.
    prompt_cache: Arc<Mutex<Option<Arc<prompt_cache::PromptCache>>>>,
}

impl AgentExecutor {
    /// Create a new `AgentExecutor` with no LLM configured.
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self {
            llm_config: Arc::new(Mutex::new(None)),
            prompt_cache: Arc::new(Mutex::new(None)),
        })
    }

    /// Set (or replace) the LLM configuration.
    pub fn set_llm_config(&self, config: LlmConfig) {
        match self.llm_config.lock() {
            Ok(mut guard) => *guard = Some(config),
            Err(e) => {
                // Mutex is poisoned — recover by replacing with the new config anyway.
                // A poisoned mutex means another thread panicked while holding the lock;
                // the data may be stale but the new config is authoritative.
                let mut guard = e.into_inner();
                *guard = Some(config);
            }
        }
    }

    /// Set the prompt cache for request-hash-level deduplication.
    pub fn set_prompt_cache(&self, cache: Arc<prompt_cache::PromptCache>) {
        match self.prompt_cache.lock() {
            Ok(mut guard) => *guard = Some(cache),
            Err(e) => {
                let mut guard = e.into_inner();
                *guard = Some(cache);
            }
        }
    }

    /// Access the LLM config mutex (pub(crate) for use by AgenticLoopExecutor).
    pub(crate) fn llm_config(&self) -> &Arc<Mutex<Option<LlmConfig>>> {
        &self.llm_config
    }

    /// Get the current LLM configuration (or a default placeholder if not set).
    ///
    /// Used by IM bridge to retrieve the config for partial field updates.
    pub fn get_llm_config(&self) -> LlmConfig {
        match self.llm_config.lock() {
            Ok(guard) => guard.clone().unwrap_or_default(),
            Err(e) => e.into_inner().clone().unwrap_or_default(),
        }
    }

    /// Check whether a valid LLM configuration has been set.
    ///
    /// Returns `true` only when `base_url` is present and non-empty.
    /// `api_key` is **not** required — local providers like Ollama don't need one.
    pub fn with_llm(&self) -> bool {
        let config_opt = match self.llm_config.lock() {
            Ok(guard) => guard.clone(),
            Err(e) => e.into_inner().clone(),
        };
        config_opt
            .as_ref()
            .and_then(|c| c.base_url.as_deref())
            .map(|url| !url.trim().is_empty())
            .unwrap_or(false)
    }

    /// Execute a prompt against the configured LLM with streaming.
    ///
    /// Returns a `Stream<Item = LlmStreamChunk>` that the caller polls for
    /// real-time content deltas. Falls back to the orchestration placeholder
    /// when no LLM is configured (same as [`execute_prompt`]).
    pub async fn execute_prompt_stream(
        &self,
        req: &LlmExecuteRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = LlmStreamChunk> + Send>>, unified_error::UnifiedError>
    {
        let config_opt = match self.llm_config.lock() {
            Ok(guard) => guard.clone(),
            Err(e) => {
                tracing::warn!("LLM config mutex poisoned, recovering");
                e.into_inner().clone()
            }
        };

        match config_opt {
            Some(config) => {
                let model = req
                    .model_id
                    .as_deref()
                    .map(|id| id.rsplit_once('/').map(|(_, m)| m).unwrap_or(id))
                    .unwrap_or_else(|| config.default_model_id.as_str())
                    .to_string();

                let max_tokens = req.max_tokens.unwrap_or(4096);
                // Temperature priority: request > LlmConfig setting > code default (0.0).
                let temperature = req
                    .temperature
                    .or(config.temperature)
                    .unwrap_or(timeouts::DEFAULT_LLM_TEMPERATURE);

                let api_url = match &config.base_url {
                    Some(url) => resolve_api_url(url, &config.provider),
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

                let llm_request = LlmRequest {
                    model,
                    messages: vec![LlmMessage::user(&req.prompt)],
                    max_tokens: Some(max_tokens),
                    temperature: Some(temperature),
                    stream: Some(true),
                    tools: None,
                    tool_choice: None,
                    response_format: None,
                    top_k: None,
                    top_p: None,
                    extra_body: None,
                };

                // [LLM-05] Cross-model fallback when the primary model is unavailable.
                crate::llm::call_llm_stream_with_fallback(
                    &api_url,
                    api_key.as_deref(),
                    &llm_request,
                    CancellationToken::new(),
                    config.max_retry_attempts.unwrap_or(timeouts::MAX_ATTEMPTS),
                    config.fallback_models.as_deref().unwrap_or(&[]),
                )
                .await
            }
            None => {
                // Phase 1: no LLM configured — return a stream that immediately
                // emits Done with the orchestration placeholder.
                let truncated = truncate_str(&req.prompt, 100);
                let placeholder = LlmResponse {
                    content: format!(
                        "[Orchestration] Prompt received but no LLM configured. Prompt: {}",
                        truncated
                    ),
                    reasoning_content: None,
                    model_id: Some("orchestrator".to_string()),
                    token_usage: TokenUsage {
                        prompt_tokens: 0,
                        completion_tokens: 0,
                        total_tokens: 0,
                        ..Default::default()
                    },
                    finish_reason: Some("orchestrator_passthrough".to_string()),
                    tool_calls: None,
                };
                let stream: Pin<Box<dyn Stream<Item = LlmStreamChunk> + Send>> = Box::pin(
                    futures::stream::iter(vec![LlmStreamChunk::Done(placeholder)]),
                );
                Ok(stream)
            }
        }
    }

    /// Execute a prompt against the configured LLM.
    ///
    /// When an LLM configuration is present, this sends the prompt to the
    /// configured API endpoint and returns the response.
    ///
    /// When **no** LLM is configured (Phase 1 default), this returns an
    /// orchestration placeholder response instead of erroring, so that the
    /// TS side can drive LLM calls while Rust handles orchestration only.
    pub async fn execute_prompt(
        &self,
        req: &LlmExecuteRequest,
        cancel_token: tokio_util::sync::CancellationToken,
    ) -> Result<LlmResponse, unified_error::UnifiedError> {
        // NOTE: clones LlmConfig on every call — consider Arc<LlmConfig> if this
        // becomes a bottleneck. Mutex pattern is preserved to avoid breaking the API.
        let config_opt = match self.llm_config.lock() {
            Ok(guard) => guard.clone(),
            Err(e) => {
                // Mutex poisoned — recover the inner data and continue.
                // The config may be stale but we can still try to use it.
                tracing::warn!("LLM config mutex poisoned, recovering");
                e.into_inner().clone()
            }
        };

        match config_opt {
            Some(config) => {
                // Build the OpenAI-compatible request from the user-facing request +
                // stored config defaults.
                //
                // req.model_id may be in "provider/modelID" format (e.g. "xunfei/astron-code-latest")
                // coming from the frontend pipeline, but the LLM API only accepts the bare model ID.
                // Strip the provider prefix if present; fallback to config.default_model_id.
                let model = req
                    .model_id
                    .as_deref()
                    .map(|id| id.rsplit_once('/').map(|(_, m)| m).unwrap_or(id))
                    .unwrap_or_else(|| config.default_model_id.as_str())
                    .to_string();

                // Check prompt cache — if the same model+prompt was already answered, return cached response
                let cache_key = prompt_cache::CacheKey::from_prompt(&model, &req.prompt);
                if let Some(cache) = self.prompt_cache.lock().ok().and_then(|g| g.clone())
                    && let Some(cached) = cache.get(&cache_key) {
                        tracing::info!(model = %model, "Prompt cache hit — returning cached response");
                        return Ok(cached);
                    }

                let max_tokens = req.max_tokens.unwrap_or(4096);
                // Temperature priority: request > LlmConfig setting > code default (0.0).
                let temperature = req
                    .temperature
                    .or(config.temperature)
                    .unwrap_or(timeouts::DEFAULT_LLM_TEMPERATURE);

                // Resolve API URL from config.base_url.
                // The base_url may be either a full endpoint (ending with /chat/completions)
                // or a base URL (e.g. "https://api.openai.com/v1"). When it's a base URL,
                // we append the appropriate path based on the provider.
                // If no base_url is configured, this is a misconfiguration — the frontend
                // should always provide one, so we return a clear error instead of silently
                // falling back to localhost:11434 (which was the old behavior that caused
                // "Failed to reach LLM API at http://localhost:11434/v1/chat/completions").
                let api_url = match &config.base_url {
                    Some(url) => resolve_api_url(url, &config.provider),
                    None => {
                        return Err(unified_error::UnifiedError::Configuration(
                            "No LLM base URL configured. Please select a model with a valid provider in Settings.".to_string(),
                        ));
                    }
                };

                // Resolve API key: prefer direct `api_key` value, then `api_key_env` env var.
                let api_key = config.api_key.clone().or_else(|| {
                    config
                        .api_key_env
                        .as_ref()
                        .and_then(|env_var| std::env::var(env_var).ok())
                });

                let llm_request = LlmRequest {
                    model,
                    messages: vec![LlmMessage::user(&req.prompt)],
                    max_tokens: Some(max_tokens),
                    temperature: Some(temperature),
                    stream: None,
                    tools: None,
                    tool_choice: None,
                    response_format: None,
                    top_k: None,
                    top_p: None,
                    extra_body: None,
                };

                // [LLM-05] Cross-model fallback when the primary model is unavailable.
                let response = crate::llm::call_llm_with_fallback(
                    &api_url,
                    api_key.as_deref(),
                    &llm_request,
                    cancel_token,
                    config.max_retry_attempts.unwrap_or(timeouts::MAX_ATTEMPTS),
                    config.fallback_models.as_deref().unwrap_or(&[]),
                )
                .await?;
                // Write to prompt cache on success
                if let Some(cache) = self.prompt_cache.lock().ok().and_then(|g| g.clone()) {
                    cache.put(cache_key, response.clone());
                }
                Ok(response)
            }
            None => {
                // Phase 1: no LLM configured — return orchestration placeholder.
                let truncated = truncate_str(&req.prompt, 100);
                Ok(LlmResponse {
                    content: format!(
                        "[Orchestration] Prompt received but no LLM configured. Prompt: {}",
                        truncated
                    ),
                    reasoning_content: None,
                    model_id: Some("orchestrator".to_string()),
                    token_usage: TokenUsage {
                        prompt_tokens: 0,
                        completion_tokens: 0,
                        total_tokens: 0,
                        ..Default::default()
                    },
                    finish_reason: Some("orchestrator_passthrough".to_string()),
                    tool_calls: None,
                })
            }
        }
    }
}

/// Resolve the full API endpoint URL from a base URL and provider type.
///
/// The Rust `call_llm` function only supports the **OpenAI chat-completions**
/// request/response format. Therefore **all** providers must resolve to an
/// endpoint that accepts OpenAI-compatible requests (i.e. `/chat/completions`).
///
/// - If the URL already ends with `/chat/completions`, use it as-is.
/// - Otherwise, append `/chat/completions`.
///
/// NOTE: Anthropic's native `/v1/messages` endpoint uses a completely different
/// request/response format and is NOT compatible with `call_llm`. Users who
/// want to use Anthropic models through this pipeline must route through an
/// OpenAI-compatible proxy (e.g. litellm, openrouter) that translates the
/// protocol. In that case the `base_url` will point to the proxy, not Anthropic
/// directly, and `/chat/completions` is the correct path.
pub fn resolve_api_url(base_url: &str, _provider: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');

    // Already a full endpoint — use as-is
    if trimmed.ends_with("/chat/completions") {
        return trimmed.to_string();
    }

    // All providers use the OpenAI-compatible chat completions endpoint
    format!("{}/chat/completions", trimmed)
}

impl Default for AgentExecutor {
    fn default() -> Self {
        Self::new().expect("Failed to initialize AgentExecutor")
    }
}

/// `LlmJudge` adapter so `QualityPipeline` can ask the user's currently
/// configured LLM whether an edit is correct (问题1). The pipeline depends only
/// on the `LlmJudge` trait (no cyclic dep on `agent-executor`).
#[async_trait::async_trait]
impl LlmJudge for AgentExecutor {
    async fn judge(&self, prompt: &str) -> anyhow::Result<String> {
        let req = LlmExecuteRequest {
            prompt: prompt.to_string(),
            model_id: None,
            max_tokens: Some(1024),
            temperature: Some(0.0),
            project_path: None,
        };
        let resp = self
            .execute_prompt(&req, CancellationToken::new())
            .await
            .map_err(|e| anyhow::anyhow!("LLM judge call failed: {e}"))?;
        Ok(resp.content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_executor_has_no_llm_configured() {
        let exec = AgentExecutor::new().unwrap();
        assert!(!exec.with_llm());
    }

    #[test]
    fn set_llm_config_with_base_url_enables_with_llm() {
        let exec = AgentExecutor::new().unwrap();
        let config = LlmConfig {
            provider: "openai".to_string(),
            api_key_env: None,
            api_key: None,
            base_url: Some("https://api.openai.com/v1".to_string()),
            default_model_id: "gpt-4".to_string(),
            ..Default::default()
        };
        exec.set_llm_config(config);
        assert!(exec.with_llm());
    }

    #[test]
    fn set_llm_config_without_base_url_disables_with_llm() {
        let exec = AgentExecutor::new().unwrap();
        let config = LlmConfig {
            provider: "openai".to_string(),
            api_key_env: None,
            api_key: None,
            base_url: None,
            default_model_id: "gpt-4".to_string(),
            ..Default::default()
        };
        exec.set_llm_config(config);
        assert!(!exec.with_llm());
    }

    #[test]
    fn set_llm_config_with_empty_base_url_disables_with_llm() {
        let exec = AgentExecutor::new().unwrap();
        let config = LlmConfig {
            provider: "openai".to_string(),
            api_key_env: None,
            api_key: None,
            base_url: Some(String::new()),
            default_model_id: "gpt-4".to_string(),
            ..Default::default()
        };
        exec.set_llm_config(config);
        assert!(!exec.with_llm());
    }

    #[test]
    fn set_llm_config_with_whitespace_base_url_disables_with_llm() {
        let exec = AgentExecutor::new().unwrap();
        let config = LlmConfig {
            provider: "openai".to_string(),
            api_key_env: None,
            api_key: None,
            base_url: Some("   ".to_string()),
            default_model_id: "gpt-4".to_string(),
            ..Default::default()
        };
        exec.set_llm_config(config);
        assert!(!exec.with_llm());
    }

    #[test]
    fn resolve_api_url_appends_chat_completions_for_openai() {
        assert_eq!(
            resolve_api_url("https://api.openai.com/v1", "openai"),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn resolve_api_url_appends_chat_completions_for_anthropic_too() {
        // Anthropic must also use /chat/completions because call_llm only
        // supports OpenAI-compatible format. Users need a proxy like openrouter.
        assert_eq!(
            resolve_api_url("https://api.anthropic.com/v1", "anthropic"),
            "https://api.anthropic.com/v1/chat/completions"
        );
    }

    #[test]
    fn resolve_api_url_uses_full_endpoint_as_is() {
        assert_eq!(
            resolve_api_url("https://api.openai.com/v1/chat/completions", "openai"),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn resolve_api_url_handles_trailing_slash() {
        assert_eq!(
            resolve_api_url("https://api.openai.com/v1/", "openai"),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn resolve_api_url_ollama_base_url() {
        assert_eq!(
            resolve_api_url("http://localhost:11434/v1", "ollama"),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[tokio::test]
    async fn execute_prompt_without_base_url_returns_error() {
        let exec = AgentExecutor::new().unwrap();
        let config = LlmConfig {
            provider: "openai".to_string(),
            api_key_env: None,
            api_key: None,
            base_url: None,
            default_model_id: "gpt-4".to_string(),
            ..Default::default()
        };
        exec.set_llm_config(config);
        let req = LlmExecuteRequest {
            prompt: "hello".to_string(),
            model_id: None,
            max_tokens: None,
            temperature: None,
            project_path: None,
        };
        let result = exec
            .execute_prompt(&req, tokio_util::sync::CancellationToken::new())
            .await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("No LLM base URL configured"),
            "Expected base URL error, got: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn execute_prompt_without_config_returns_orchestration_result() {
        let exec = AgentExecutor::new().unwrap();
        let req = LlmExecuteRequest {
            prompt: "hello world".to_string(),
            model_id: None,
            max_tokens: None,
            temperature: None,
            project_path: None,
        };
        let resp = exec
            .execute_prompt(&req, tokio_util::sync::CancellationToken::new())
            .await
            .unwrap();
        assert!(resp.content.contains("[Orchestration]"));
        assert!(resp.content.contains("hello world"));
        assert_eq!(resp.model_id.as_deref(), Some("orchestrator"));
        assert_eq!(resp.token_usage.total_tokens, 0);
    }

    #[tokio::test]
    async fn execute_prompt_truncates_long_prompt_in_orchestration_mode() {
        let exec = AgentExecutor::new().unwrap();
        let long_prompt = "x".repeat(200);
        let req = LlmExecuteRequest {
            prompt: long_prompt,
            model_id: None,
            max_tokens: None,
            temperature: None,
            project_path: None,
        };
        let resp = exec
            .execute_prompt(&req, tokio_util::sync::CancellationToken::new())
            .await
            .unwrap();
        assert!(resp.content.contains("[Orchestration]"));
        // The truncated portion should be at most 100 chars of the prompt
        let prompt_part = resp.content.split("Prompt: ").nth(1).unwrap();
        assert!(prompt_part.len() <= 100);
    }

    #[test]
    fn truncate_str_respects_utf8_boundaries() {
        // ASCII — no boundary issue
        assert_eq!(truncate_str("hello world", 5), "hello");

        // Chinese characters — each char is 3 bytes in UTF-8
        // "做" = bytes 0..3, "一" = bytes 3..6, "个" = bytes 6..9
        // Truncating at byte 8: not a char boundary → back up to 6 → "做一"
        let chinese = "做一个html小游戏";
        assert_eq!(truncate_str(chinese, 8), "做一");
        // Truncating at byte 5: not a char boundary → back up to 3 → "做"
        assert_eq!(truncate_str(chinese, 5), "做");
        // Truncating at byte 6: exactly at "一"/"个" boundary → "做一"
        assert_eq!(truncate_str(chinese, 6), "做一");
        // Truncating at byte 3: exactly at "做"/"一" boundary → "做"
        assert_eq!(truncate_str(chinese, 3), "做");

        // String shorter than max_bytes — returned as-is
        assert_eq!(truncate_str("短", 100), "短");

        // Mixed ASCII + Chinese: "abc做" = 6 bytes (1+1+1+3)
        // Truncating at 4 bytes: not a boundary → back up to 3 → "abc"
        let mixed = "abc做一个";
        assert_eq!(truncate_str(mixed, 4), "abc");
        // Truncating at 5 bytes: not a boundary → back up to 3 → "abc"
        assert_eq!(truncate_str(mixed, 5), "abc");
        // Truncating at 6 bytes: at boundary → "abc做"
        assert_eq!(truncate_str(mixed, 6), "abc做");

        // Zero max_bytes
        assert_eq!(truncate_str("任何内容", 0), "");
    }

    #[tokio::test]
    async fn execute_prompt_truncates_chinese_without_panic() {
        let exec = AgentExecutor::new().unwrap();
        // A long Chinese prompt that would panic with naive byte slicing at 100
        let long_chinese = "做一个html赛车类小游戏".repeat(20);
        let req = LlmExecuteRequest {
            prompt: long_chinese.clone(),
            model_id: None,
            max_tokens: None,
            temperature: None,
            project_path: None,
        };
        // Should NOT panic
        let resp = exec
            .execute_prompt(&req, tokio_util::sync::CancellationToken::new())
            .await
            .unwrap();
        assert!(resp.content.contains("[Orchestration]"));
        assert!(resp.content.contains("做一个"));
    }
}
