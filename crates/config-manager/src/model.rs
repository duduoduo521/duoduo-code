//! Configuration model definitions for DuoDuo smart layer.

use serde::{Deserialize, Serialize};

// Re-export the unified MemoryConfig from duo-types so that all crates
// share a single definition.
pub use duo_types::MemoryConfig;

// Re-export ImConfig from im-bridge so all crates share one definition.
pub use im_bridge::config::ImConfig;

/// Top-level configuration for the DuoDuo smart layer.
#[derive(Debug, Clone, Deserialize)]
pub struct SmartLayerConfig {
    /// Port to listen on. `0` means OS assigns a random available port.
    pub port: u16,
    /// Hostname to bind to.
    pub hostname: String,
    /// Logging level (trace, debug, info, warn, error).
    pub log_level: String,
    /// Optional authentication token for securing the smart layer endpoint.
    pub auth_token: Option<String>,
    /// Memory subsystem configuration.
    pub memory: MemoryConfig,
    /// Security policy configuration.
    pub security: SecurityConfig,
    /// IM bridge configuration (Feishu).
    pub im: ImConfig,
    /// Loop-specific configuration (optional, progressive adoption).
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "loop")]
    pub loop_config: Option<LoopConfig>,
}

impl Serialize for SmartLayerConfig {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut field_count = 6;
        if self.auth_token.is_some() {
            field_count += 1;
        }
        if self.loop_config.is_some() {
            field_count += 1;
        }
        let mut state = serializer.serialize_struct("SmartLayerConfig", field_count)?;
        state.serialize_field("port", &self.port)?;
        state.serialize_field("hostname", &self.hostname)?;
        state.serialize_field("log_level", &self.log_level)?;
        // Mask auth_token for security
        if let Some(ref token) = self.auth_token {
            let masked = if token.len() <= 8 {
                "***".to_string()
            } else {
                format!("{}***{}", &token[..4], &token[token.len() - 4..])
            };
            state.serialize_field("auth_token", &masked)?;
        }
        state.serialize_field("memory", &self.memory)?;
        state.serialize_field("security", &self.security)?;
        state.serialize_field("im", &self.im)?;
        if let Some(ref lc) = self.loop_config {
            state.serialize_field("loop", lc)?;
        }
        state.end()
    }
}

impl Default for SmartLayerConfig {
    fn default() -> Self {
        Self {
            port: 0,
            hostname: duo_types::DEFAULT_HOSTNAME.to_string(),
            log_level: duo_types::DEFAULT_LOG_LEVEL.to_string(),
            auth_token: None,
            memory: MemoryConfig::default(),
            security: SecurityConfig::default(),
            im: ImConfig::default(),
            loop_config: None,
        }
    }
}

/// Loop optimization configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopConfig {
    /// Enable explicit reflection in agent loop.
    /// Documented default is ON (see loop汇总实施方案.md §P4/P6:
    /// "「审校」开关 = LoopConfig.reflect（默认 true，已有）").
    #[serde(default = "default_true")]
    pub reflect: bool,
    /// Enable the L1 syntax gate (tree-sitter) on file writes. Default true.
    /// When false, writes skip the syntax check (expert escape hatch).
    #[serde(default = "default_syntax_check")]
    pub syntax_check: bool,
    /// Reflection trigger mode: "always", "keypoint", "never".
    #[serde(default = "default_reflect_on")]
    pub reflect_on: String,
    /// Maximum tokens for reflection prompt.
    #[serde(default = "default_reflect_budget")]
    pub reflect_budget_tokens: u32,
    /// Search tool preferences.
    #[serde(default)]
    pub search: SearchConfig,
    /// Quality pipeline settings.
    #[serde(default)]
    pub quality: QualityConfig,
    /// Intent awareness settings.
    #[serde(default)]
    pub intent: IntentConfig,
    /// Feedback loop settings.
    #[serde(default)]
    pub feedback: FeedbackConfig,
    /// Blackboard coordination settings.
    #[serde(default)]
    pub blackboard: BlackboardConfig,
    /// G7: parallel multi-agent dispatch. When true, `run_loop_handler` fans
    /// out independent sub-tasks to multiple `AgenticLoopExecutor` instances
    /// that run concurrently (each writes through the shared blackboard's
    /// `FileLockManager` exclusive lock (single winner) + under-lock read + optimistic version check, so concurrent writes stay
    /// safe). Default **false** → the existing single-agent loop is byte-for-
    /// byte unchanged. This is the zero-risk toggle for G7.
    #[serde(default)]
    pub parallel_dispatch: bool,
    /// Maximum number of agentic-loop tool-call rounds (the loop safety guard).
    /// User-configurable so long-running agents (e.g. large multi-file bug fixes)
    /// are not hard-capped at the compile-time `MAX_STEPS` constant.
    /// Resolved at runtime by `run_loop_handler` with precedence:
    /// per-request `max_steps` > `LoopConfig.max_steps` > `MAX_STEPS`.
    ///
    /// Semantics: a positive value is the hard cap (tools disabled + text-only
    /// summary once reached); `0` means "no tools at all" (immediate stop);
    /// `-1` means "unlimited" (no step cap — relies on the completion/truncation
    /// guards and the user's Stop button instead). Default **-1** (unlimited),
    /// aligned with letting the LLM drive task scope.
    #[serde(default = "default_max_steps")]
    pub max_steps: i32,
}

