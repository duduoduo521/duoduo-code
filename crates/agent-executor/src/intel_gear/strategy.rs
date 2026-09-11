//! Strategy: pluggable execution loop parameters.
//!
//! Phase 2: strategies parameterize the agentic loop (max_rounds, tool filtering,
//! termination hints) rather than replacing the loop body. The loop in
//! `agentic_loop.rs` reads `StrategyParams` to adjust its behavior.
//!
//! Phase 3 (future): strategies will own the full loop via `Strategy::run`.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use anyhow::Result;

/// Parameters that a strategy contributes to the agentic loop.
///
/// The loop reads these to adjust its behavior without the strategy
/// owning the full loop body (Phase 2 approach).
#[derive(Debug, Clone)]
pub struct StrategyParams {
    /// Maximum number of LLM rounds. Overrides the default if set.
    pub max_rounds: Option<usize>,
    /// Tool name filter: if non-empty, only these tools are exposed to the LLM.
    /// Empty = all tools available.
    pub tool_filter: Vec<String>,
    /// Tools to explicitly exclude (blacklist). Applied after tool_filter.
    pub tool_exclude: Vec<String>,
    /// Whether the strategy allows file-writing tools.
    /// `false` = read-only mode (explore strategy).
    pub allow_write: bool,
    /// Whether the strategy requires a submit_code terminal action.
    /// `true` = loop won't terminate until submit_code is called.
    pub require_submit: bool,
    /// Additional system prompt fragment injected by the strategy.
    pub system_prompt_addition: Option<String>,
    /// Early termination hint: if the LLM output contains this pattern,
    /// the loop can terminate early (before max_rounds).
    pub early_stop_pattern: Option<String>,
}

impl Default for StrategyParams {
    fn default() -> Self {
        Self {
            max_rounds: None,
            tool_filter: Vec::new(),
            tool_exclude: Vec::new(),
            allow_write: true,
            require_submit: false,
            system_prompt_addition: None,
            early_stop_pattern: None,
        }
    }
}

impl StrategyParams {
    /// Check if a tool name is allowed by this strategy's filters.
    pub fn is_tool_allowed(&self, tool_name: &str) -> bool {
        // Blacklist takes priority
        if self.tool_exclude.iter().any(|t| t == tool_name) {
            return false;
        }
        // If whitelist is empty, all tools are allowed
        if self.tool_filter.is_empty() {
            return true;
        }
        // Otherwise, only whitelisted tools
        self.tool_filter.iter().any(|t| t == tool_name)
    }

    /// Filter a list of tool definitions, keeping only allowed tools.
    pub fn filter_tools(&self, tools: Vec<duo_types::ToolDefinition>) -> Vec<duo_types::ToolDefinition> {
        if self.tool_filter.is_empty() && self.tool_exclude.is_empty() {
            return tools;
        }
        tools
            .into_iter()
            .filter(|t| self.is_tool_allowed(&t.function.name))
            .collect()
    }
}

/// Outcome of a strategy run (Phase 3: full loop ownership).
#[derive(Debug, Clone)]
pub enum StrategyOutcome {
    Completed(String),
    Aborted(String),
}

/// A pluggable execution strategy.
///
/// Phase 2: strategies provide `params()` to parameterize the loop.
/// Phase 3 (future): strategies will implement `run()` to own the full loop.
#[allow(async_fn_in_trait)]
pub trait Strategy: Send + Sync {
    fn name(&self) -> &str;

    /// Return strategy parameters that influence the agentic loop.
    fn params(&self) -> StrategyParams;

    /// Run a full task loop. The strategy drives the shared agentic-loop kernel
    /// (via `AgenticLoopExecutor::run_with_strategy`) using its own `params()`,
    /// so the strategy owns rounds / tool selection / termination (Phase 3).
    fn run(
        &self,
        exec: &crate::agentic_loop::AgenticLoopExecutor,
        system_prompt: &str,
        task_prompt: &str,
        tool_set: crate::agentic_loop::LoopToolSet,
    ) -> impl std::future::Future<Output = Result<String>> + Send;
}

/// Registry for strategies (builtin + custom).
pub struct StrategyRegistry {
    strategies: RwLock<HashMap<String, Arc<dyn StrategyDyn>>>,
    default: RwLock<String>,
}

/// Object-safe wrapper for Strategy.
pub trait StrategyDyn: Send + Sync {
    fn name(&self) -> &str;
    fn params(&self) -> StrategyParams;
    fn run<'a>(
        &'a self,
        exec: &'a crate::agentic_loop::AgenticLoopExecutor,
        system_prompt: &'a str,
        task_prompt: &'a str,
        tool_set: crate::agentic_loop::LoopToolSet,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send + 'a>>;
}

