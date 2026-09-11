//! GearHost: the central coordinator for IntelGear capabilities.
//!
//! Process-level singleton held by AppState (Arc<GearHost>).
//! Registries are shared (RwLock); per-run context is constructed per request.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, Result};
use tracing::{info, warn};

use super::adapter::AdapterRegistry;
use super::backend::{PluginBackend, PluginSource};
use super::injector::PromptInjector;
use super::manifest::{ActivationMode, GearKind, GearManifest};
use super::model::*;
use super::strategy::StrategyRegistry;
use super::ts_backend::LegacyTsBackend;
use super::wasm_backend::WasmBackend;

/// Central gear host. Owns all registries and lifecycle.
pub struct GearHost {
    pub injector: Arc<PromptInjector>,
    pub adapters: AdapterRegistry,
    pub strategies: StrategyRegistry,
    /// Installed gears: id → (manifest, normalized, enabled).
    gears: std::sync::RwLock<std::collections::HashMap<GearId, GearEntry>>,
    /// Root directory for gear packs (from DUODUO_GEARS_DIR).
    gears_dir: Option<PathBuf>,
    /// Persisted per-gear user overrides (UI auto-call toggle + on/off switch),
    /// keyed by gear name and backed by `<gears_dir>/.activation_overrides.json`.
    /// This lets user preferences survive restarts without rewriting each gear's
    /// manifest.toml (`GearManifest` is not `Serialize`-able, so the manifests
    /// are treated as read-only defaults).
    activation_overrides: std::sync::RwLock<std::collections::HashMap<String, GearOverride>>,
    /// Path to the overrides file (inside `gears_dir`). `None` when no gears dir is set.
    overrides_path: Option<PathBuf>,
    /// TS plugin execution backend (controlled subprocess IPC).
    ts_backend: Arc<LegacyTsBackend>,
    /// WASM component plugin backend (wasmtime, feature-gated).
    wasm_backend: Arc<WasmBackend>,
}

struct GearEntry {
    manifest: GearManifest,
    normalized: NormalizedGear,
    enabled: bool,
    /// Activation policy (the user-facing "auto-call" switch).
    activation: ActivationMode,
    /// On-disk directory backing this gear (if any). Used to delete the files
    /// on uninstall so a later `load_all` rescan cannot resurrect it. `None`
    /// for standalone `.md` skills (which live at the gears_dir root) and for
    /// registry-only gears (MCP / plugins) that have no managed directory.
    dir: Option<PathBuf>,
}

/// Removes `dir` on drop unless `keep` is set. Used by
/// [`GearHost::install_modelscope_skill`] so a failed install (e.g. a git clone
/// auth failure, or an `INVALID_NAME` from a malformed manifest) never leaves a
/// half-written gear dir on disk — otherwise it would surface in Settings as an
/// installed gear that never registered.
struct InstallDirGuard<'a> {
    dir: &'a Path,
    keep: bool,
}

impl Drop for InstallDirGuard<'_> {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_dir_all(self.dir);
        }
    }
}

/// Per-gear user override persisted in `<gears_dir>/.activation_overrides.json`.
///
/// This file is the single source of truth for user choices made in the UI
/// (the on/off switch and the auto-call toggle); manifests stay read-only
/// defaults. Values were historically a bare `ActivationMode` string; the file
/// now stores `{ "activation": ..., "enabled": ... }` objects.
/// [`read_activation_overrides`] accepts both forms.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct GearOverride {
    /// Activation mode chosen via the UI auto-call toggle (`None` = keep the
    /// manifest's declared default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation: Option<ActivationMode>,
    /// Whether the gear is enabled at all (the Settings on/off switch).
    /// Missing in legacy files → defaults to `true` (backward compatible).
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl Default for GearOverride {
    fn default() -> Self {
        Self { activation: None, enabled: true }
    }
}

fn default_true() -> bool {
    true
}

/// Legacy-tolerant representation of one override value.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum GearOverrideRepr {
    /// Old format: `"name": "progressive"`.
    Legacy(ActivationMode),
    /// Current format: `"name": { "activation": "...", "enabled": false }`.
    Full(GearOverride),
}

/// Read `<gears_dir>/.activation_overrides.json` (empty map when absent or
/// invalid). Shared by [`GearHost`], [`super::load_gears_from_dir`] and the MCP
/// scanner (`crate::mcp`) so every runtime path agrees on the user's
/// enable/activation choices.
pub fn read_activation_overrides(
    gears_dir: &Path,
) -> std::collections::HashMap<String, GearOverride> {
    let path = gears_dir.join(".activation_overrides.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Default::default();
    };
    let Ok(raw) =
        serde_json::from_str::<std::collections::HashMap<String, GearOverrideRepr>>(&text)
    else {
        return Default::default();
    };
    raw.into_iter()
        .map(|(k, v)| {
            let ov = match v {
                GearOverrideRepr::Legacy(mode) => GearOverride {
                    activation: Some(mode),
                    enabled: true,
                },
                GearOverrideRepr::Full(o) => o,
            };
            (k, ov)
        })
        .collect()
}

impl GearHost {
    pub fn new() -> Self {
        let gears_dir = std::env::var("DUODUO_GEARS_DIR")
            .ok()
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from);

        // Load persisted overrides (UI auto-call toggle + on/off switch) so they
        // survive restarts. Backed by `<gears_dir>/.activation_overrides.json`.
        let overrides_path = gears_dir.as_ref().map(|d| d.join(".activation_overrides.json"));
        let activation_overrides = gears_dir
            .as_ref()
            .map(|d| read_activation_overrides(d))
            .unwrap_or_default();

