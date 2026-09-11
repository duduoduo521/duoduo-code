//! Unified tool registry: overlays on top of dispatch.rs, not a replacement.
//!
//! Phase 1: builtin tools are registered by wrapping existing `ToolHandler` fn
//! pointers. MCP tools are registered with `ToolExecutor::Mcp`. The `dispatch`
//! function in `dispatch.rs` consults this registry FIRST, then falls back to
//! the legacy `TOOL_REGISTRY` / `DYNAMIC_REGISTRY` / MCP hardcoded branch.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use anyhow::{Result, anyhow};
use serde_json::Value;

use super::model::{CapabilitySource, NormalizedTool, ToolExecutor};
use tracing::info;

/// Unified tool registry. Thread-safe (RwLock), shared across runs.
pub struct GearToolRegistry {
    tools: RwLock<HashMap<String, Arc<NormalizedTool>>>,
}

impl GearToolRegistry {
    pub fn new() -> Self {
        Self { tools: RwLock::new(HashMap::new()) }
    }

    /// Register a tool. Aliases should be registered separately.
    pub fn register(&self, tool: Arc<NormalizedTool>) {
        if let Ok(mut map) = self.tools.write() {
            map.insert(tool.name.clone(), tool);
        }
    }

    /// Remove all tools for a given source (used on gear disable/uninstall).
    pub fn remove_by_prefix(&self, prefix: &str) {
        if let Ok(mut map) = self.tools.write() {
            map.retain(|k, _| !k.starts_with(prefix));
        }
    }

    /// Remove a single tool by name.
    pub fn remove(&self, name: &str) {
        if let Ok(mut map) = self.tools.write() {
            map.remove(name);
        }
    }

    pub fn get(&self, name: &str) -> Option<Arc<NormalizedTool>> {
        self.tools.read().ok()?.get(name).cloned()
    }

    /// All LLM-facing tool definitions.
    pub fn definitions(&self) -> Vec<duo_types::ToolDefinition> {
        self.tools
            .read()
            .map(|map| map.values().map(|t| t.definition.clone()).collect())
            .unwrap_or_default()
    }

    /// Try to dispatch a tool call. Returns `None` if the tool is not registered
    /// here (caller falls back to legacy dispatch).
    ///
    /// Handles MCP and Plugin executors. Builtin executors require
    /// `try_execute_with_ctx` (they need the AgenticLoopExecutor reference).
    pub async fn try_execute(&self, name: &str, args: &Value) -> Option<Result<String>> {
        let tool = self.get(name)?;
        Some(match &tool.executor {
            ToolExecutor::Builtin { .. } => {
                Err(anyhow!("builtin tool '{}' requires try_execute_with_ctx", name))
            }
            ToolExecutor::Mcp { server_key: _ } => {
                crate::mcp::call_mcp_tool(name, args).await
            }
            ToolExecutor::Plugin { instance_id } => {
                Err(anyhow!("plugin backend not yet implemented (instance: {instance_id})"))
            }
        })
    }

    /// Execute a tool with full context (supports all executor types including Builtin).
    ///
    /// This is the unified execution path: dispatch.rs should prefer this over
    /// the legacy TOOL_REGISTRY scan + DYNAMIC_REGISTRY scan + MCP prefix check.
    pub async fn try_execute_with_ctx(
        &self,
        name: &str,
        args: &Value,
        exec: &crate::agentic_loop::AgenticLoopExecutor,
        files_read: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        read_reservations: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    ) -> Option<Result<String>> {
        let tool = self.get(name)?;
        Some(match &tool.executor {
            ToolExecutor::Builtin { handler } => {
                (handler)(exec, args, files_read, read_reservations).await
            }
            ToolExecutor::Mcp { server_key: _ } => {
                crate::mcp::call_mcp_tool(name, args).await
            }
            ToolExecutor::Plugin { instance_id } => {
                // Route Plugin tool calls through the backend that owns this
                // instance id. TS and WASM backends use disjoint id namespaces
                // (ts-plugin-N / wasm-plugin-N), so we probe TS first, then WASM.
                use super::backend::PluginBackend;
                let ts = super::ts_backend::global_ts_backend();
                if let Some(plugin_ref) = ts.get_instance(instance_id).await {
                    ts.call(&plugin_ref, name, args)
                        .await
                        .map_err(|e| anyhow::anyhow!(e))
                } else {
                    let wasm = super::wasm_backend::global_wasm_backend();
                    match wasm.get_instance(instance_id).await {
                        Some(plugin_ref) => wasm
                            .call(&plugin_ref, name, args)
                            .await
                            .map_err(|e| anyhow::anyhow!(e)),
                        None => Err(anyhow!(
                            "plugin instance '{instance_id}' not found (was it loaded via install?)"
                        )),
                    }
                }
            }
        })
    }

    /// Number of registered tools (for diagnostics).
    pub fn len(&self) -> usize {
        self.tools.read().map(|m| m.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for GearToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Process-global gear tool registry. Initialized once, shared across all runs.
static GEAR_REGISTRY: std::sync::OnceLock<GearToolRegistry> = std::sync::OnceLock::new();

/// Get the global gear tool registry (created on first access).
pub fn global() -> &'static GearToolRegistry {
    GEAR_REGISTRY.get_or_init(GearToolRegistry::new)
}

/// Register every builtin tool from the legacy `dispatch::TOOL_REGISTRY` into the
/// global GearToolRegistry exactly once.
///
/// After this runs, `dispatch()` routes builtins through the unified registry and
/// no longer needs to scan the legacy `TOOL_REGISTRY` slice. This is the single
/// source of truth for builtin registration: both `GearHost::register_builtins()`
/// and `dispatch()` converge here, and it is idempotent via `OnceLock`.
pub fn ensure_builtins_registered() {
    static INIT: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    INIT.get_or_init(|| {
        let reg = global();
        for entry in crate::tools::dispatch::TOOL_REGISTRY.iter() {
            let canonical = entry.names.first().unwrap_or(&"unknown");
            let definition = entry.meta.map(|m| m());
            for name in entry.names.iter() {
                let tool = Arc::new(NormalizedTool {
                    name: name.to_string(),
                    definition: definition.clone().unwrap_or_else(|| duo_types::ToolDefinition {
                        r#type: "function".into(),
                        function: duo_types::FunctionDefinition {
                            name: name.to_string(),
                            description: String::new(),
                            parameters: serde_json::json!({"type":"object","properties":{}}),
                        },
                    }),
                    source: CapabilitySource::Builtin,
                    executor: ToolExecutor::Builtin { handler: entry.handler },
                });
                reg.register(tool);
            }
            info!(tool = %canonical, aliases = ?entry.names, "builtin tool registered in GearToolRegistry");
        }
    });
}
