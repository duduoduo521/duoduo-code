//! Gear manifest: TOML parsing + validation (01 §3.3, 05 §三).

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};

use super::model::CapabilitySource;

/// Full manifest parsed from `manifest.toml`.
#[derive(Debug, Clone, Deserialize)]
pub struct GearManifest {
    pub meta: GearMeta,
    #[serde(default)]
    pub capabilities: GearCapabilities,
    #[serde(default)]
    pub permissions: GearPermissions,
    /// Connection details for `kind = "mcp"` / `"plugin"` directory packages.
    #[serde(default)]
    pub connection: GearConnection,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GearMeta {
    pub name: String,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub icon: Option<String>,
    /// Capability kind. Drives how the gear pack is loaded. Defaults to `Native`.
    #[serde(default)]
    pub kind: GearKind,
    /// Activation policy (the user-facing "auto-call" switch). Defaults to `command`.
    #[serde(default)]
    pub activation: ActivationMode,
    /// SPDX license id of this gear (for marketplace redistribution checks).
    #[serde(default)]
    pub license: Option<String>,
    /// Human-friendly title surfaced in the UI. For marketplace-installed gears
    /// this carries the registry's display name so the installed gear shows the
    /// same title as the market entry (the `name` field stays the stable,
    /// filesystem-safe slug used for identity / delete / idempotency).
    #[serde(default)]
    pub display_name: Option<String>,
    /// Marketplace spec this gear was installed from, e.g.
    /// `modelscope:Alipay/alipay-subscription` or `modelscope-skill:owner/repo`.
    /// Lets the management UI show the same title/id as the market (and backfill
    /// `display_name` for gears installed before it was persisted) without guessing.
    #[serde(default)]
    pub spec: Option<String>,
}

fn default_version() -> String {
    "0.1.0".into()
}

/// How a gear is activated — i.e. whether the model may call it automatically or
/// the user must trigger it explicitly. This is the user-facing "auto-call" switch.
///
/// - `command` (default for skills): NOT auto-exposed. The model cannot call its
///   tools on its own; the user invokes it via `/<name>`. Instructions are injected
///   only for the triggering session.
/// - `progressive` (Agent Skills style): only the skill's `name` + `description`
///   are registered as a lightweight catalog in the system prompt (L1). The model
///   expands the full instructions on demand via the `load_skill` tool (L2). This
///   keeps large skill bodies out of every session until they are actually needed.
/// - `auto`: tools are registered into the unified registry; the model may call
///   them automatically when relevant.
/// - `global`: always-on — instructions are injected into every session and tools
///   (if any) are registered for automatic use. Use for lightweight global guidance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ActivationMode {
    /// User triggers explicitly via `/<name>` (default for skills).
    #[default]
    Command,
    /// Progressive disclosure (Agent Skills style): lightweight catalog only; the
    /// model loads full instructions on demand via the `load_skill` tool.
    Progressive,
    /// Tools auto-registered; model may call automatically when relevant.
    Auto,
    /// Always-on: instructions injected every session, tools (if any) auto-available.
    Global,
}