        Self {
            injector: Arc::new(PromptInjector::new()),
            adapters: super::adapter::default_registry(),
            strategies: super::strategy::default_registry(),
            gears: std::sync::RwLock::new(std::collections::HashMap::new()),
            gears_dir,
            activation_overrides: std::sync::RwLock::new(activation_overrides),
            overrides_path,
            ts_backend: super::ts_backend::global_ts_backend(),
            wasm_backend: super::wasm_backend::global_wasm_backend(),
        }
    }

    /// Get the TS plugin backend.
    pub fn ts_backend(&self) -> Arc<LegacyTsBackend> {
        self.ts_backend.clone()
    }

    /// Get the WASM plugin backend.
    pub fn wasm_backend(&self) -> Arc<WasmBackend> {
        self.wasm_backend.clone()
    }

    /// Register all builtin tools from dispatch.rs TOOL_REGISTRY into the unified
    /// GearToolRegistry. Delegates to the idempotent `ensure_builtins_registered`
    /// so the single source of truth is used everywhere (dispatch() also calls it).
    pub fn register_builtins(&self) {
        super::registry::ensure_builtins_registered();
    }

    /// Scan gears directory, parse manifests, register tools + instructions.
    /// Also discovers standalone `.md` skill files in the gears dir.
    /// Called once at startup (or on gear install/uninstall).
    pub async fn load_all(&self) {
        let Some(dir) = &self.gears_dir else { return };
        let Ok(entries) = std::fs::read_dir(dir) else { return };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Err(e) = self.load_gear_pack(&path).await {
                    warn!(gear = %path.display(), error = %e, "skipping gear pack");
                }
            } else if path.extension().map(|e| e == "md").unwrap_or(false) {
                // Standalone skill file. Skills default to `progressive` activation
                // (Agent Skills style): only the catalog is registered; the model
                // expands the full body on demand via the `load_skill` tool.
                let activation = ActivationMode::Progressive;
                match super::skill::normalize_skill(&path) {
                    Ok(gear) => {
                        if activation.auto_inject() {
                            self.injector.add(gear.id.clone(), gear.instructions.clone());
                        }
                        if let Ok(mut gears) = self.gears.write() {
                            gears.insert(gear.id.clone(), GearEntry {
                                manifest: GearManifest {
                                    meta: super::manifest::GearMeta {
                                        name: gear.name.clone(),
                                        version: "0.1.0".into(),
                                        description: String::new(),
                                        author: String::new(),
                                        icon: None,
                                        kind: super::manifest::GearKind::Skill,
                                        activation,
            license: None,
            display_name: None,
            spec: None,
                                    },
                                    capabilities: Default::default(),
                                    permissions: Default::default(),
                                    connection: Default::default(),
                                },
                                normalized: gear,
                                enabled: true,
                                activation,
                                dir: None,
                            });
                        }
                    }
                    Err(e) => warn!(skill = %path.display(), error = %e, "skipping skill file"),
                }
            }
        }
        // Apply persisted activation overrides (UI auto-call toggle / install choice) on
        // top of each manifest's declared value, so user preferences survive restarts.
        self.apply_activation_overrides();
    }

    /// Load a single gear pack directory, dispatching by `manifest.toml`'s `kind`.
    /// All four kinds (Native / Skill / Plugin / Mcp) live in the same gears folder;
    /// this is what makes the unified "智械" directory work.
    async fn load_gear_pack(&self, root: &Path) -> Result<()> {
        let manifest_path = root.join("manifest.toml");

        // Parse manifest.toml if present; otherwise fall back to legacy mode
        // (directory name + instructions.md only, treated as a Native pack).
        let manifest = if manifest_path.exists() {
            let text = std::fs::read_to_string(&manifest_path)?;
            let m = GearManifest::from_toml(&text)?;
            m.validate(root)?;
            m
        } else {
            // Legacy: no manifest.toml — synthesize a minimal one from dir name.
            let name = root.file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_else(|| "unknown".into());
            GearManifest {
                meta: super::manifest::GearMeta {
                    name,
                    version: "0.1.0".into(),
                    description: String::new(),
                    author: String::new(),
                    icon: None,
                    kind: super::manifest::GearKind::Native,
                    activation: ActivationMode::Command,
                    license: None,
                    display_name: None,
                    spec: None,
                },
                capabilities: super::manifest::GearCapabilities {
                    instructions: root.join("instructions.md").exists(),
                    tools: Vec::new(),
                    strategies: Vec::new(),
                },
                permissions: Default::default(),
                connection: Default::default(),
            }
        };

        // Delegate to the unified install pipeline (normalizes, loads plugin backend,
        // applies activation semantics, stores the entry). This guarantees directory
        // packs and spec-string installs behave identically.
        let kind = manifest.meta.kind;
        let source = kind.source();
        let server_key = manifest.connection.mcp_server_key.clone()
            .unwrap_or_else(|| manifest.meta.name.clone());
        let raw = match kind {
            super::manifest::GearKind::Native => format!("native:{}", manifest.meta.name),
            super::manifest::GearKind::Skill => format!("skill:{}", manifest.meta.name),
            super::manifest::GearKind::Mcp => format!("mcp:{}", server_key),
            super::manifest::GearKind::Plugin => format!("plugin:{}", manifest.meta.name),
        };
        self.install_spec(GearSpec {
            raw,
            source,
            name: manifest.meta.name.clone(),
            version: Some(manifest.meta.version.clone()),
            path: match kind {
                super::manifest::GearKind::Native => Some(root.to_path_buf()),
                super::manifest::GearKind::Skill => Some(root.join("instructions.md")),
                super::manifest::GearKind::Mcp => None,
                super::manifest::GearKind::Plugin => {
                    manifest.connection.plugin_path.as_ref().map(|p| root.join(p))
                }
            },
        }, Some(manifest.effective_activation()), Some(manifest)).await?;

        Ok(())
    }

    /// List all installed gears (name, version, enabled). Kept for backward compat.
    pub fn list(&self) -> Vec<(String, String, bool)> {
        self.gears
            .read()
            .map(|g| {
                g.values()
                    .map(|e| (e.normalized.name.clone(), e.manifest.meta.version.clone(), e.enabled))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Detailed listing for the management UI (includes kind, activation, license).
    pub fn list_detailed(&self) -> Vec<GearInfo> {
        self.gears
            .read()
            .map(|g| g.values().map(entry_to_info).collect())
            .unwrap_or_default()
    }

    /// Single-gear detail by id. Used by the install route to return the real
    /// post-install summary (same shape as `GET /gears`) instead of a hand-built stub.
    pub fn get_info(&self, id: &GearId) -> Option<GearInfo> {
        self.gears
            .read()
            .ok()
            .and_then(|g| g.get(id).map(entry_to_info))
    }

    /// Disable a gear: remove its instructions from PromptInjector.
    pub fn disable(&self, id: &GearId) -> Result<()> {
        self.injector.remove(id);
        if let Ok(mut gears) = self.gears.write()
            && let Some(entry) = gears.get_mut(id) {
                entry.enabled = false;
            }
        Ok(())
    }

    /// Re-enable a gear.
    pub fn enable(&self, id: &GearId) -> Result<()> {
        if let Ok(mut gears) = self.gears.write()
            && let Some(entry) = gears.get_mut(id) {
                entry.enabled = true;
                self.injector.add(id.clone(), entry.normalized.instructions.clone());
            }
        Ok(())
    }

    /// Uninstall: disable + remove from registry + delete on-disk files.
    pub fn uninstall(&self, id: &GearId) -> Result<()> {
        // Capture the backing directory before mutating the map.
        let dir = self
            .gears
            .read()
            .ok()
            .and_then(|g| g.get(id).and_then(|e| e.dir.clone()));
        self.injector.remove(id);
        if let Ok(mut gears) = self.gears.write() {
            gears.remove(id);
        }
        // Delete the gear's files so a later `load_all` rescan cannot resurrect it.
        if let Some(dir) = dir
            && let Some(base) = &self.gears_dir
                && dir.starts_with(base) {
                    let _ = std::fs::remove_dir_all(&dir);
                }
        Ok(())
    }

    /// Install a gear from a spec string (unified pipeline: parse → adapter → register → enable).
    pub async fn install(&self, spec_str: &str) -> Result<GearId> {
        let spec = GearSpec::parse(spec_str);
        // An `mcp:` spec through this generic path would register an empty tool
        // list and never write `tools/mcp.json`, i.e. it "installs" but never
        // connects. Fail loudly instead of silently producing a dead gear.
        if spec.source == CapabilitySource::Mcp {
            anyhow::bail!(
                "MCP gears cannot be installed via the generic install pipeline \
                 (spec '{spec_str}' would never connect); use POST /gears/mcp/import instead"
            );
        }
        self.install_spec(spec, None, None).await
    }

    /// Install a gear from a parsed [`GearSpec`].
    ///
    /// - `activation_override`: the user's choice at install time (UI auto-call
    ///   toggle). Takes precedence over the manifest's declared `activation`.
    /// - `parsed_manifest`: when the gear ships a real `manifest.toml` (e.g. from a
    ///   directory package), it is stored verbatim so `activation`/`license`/`kind`
    ///   are preserved. Otherwise a minimal manifest is synthesized from the spec.
    pub async fn install_spec(
        &self,
        spec: GearSpec,
        activation_override: Option<ActivationMode>,
        parsed_manifest: Option<GearManifest>,
    ) -> Result<GearId> {
        let source = spec.source;

        // For plugin sources we need the `PluginSpec` both for the adapter input and
        // the backend load. `into_plugin_spec` consumes self, so clone first.
        let plugin_spec = if source == CapabilitySource::Plugin {
            Some(spec.clone().into_plugin_spec()
                .ok_or_else(|| anyhow::anyhow!("invalid plugin spec"))?)
        } else {
            None
        };

        let input = match source {
            CapabilitySource::Native => {
                let root = spec.path.clone().unwrap_or_else(|| {
                    self.gears_dir.as_ref().map(|d| d.join(&spec.name)).unwrap_or_default()
                });
                super::adapter::AdapterInput::NativePack { root }
            }
            CapabilitySource::Skill => {
                let path = spec.path.clone().unwrap_or_default();
                super::adapter::AdapterInput::SkillFile { path }
            }
            CapabilitySource::Mcp => {
                super::adapter::AdapterInput::McpEntry {
                    gear_name: spec.name.clone(),
                    server_key: spec.name.clone(),
                }
            }
            CapabilitySource::Plugin => {
                super::adapter::AdapterInput::Plugin(
                    plugin_spec.clone().ok_or_else(|| anyhow::anyhow!("plugin spec missing"))?,
                )
            }
            CapabilitySource::Builtin => {
                anyhow::bail!("cannot install builtin tools via spec");
            }
        };

        let adapter = self.adapters.get(source)
            .ok_or_else(|| anyhow::anyhow!("no adapter for source {:?}", source))?;
        let mut gear = adapter.normalize(input).await?;

        // Skill gear *packs* (directories carrying manifest.toml) must be named by
        // their manifest, not by the instructions.md filename. The Skill adapter only
        // sees the `.md` path and would otherwise derive the name from the filename
        // ("instructions"), breaking directory-based skill identity. Override with the
        // spec name — `load_gear_pack` derives it from the manifest. This keeps Skill
        // consistent with Native/Plugin/Mcp, which are all named by their manifest.
        if source == CapabilitySource::Skill {
            let real_name = spec.name.clone();
            let version = spec.version.as_deref().unwrap_or("0.1.0");
            gear.name = real_name.clone();
            gear.id = GearId::new(CapabilitySource::Skill, &real_name, version);
            for instr in &mut gear.instructions {
                instr.name = Some(real_name.clone());
            }
        }

        let id = gear.id.clone();

        // Post-normalization: load plugin through the matching backend.
        // Source is chosen at parse time (Wasm for `.wasm`/`.component` specs,
        // otherwise the TS/IPC backend). The backend-agnostic PluginRef carries
        // its own tag so the execute path can route back correctly.
        if source == CapabilitySource::Plugin {
            let plugin_spec = plugin_spec
                .ok_or_else(|| anyhow::anyhow!("invalid plugin spec for backend load"))?;
            let backend_type = if plugin_spec.source == PluginSource::Wasm { "wasm" } else { "ts" };
            let load = if plugin_spec.source == PluginSource::Wasm {
                self.wasm_backend().load(&plugin_spec).await
            } else {
                self.ts_backend().load(&plugin_spec).await
            };
            match load {
                Ok(load_result) => {
                    let instance_id = load_result.plugin.instance_id.clone();
                    // Replace placeholder tools with real tool definitions
                    gear.tools = load_result
                        .tools
                        .iter()
                        .map(|t| NormalizedTool {
                            name: t.name.clone(),
                            definition: duo_types::ToolDefinition {
                                r#type: "function".into(),
                                function: duo_types::FunctionDefinition {
                                    name: t.name.clone(),
                                    description: t.description.clone(),
                                    parameters: t.input_schema.clone(),
                                },
                            },
                            source: CapabilitySource::Plugin,
                            executor: ToolExecutor::Plugin {
                                instance_id: instance_id.clone(),
                            },
                        })
                        .collect();
                    info!(
                        gear = %plugin_spec.name,
                        instance = %instance_id,
                        backend = backend_type,
                        tools = gear.tools.len(),
                        "plugin loaded via {backend_type} backend"
                    );
                }
                Err(e) => {
                    if plugin_spec.source == PluginSource::Wasm {
                        anyhow::bail!(
                            "WASM plugin load failed (the `wasm-backend` feature is required): {e}"
                        );
                    }
                    warn!(gear = %plugin_spec.name, error = %e, "plugin backend load failed, using placeholder tools");
                }
            }
        }

        // Resolve activation policy (user override > manifest > kind default).
        let activation = activation_override
            .or_else(|| parsed_manifest.as_ref().map(|m| m.effective_activation()))
            .unwrap_or_else(|| default_activation_for(source));

        // Register instructions only when activation calls for it. `global` gears are
        // injected into every session; `command` gears are injected on-demand via
        // `activate_command` (user triggers `/<name>`). `auto` gears expose tools but
        // do NOT auto-inject instructions (model calls tools, not reads a prompt).
        if activation.auto_inject() {
            self.injector.add(id.clone(), gear.instructions.clone());
        }

        // Register tools into the unified global registry only when the gear is
        // allowed to be auto-called (auto/global). `command` gears stay out of the
        // model's tool list until the user explicitly triggers them.
        if activation.auto_expose_tools() {
            let gear_reg = crate::intel_gear::registry::global();
            for tool in &gear.tools {
                gear_reg.register(std::sync::Arc::new(super::model::NormalizedTool {
                    name: tool.name.clone(),
                    definition: tool.definition.clone(),
                    source: tool.source,
                    executor: match &tool.executor {
                        ToolExecutor::Mcp { server_key } => ToolExecutor::Mcp { server_key: server_key.clone() },
                        ToolExecutor::Plugin { instance_id } => ToolExecutor::Plugin { instance_id: instance_id.clone() },
                        ToolExecutor::Builtin { handler } => ToolExecutor::Builtin { handler: *handler },
                    },
                }));
            }
        }

        // Store entry (verbatim manifest when available, else synthesize from spec).
        let stored_manifest = parsed_manifest.unwrap_or_else(|| GearManifest {
            meta: super::manifest::GearMeta {
                name: gear.name.clone(),
                version: spec.version.clone().unwrap_or_else(|| "0.1.0".into()),
                description: String::new(),
                author: String::new(),
                icon: None,
                kind: kind_of(source),
                activation,
                license: None,
                spec: None,
                display_name: None,
            },
            capabilities: Default::default(),
            permissions: gear.permissions.clone(),
            connection: Default::default(),
        });

        // On-disk directory backing this gear, used to delete files on uninstall.
        // Skill packs expose `instructions.md` inside their dir; native packs expose
        // the dir directly. Standalone `.md` skills sit at the gears_dir root, so we
        // must not treat that root as a deletable gear dir.
        let dir: Option<PathBuf> = match source {
            CapabilitySource::Native => spec.path.as_ref().filter(|p| p.is_dir()).cloned(),
            CapabilitySource::Skill => spec
                .path
                .as_ref()
                .and_then(|p| p.parent())
                .filter(|parent| self.gears_dir.as_ref().map(|g| parent != g).unwrap_or(true))
                .map(|p| p.to_path_buf()),
            _ => None,
        };

        if let Ok(mut gears) = self.gears.write() {
            // Spec-based dedupe: the same marketplace spec (e.g.
            // `modelscope-skill:Owner/Name`) must never surface as two separate
            // gears just because its `name` was normalized under different rules
            // over time. When a duplicate with the same spec but a different id
            // exists, keep the canonical-named one (`manifest_safe_name`) and
            // delete the other's directory. If neither is canonical, keep the
            // incoming (latest) entry.
            let spec_key = stored_manifest.meta.spec.clone();
            let canonical = spec_key
                .as_deref()
                .map(|s| manifest_safe_name(s.strip_prefix("modelscope-skill:").unwrap_or(s)));
            let mut dup_id: Option<GearId> = None;
            if let Some(spec_key) = &spec_key {
                for (k, e) in gears.iter() {
                    if k != &id && e.manifest.meta.spec.as_deref() == Some(spec_key.as_str()) {
                        dup_id = Some(k.clone());
                        break;
                    }
                }
            }
            if let Some(dup_id) = dup_id {
                let dup_canonical = canonical
                    .as_deref()
                    .map(|c| gears.get(&dup_id).map(|e| e.manifest.meta.name == c).unwrap_or(false))
                    .unwrap_or(false);
                let self_canonical = canonical
                    .as_deref()
                    .map(|c| stored_manifest.meta.name == c)
                    .unwrap_or(false);
                if dup_canonical && !self_canonical {
                    // Keep the already-registered canonical entry; discard incoming.
                    drop(gears);
                    self.injector.remove(&id);
                    if let Some(d) = &dir
                        && let Some(base) = &self.gears_dir
                            && d.starts_with(base) {
                                let _ = std::fs::remove_dir_all(d);
                            }
                    return Ok(id);
                }
                // Drop the duplicate and keep the incoming one.
                if let Some(d) = gears.get(&dup_id).and_then(|e| e.dir.clone())
                    && let Some(base) = &self.gears_dir
                        && d.starts_with(base) {
                            let _ = std::fs::remove_dir_all(d);
                        }
                self.injector.remove(&dup_id);
                gears.remove(&dup_id);
            }
            gears.insert(id.clone(), GearEntry {
                manifest: stored_manifest,
                normalized: gear,
                enabled: true,
                activation,
                dir,
            });
        }

        info!(gear_id = %id.0, activation = ?activation, "gear installed via unified pipeline");
        Ok(id)
    }

    /// Install a gear from a local directory (folder). The directory must contain
    /// a `manifest.toml`. `activation_override` lets the user choose auto-call at
    /// install time (the UI toggle).
    pub async fn install_local_pack(&self, target: &Path, activation_override: Option<ActivationMode>) -> Result<GearId> {
        if !target.is_dir() {
            anyhow::bail!("no manifest.toml found in {}", target.display());
        }
        let dir: &Path = target;
        let manifest_path = dir.join("manifest.toml");
        if !manifest_path.exists() {
            anyhow::bail!("no manifest.toml found in {}", dir.display());
        }
        let text = std::fs::read_to_string(&manifest_path)?;
        let manifest = GearManifest::from_toml(&text)?;
        manifest.validate(dir)?;
        let effective = activation_override.unwrap_or_else(|| manifest.effective_activation());
        let spec = match manifest.meta.kind {
            super::manifest::GearKind::Native => GearSpec {
                raw: format!("native:{}", manifest.meta.name),
                source: CapabilitySource::Native,
                name: manifest.meta.name.clone(),
                version: Some(manifest.meta.version.clone()),
                path: Some(dir.to_path_buf()),
            },
            super::manifest::GearKind::Skill => GearSpec {
                raw: format!("skill:{}", manifest.meta.name),
                source: CapabilitySource::Skill,
                name: manifest.meta.name.clone(),
                version: Some(manifest.meta.version.clone()),
                path: Some(dir.join("instructions.md")),
            },
            super::manifest::GearKind::Mcp => GearSpec {
                raw: format!("mcp:{}", manifest.connection.mcp_server_key.clone()
                    .unwrap_or_else(|| manifest.meta.name.clone())),
                source: CapabilitySource::Mcp,
                name: manifest.connection.mcp_server_key.clone()
                    .unwrap_or_else(|| manifest.meta.name.clone()),
                version: Some(manifest.meta.version.clone()),
                path: None,
            },
            super::manifest::GearKind::Plugin => {
                let src = manifest.connection.plugin_source.clone().unwrap_or_else(|| "file".into());
                let path = manifest.connection.plugin_path.as_ref().map(|p| dir.join(p));
                let name = match src.as_str() {
                    "npm" => format!("npm:{}", manifest.connection.plugin_path.clone()
                        .unwrap_or_else(|| manifest.meta.name.clone())),
                    "wasm" => format!("wasm:{}", manifest.meta.name.clone()),
                    _ => manifest.meta.name.clone(),
                };
                GearSpec {
                    raw: format!("plugin:{}", name),
                    source: CapabilitySource::Plugin,
                    name,
                    version: Some(manifest.meta.version.clone()),
                    path,
                }
            }
        };
        let gear_name = spec.name.clone();
        let id = self.install_spec(spec, Some(effective), Some(manifest)).await?;
        // Persist the user's chosen activation so it survives restarts. This branch is
        // only reached on explicit user installs — `load_all` calls `install_spec`
        // directly and never persists, so startup never clobbers stored overrides.
        if let Err(e) = self.persist_activation_override(&gear_name, effective) {
            warn!(gear = %gear_name, error = %e, "failed to persist activation override");
        }
        Ok(id)
    }

    /// Inject a `command`-activated gear's instructions for the current session.
    /// Called when the user triggers `/<name>`. No-op for auto/global gears (already active).
    pub fn activate_command(&self, id: &GearId) -> Result<()> {
        if let Ok(gears) = self.gears.read()
            && let Some(entry) = gears.get(id) {
                if entry.activation == ActivationMode::Command {
                    self.injector.add(id.clone(), entry.normalized.instructions.clone());
                }
                return Ok(());
            }
        anyhow::bail!("gear not installed: {}", id.0)
    }

    /// Find a gear's id by (case-insensitive) name.
    pub fn find_id_by_name(&self, name: &str) -> Option<GearId> {
        self.gears.read().ok().and_then(|g| {
            g.values()
                .find(|e| e.normalized.name.eq_ignore_ascii_case(name))
                .map(|e| e.normalized.id.clone())
        })
    }

    /// Activate a `command` gear by name (the `/<name>` command handler).
    pub fn activate_command_by_name(&self, name: &str) -> Result<()> {
        let id = self.find_id_by_name(name)
            .ok_or_else(|| anyhow::anyhow!("gear not installed: {name}"))?;
        self.activate_command(&id)
    }

    /// Update a gear's activation policy at runtime (user toggles auto-call in the UI).
    ///
    /// Instructions are re-evaluated immediately (injected for `global`, removed for
    /// `command`). Tool auto-exposure changes take effect on the next gear load; for
    /// immediate effect, re-install the gear.
    pub fn set_activation_by_name(&self, name: &str, mode: ActivationMode) -> Result<()> {
        let id = self.find_id_by_name(name)
            .ok_or_else(|| anyhow::anyhow!("gear not installed: {name}"))?;
        if let Ok(mut gears) = self.gears.write()
            && let Some(entry) = gears.get_mut(&id) {
                entry.activation = mode;
                if mode.auto_inject() {
                    self.injector.add(id.clone(), entry.normalized.instructions.clone());
                } else {
                    self.injector.remove(&id);
                }
                // Persist so the UI auto-call toggle survives restarts. Release the gears
                // write lock before doing blocking file I/O.
                drop(gears);
                if let Err(e) = self.persist_activation_override(name, mode) {
                    warn!(gear = %name, error = %e, "failed to persist activation override");
                }
                return Ok(());
            }
        anyhow::bail!("gear entry locked: {name}")
    }

    /// Persist an activation override to `<gears_dir>/.activation_overrides.json`.
    /// `name` is the gear name used as the override key (matches `find_id_by_name`).
    fn persist_activation_override(&self, name: &str, mode: ActivationMode) -> Result<()> {
        self.persist_override_with(name, |ov| ov.activation = Some(mode))
    }

    /// Read-modify-write one entry of the overrides map, preserving the other
    /// field (activation vs enabled) so the two toggles never clobber each other.
    /// Always updates the in-memory map; skips file I/O when no gears dir is set.
    fn persist_override_with(
        &self,
        name: &str,
        update: impl FnOnce(&mut GearOverride),
    ) -> Result<()> {
        let mut map = self
            .activation_overrides
            .write()
            .map_err(|_| anyhow::anyhow!("activation overrides lock poisoned"))?;
        update(map.entry(name.to_string()).or_default());
        let Some(path) = &self.overrides_path else { return Ok(()) };
        let json = serde_json::to_string_pretty(&*map)
            .map_err(|e| anyhow::anyhow!("serialize activation overrides: {e}"))?;
        std::fs::write(path, json).map_err(|e| anyhow::anyhow!("write activation overrides: {e}"))?;
        Ok(())
    }

    /// Enable/disable a gear by name and persist the choice so it survives
    /// restarts AND is honored by the runtime loaders (`load_gears_from_dir`
    /// prompt injection + `crate::mcp` tool exposure), which read the same
    /// overrides file. This is the entry point for the Settings on/off switch;
    /// the id-based [`Self::enable`]/[`Self::disable`] stay memory-only because
    /// they are also used internally (e.g. by [`Self::upgrade`]).
    pub fn set_enabled_by_name(&self, name: &str, enabled: bool) -> Result<()> {
        // Flip the in-memory entry when the gear is registered. MCP gears
        // imported from the marketplace in the current session exist only on
        // disk until the next restart (`write_mcp_gear` does not register in
        // memory), so fall back to a filesystem check instead of 404-ing.
        let mut known = false;
        if let Some(id) = self.find_id_by_name(name) {
            known = true;
            if enabled {
                self.enable(&id)?;
            } else {
                self.disable(&id)?;
            }
        }
        if !known && !self.gear_exists_on_disk(name) {
            anyhow::bail!("gear not installed: {name}");
        }
        self.persist_override_with(name, |ov| ov.enabled = enabled)
    }

    /// Whether a gear directory for `name` exists under the gears dir (matched
    /// by directory name or `manifest.toml` meta name).
    fn gear_exists_on_disk(&self, name: &str) -> bool {
        let Some(dir) = &self.gears_dir else { return false };
        let Ok(entries) = std::fs::read_dir(dir) else { return false };
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            if e.file_name().to_string_lossy().eq_ignore_ascii_case(name) {
                return true;
            }
            let meta_name = std::fs::read_to_string(p.join("manifest.toml"))
                .ok()
                .and_then(|t| GearManifest::from_toml(&t).ok())
                .map(|m| m.meta.name);
            if meta_name.is_some_and(|n| n.eq_ignore_ascii_case(name)) {
                return true;
            }
        }
        false
    }

    /// Remove any persisted activation override for `name` (e.g. after a gear is
    /// uninstalled) so a deleted gear does not leave a stale entry in
    /// `.activation_overrides.json`. The file is removed entirely when no overrides remain.
    pub fn clear_activation_override(&self, name: &str) {
        let Some(path) = &self.overrides_path else { return };
        let mut map = match self.activation_overrides.write() {
            Ok(m) => m,
            Err(_) => return,
        };
        if map.remove(name).is_none() {
            return;
        }
        if map.is_empty() {
            let _ = std::fs::remove_file(path);
            return;
        }
        if let Ok(json) = serde_json::to_string_pretty(&*map) {
            let _ = std::fs::write(path, json);
        }
    }

    /// Re-apply persisted activation overrides on top of the loaded gears. Called after
    /// `load_all` so choices made via the UI toggle or at install time survive restarts.
    fn apply_activation_overrides(&self) {
        let overrides = match self.activation_overrides.read() {
            Ok(o) => o,
            Err(_) => return,
        };
        if overrides.is_empty() {
            return;
        }
        for (name, ov) in overrides.iter() {
            let Some(id) = self.find_id_by_name(name) else { continue };
            if let Ok(mut gears) = self.gears.write()
                && let Some(entry) = gears.get_mut(&id) {
                    if let Some(mode) = ov.activation {
                        entry.activation = mode;
                        if mode.auto_inject() {
                            self.injector.add(id.clone(), entry.normalized.instructions.clone());
                        } else {
                            self.injector.remove(&id);
                        }
                    }
                    entry.enabled = ov.enabled;
                    if !ov.enabled {
                        self.injector.remove(&id);
                    }
                }
        }
    }

    /// Upgrade: atomic replace (01 §5.5.1). Disable old → install new → rollback on failure.
    pub async fn upgrade(&self, id: &GearId, new_spec: &str) -> Result<GearId> {
        // 1. Normalize + install new version first (fail = old untouched)
        let spec = GearSpec::parse(new_spec);
        if spec.source != CapabilitySource::Native {
            anyhow::bail!("upgrade only supported for native gears in Phase 1");
        }
        let new_id = self.install_spec(spec, None, None).await?;

        // 2. Disable old
        self.disable(id)?;

        // 3. Replace
        if let Ok(mut gears) = self.gears.write() {
            gears.remove(id);
        }

        info!(old = %id.0, new = %new_id.0, "gear upgraded");
        Ok(new_id)
    }
}

impl Default for GearHost {
    fn default() -> Self {
        Self::new()
    }
}

/// Project a stored gear entry into the serializable UI summary. This is the
/// single source of truth for both `list_detailed` and `get_info` so the two
/// can never diverge.
fn entry_to_info(e: &GearEntry) -> GearInfo {
    GearInfo {
        id: e.normalized.id.0.clone(),
        name: e.normalized.name.clone(),
        display_name: e.manifest.meta.display_name.clone(),
        spec: e.manifest.meta.spec.clone(),
        version: e.manifest.meta.version.clone(),
        enabled: e.enabled,
        kind: e.manifest.meta.kind,
        activation: e.activation,
        license: e.manifest.meta.license.clone(),
        description: e.manifest.meta.description.clone(),
        has_instructions: !e.normalized.instructions.is_empty(),
        capabilities: GearCapabilitySummary {
            instructions: e.manifest.capabilities.instructions,
            tools: e
                .manifest
                .capabilities
                .tools
                .iter()
                .map(|t| t.ref_name().to_string())
                .collect(),
            strategies: e.manifest.capabilities.strategies.clone(),
        },
    }
}

/// Flat, serializable summary of a gear's declared capabilities (manifest
/// `[capabilities]`), so the management UI can render capability tags.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct GearCapabilitySummary {
    pub instructions: bool,
    /// Referenced tool names (`ref`/`spec` of each declared tool capability).
    pub tools: Vec<String>,
    pub strategies: Vec<String>,
}

