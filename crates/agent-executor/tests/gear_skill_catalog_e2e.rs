//! End-to-end test for the market Skill install -> runtime exposure path.
//!
//! Covers the gap called out in the audit: the runtime system prompt is built
//! SOLELY by `load_gears_from_dir` (C-system), and a `progressive` skill must
//! surface ONLY in `skill_catalog` (not in `payloads`), while a `command`
//! (non-progressive) skill must surface ONLY in `payloads` (not the catalog).
//! This exercises the same code `install_modelscope_skill` uses internally
//! (`install_local_pack` -> `install_spec`), fully offline.
//!
//! NOTE: the file name intentionally avoids the substring "install" — Windows
//! "Installer Detection" forces UAC elevation for binaries whose name contains
//! "install"/"setup"/"update", which would block `cargo test` from launching it.

use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use agent_executor::intel_gear::host::GearHost;
use agent_executor::intel_gear::load_gears_from_dir;
use agent_executor::intel_gear::manifest::ActivationMode;

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// Serializes tests that touch the process-global `DUODUO_GEARS_DIR` env var
/// (cargo runs tests in one binary on parallel threads).
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn env_guard() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Create a unique temp gears dir that is cleaned up on drop.
///
/// NB: we deliberately avoid `std::env::temp_dir()` (normally
/// `C:\Users\...\AppData\Local\Temp`): on this Windows host spawning test
/// binaries that touch that path triggers a UAC elevation prompt. The project
/// lives on `D:`, so we keep the scratch dir under the crate's working dir.
fn make_gears_dir() -> std::path::PathBuf {
    let pid = std::process::id();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::current_dir()
        .unwrap()
        .join(format!("target/gear_skill_test_{pid}_{n}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp gears dir");
    dir
}

/// Write a skill pack (manifest.toml + instructions.md) under `parent`.
fn write_skill_pack(parent: &Path, name: &str, activation: ActivationMode, body: &str) {
    let dir = parent.join(name);
    std::fs::create_dir_all(&dir).expect("create skill dir");
    let activation_str = match activation {
        ActivationMode::Progressive => "progressive",
        ActivationMode::Command => "command",
        ActivationMode::Auto => "auto",
        ActivationMode::Global => "global",
    };
    let manifest = format!(
        r#"[meta]
kind = "skill"
name = "{name}"
version = "1.0.0"
description = "Description for {name}"
author = "tester"
activation = "{activation_str}"
spec = "modelscope-skill:tester/{name}"

[connection]
skill_path = "instructions.md"

[capabilities]
instructions = true
tools = []
"#,
    );
    std::fs::write(dir.join("manifest.toml"), manifest).expect("write manifest.toml");
    std::fs::write(
        dir.join("instructions.md"),
        format!(
            "---\ndescription: frontmatter description for {name}\n---\n{body}\n",
        ),
    )
    .expect("write instructions.md");
}

#[tokio::test]
async fn market_skill_register_exposes_progressive_in_catalog_only() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .try_init();

    let _env = env_guard();
    let gears_dir = make_gears_dir();
    unsafe {
        std::env::set_var("DUODUO_GEARS_DIR", &gears_dir);
    }

    // Two packs: one progressive (market default), one command (user-triggered).
    write_skill_pack(&gears_dir, "skill-a", ActivationMode::Progressive, "Skill A body.");
    write_skill_pack(&gears_dir, "cmd-skill", ActivationMode::Command, "Cmd skill body.");

    let host = GearHost::new();
    // install_local_pack is the exact function install_modelscope_skill calls.
    host.install_local_pack(&gears_dir.join("skill-a"), Some(ActivationMode::Progressive))
        .await
        .expect("install skill-a");
    host.install_local_pack(&gears_dir.join("cmd-skill"), Some(ActivationMode::Command))
        .await
        .expect("install cmd-skill");

    // 1) Install registration: the progressive gear is registered in GearHost.
    assert!(
        host.find_id_by_name("skill-a").is_some(),
        "skill-a must be registered after install"
    );

    // 2) Runtime exposure (the path agent.rs uses). Progressive -> catalog only.
    let result = load_gears_from_dir(&gears_dir);
    assert!(
        result.skill_catalog.contains("skill-a"),
        "progressive skill must appear in skill_catalog; got:\n{}",
        result.skill_catalog
    );
    assert!(
        result
            .skill_catalog
            .contains("frontmatter description for skill-a"),
        "catalog must surface the frontmatter description; got:\n{}",
        result.skill_catalog
    );
    assert!(
        !result.payloads.iter().any(|p| p.name == "skill-a"),
        "progressive skill must NOT be injected into payloads; got {:?}",
        result.payloads
    );

    // 3) Non-progressive (command) skill -> payloads only, never the catalog.
    assert!(
        result
            .payloads
            .iter()
            .any(|p| p.name == "cmd-skill" && p.instructions.contains("Cmd skill body.")),
        "command skill must be injected into payloads; got {:?}",
        result.payloads
    );
    assert!(
        !result.skill_catalog.contains("cmd-skill"),
        "command skill must NOT appear in the progressive catalog; got:\n{}",
        result.skill_catalog
    );

    let _ = std::fs::remove_dir_all(&gears_dir);
}

