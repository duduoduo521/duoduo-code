//! IntelGear (智械): unified capability package of instructions + tools + strategy.
//!
//! Module structure:
//! - `model`    — core types (NormalizedGear, ToolExecutor, GearSpec, …)
//! - `manifest` — TOML manifest parsing + validation
//! - `registry` — GearToolRegistry (unified tool dispatch overlay)
//! - `injector` — PromptInjector (system prompt instruction injection)
//! - `host`     — GearHost (central coordinator, lifecycle management)
//!
//! Backward compatibility: `GearInstructionPayload` (formerly `GearManifest`)
//! and `load_gears_from_env` / `load_gears_from_dir` are preserved so existing
//! callers (`agentic_loop.rs with_gears`, `agent.rs run_loop_handler`) keep working.

pub mod adapter;
pub mod backend;
pub mod host;
pub mod injector;
pub mod manifest;
pub mod market;
pub mod model;
pub mod registry;
pub mod skill;
pub mod strategy;
pub mod ts_backend;
pub mod wasm_backend;

// ── Backward-compatible instruction payload ──
// agentic_loop.rs consumes this via `with_gears(Vec<GearInstructionPayload>)`.

/// A single capability package's instruction payload (per-run injection).
/// This is the OLD `GearManifest` — renamed to avoid collision with the full
/// TOML manifest in `manifest.rs`.
#[derive(Clone, Debug, Default)]
pub struct GearInstructionPayload {
    /// Human-readable capability name (used as the `## Active Capability:` heading).
    pub name: String,
    /// Instruction text appended to the system prompt.
    pub instructions: String,
}

// Keep the old name as an alias so existing code compiles without changes.
pub type GearManifest = GearInstructionPayload;

/// Result of loading installed gears for a single run.
pub struct GearLoadResult {
    /// Full instruction payloads to inject into the system prompt
    /// (non-progressive gears: `command`/`global`/`auto` + native packs).
    pub payloads: Vec<GearInstructionPayload>,
    /// Lightweight progressive-disclosure catalog of `progressive` skills
    /// (`name + description` only). Injected as a small block so the model can
    /// decide which skill to expand via the `load_skill` tool — without paying
    /// the token cost of every full skill body.
    pub skill_catalog: String,
}

/// Load installed gears from the directory named by `DUODUO_GEARS_DIR`.
///
/// `progressive` skills contribute only to the lightweight catalog; their full
/// instructions are loaded on demand via the `load_skill` tool.
/// The full TOML manifest parsing + tool registration is handled by `GearHost::load_all`.
pub fn load_gears_from_env() -> GearLoadResult {
    match std::env::var("DUODUO_GEARS_DIR") {
        Ok(dir) => load_gears_from_dir(std::path::Path::new(&dir)),
        Err(_) => GearLoadResult {
            payloads: Vec::new(),
            skill_catalog: String::new(),
        },
    }
}

/// Read each subdirectory of `dir` as one gear (instruction-only, backward compat).
///
/// `progressive` skills are registered as catalog entries only (name + description);
/// every other kind has its full `instructions.md` injected.
///
/// Honors the user overrides in `<dir>/.activation_overrides.json` (single
/// source of truth written by `GearHost`): a gear disabled via the Settings
/// switch is skipped entirely, and an activation override (UI auto-call
/// toggle) takes precedence over the manifest's declared default.
pub fn load_gears_from_dir(dir: &std::path::Path) -> GearLoadResult {
    let mut payloads = Vec::new();
    let mut catalog_lines: Vec<String> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return GearLoadResult {
            payloads,
            skill_catalog: String::new(),
        };
    };
    let overrides = host::read_activation_overrides(dir);
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let instructions =
            std::fs::read_to_string(path.join("instructions.md")).unwrap_or_default();
        if instructions.trim().is_empty() {
            continue;
        }

        // Determine activation mode from manifest.toml (default Command).
        let manifest = path
            .join("manifest.toml")
            .exists()
            .then(|| {
                std::fs::read_to_string(path.join("manifest.toml"))
                    .ok()
                    .and_then(|t| manifest::GearManifest::from_toml(&t).ok())
            })
            .flatten();

        // Gear name = manifest meta.name (the override key used by the UI
        // routes) with the directory name as fallback for manifest-less packs.
        let dir_name = entry.file_name().to_string_lossy().to_string();
        let name = manifest
            .as_ref()
            .map(|m| m.meta.name.clone())
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| dir_name.clone());

        // User override: disabled gears are skipped entirely (no prompt
        // injection, no catalog entry); activation override wins over manifest.
        let ov = overrides.get(&name);
        if ov.is_some_and(|o| !o.enabled) {
            continue;
        }
        let activation = ov
            .and_then(|o| o.activation)
            .or_else(|| manifest.as_ref().map(|m| m.meta.activation))
            .unwrap_or_default();

        if activation.is_progressive() {
            // Only register the lightweight catalog; do NOT inject the full body.
            let fm_desc = skill::split_frontmatter(&instructions)
                .0
                .get("description")
                .cloned()
                .filter(|s| !s.trim().is_empty());
            let description = fm_desc
                .or_else(|| {
                    manifest
                        .as_ref()
                        .map(|m| m.meta.description.clone())
                        .filter(|d| !d.trim().is_empty())
                })
                .unwrap_or_else(|| "(no description)".to_string());
            catalog_lines.push(format!("- {}: {}", name, description));
            continue;
        }

        payloads.push(GearInstructionPayload { name: dir_name, instructions });
    }

    let skill_catalog = if catalog_lines.is_empty() {
        String::new()
    } else {
        format!(
            "## Available Skills (call load_skill(name) to load full instructions)\n{}",
            catalog_lines.join("\n")
        )
    };

    GearLoadResult {
        payloads,
        skill_catalog,
    }
}