/// Serializable summary of an installed gear for the management UI.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GearInfo {
    pub id: String,
    pub name: String,
    /// Human-friendly title for the UI (mirrors `manifest.meta.display_name`).
    /// Falls back to `name` on the client when `None`.
    pub display_name: Option<String>,
    /// Marketplace spec this gear was installed from (e.g.
    /// `modelscope:Alipay/alipay-subscription`); lets the UI show the same id.
    pub spec: Option<String>,
    pub version: String,
    pub enabled: bool,
    pub kind: GearKind,
    pub activation: ActivationMode,
    pub license: Option<String>,
    pub description: String,
    /// Whether this gear actually carries instruction content (ground truth:
    /// derived from `normalized.instructions`, not from its kind or description).
    pub has_instructions: bool,
    /// Declared capabilities (manifest `[capabilities]`) for UI capability tags.
    #[serde(default)]
    pub capabilities: GearCapabilitySummary,
}

/// Map a [`CapabilitySource`] to its [`GearKind`] (for synthesizing manifests).
fn kind_of(source: CapabilitySource) -> GearKind {
    match source {
        CapabilitySource::Native => GearKind::Native,
        CapabilitySource::Skill => GearKind::Skill,
        CapabilitySource::Plugin => GearKind::Plugin,
        CapabilitySource::Mcp => GearKind::Mcp,
        CapabilitySource::Builtin => GearKind::Native,
    }
}