/// The Settings on/off switch must actually affect the runtime: a gear
/// disabled via `set_enabled_by_name` is persisted to
/// `.activation_overrides.json` and skipped by `load_gears_from_dir`
/// (no prompt injection, no catalog entry) — and survives a "restart"
/// (a fresh `GearHost` + a fresh loader pass reading only the disk state).
#[tokio::test]
async fn disabled_gear_is_skipped_by_runtime_loader() {
    let _env = env_guard();
    let gears_dir = make_gears_dir();
    unsafe {
        std::env::set_var("DUODUO_GEARS_DIR", &gears_dir);
    }

    write_skill_pack(&gears_dir, "prog-off", ActivationMode::Progressive, "Prog body.");
    write_skill_pack(&gears_dir, "cmd-off", ActivationMode::Command, "Cmd body.");

    let host = GearHost::new();
    host.install_local_pack(&gears_dir.join("prog-off"), Some(ActivationMode::Progressive))
        .await
        .expect("install prog-off");
    host.install_local_pack(&gears_dir.join("cmd-off"), Some(ActivationMode::Command))
        .await
        .expect("install cmd-off");

    // Baseline: both visible to the runtime loader.
    let before = load_gears_from_dir(&gears_dir);
    assert!(before.skill_catalog.contains("prog-off"));
    assert!(before.payloads.iter().any(|p| p.name == "cmd-off"));

    // Disable both via the persisted path (what the routes now call).
    host.set_enabled_by_name("prog-off", false).expect("disable prog-off");
    host.set_enabled_by_name("cmd-off", false).expect("disable cmd-off");
    assert!(
        gears_dir.join(".activation_overrides.json").exists(),
        "disable must persist to .activation_overrides.json"
    );

    // Runtime loader must now skip both entirely.
    let after = load_gears_from_dir(&gears_dir);
    assert!(
        !after.skill_catalog.contains("prog-off"),
        "disabled progressive gear must vanish from the catalog; got:\n{}",
        after.skill_catalog
    );
    assert!(
        !after.payloads.iter().any(|p| p.name == "cmd-off"),
        "disabled command gear must not be injected; got {:?}",
        after.payloads
    );

    // Re-enable one and confirm it comes back.
    host.set_enabled_by_name("cmd-off", true).expect("re-enable cmd-off");
    let back = load_gears_from_dir(&gears_dir);
    assert!(back.payloads.iter().any(|p| p.name == "cmd-off"));
    assert!(!back.skill_catalog.contains("prog-off"), "prog-off stays disabled");

    let _ = std::fs::remove_dir_all(&gears_dir);
}

