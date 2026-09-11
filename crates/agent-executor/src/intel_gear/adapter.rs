//! Adapter layer: normalize heterogeneous capability sources into NormalizedGear.
//!
//! Each source (native/mcp/skill/plugin/builtin) implements `CapabilityAdapter`.
//! `AdapterRegistry` holds them all; new sources just register a new adapter.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;

use super::backend::PluginSpec;
use super::model::*;

/// Input to an adapter's `normalize` — one variant per source type.
pub enum AdapterInput {
    /// Native gear pack directory (contains manifest.toml + instructions.md + tools/).
    NativePack { root: PathBuf },
    /// MCP server config entry from tools/mcp.json.
    McpEntry { gear_name: String, server_key: String },
    /// Skill markdown file path.
    SkillFile { path: PathBuf },
    /// Plugin install target.
    Plugin(PluginSpec),
    /// Builtin tool registration entry (from dispatch.rs TOOL_REGISTRY).
    BuiltinEntry {
        names: Vec<String>,
        definition: Option<duo_types::ToolDefinition>,
        handler: crate::tools::dispatch::ToolHandler,
    },
}

/// Adapter trait: normalize one source type into the kernel model.
#[allow(async_fn_in_trait)]
pub trait CapabilityAdapter: Send + Sync {
    fn source(&self) -> CapabilitySource;

    /// Normalize an input into a NormalizedGear. Must return Err on failure (never skip silently).
    fn normalize(&self, input: AdapterInput) -> impl std::future::Future<Output = Result<NormalizedGear>> + Send;

    /// Execute a tool call for sources that manage execution (mcp/plugin).
    /// Default: bail (native/builtin/skill don't execute via adapter).
    fn execute_tool(
        &self,
        _tool_name: &str,
        _args: &serde_json::Value,
    ) -> impl std::future::Future<Output = Result<String>> + Send {
        let src = self.source();
        async move { anyhow::bail!("source {src:?} does not implement execute_tool") }
    }
}

/// Registry holding all adapters, keyed by source.
pub struct AdapterRegistry {
    adapters: HashMap<CapabilitySource, Arc<dyn CapabilityAdapterDyn>>,
}

/// Object-safe wrapper (CapabilityAdapter uses async_fn_in_trait which isn't dyn-safe).
#[allow(async_fn_in_trait)]
pub trait CapabilityAdapterDyn: Send + Sync {
    fn source(&self) -> CapabilitySource;
    fn normalize<'a>(&'a self, input: AdapterInput) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<NormalizedGear>> + Send + 'a>>;
    fn execute_tool<'a>(&'a self, tool_name: &'a str, args: &'a serde_json::Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send + 'a>>;
}

/// Blanket impl: any CapabilityAdapter auto-implements CapabilityAdapterDyn.
impl<T: CapabilityAdapter> CapabilityAdapterDyn for T {
    fn source(&self) -> CapabilitySource {
        CapabilityAdapter::source(self)
    }
    fn normalize<'a>(&'a self, input: AdapterInput) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<NormalizedGear>> + Send + 'a>> {
        Box::pin(CapabilityAdapter::normalize(self, input))
    }
    fn execute_tool<'a>(&'a self, tool_name: &'a str, args: &'a serde_json::Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send + 'a>> {
        Box::pin(CapabilityAdapter::execute_tool(self, tool_name, args))
    }
}

impl AdapterRegistry {
    pub fn new() -> Self {
        Self { adapters: HashMap::new() }
    }

    pub fn register(&mut self, adapter: Arc<dyn CapabilityAdapterDyn>) {
        self.adapters.insert(adapter.source(), adapter);
    }

    pub fn get(&self, source: CapabilitySource) -> Option<&Arc<dyn CapabilityAdapterDyn>> {
        self.adapters.get(&source)
    }
}

impl Default for AdapterRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ── Concrete adapters ──

/// NativeAdapter: reads a gear pack directory.
pub struct NativeAdapter;
impl CapabilityAdapter for NativeAdapter {
    fn source(&self) -> CapabilitySource { CapabilitySource::Native }
    async fn normalize(&self, input: AdapterInput) -> Result<NormalizedGear> {
        let AdapterInput::NativePack { root } = input else {
            anyhow::bail!("NativeAdapter expects NativePack input");
        };
        super::host::normalize_native_pack(&root)
    }
}