/// Default activation when neither the manifest nor the user specifies one.
/// Tools-bearing kinds (plugin/mcp/native-with-tools) default to `auto` so the
/// model can call them; skills default to `command` (user-triggered via `/name`).
fn default_activation_for(source: CapabilitySource) -> ActivationMode {
    match source {
        CapabilitySource::Skill => ActivationMode::Command,
        _ => ActivationMode::Auto,
    }
}

/// Normalize a native gear pack directory (used by NativeAdapter).
pub fn normalize_native_pack(root: &Path) -> Result<NormalizedGear> {
    let manifest_path = root.join("manifest.toml");
    let manifest = if manifest_path.exists() {
        let text = std::fs::read_to_string(&manifest_path)?;
        let m = GearManifest::from_toml(&text)?;
        m.validate(root)?;
        m
    } else {
        let name = root.file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "unknown".into());
        GearManifest {
            meta: super::manifest::GearMeta {
                name,
                version: "0.1.0".into(),
                description: String::new(),
                author: String::new(),
                icon: None,
                kind: super::manifest::GearKind::Native,
                activation: ActivationMode::Command,
                license: None,
                spec: None,
                display_name: None,
            },
            capabilities: super::manifest::GearCapabilities {
                instructions: root.join("instructions.md").exists(),
                tools: Vec::new(),
                strategies: Vec::new(),
            },
            permissions: Default::default(),
            connection: Default::default(),
        }
    };

    let name = manifest.meta.name.clone();
    let version = manifest.meta.version.clone();
    let id = GearId::new(CapabilitySource::Native, &name, &version);

    let mut instructions = Vec::new();
    if manifest.capabilities.instructions
        && let Ok(text) = std::fs::read_to_string(root.join("instructions.md"))
            && !text.trim().is_empty() {
                instructions.push(Instruction {
                    content: text,
                    source: CapabilitySource::Native,
                    name: Some(name.clone()),
                });
            }

    Ok(NormalizedGear {
        id,
        name,
        description: None,
        instructions,
        tools: Vec::new(),
        permissions: manifest.permissions,
        source: CapabilitySource::Native,
    })
}

    // Marketplace install pipeline
    //
    // Market components (`modelscope-skill:<id>`) are not expressible as a
    // local/remote/mcp spec, so they get a dedicated download -> materialise ->
    // register pipeline here.

    impl GearHost {
        /// Install a marketplace component by its unified spec.
        ///
        /// * `modelscope-skill:<id>` -> fetch the skill's `SKILL.md` and register a
        ///   `kind = skill` gear.
        pub async fn install_market(
            &self,
            spec: &str,
            download_url: Option<String>,
            version: Option<String>,
            display_name: Option<String>,
        ) -> Result<GearId> {
            if let Some(id) = spec.strip_prefix("modelscope-skill:") {
                self.install_modelscope_skill(id, download_url, version, display_name).await
            } else {
                anyhow::bail!("Unsupported marketplace component spec: {spec}")
            }
        }
    async fn install_modelscope_skill(
        &self,
        id: &str,
        download_url: Option<String>,
        version: Option<String>,
        display_name: Option<String>,
    ) -> Result<GearId> {
        // Idempotency: if a gear with the same marketplace spec is already
        // installed (possibly under an older/different `name` after the slug
        // rules changed), uninstall it first so we never accumulate duplicates.
        let spec_key = format!("modelscope-skill:{id}");
        let existing = self.gears.read().ok().and_then(|g| {
            g.iter()
                .find(|(_, e)| e.manifest.meta.spec.as_deref() == Some(spec_key.as_str()))
                .map(|(k, _)| k.clone())
        });
        if let Some(existing) = existing {
            let _ = self.uninstall(&existing);
        }

        let source_url = download_url
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("https://www.modelscope.cn/{id}"));

        // Author/owner used in the generated manifest; defaults to the id's
        // owner segment and is overridden when the source is a GitHub repo.
        let mut owner = id.split('/').next().unwrap_or(id).to_string();

        let dir = self.market_gear_dir("skill", id)?;
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        // Roll back the gear dir if installation fails at any step below (clone,
        // manifest write, registration) so a failed install never lingers on disk
        // and is never shown as installed in Settings.
        let mut install_guard = InstallDirGuard { dir: &dir, keep: false };

        // Resolve the skill body (SKILL.md / skill.md / README.md).
        // GitHub-hosted sources are fetched via raw URLs; ModelScope-hosted
        // sources are cloned locally (their web UI exposes no raw-file endpoint).
        let content = if source_url.contains("github.com") || source_url.contains("raw.githubusercontent.com") {
            let (o, repo, branch, subpath) = parse_github_tree_or_blob(&source_url)
                .ok_or_else(|| anyhow!("暂仅支持 GitHub 托管的技能源码 (source_url={source_url})"))?;
            owner = o;
            let branches = resolve_github_branches(&source_url, &branch, subpath.is_empty());
            let mut found: Option<String> = None;
            for b in &branches {
                let raw_base = format!(
                    "https://raw.githubusercontent.com/{owner}/{repo}/{b}/{subpath}"
                );
                let candidates: Vec<String> = if subpath.ends_with(".md") || subpath.ends_with(".markdown") {
                    vec![raw_base]
                } else {
                    vec![
                        format!("{raw_base}/SKILL.md"),
                        format!("{raw_base}/skill.md"),
                        format!("{raw_base}/README.md"),
                    ]
                };
                for url in &candidates {
                    if let Ok(text) = download_text(url).await
                        && !text.trim().is_empty() {
                            found = Some(text);
                            break;
                        }
                }
                if found.is_some() {
                    break;
                }
            }
            found.ok_or_else(|| anyhow!("未能从源码仓库获取技能文件 (SKILL.md)，source_url={source_url}"))?
        } else if source_url.contains("modelscope.cn") {
            clone_skill_from_modelscope(&source_url, &dir).await?
        } else {
            anyhow::bail!("暂不支持的技能源码地址: {source_url}")
        };
        std::fs::write(dir.join("instructions.md"), &content)?;

        let display = id.rsplit('/').next().unwrap_or(id).replace('"', "'");
        // Manifest `name` is validated against `^[a-z0-9][a-z0-9-]{0,63}$` in
        // `GearManifest::validate`, so it must not start with `_`/`.` or contain
        // them at all — `sanitize_name` (directory-safe) would keep them and
        // trip `INVALID_NAME` for ids like `_anthropics_skill-creator`.
        let safe = manifest_safe_name(id);
        // Prefer the marketplace's human title so the installed gear shows the
        // same name the user saw in the market (the internal `safe` slug stays
        // the stable identity used for delete / idempotency / installed-detection).
        let friendly = display_name
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.replace('"', "'"))
            .unwrap_or_else(|| display.clone());
        let version = version.filter(|v| !v.is_empty()).unwrap_or_else(|| "1.0.0".into());
        let manifest = format!(
            "[meta]\n\
             kind = \"skill\"\n\
             name = \"{safe}\"\n\
             version = \"{version}\"\n\
             description = \"Marketplace skill: {friendly}\"\n\
             author = \"{owner}\"\n\
             activation = \"progressive\"\n\
             display_name = \"{friendly}\"\n\
             spec = \"modelscope-skill:{id}\"\n\
             \n\
             [connection]\n\
             skill_path = \"instructions.md\"\n"
        );
        std::fs::write(dir.join("manifest.toml"), manifest)?;

        let id = self
            .install_local_pack(&dir, Some(ActivationMode::Progressive))
            .await
            .inspect_err(|_e| {
                // A failed install (e.g. `INVALID_NAME` from a malformed manifest)
                // must not leave the half-written gear dir on disk, or it would
                // surface in Settings as an installed gear even though registration
                // never succeeded.
                let _ = std::fs::remove_dir_all(&dir);
            })?;
        // Successfully registered — keep the gear dir on disk.
        install_guard.keep = true;
        Ok(id)
    }

    /// Allocate a dedicated, sanitized directory under `gears_dir` for a
    /// marketplace component.
    fn market_gear_dir(&self, prefix: &str, id: &str) -> Result<PathBuf> {
        let base = self
            .gears_dir
            .as_ref()
            .ok_or_else(|| anyhow!("未配置 DUODUO_GEARS_DIR，无法安装市场组件"))?;
        let name = sanitize_name(&format!("{prefix}-{id}"));
        Ok(base.join(name))
    }
}

