//! End-to-end test for the `/<gear>` command → activate route behaviour.
//!
//! The HTTP handler `POST /gears/:name/activate` ultimately calls
//! `GearHost::activate_command_by_name`, which injects the gear's instructions
//! into the host's `PromptInjector`. This test exercises that exact path
//! (load → discover → activate → inject).
//!
//! ## Why a self-built fixture instead of the real gears repo
//!
//! This test used to point `DUODUO_GEARS_DIR` at an external `duoduocode-gears`
//! checkout (`D:\duoduocode-gears\gears` or a sibling of the workspace). That
//! checkout is not part of this repository, so on any machine without it the
//! loader found zero gears and the assertions failed — a red test that said
//! nothing about the code under test. A test whose outcome depends on an
//! unavailable external checkout cannot verify anything.
//!
//! Instead each test writes a minimal but *real* gear pack (`manifest.toml` +
//! `instructions.md`) into a temp dir and points the loader at it. The code path
//! under test — `load_all` → `load_gear_pack` → manifest parse/validate →
//! `install_spec` → activation semantics → `PromptInjector` — is exercised in
//! full, and the test is now hermetic and runs anywhere.

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use agent_executor::intel_gear::host::GearHost;

/// `DUODUO_GEARS_DIR` is process-global and `GearHost::new()` reads it at
/// construction time, so two tests running concurrently in the same process
/// would race and read each other's directory. Serialize them.
fn env_guard() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Write one gear pack (`manifest.toml` + `instructions.md`) under `root`.
///
/// `activation` must be a valid `ActivationMode` TOML value (`command`,
/// `progressive`, `auto`, `global`). `kind = "native"` with no declared tools
/// keeps `effective_activation()` from promoting `command` → `auto`, which is
/// what makes the command-gear half of this test meaningful.
fn write_gear(root: &Path, name: &str, activation: &str, instructions: &str) {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).expect("create gear dir");
    std::fs::write(
        dir.join("manifest.toml"),
        format!(
            r#"[meta]
name = "{name}"
version = "0.1.0"
description = "fixture gear for the activate e2e test"
author = "test"
kind = "native"
activation = "{activation}"

[capabilities]
instructions = true
"#
        ),
    )
    .expect("write manifest.toml");
    // `validate()` requires this file to exist when `capabilities.instructions`
    // is true; its body is what must reach the PromptInjector.
    std::fs::write(dir.join("instructions.md"), instructions).expect("write instructions.md");
}

/// Build a host over a fresh temp gears dir containing the two fixture gears.
/// Returns the host and the `TempDir` guard (kept alive by the caller).
async fn host_with_fixture() -> (GearHost, tempfile::TempDir) {
    let tmp = tempfile::tempdir().expect("create temp gears dir");
    write_gear(
        tmp.path(),
        "duoduo-git",
        "command",
        "# duoduo-git\n\nGit workflow guidance for the agent.\n",
    );
    write_gear(
        tmp.path(),
        "duoduo-code-review",
        "global",
        "# duoduo-code-review\n\nAlways-on code review guidance.\n",
    );

    // Must be set before `GearHost::new()` — the constructor snapshots it.
    unsafe {
        std::env::set_var("DUODUO_GEARS_DIR", tmp.path());
    }
    let host = GearHost::new();
    host.load_all().await;
    (host, tmp)
}

#[tokio::test]
async fn e2e_command_gear_activate_injects_instructions() {
    let _guard = env_guard().lock().unwrap_or_else(|e| e.into_inner());
    // Surface any gear-pack load skips (they are logged via `warn!`).
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .try_init();

    let (host, _tmp) = host_with_fixture().await;

    // Both fixture gears must be discovered from the unified gears folder.
    let detailed = host.list_detailed();
    let names: Vec<&str> = detailed.iter().map(|g| g.name.as_str()).collect();
    assert!(names.contains(&"duoduo-git"), "duoduo-git should be loaded");
    assert!(
        names.contains(&"duoduo-code-review"),
        "duoduo-code-review should be loaded"
    );

    // duoduo-git is a command-gear: it must NOT be auto-injected at load time.
    let before = host.injector.snapshot_instructions();
    assert!(
        !before
            .iter()
            .any(|i| i.name.as_deref() == Some("duoduo-git")),
        "command-gear must NOT be injected before activation"
    );

    // Activate via the same method the HTTP route calls.
    host.activate_command_by_name("duoduo-git")
        .expect("activate duoduo-git must succeed");

    // Now the gear's instructions are injected with the gear's name.
    let after = host.injector.snapshot_instructions();
    let git_instructions: Vec<_> = after
        .iter()
        .filter(|i| i.name.as_deref() == Some("duoduo-git"))
        .collect();
    assert_eq!(git_instructions.len(), 1, "exactly one duoduo-git injection");
    assert!(
        git_instructions[0].content.contains("Git workflow guidance"),
        "injected instruction must carry the gear's workflow content, got: {:?}",
        git_instructions[0].content
    );

    // Idempotent: re-activation must not duplicate the gear.
    host.activate_command_by_name("duoduo-git").ok();
    let again = host.injector.snapshot_instructions();
    assert_eq!(
        again
            .iter()
            .filter(|i| i.name.as_deref() == Some("duoduo-git"))
            .count(),
        1,
        "re-activation must not duplicate the gear"
    );
}

#[tokio::test]
async fn e2e_global_gear_auto_injected_at_load() {
    let _guard = env_guard().lock().unwrap_or_else(|e| e.into_inner());
    let (host, _tmp) = host_with_fixture().await;

    // duoduo-code-review is a global gear → injected at load time (no trigger needed).
    let snapshot = host.injector.snapshot_instructions();
    assert!(
        snapshot
            .iter()
            .any(|i| i.name.as_deref() == Some("duoduo-code-review")),
        "global gear must be auto-injected at load"
    );
}