impl Default for LoopConfig {
    fn default() -> Self {
        Self {
            reflect: default_true(),
            syntax_check: default_syntax_check(),
            reflect_on: default_reflect_on(),
            reflect_budget_tokens: default_reflect_budget(),
            search: SearchConfig::default(),
            quality: QualityConfig::default(),
            intent: IntentConfig::default(),
            feedback: FeedbackConfig::default(),
            blackboard: BlackboardConfig::default(),
            parallel_dispatch: false,
            max_steps: default_max_steps(),
        }
    }
}

fn default_reflect_on() -> String {
    "keypoint".to_string()
}
fn default_reflect_budget() -> u32 {
    150
}
fn default_syntax_check() -> bool {
    true
}
fn default_max_steps() -> i32 {
    -1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchConfig {
    #[serde(default = "default_true")]
    pub prefer_graph: bool,
    #[serde(default = "default_true")]
    pub prefer_symbol: bool,
    #[serde(default = "default_true")]
    pub grep_fallback: bool,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            prefer_graph: true,
            prefer_symbol: true,
            grep_fallback: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityConfig {
    #[serde(default)]
    pub mid_loop_check: bool,
    #[serde(default = "default_self_check")]
    pub mid_loop_level: String,
    #[serde(default = "default_retry_score")]
    pub retry_on_score_below: f64,
}

impl Default for QualityConfig {
    fn default() -> Self {
        Self {
            mid_loop_check: false,
            mid_loop_level: "SelfCheck".to_string(),
            retry_on_score_below: 0.5,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentConfig {
    #[serde(default)]
    pub clarify_before_loop: bool,
    #[serde(default)]
    pub skip_loop_for_questions: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackConfig {
    #[serde(default)]
    pub adjust_strategy_on_low_score: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlackboardConfig {
    #[serde(default)]
    pub notify_changes: bool,
    #[serde(default)]
    pub warn_public_resource: bool,
}

fn default_true() -> bool {
    true
}
fn default_self_check() -> String {
    "SelfCheck".to_string()
}
fn default_retry_score() -> f64 {
    0.5
}

/// Security policy configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityConfig {
    /// Filesystem paths that the smart layer is allowed to access.
    pub allowed_paths: Vec<String>,
    /// Shell commands that are explicitly blocked from execution.
    pub blocked_commands: Vec<String>,
    /// Maximum allowed file size in bytes for read/write operations.
    pub max_file_size_bytes: u64,
    /// Whether to require user confirmation before executing dangerous operations.
    pub require_confirmation: bool,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            allowed_paths: Vec::new(),
            blocked_commands: Vec::new(),
            max_file_size_bytes: 10 * 1024 * 1024, // 10 MB
            require_confirmation: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smart_layer_config_default_values() {
        let config = SmartLayerConfig::default();
        assert_eq!(config.port, 0);
        assert_eq!(config.hostname, duo_types::DEFAULT_HOSTNAME);
        assert_eq!(config.log_level, duo_types::DEFAULT_LOG_LEVEL);
        assert!(config.auth_token.is_none());
    }

    #[test]
    fn memory_config_default_values() {
        let config = SecurityConfig::default();
        assert!(config.allowed_paths.is_empty());
        assert!(config.blocked_commands.is_empty());
        assert_eq!(config.max_file_size_bytes, 10 * 1024 * 1024);
        assert!(config.require_confirmation);
    }

    #[test]
    fn config_roundtrip_toml() {
        let config = SmartLayerConfig::default();
        let toml_str = toml::to_string(&config).expect("serialize to toml");
        let parsed: SmartLayerConfig = toml::from_str(&toml_str).expect("deserialize from toml");
        assert_eq!(parsed.port, config.port);
        assert_eq!(parsed.hostname, config.hostname);
        assert_eq!(parsed.log_level, config.log_level);
        assert_eq!(parsed.memory.max_entries, config.memory.max_entries);
        assert_eq!(
            parsed.security.max_file_size_bytes,
            config.security.max_file_size_bytes
        );
    }
}