impl<T: Strategy> StrategyDyn for T {
    fn name(&self) -> &str { Strategy::name(self) }
    fn params(&self) -> StrategyParams { Strategy::params(self) }
    fn run<'a>(
        &'a self,
        exec: &'a crate::agentic_loop::AgenticLoopExecutor,
        system_prompt: &'a str,
        task_prompt: &'a str,
        tool_set: crate::agentic_loop::LoopToolSet,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send + 'a>> {
        Box::pin(Strategy::run(self, exec, system_prompt, task_prompt, tool_set))
    }
}

impl StrategyRegistry {
    pub fn new() -> Self {
        Self {
            strategies: RwLock::new(HashMap::new()),
            default: RwLock::new("codegen".into()),
        }
    }

    pub fn register(&self, s: Arc<dyn StrategyDyn>) {
        if let Ok(mut map) = self.strategies.write() {
            map.insert(s.name().to_string(), s);
        }
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn StrategyDyn>> {
        self.strategies.read().ok()?.get(name).cloned()
    }

    pub fn set_default(&self, name: &str) {
        if let Ok(mut d) = self.default.write() {
            *d = name.to_string();
        }
    }

    pub fn default_name(&self) -> String {
        self.default.read().map(|d| d.clone()).unwrap_or_else(|_| "codegen".into())
    }

    /// Get strategy params by name (or default).
    pub fn params(&self, name: Option<&str>) -> StrategyParams {
        let default = self.default_name();
        let name = name.unwrap_or(&default);
        self.get(name)
            .map(|s| s.params())
            .unwrap_or_default()
    }

    /// Run a strategy by name (or default). The strategy drives the real
    /// agentic loop via `AgenticLoopExecutor::run_with_strategy` (Phase 3).
    pub async fn run(
        &self,
        name: Option<&str>,
        exec: &crate::agentic_loop::AgenticLoopExecutor,
        system_prompt: &str,
        task_prompt: &str,
        tool_set: crate::agentic_loop::LoopToolSet,
    ) -> Result<String> {
        let default = self.default_name();
        let name = name.unwrap_or(&default);
        let strategy = self.get(name)
            .ok_or_else(|| anyhow::anyhow!("strategy '{name}' not registered"))?;
        strategy.run(exec, system_prompt, task_prompt, tool_set).await
    }

    pub fn list(&self) -> Vec<String> {
        self.strategies.read().map(|m| m.keys().cloned().collect()).unwrap_or_default()
    }
}

impl Default for StrategyRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ── Builtin strategies ──

/// Codegen strategy: the default agentic loop.
///
/// Allows all tools, requires submit_code for termination,
/// uses the default max_rounds from config.
pub struct CodegenStrategy;
impl Strategy for CodegenStrategy {
    fn name(&self) -> &str { "codegen" }

    fn params(&self) -> StrategyParams {
        StrategyParams {
            max_rounds: None, // use config default
            tool_filter: Vec::new(), // all tools
            tool_exclude: Vec::new(),
            allow_write: true,
            require_submit: true,
            system_prompt_addition: None,
            early_stop_pattern: None,
        }
    }

    async fn run(
        &self,
        exec: &crate::agentic_loop::AgenticLoopExecutor,
        system_prompt: &str,
        task_prompt: &str,
        tool_set: crate::agentic_loop::LoopToolSet,
    ) -> Result<String> {
        exec.run_with_strategy(system_prompt, task_prompt, &Strategy::params(self), tool_set)
            .await
    }
}

/// Explore strategy: read-only exploration loop.
///
/// Restricts tools to read-only operations, no submit_code required,
/// lower max_rounds for efficiency.
pub struct ExploreStrategy;
impl Strategy for ExploreStrategy {
    fn name(&self) -> &str { "explore" }

    fn params(&self) -> StrategyParams {
        StrategyParams {
            max_rounds: Some(10), // exploration is bounded
            tool_filter: vec![
                "read_file".into(),
                "list_files".into(),
                "search_codebase".into(),
                "search_content".into(),
                "search_file".into(),
                "get_problems".into(),
                "run_terminal_cmd".into(), // allow read-only commands
                "fetch_content".into(),
                "web_search".into(),
                "use_mcp_tool".into(),
                "ask_user".into(),
                "todo_write".into(),
            ],
            tool_exclude: vec![
                "write_file".into(),
                "edit_file".into(),
                "submit_code".into(),
            ],
            allow_write: false,
            require_submit: false,
            system_prompt_addition: Some(
                "You are in exploration mode. Read and analyze code only. \
                 Do NOT modify any files. Provide a thorough analysis of the \
                 codebase structure, patterns, and relevant implementation details."
                    .into(),
            ),
            early_stop_pattern: None,
        }
    }