/// McpAdapter: wraps crate::mcp for tool execution.
pub struct McpAdapter;
impl CapabilityAdapter for McpAdapter {
    fn source(&self) -> CapabilitySource { CapabilitySource::Mcp }
    async fn normalize(&self, input: AdapterInput) -> Result<NormalizedGear> {
        let AdapterInput::McpEntry { gear_name, .. } = input else {
            anyhow::bail!("McpAdapter expects McpEntry input");
        };
        let id = GearId::new(CapabilitySource::Mcp, &gear_name, "0.1.0");
        Ok(NormalizedGear {
            id,
            name: gear_name,
            description: None,
            instructions: Vec::new(),
            tools: Vec::new(), // MCP tools are registered by ensure_gear_mcp at connection time
            permissions: Default::default(),
            source: CapabilitySource::Mcp,
        })
    }
    async fn execute_tool(&self, tool_name: &str, args: &serde_json::Value) -> Result<String> {
        crate::mcp::call_mcp_tool(tool_name, args).await
    }
}

/// SkillAdapter: normalizes .md skill files.
pub struct SkillAdapter;
impl CapabilityAdapter for SkillAdapter {
    fn source(&self) -> CapabilitySource { CapabilitySource::Skill }
    async fn normalize(&self, input: AdapterInput) -> Result<NormalizedGear> {
        let AdapterInput::SkillFile { path } = input else {
            anyhow::bail!("SkillAdapter expects SkillFile input");
        };
        super::skill::normalize_skill(&path)
    }
}

/// BuiltinAdapter: wraps dispatch.rs TOOL_REGISTRY entries.
pub struct BuiltinAdapter;
impl CapabilityAdapter for BuiltinAdapter {
    fn source(&self) -> CapabilitySource { CapabilitySource::Builtin }
    async fn normalize(&self, input: AdapterInput) -> Result<NormalizedGear> {
        let AdapterInput::BuiltinEntry { names, definition, handler } = input else {
            anyhow::bail!("BuiltinAdapter expects BuiltinEntry input");
        };
        let canonical = names.first().cloned().unwrap_or_default();
        let id = GearId::new(CapabilitySource::Builtin, &canonical, "0.0.0");
        let tools = names.iter().map(|name| {
            NormalizedTool {
                name: name.clone(),
                definition: definition.clone().unwrap_or_else(|| duo_types::ToolDefinition {
                    r#type: "function".into(),
                    function: duo_types::FunctionDefinition {
                        name: name.clone(),
                        description: String::new(),
                        parameters: serde_json::json!({"type":"object","properties":{}}),
                    },
                }),
                source: CapabilitySource::Builtin,
                executor: ToolExecutor::Builtin { handler },
            }
        }).collect();
        Ok(NormalizedGear {
            id,
            name: format!("builtin:{canonical}"),
            description: None,
            instructions: Vec::new(),
            tools,
            permissions: Default::default(),
            source: CapabilitySource::Builtin,
        })
    }
}

/// PluginAdapter: normalizes plugin specs (Phase 2 — load via PluginBackend).
pub struct PluginAdapter;
impl CapabilityAdapter for PluginAdapter {
    fn source(&self) -> CapabilitySource { CapabilitySource::Plugin }
    async fn normalize(&self, input: AdapterInput) -> Result<NormalizedGear> {
        let AdapterInput::Plugin(spec) = input else {
            anyhow::bail!("PluginAdapter expects Plugin input");
        };
        let id = GearId::new(CapabilitySource::Plugin, &spec.name, spec.version.as_deref().unwrap_or("0.0.0"));
        // Returns an empty gear: the real tool list is filled in by
        // `GearHost::install` after the TS backend (`LegacyTsBackend`) loads the
        // plugin subprocess and discovers its tools. This split keeps the adapter
        // pure (no backend access) and defers IO to the install pipeline.
        Ok(NormalizedGear {
            id,
            name: spec.name.clone(),
            description: None,
            instructions: Vec::new(),
            tools: Vec::new(),
            permissions: Default::default(),
            source: CapabilitySource::Plugin,
        })
    }
}

/// Build the default AdapterRegistry with all five adapters.
pub fn default_registry() -> AdapterRegistry {
    let mut reg = AdapterRegistry::new();
    reg.register(Arc::new(NativeAdapter));
    reg.register(Arc::new(McpAdapter));
    reg.register(Arc::new(SkillAdapter));
    reg.register(Arc::new(BuiltinAdapter));
    reg.register(Arc::new(PluginAdapter));
    reg
}
