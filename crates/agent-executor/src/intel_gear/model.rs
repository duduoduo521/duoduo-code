//! Core types for the IntelGear unified capability model.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::manifest::GearPermissions;

// ── Capability source ──

/// Where a capability comes from. Derives Hash/Eq for use as HashMap key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CapabilitySource {
    Native,
    Mcp,
    Skill,
    Plugin,
    Builtin,
}

// ── Gear identity ──

/// Global unique id: `<source>://<name>@<version>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct GearId(pub String);

impl GearId {
    pub fn new(source: CapabilitySource, name: &str, version: &str) -> Self {
        let prefix = match source {
            CapabilitySource::Native => "native",
            CapabilitySource::Mcp => "mcp",
            CapabilitySource::Skill => "skill",
            CapabilitySource::Plugin => "plugin",
            CapabilitySource::Builtin => "builtin",
        };
        Self(format!("{prefix}://{name}@{version}"))
    }
}

// ── Normalized model (kernel only operates on these) ──

/// A gear after adapter normalization — the kernel's internal representation.
#[derive(Debug)]
pub struct NormalizedGear {
    pub id: GearId,
    pub name: String,
    /// Short human-readable summary from the manifest/frontmatter. Used for the
    /// progressive-disclosure skill catalog so the model can decide which skill
    /// to expand via `load_skill` without loading every full body.
    pub description: Option<String>,
    pub instructions: Vec<Instruction>,
    pub tools: Vec<NormalizedTool>,
    pub permissions: GearPermissions,
    pub source: CapabilitySource,
}

/// Instruction text injected into the system prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Instruction {
    pub content: String,
    pub source: CapabilitySource,
    #[serde(default)]
    pub name: Option<String>,
}

/// A tool registered in the unified registry.
pub struct NormalizedTool {
    pub name: String,
    /// LLM-facing definition (OpenAI function calling format).
    pub definition: duo_types::ToolDefinition,
    pub source: CapabilitySource,
    pub executor: ToolExecutor,
}

impl std::fmt::Debug for NormalizedTool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NormalizedTool")
            .field("name", &self.name)
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}

/// How a tool is executed.
pub enum ToolExecutor {
    /// Kernel-direct: existing Rust handler (via dispatch.rs ToolHandler).
    Builtin {
        handler: super::super::tools::dispatch::ToolHandler,
    },
    /// Forwarded to an external MCP server process.
    Mcp { server_key: String },
    /// Future: plugin backend (WASM/native). Skeleton only in Phase 1.
    Plugin { instance_id: String },
}

impl std::fmt::Debug for ToolExecutor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Builtin { .. } => write!(f, "Builtin"),
            Self::Mcp { server_key } => f.debug_struct("Mcp").field("server_key", server_key).finish(),
            Self::Plugin { instance_id } => f.debug_struct("Plugin").field("instance_id", instance_id).finish(),
        }
    }
}

// ── GearSpec (install descriptor) ──

/// Install descriptor: the unified input to `LifecycleManager::install`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GearSpec {
    pub raw: String,
    pub source: CapabilitySource,
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub path: Option<PathBuf>,
}

impl GearSpec {
    /// Parse a spec string like `plugin:foo@1.0`, `mcp:bar`, `skill:./x.md`,
    /// or a bare `github.com/foo/bar` (native).
    pub fn parse(raw: &str) -> Self {
        if let Some(rest) = raw.strip_prefix("plugin:") {
            let (name, version) = split_name_version(rest);
            let path = if rest.starts_with('.') || rest.starts_with('/') {
                Some(PathBuf::from(rest))
            } else {
                None
            };
            Self { raw: raw.into(), source: CapabilitySource::Plugin, name, version, path }
        } else if let Some(rest) = raw.strip_prefix("mcp:") {
            Self { raw: raw.into(), source: CapabilitySource::Mcp, name: rest.into(), version: None, path: None }
        } else if let Some(rest) = raw.strip_prefix("skill:") {
            let path = Some(PathBuf::from(rest));
            let name = std::path::Path::new(rest)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| rest.into());
            Self { raw: raw.into(), source: CapabilitySource::Skill, name, version: None, path }
        } else {
            // native: bare URL or path
            let name = raw.rsplit('/').next().unwrap_or(raw).to_string();
            Self { raw: raw.into(), source: CapabilitySource::Native, name, version: None, path: None }
        }
    }

    /// Project into PluginSpec (only for plugin source).
    pub fn into_plugin_spec(self) -> Option<super::backend::PluginSpec> {
        if self.source != CapabilitySource::Plugin {
            return None;
        }
        let source = match &self.path {
            Some(p) if is_wasm_path(p) => super::backend::PluginSource::Wasm,
            Some(_) => super::backend::PluginSource::File,
            None => super::backend::PluginSource::Npm,
        };
        Some(super::backend::PluginSpec {
            raw: self.raw,
            source,
            name: self.name,
            version: self.version,
            path: self.path,
        })
    }
}

/// True when a plugin path points at a compiled WebAssembly component
/// (`.wasm`, `.component`, or `.wasm.component`).
fn is_wasm_path(p: &Path) -> bool {
    let s = p.to_string_lossy();
    s.ends_with(".wasm") || s.ends_with(".component") || s.ends_with(".wasm.component")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_spec_routes_wasm_by_path() {
        // `.wasm` / `.component` / `.wasm.component` -> WASM backend.
        for spec in [
            "plugin:./echo.wasm",
            "plugin:/abs/echo.component",
            "plugin:./out.wasm.component",
        ] {
            let parsed = GearSpec::parse(spec).into_plugin_spec().unwrap();
            assert_eq!(parsed.source, crate::intel_gear::backend::PluginSource::Wasm, "spec={spec}");
        }
    }

    #[test]
    fn plugin_spec_routes_ts_for_plain_files() {
        // Plain relative/absolute file paths -> TS backend (not WASM).
        for spec in ["plugin:./my-plugin", "plugin:/abs/my-plugin"] {
            let parsed = GearSpec::parse(spec).into_plugin_spec().unwrap();
            assert_eq!(parsed.source, crate::intel_gear::backend::PluginSource::File, "spec={spec}");
        }
    }

    #[test]
    fn plugin_spec_routes_npm_without_path() {
        // Bare npm spec (no path) -> Npm backend.
        let parsed = GearSpec::parse("plugin:my-gear-plugin")
            .into_plugin_spec()
            .unwrap();
        assert_eq!(parsed.source, crate::intel_gear::backend::PluginSource::Npm);
    }
}

// ── ToolContext (unified execution context) ──

/// Runtime context passed to tool execution. Extends the legacy ToolHandler params.
pub struct ToolContext<'a> {
    pub session_id: &'a str,
    pub executor: &'a super::super::agentic_loop::AgenticLoopExecutor,
    pub files_read: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    pub read_reservations: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

fn split_name_version(s: &str) -> (String, Option<String>) {
    if let Some(at) = s.rfind('@')
        && at > 0 {
            return (s[..at].to_string(), Some(s[at + 1..].to_string()));
        }
    (s.to_string(), None)
}