/// Shared HTTP client for marketplace downloads (skill source repos, etc.).
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("failed to build http client")
    })
}

async fn download_text(url: &str) -> Result<String> {
    let resp = http_client()
        .get(url)
        .header("User-Agent", "duoduo-ide/1.0")
        .send()
        .await
        .map_err(|e| anyhow!("下载失败: {e}"))?;
    if !resp.status().is_success() {
        anyhow::bail!("下载返回状态 {}", resp.status());
    }
    resp.text()
        .await
        .map_err(|e| anyhow!("读取响应失败: {e}"))
}

/// Clone a ModelScope-hosted skill repo and read its `SKILL.md` / `skill.md` /
/// `README.md`. ModelScope's web UI exposes no raw-file endpoint, so we clone
/// the git repo (shallow HTTPS) and read the file from disk.
async fn clone_skill_from_modelscope(source_url: &str, dir: &Path) -> Result<String> {
    let clone_url = if source_url.ends_with(".git") {
        source_url.to_string()
    } else {
        format!("{source_url}.git")
    };
    let target = dir.to_string_lossy().to_string();
    // `silent_command` applies CREATE_NO_WINDOW on Windows so the clone runs
    // fully in the background instead of flashing a console window; stdio is
    // piped (not inherited) for the same reason.
    let status = duo_utils::platform::silent_command("git")
        .args(["clone", "--depth", "1", clone_url.as_str(), target.as_str()])
        // Never prompt for credentials interactively (e.g. a Windows git
        // credential manager GUI). Fail fast so the error surfaces as a toast
        // instead of hanging on a hidden terminal prompt.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| anyhow!("执行 git clone 失败: {e}"))?;
    if !status.success() {
        anyhow::bail!("克隆技能仓库失败: {clone_url}");
    }
    for name in ["SKILL.md", "skill.md", "README.md", "readme.md"] {
        let p = dir.join(name);
        if p.exists() {
            return std::fs::read_to_string(&p).map_err(|e| anyhow!("读取 {name} 失败: {e}"));
        }
    }
    // Fallback for multi-skill repos (e.g. `anthropics/skills`) where the skill
    // file lives under a subdirectory like `skills/<name>/SKILL.md` instead of
    // the repo root. Recurse one level deep and pick the first match so a
    // monorepo of skills still resolves instead of failing outright.
    if let Ok(mut entries) = std::fs::read_dir(dir) {
        while let Some(Ok(entry)) = entries.next() {
            let sub = entry.path();
            if sub.is_dir() {
                for name in ["SKILL.md", "skill.md", "README.md", "readme.md"] {
                    let p = sub.join(name);
                    if p.exists() {
                        return std::fs::read_to_string(&p)
                            .map_err(|e| anyhow!("读取 {name} 失败: {e}"));
                    }
                }
            }
        }
    }
    anyhow::bail!("仓库中未找到 SKILL.md / skill.md / README.md: {clone_url}")
}




    /// Sanitize a marketplace component id into a safe directory name.
    pub fn sanitize_name(id: &str) -> String {
        id.chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    }

    /// Sanitize a marketplace id into a `manifest.toml` `name` value. Unlike
    /// [`sanitize_name`] (which only targets filesystem safety and may keep a
    /// leading `_`/`.`), this yields a lowercase, `[a-z0-9-]`-only identifier that
    /// starts with an alphanumeric and is at most 64 chars — exactly what
    /// `GearManifest::validate` accepts (`^[a-z0-9][a-z0-9-]{0,63}$`). Used as the
    /// gear's stable identity so ids like `_anthropics_skill-creator` become
    /// `anthropics-skill-creator` instead of failing `INVALID_NAME`.
    fn manifest_safe_name(id: &str) -> String {
        let mut s: String = id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect();
        // Must start with [a-z0-9]; drop any leading separators.
        while s.starts_with('-') {
            s.remove(0);
        }
        if s.is_empty() {
            s.push_str("skill");
        }
        // Collapse repeated/leading/trailing separators.
        s = s
            .split('-')
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        s.truncate(64);
        while s.ends_with('-') {
            s.pop();
        }
        if s.is_empty() {
            s.push_str("skill");
        }
        s
    }

    /// Parse a GitHub tree/blob URL (or a plain `owner/repo[/path]` spec) into
    /// its components. Returns `None` for anything that is not a recognizable
    /// GitHub source.
    fn parse_github_tree_or_blob(
        url: &str,
    ) -> Option<(String, String, String, String)> {
        let url = url.trim();
        if !url.contains("github.com") && !url.contains("raw.githubusercontent.com") {
            let parts: Vec<&str> = url.split('/').filter(|p| !p.is_empty()).collect();
            if parts.len() >= 2 {
                let owner = parts[0].to_string();
                let repo = parts[1].to_string();
                let branch = "main".to_string();
                let subpath = parts[2..].join("/");
                return Some((owner, repo, branch, subpath));
            }
            return None;
        }
        let is_raw = url.contains("raw.githubusercontent.com");
        let path = if let Some(idx) = url.find("github.com/") {
            &url[idx + "github.com/".len()..]
        } else if let Some(idx) = url.find("raw.githubusercontent.com/") {
            &url[idx + "raw.githubusercontent.com/".len()..]
        } else {
            return None;
        };
        let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
        if parts.len() < 2 {
            return None;
        }
        let owner = parts[0].to_string();
        let repo = parts[1].to_string();
        // `raw.githubusercontent.com/owner/repo/<branch>/<path>` puts the branch at
        // index 2; `github.com/owner/repo/(tree|blob)/<branch>/<path>` puts it at
        // index 3 (index 2 is the literal `tree`/`blob`).
        let (branch, subpath) = if is_raw {
            (
                parts
                    .get(2)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "main".to_string()),
                parts.get(3..).map(|s| s.join("/")).unwrap_or_default(),
            )
        } else {
            (
                parts
                    .get(3)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "main".to_string()),
                parts.get(4..).map(|s| s.join("/")).unwrap_or_default(),
            )
        };
        Some((owner, repo, branch, subpath))
    }

    /// Decide which branches to probe for a GitHub-hosted source.
    ///
    /// - `/tree/` or `/blob/` URLs: strictly use the parsed `branch`.
    /// - bare `owner/repo` (no subpath): probe `main` then `master`, to tolerate
    ///   repos whose default branch is `master`.
    /// - `raw.githubusercontent.com` URLs (and any other subpath-bearing form):
    ///   honor the parsed `branch` + `subpath` exactly. Previously the raw branch
    ///   was mis-parsed and then discarded, so a raw source on a non-default
    ///   branch / nested path would fail to install.
    fn resolve_github_branches(source_url: &str, branch: &str, subpath_is_empty: bool) -> Vec<String> {
        if source_url.contains("/tree/") || source_url.contains("/blob/") {
            vec![branch.to_string()]
        } else if subpath_is_empty {
            vec!["main".to_string(), "master".to_string()]
        } else if source_url.contains("raw.githubusercontent.com") {
            vec![branch.to_string()]
        } else {
            // Non-tree/blob URL with a subpath (e.g. a bare `owner/repo/path`):
            // honor the parsed branch rather than guessing main/master.
            vec![branch.to_string()]
        }
    }

    /// Route-level end-to-end smoke test.
    ///
    /// The HTTP route `routes/gear.rs::install` is a thin wrapper that calls
    /// `GearHost::install(name)`. This test drives that same call and proves the
    /// full `install → dispatch → IPC` chain:
    ///   1. `install` spawns `ipc-host.mjs`, loads the echo sample, and
    ///      registers its `echo` tool into the unified global registry.
    ///   2. The tool is discoverable (source = `Plugin`).
    ///   3. A dispatch call routes back to the TS backend instance over IPC and
    ///      returns the tool output (`ECHO:hi`).
    #[tokio::test]
    #[ignore = "integration: spawns ipc-host and installs the local echo plugin sample"]
    async fn install_then_dispatch_ipc_e2e() {
        let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
        let echo = std::path::PathBuf::from(&manifest)
            .join("../../packages/duoduo/src/plugin/samples/echo.mjs");
        assert!(echo.exists(), "echo sample not found");

        let host = GearHost::new();
        host.install(&format!("plugin:{}", echo.display()))
            .await
            .expect("install echo plugin via host");

        // (2) tool must be discoverable in the unified global registry.
        let tool = crate::intel_gear::registry::global()
            .get("echo")
            .expect("echo tool registered after install");
        assert_eq!(tool.source, CapabilitySource::Plugin);

        // (3) dispatch half: route the call back to the TS backend over IPC.
        let instance_id = match &tool.executor {
            ToolExecutor::Plugin { instance_id } => instance_id.clone(),
            _ => panic!("expected Plugin executor"),
        };
        let ts = crate::intel_gear::ts_backend::global_ts_backend();
        let plugin_ref = ts
            .get_instance(&instance_id)
            .await
            .expect("plugin instance registered in TS backend");
        let out = ts
            .call(&plugin_ref, "echo", &serde_json::json!({"msg": "hi"}))
            .await
            .expect("ipc call to echo");
        assert_eq!(out, "ECHO:hi");

        // cleanup so the global registry does not leak across tests
        crate::intel_gear::registry::global().remove("echo");
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn sanitize_name_keeps_safe_chars() {
            // Filesystem-safe characters are preserved verbatim; everything else
            // becomes '_'. This is the directory name used on disk.
            assert_eq!(sanitize_name("a-b_c.d"), "a-b_c.d");
            assert_eq!(sanitize_name("Foo Bar!@#"), "Foo_Bar___");
            assert_eq!(sanitize_name("a/b:c"), "a_b_c");
            assert_eq!(sanitize_name(""), "");
        }

        #[test]
        fn manifest_safe_name_strips_leading_separators() {
            // A leading '_' (kept by sanitize_name) must be dropped and the id
            // must become a valid `[a-z0-9][a-z0-9-]{0,63}` slug.
            assert_eq!(
                manifest_safe_name("_anthropics_skill-creator"),
                "anthropics-skill-creator"
            );
        }

        #[test]
        fn manifest_safe_name_collapses_separators() {
            // Runs of non-alphanumeric chars collapse to a single '-'.
            assert_eq!(manifest_safe_name("a__b--c..d"), "a-b-c-d");
            assert_eq!(manifest_safe_name("My-Cool_Plugin.v2"), "my-cool-plugin-v2");
        }

        #[test]
        fn manifest_safe_name_empty_becomes_skill() {
            // An all-separator or empty id must fall back to "skill" rather than
            // producing an empty/invalid manifest name.
            assert_eq!(manifest_safe_name("---"), "skill");
            assert_eq!(manifest_safe_name(""), "skill");
        }

        #[test]
        fn manifest_safe_name_truncates_to_64() {
            let long = "a".repeat(120);
            let out = manifest_safe_name(&long);
            assert!(out.len() <= 64, "slug must be <= 64 chars");
            assert!(!out.ends_with('-'), "trailing separator trimmed");
        }

        #[test]
        fn manifest_safe_name_starts_alphanumeric() {
            // After stripping leading separators, the first char must be [a-z0-9]
            // (validated against `^[a-z0-9][a-z0-9-]{0,63}$`).
            let out = manifest_safe_name("_123abc");
            assert!(out.chars().next().unwrap().is_ascii_alphanumeric());
        }

        #[test]
        fn parse_github_bare_owner_repo() {
            // `owner/repo` (no github host) still parses as a GitHub source with
            // the default `main` branch and empty subpath.
            let (o, r, b, sub) = parse_github_tree_or_blob("owner/repo").unwrap();
            assert_eq!(
                (o.as_str(), r.as_str(), b.as_str(), sub.as_str()),
                ("owner", "repo", "main", "")
            );
        }

        #[test]
        fn parse_github_with_subpath() {
            let (o, r, b, sub) = parse_github_tree_or_blob("owner/repo/some/path").unwrap();
            assert_eq!(
                (o.as_str(), r.as_str(), b.as_str(), sub.as_str()),
                ("owner", "repo", "main", "some/path")
            );
        }

        #[test]
        fn parse_github_tree_url_uses_explicit_branch() {
            // `/tree/<branch>/...` must pin the branch exactly (not fall back to
            // main/master probing).
            let (o, r, b, sub) = parse_github_tree_or_blob(
                "https://github.com/owner/repo/tree/dev/skill",
            )
            .unwrap();
            assert_eq!(
                (o.as_str(), r.as_str(), b.as_str(), sub.as_str()),
                ("owner", "repo", "dev", "skill")
            );
        }

        #[test]
        fn parse_github_raw_url() {
            // raw.githubusercontent.com/owner/repo/<branch>/<path> — branch sits at
            // index 2 (no `/tree/`/`/blob/` shim), subpath at index 3..
            let (o, r, b, sub) = parse_github_tree_or_blob(
                "https://raw.githubusercontent.com/owner/repo/main/SKILL.md",
            )
            .unwrap();
            assert_eq!(
                (o.as_str(), r.as_str(), b.as_str(), sub.as_str()),
                ("owner", "repo", "main", "SKILL.md")
            );
        }

        #[test]
        fn parse_github_raw_url_with_subpath_and_branch() {
            // Non-default branch + nested subpath must be preserved exactly.
            let (o, r, b, sub) = parse_github_tree_or_blob(
                "https://raw.githubusercontent.com/owner/repo/dev/some/SKILL.md",
            )
            .unwrap();
            assert_eq!(
                (o.as_str(), r.as_str(), b.as_str(), sub.as_str()),
                ("owner", "repo", "dev", "some/SKILL.md")
            );
        }

        #[test]
        fn parse_github_blob_url_uses_branch_segment() {
            // `/blob/<branch>/...` keeps the branch segment at index 3.
            let (o, r, b, sub) = parse_github_tree_or_blob(
                "https://github.com/owner/repo/blob/rel-1/skill/SKILL.md",
            )
            .unwrap();
            assert_eq!(
                (o.as_str(), r.as_str(), b.as_str(), sub.as_str()),
                ("owner", "repo", "rel-1", "skill/SKILL.md")
            );
        }

        #[test]
        fn parse_github_accepts_any_owner_repo_form() {
            // Non-GitHub strings with >=2 path segments are still parsed as
            // owner/repo (+ default main branch, remaining as subpath). This pins
            // the current lenient behavior.
            let (o, r, b, sub) = parse_github_tree_or_blob("https://example.com/x/y").unwrap();
            // parts[0] retains the `https:` scheme token from the leading `//`.
            assert_eq!(
                (o.as_str(), r.as_str(), b.as_str(), sub.as_str()),
                ("https:", "example.com", "main", "x/y")
            );
            // Fewer than 2 segments cannot form owner/repo and return None.
            assert!(parse_github_tree_or_blob("just-one-segment").is_none());
        }

        // Mirror of `norm_key` (duo-smart-layer route side) — kept local so the
        // installed-detection alignment invariant can be asserted here without
        // crossing crate boundaries. Must stay in sync with gear.rs:norm_key.
        fn norm_key(s: &str) -> String {
            s.chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
                .to_lowercase()
        }

        #[test]
        fn installed_detection_alignment_invariant() {
            // The `entry_installed` invariant (gear.rs:240) relies on
            // norm_key(sanitize_name(id)) == norm_key(manifest_safe_name(id))
            // so a market skill id resolves to the same gear whether matched by
            // its directory-safe name or its manifest-safe slug.
            let ids = [
                "_anthropics_skill-creator",
                "My-Cool_Plugin.v2",
                "owner/repo-name",
                "a__b--c..d",
                "ModelScope/Skill_ID",
            ];
            for id in ids {
                let a = norm_key(&sanitize_name(id));
                let b = norm_key(&manifest_safe_name(id));
                assert_eq!(
                    a, b,
                    "norm_key mismatch for id {id}: sanitize={a} manifest={b}"
                );
            }
        }

        #[test]
        fn resolve_github_branches_tree_blob_uses_exact_branch() {
            // Explicit /tree/ or /blob/ must pin the parsed branch verbatim.
            assert_eq!(
                resolve_github_branches("https://github.com/o/r/tree/dev/x", "dev", false),
                vec!["dev".to_string()]
            );
            assert_eq!(
                resolve_github_branches("https://github.com/o/r/blob/v1/y", "v1", true),
                vec!["v1".to_string()]
            );
        }

        #[test]
        fn resolve_github_branches_bare_repo_probes_main_master() {
            // Bare `owner/repo` (empty subpath) probes main then master.
            assert_eq!(
                resolve_github_branches("https://github.com/o/r", "main", true),
                vec!["main".to_string(), "master".to_string()]
            );
        }

        #[test]
        fn resolve_github_branches_raw_uses_parsed_branch() {
            // raw URL with a non-default branch + subpath must honor the parsed
            // branch (this is the bug fix: previously it fell back to main/master
            // and discarded the subpath).
            assert_eq!(
                resolve_github_branches(
                    "https://raw.githubusercontent.com/o/r/dev/some/SKILL.md",
                    "dev",
                    false
                ),
                vec!["dev".to_string()]
            );
            // raw URL on the default branch still resolves (subpath present here).
            assert_eq!(
                resolve_github_branches(
                    "https://raw.githubusercontent.com/o/r/main/SKILL.md",
                    "main",
                    false
                ),
                vec!["main".to_string()]
            );
        }
    }
