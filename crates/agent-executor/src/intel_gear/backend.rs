//! PluginBackend trait + types (01 §4.3, 03 §二).
//!
//! Phase 2 skeleton: defines the trait and types. NativeWasmBackend requires
//! wasmtime (not yet added); LegacyTsBackend requires IPC to duoduo subprocess.
//! Both are stubbed — the trait is ready for implementation when backends land.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

/// Internal tool definition (flat format + annotations).
/// Converted to `duo_types::ToolDefinition` for LLM via `From` impl.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GearToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(default)]
    pub annotations: Option<ToolAnnotations>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ToolAnnotations {
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub destructive: bool,
    #[serde(default)]
    pub network: bool,
}

impl From<&GearToolDefinition> for duo_types::ToolDefinition {
    fn from(g: &GearToolDefinition) -> Self {
        duo_types::ToolDefinition {
            r#type: "function".into(),
            function: duo_types::FunctionDefinition {
                name: g.name.clone(),
                description: g.description.clone(),
                parameters: g.input_schema.clone(),
            },
        }
    }
}

/// Plugin install target (projected from GearSpec when source=Plugin).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginSpec {
    pub raw: String,
    pub source: PluginSource,
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PluginSource {
    Npm,
    File,
    /// A compiled WebAssembly component implementing the `duoduo:gear-plugin`
    /// world (see `intel_gear/wit/gear-plugin.wit`). Loaded via the wasm backend.
    Wasm,
}

/// Runtime handle for a loaded plugin instance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginRef {
    pub spec: PluginSpec,
    pub backend: String,
    pub instance_id: String,
}

/// Result of loading a plugin.
pub struct PluginLoadResult {
    pub plugin: PluginRef,
    pub tools: Vec<GearToolDefinition>,
}

/// Pluggable execution backend for plugins (01 §4.3).
///
/// Implementations:
/// - `NativeWasmBackend`: wasmtime component model (Phase 2+, requires wasmtime dep)
/// - `LegacyTsBackend`: controlled subprocess IPC to duoduo PluginLoader (temporary)
#[allow(async_fn_in_trait)]
pub trait PluginBackend: Send + Sync {
    /// Load a plugin, returning its instance handle and exposed tools.
    fn load(
        &self,
        spec: &PluginSpec,
    ) -> impl std::future::Future<Output = anyhow::Result<PluginLoadResult>> + Send;

    /// Execute a tool call (caller guarantees permission middleware has passed).
    fn call(
        &self,
        plugin: &PluginRef,
        tool: &str,
        args: &Value,
    ) -> impl std::future::Future<Output = anyhow::Result<String>> + Send;

    /// Unload (called on gear disable/uninstall).
    fn unload(
        &self,
        plugin: &PluginRef,
    ) -> impl std::future::Future<Output = anyhow::Result<()>> + Send;
}