impl ActivationMode {
    /// Whether tools should be registered for model auto-call at load time.
    pub fn auto_expose_tools(&self) -> bool {
        matches!(self, ActivationMode::Auto | ActivationMode::Global)
    }
    /// Whether instructions should be injected at load time (every session).
    pub fn auto_inject(&self) -> bool {
        matches!(self, ActivationMode::Global)
    }
    /// Progressive disclosure (Agent Skills style): only the catalog is injected;
    /// the model loads the full body on demand via the `load_skill` tool.
    pub fn is_progressive(&self) -> bool {
        matches!(self, ActivationMode::Progressive)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum GearKind {
    #[default]
    Native,
    Skill,
    Plugin,
    Mcp,
}

impl GearKind {
    /// The [`CapabilitySource`] that owns a gear of this kind.
    pub fn source(&self) -> CapabilitySource {
        match self {
            GearKind::Native => CapabilitySource::Native,
            GearKind::Skill => CapabilitySource::Skill,
            GearKind::Plugin => CapabilitySource::Plugin,
            GearKind::Mcp => CapabilitySource::Mcp,
        }
    }
}

/// Connection configuration for `kind = "mcp"` / `"plugin"` directory packages.
///
/// For MCP this mirrors the `tools/mcp.json` entries; for Plugin it mirrors the
/// `plugin:` spec. This lets a gear pack be fully self-contained in one folder.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GearConnection {
    // ── MCP ──────────────────────────────────────────────────────────────
    /// Reference an MCP server declared in this gear's `tools/mcp.json`.
    #[serde(default)]
    pub mcp_server_key: Option<String>,
    /// Inline spawn: command (e.g. `npx`). Mutually exclusive with `mcp_server_key`.
    #[serde(default)]
    pub mcp_command: Option<String>,
    /// Args for the inline MCP command.
    #[serde(default)]
    pub mcp_args: Vec<String>,
    /// Extra env vars for the inline MCP command.
    #[serde(default)]
    pub mcp_env: HashMap<String, String>,
    // ── Plugin ───────────────────────────────────────────────────────────
    /// Plugin source: `file` (local .mjs), `npm` (package name), or `wasm`.
    #[serde(default)]
    pub plugin_source: Option<String>,
    /// Plugin path: a relative path inside the gear dir (file/wasm) or an
    /// npm package name (npm).
    #[serde(default)]
    pub plugin_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GearCapabilities {
    #[serde(default)]
    pub instructions: bool,
    #[serde(default)]
    pub tools: Vec<ToolCapability>,
    #[serde(default)]
    pub strategies: Vec<String>,
}

/// Typed tool reference in manifest. `ref` is a Rust keyword → `reference`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "source")]
pub enum ToolCapability {
    #[serde(rename = "mcp")]
    Mcp {
        #[serde(rename = "ref")]
        reference: String,
    },
    #[serde(rename = "plugin")]
    Plugin { spec: String },
    #[serde(rename = "builtin")]
    Builtin {
        #[serde(rename = "ref")]
        reference: String,
    },
    #[serde(rename = "native")]
    Native {
        #[serde(rename = "ref")]
        reference: String,
    },
}

impl ToolCapability {
    /// The referenced name (for permissions subset check).
    pub fn ref_name(&self) -> &str {
        match self {
            Self::Mcp { reference } | Self::Builtin { reference } | Self::Native { reference } => reference,
            Self::Plugin { spec } => spec,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GearPermissions {
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub network: bool,
}

impl GearManifest {
    /// Parse from TOML text.
    pub fn from_toml(text: &str) -> Result<Self> {
        toml::from_str(text).map_err(|e| anyhow!("manifest parse error: {e}"))
    }

    /// Resolve the effective activation policy.
    ///
    /// When the manifest does not explicitly set an activation (still the `Command`
    /// default), tool-bearing kinds (Plugin / Mcp / Native-with-tools) are promoted
    /// to `Auto` so the model can call them; instruction-only skills stay `Command`
    /// (user-triggered via `/<name>`).
    pub fn effective_activation(&self) -> ActivationMode {
        let has_tools = !self.capabilities.tools.is_empty();
        match self.meta.activation {
            ActivationMode::Command
                if matches!(self.meta.kind, GearKind::Plugin | GearKind::Mcp)
                    || (self.meta.kind == GearKind::Native && has_tools) =>
            {
                ActivationMode::Auto
            }
            a => a,
        }
    }

    /// Validate against 05 §二 rules. `root` = gear pack directory.
    pub fn validate(&self, root: &Path) -> Result<()> {
        // name: ^[a-z0-9][a-z0-9-]{0,63}$
        let name_re = regex::Regex::new(r"^[a-z0-9][a-z0-9-]{0,63}$").unwrap();
        if !name_re.is_match(&self.meta.name) {
            return Err(anyhow!("INVALID_NAME: {}", self.meta.name));
        }
        if self.meta.description.trim().is_empty() && !self.capabilities.tools.is_empty() {
            // description required only when gear has capabilities beyond just a name
            // (relaxed: allow empty for instruction-only gears)
        }
        if self.capabilities.instructions && !root.join("instructions.md").exists() {
            return Err(anyhow!("INSTRUCTIONS_FILE_MISSING"));
        }
        for t in &self.capabilities.tools {
            if t.ref_name().is_empty() {
                return Err(anyhow!("INVALID_TOOL_CAPABILITY: empty ref"));
            }
        }
        // permissions.tools ⊆ capabilities.tools ref names
        let declared: Vec<&str> = self.capabilities.tools.iter().map(|t| t.ref_name()).collect();
        for p in &self.permissions.tools {
            if !declared.contains(&p.as_str()) {
                return Err(anyhow!("PERMISSION_NOT_DECLARED: {p}"));
            }
        }
        Ok(())
    }
}