    async fn run(
        &self,
        exec: &crate::agentic_loop::AgenticLoopExecutor,
        system_prompt: &str,
        task_prompt: &str,
        tool_set: crate::agentic_loop::LoopToolSet,
    ) -> Result<String> {
        exec.run_with_strategy(system_prompt, task_prompt, &Strategy::params(self), tool_set)
            .await
    }
}

/// Review strategy: code review loop.
///
/// Read-only with focus on analysis, produces structured review output.
pub struct ReviewStrategy;
impl Strategy for ReviewStrategy {
    fn name(&self) -> &str { "review" }

    fn params(&self) -> StrategyParams {
        StrategyParams {
            max_rounds: Some(8),
            tool_filter: vec![
                "read_file".into(),
                "list_files".into(),
                "search_codebase".into(),
                "search_content".into(),
                "search_file".into(),
                "get_problems".into(),
                "run_terminal_cmd".into(),
                "ask_user".into(),
            ],
            tool_exclude: vec![
                "write_file".into(),
                "edit_file".into(),
                "submit_code".into(),
            ],
            allow_write: false,
            require_submit: false,
            system_prompt_addition: Some(
                "You are in code review mode. Analyze the code for bugs, \
                 security issues, performance problems, and style violations. \
                 Provide a structured review with severity levels."
                    .into(),
            ),
            early_stop_pattern: None,
        }
    }

    async fn run(
        &self,
        exec: &crate::agentic_loop::AgenticLoopExecutor,
        system_prompt: &str,
        task_prompt: &str,
        tool_set: crate::agentic_loop::LoopToolSet,
    ) -> Result<String> {
        exec.run_with_strategy(system_prompt, task_prompt, &Strategy::params(self), tool_set)
            .await
    }
}

/// Build default registry with builtin strategies.
pub fn default_registry() -> StrategyRegistry {
    let reg = StrategyRegistry::new();
    reg.register(Arc::new(CodegenStrategy));
    reg.register(Arc::new(ExploreStrategy));
    reg.register(Arc::new(ReviewStrategy));
    reg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strategy_params_tool_filter() {
        let params = StrategyParams {
            tool_filter: vec!["read_file".into(), "search_codebase".into()],
            tool_exclude: vec!["run_terminal_cmd".into()],
            ..Default::default()
        };
        assert!(params.is_tool_allowed("read_file"));
        assert!(params.is_tool_allowed("search_codebase"));
        assert!(!params.is_tool_allowed("write_file")); // not in whitelist
        assert!(!params.is_tool_allowed("run_terminal_cmd")); // blacklisted
    }

    #[test]
    fn strategy_params_empty_filter_allows_all() {
        let params = StrategyParams::default();
        assert!(params.is_tool_allowed("any_tool"));
        assert!(params.is_tool_allowed("write_file"));
    }

    #[test]
    fn explore_strategy_is_readonly() {
        let strategy = ExploreStrategy;
        let params = Strategy::params(&strategy);
        assert!(!params.allow_write);
        assert!(!params.is_tool_allowed("write_file"));
        assert!(!params.is_tool_allowed("edit_file"));
        assert!(params.is_tool_allowed("read_file"));
        assert!(params.is_tool_allowed("search_codebase"));
    }

    #[test]
    fn codegen_strategy_allows_all() {
        let strategy = CodegenStrategy;
        let params = Strategy::params(&strategy);
        assert!(params.allow_write);
        assert!(params.require_submit);
        assert!(params.is_tool_allowed("write_file"));
        assert!(params.is_tool_allowed("edit_file"));
    }

    #[test]
    fn review_strategy_is_readonly() {
        let strategy = ReviewStrategy;
        let params = Strategy::params(&strategy);
        assert!(!params.allow_write);
        assert!(!params.require_submit);
        assert!(params.is_tool_allowed("read_file"));
        assert!(!params.is_tool_allowed("write_file"));
    }

    #[test]
    fn filter_tools_respects_whitelist() {
        let params = StrategyParams {
            tool_filter: vec!["read_file".into()],
            ..Default::default()
        };
        let tools = vec![
            duo_types::ToolDefinition {
                r#type: "function".into(),
                function: duo_types::FunctionDefinition {
                    name: "read_file".into(),
                    description: String::new(),
                    parameters: serde_json::json!({}),
                },
            },
            duo_types::ToolDefinition {
                r#type: "function".into(),
                function: duo_types::FunctionDefinition {
                    name: "write_file".into(),
                    description: String::new(),
                    parameters: serde_json::json!({}),
                },
            },
        ];
        let filtered = params.filter_tools(tools);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].function.name, "read_file");
    }

    #[test]
    fn registry_params_lookup() {
        let reg = default_registry();
        let params = reg.params(Some("explore"));
        assert!(!params.allow_write);
        assert_eq!(params.max_rounds, Some(10));

        let params = reg.params(Some("codegen"));
        assert!(params.allow_write);
        assert!(params.max_rounds.is_none());

        // Unknown strategy falls back to default params
        let params = reg.params(Some("nonexistent"));
        assert!(params.allow_write); // default
    }
}