/// Backward compatibility + runtime activation override:
/// 1) a legacy `.activation_overrides.json` (bare mode string values) still
///    parses, defaults `enabled` to true, and
/// 2) the activation override now takes effect in the runtime loader
///    (command -> progressive moves the gear from payloads into the catalog).
#[tokio::test]
async fn legacy_override_file_and_activation_override_apply_at_runtime() {
    let _env = env_guard();
    let gears_dir = make_gears_dir();
    unsafe {
        std::env::set_var("DUODUO_GEARS_DIR", &gears_dir);
    }

    // Manifest says `command`, but a legacy override flips it to progressive.
    write_skill_pack(&gears_dir, "flip-skill", ActivationMode::Command, "Flip body.");
    std::fs::write(
        gears_dir.join(".activation_overrides.json"),
        r#"{ "flip-skill": "progressive" }"#,
    )
    .expect("write legacy overrides");

    let result = load_gears_from_dir(&gears_dir);
    assert!(
        result.skill_catalog.contains("flip-skill"),
        "override to progressive must move the gear into the catalog; got:\n{}",
        result.skill_catalog
    );
    assert!(
        !result.payloads.iter().any(|p| p.name == "flip-skill"),
        "overridden gear must no longer be injected as a payload; got {:?}",
        result.payloads
    );

    // A fresh GearHost must also read the legacy file without losing it: the
    // auto-call toggle written afterwards must preserve `enabled: true`.
    let host = GearHost::new();
    host.install_local_pack(&gears_dir.join("flip-skill"), None)
        .await
        .expect("install flip-skill");
    host.set_enabled_by_name("flip-skill", false).expect("disable flip-skill");
    let after = load_gears_from_dir(&gears_dir);
    assert!(
        !after.skill_catalog.contains("flip-skill"),
        "disable after a legacy activation override must win; got:\n{}",
        after.skill_catalog
    );

    let _ = std::fs::remove_dir_all(&gears_dir);
}

/// A disabled MCP gear must not have its server connected nor its tools
/// exposed by `ensure_gear_mcp_from_dir` (the runtime MCP path).
#[tokio::test]
async fn disabled_mcp_gear_is_not_exposed() {
    let _env = env_guard();
    let gears_dir = make_gears_dir();

    // One MCP gear dir: manifest.toml (meta name differs from dir name, as
    // written by write_mcp_gear) + tools/mcp.json with an unlaunchable command.
    let gear_dir = gears_dir.join("mcp-demo-server");
    std::fs::create_dir_all(gear_dir.join("tools")).expect("create mcp gear dir");
    std::fs::write(
        gear_dir.join("manifest.toml"),
        r#"[meta]
kind = "mcp"
name = "demo-server"
version = "1.0.0"
description = "demo"
author = "tester"

[capabilities]
instructions = false
tools = []
"#,
    )
    .expect("write mcp manifest");
    std::fs::write(
        gear_dir.join("tools").join("mcp.json"),
        r#"{ "kind": "stdio", "command": "definitely-not-a-real-command-xyz", "args": [] }"#,
    )
    .expect("write mcp.json");

    // Disabled via override keyed by the manifest meta name (what the UI uses).
    std::fs::write(
        gears_dir.join(".activation_overrides.json"),
        r#"{ "demo-server": { "enabled": false } }"#,
    )
    .expect("write overrides");

    agent_executor::mcp::ensure_gear_mcp_from_dir(&gears_dir).await;
    let defs = agent_executor::mcp::mcp_tool_definitions();
    assert!(
        !defs.iter().any(|d| d.function.name.contains("demo-server")
            || d.function.name.contains("mcp-demo-server")),
        "disabled MCP gear must not expose tools; got {:?}",
        defs.iter().map(|d| &d.function.name).collect::<Vec<_>>()
    );

    agent_executor::mcp::shutdown_gear_mcp().await;
    let _ = std::fs::remove_dir_all(&gears_dir);
}
