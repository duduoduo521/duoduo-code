//! Configuration loader for DuoDuo smart layer.
//!
//! Loads configuration from `config_dir()/duoduo/config.toml`,
//! falling back to defaults when the file is absent.
//! Environment variables take precedence over TOML values.

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use duo_types::env_keys::{core, im};

use crate::model::{LoopConfig, SmartLayerConfig};

/// Returns the path to the configuration file: `config_dir()/config.toml`.
fn config_file_path() -> Result<PathBuf> {
    let dir = duo_utils::path::config_dir()?;
    Ok(dir.join("config.toml"))
}

/// Secret-store id under which the Feishu App Secret is kept.
///
/// The secret lives in the OS keyring (encrypted-file fallback), never in
/// `config.toml`: that file is plain text inside the user's config directory
/// and routinely ends up attached to bug reports.
const FEISHU_APP_SECRET_ID: &str = "im.feishu.app_secret";

/// Placeholder returned by `GET /im/config` and echoed back on save.
///
/// The UI shows a mask instead of the real secret; when the user does not touch
/// the field it submits the mask again, which must be read as "unchanged" —
/// treating it as a literal secret would overwrite the stored value (or fail
/// Feishu validation) on every unrelated save.
pub const SECRET_MASK: &str = "\u{2022}\u{2022}\u{2022}\u{2022}";

/// Serialises every read-modify-write cycle on `config.toml`.
///
/// The smart-layer runs on a 4-worker tokio runtime, so `save_im_config` (an
/// HTTP handler) and `save_loop_config` (a `ConfigManager` method) execute
/// concurrently. Both read the whole file and write it back, so without this
/// lock the later writer replaces the file with a snapshot taken *before* the
/// earlier writer's change — silently dropping that change.
static CONFIG_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// The single entry point for mutating `config.toml`.
///
/// Holds [`CONFIG_WRITE_LOCK`] across the whole read → mutate → write cycle and
/// writes atomically. Together these rule out both failure modes:
///
/// - **Lost updates** — two writers racing on a stale snapshot.
/// - **Torn reads** — a concurrent `load_config()` observing a truncated file,
///   failing to parse it, and falling back to defaults (which looks like every
///   setting silently resetting itself).
fn with_config_update<F>(mutator: F) -> Result<()>
where
    F: FnOnce(&mut toml::Table) -> Result<()>,
{
    let _guard = duo_utils::sync::lock(&CONFIG_WRITE_LOCK);

    let path = config_file_path()?;
    let mut root = read_config_table(&path)?;

    mutator(&mut root)?;

    let content = toml::to_string_pretty(&root).context("Failed to serialize config to TOML")?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create config directory: {}", parent.display()))?;
    }

    duo_utils::fs::atomic_write(&path, content.as_bytes())
        .with_context(|| format!("Failed to write config file: {}", path.display()))?;

    tracing::info!("config.toml updated at {}", path.display());
    Ok(())
}

/// Parse `config.toml` into a table. A missing or empty file yields an empty
/// table; malformed TOML is an error — overwriting a config we cannot parse
/// would discard every other section the user has configured.
fn read_config_table(path: &Path) -> Result<toml::Table> {
    if !path.exists() {
        return Ok(toml::Table::new());
    }
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read config file: {}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(toml::Table::new());
    }
    toml::from_str(&content)
        .with_context(|| format!("Failed to parse config file: {}", path.display()))
}

/// Load configuration from disk and apply environment variable overrides.
///
/// Resolution order (later wins):
/// 1. Built-in defaults (`SmartLayerConfig::default()`)
/// 2. TOML file at `config_dir()/duoduo/config.toml` (if present)
/// 3. Environment variable overrides
pub fn load_config() -> Result<SmartLayerConfig> {
    let mut config = load_from_file().context("Failed to load config file")?;

    apply_env_overrides(&mut config);
    resolve_externalized_secrets(&mut config);

    Ok(config)
}

/// Fill in secrets that `config.toml` only records as "present".
///
/// An empty Feishu `app_secret` is the normal on-disk state: the value is held
/// in the OS keyring. Reading it back here keeps every consumer
/// (`im_runtime`, the HTTP config route) working on a fully populated
/// `ImConfig` without knowing where the secret physically lives.
fn resolve_externalized_secrets(config: &mut SmartLayerConfig) {
    let Some(feishu) = config.im.feishu.as_mut() else {
        return;
    };
    if !feishu.app_secret.is_empty() {
        return;
    }
    match duo_utils::secret_store::load_secret(FEISHU_APP_SECRET_ID) {
        Some(secret) => feishu.app_secret = secret,
        None => tracing::warn!(
            "Feishu is configured but no App Secret is stored — re-enter it in IM settings"
        ),
    }
}

/// Load configuration from the TOML file, returning defaults if the file
/// does not exist. Returns an error if the file exists but cannot be parsed.
fn load_from_file() -> Result<SmartLayerConfig> {
    let path = config_file_path()?;

    if !path.exists() {
        tracing::debug!(
            "Config file not found at {}, using defaults",
            path.display()
        );
        return Ok(SmartLayerConfig::default());
    }

    let content = std::fs::read_to_string(&path)
        .with_context(|| format!("Failed to read config file: {}", path.display()))?;

    let config: SmartLayerConfig = toml::from_str(&content)
        .with_context(|| format!("Failed to parse config file: {}", path.display()))?;

    tracing::debug!("Loaded config from {}", path.display());
    Ok(config)
}

/// Apply environment variable overrides on top of the loaded configuration.
fn apply_env_overrides(config: &mut SmartLayerConfig) {
    if let Ok(val) = std::env::var(core::PORT) {
        if let Ok(port) = val.parse::<u16>() {
            config.port = port;
        } else {
            tracing::warn!("Invalid {} value '{}', ignoring", core::PORT, val);
        }
    }

    if let Ok(val) = std::env::var(core::HOSTNAME)
        && !val.is_empty()
    {
        config.hostname = val;
    }

    if let Ok(val) = std::env::var(core::LOG_LEVEL)
        && !val.is_empty()
    {
        config.log_level = val;
    }

    if let Ok(val) = std::env::var(core::AUTH_TOKEN) {
        // Empty string means explicitly unset the token
        if val.is_empty() {
            config.auth_token = None;
        } else {
            config.auth_token = Some(val);
        }
    }

    if let Ok(val) = std::env::var(core::DB_PATH)
        && !val.is_empty()
    {
        config.memory.db_path = Some(val);
    }

    // IM bridge env overrides: delegate to ImConfig::from_env()
    // This ensures TOML defaults are preserved when env vars are absent,
    // but env vars win when present.
    let im_from_env = crate::model::ImConfig::from_env();
    if im_from_env.enabled {
        config.im.enabled = true;
    }
    if im_from_env.feishu.is_some() {
        config.im.feishu = im_from_env.feishu;
    }
    if im_from_env.default_project_path.is_some() {
        config.im.default_project_path = im_from_env.default_project_path;
    }
    if im_from_env.notify_on_complete {
        config.im.notify_on_complete = true;
    }
}

/// Save IM configuration to the config file.
///
/// Reads the existing config.toml (if present), updates only the `[im]` section,
/// and writes the result back. This preserves all other configuration fields.
///
/// The `env_vars` map uses the same keys as environment variables
/// (e.g. `DUO_IM_FEISHU_APP_ID`), matching the frontend's payload format.
/// Keys with empty values are treated as "clear this field".
pub fn save_im_config(env_vars: &HashMap<String, String>) -> Result<()> {
    with_config_update(|root| {
        // Build the [im] section from env_vars
        let mut im_table = toml::value::Table::new();

        // enabled — inherit the existing value when omitted from the payload, so a
        // partial update (e.g. toggling only notify_on_complete) does not silently
        // disable a running IM bridge. Same "omitted means preserve" contract as
        // the feishu credential fields below.
        let enabled = env_vars
            .get(im::ENABLED)
            .map(|v| v == "true" || v == "1")
            .or_else(|| {
                root.get("im")
                    .and_then(|im| im.get("enabled"))
                    .and_then(|v| v.as_bool())
            })
            .unwrap_or(false);
        im_table.insert("enabled".into(), toml::Value::Boolean(enabled));

        // default_project_path
        if let Some(path) = env_vars.get(im::DEFAULT_PROJECT_PATH)
            && !path.is_empty() {
                im_table.insert(
                    "default_project_path".into(),
                    toml::Value::String(path.clone()),
                );
            }

        // Feishu — inherit existing credential values when a field is omitted from
        // the payload, so a partial update (e.g. changing only app_id) does not wipe
        // the other credential or disable Feishu entirely.
        let old_feishu = root.get("im").and_then(|im| im.get("feishu"));
        let feishu_app_id = env_vars
            .get(im::FEISHU_APP_ID)
            .map(|s| s.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| {
                old_feishu
                    .and_then(|f| f.get("app_id"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_default();
        // The App Secret is resolved from three sources, in order:
        //   1. the payload — a real, unmasked value the user just typed
        //   2. the OS keyring — the normal case, it is never written to TOML
        //   3. the TOML file itself — one-time migration of a plaintext secret
        //      left behind by a build that still stored it there
        let feishu_app_secret = env_vars
            .get(im::FEISHU_APP_SECRET)
            .map(|s| s.trim())
            .filter(|s| !s.is_empty() && *s != SECRET_MASK)
            .map(|s| s.to_string())
            .or_else(|| duo_utils::secret_store::load_secret(FEISHU_APP_SECRET_ID))
            .or_else(|| {
                old_feishu
                    .and_then(|f| f.get("app_secret"))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
            })
            .unwrap_or_default();
        // domain also inherits when omitted
        let feishu_domain = env_vars
            .get(im::FEISHU_DOMAIN)
            .map(|s| s.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| {
                old_feishu
                    .and_then(|f| f.get("domain"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| "feishu".to_string());
        if !feishu_app_id.is_empty() && !feishu_app_secret.is_empty() {
            // Park the secret in the OS keyring and record only an empty string
            // here. If the keyring *and* the encrypted-file fallback both fail we
            // keep the plaintext rather than silently losing the credential —
            // a degraded write is recoverable, a lost one is not.
            let persisted = match duo_utils::secret_store::store_secret(
                FEISHU_APP_SECRET_ID,
                &feishu_app_secret,
            ) {
                Ok(()) => String::new(),
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "Could not move the Feishu App Secret into secure storage; falling back to config.toml"
                    );
                    feishu_app_secret.clone()
                }
            };

            let mut feishu_table = toml::value::Table::new();
            feishu_table.insert("app_id".into(), toml::Value::String(feishu_app_id));
            feishu_table.insert("app_secret".into(), toml::Value::String(persisted));
            feishu_table.insert("domain".into(), toml::Value::String(feishu_domain));
            im_table.insert("feishu".into(), toml::Value::Table(feishu_table));
        }

        // notify_on_complete — same "omitted means preserve" contract as `enabled`.
        let notify_on_complete = env_vars
            .get(im::NOTIFY_ON_COMPLETE)
            .map(|v| v == "true" || v == "1")
            .or_else(|| {
                root.get("im")
                    .and_then(|im| im.get("notify_on_complete"))
                    .and_then(|v| v.as_bool())
            })
            .unwrap_or(false);
        im_table.insert(
            "notify_on_complete".into(),
            toml::Value::Boolean(notify_on_complete),
        );

        // Update root [im] section
        root.insert("im".into(), toml::Value::Table(im_table));

        // Serialize back to TOML string
        // If the root is an empty table (new file), add default values for required fields
        // so that load_config can deserialize successfully.
        if root.is_empty() || !root.contains_key("port") {
            let defaults = SmartLayerConfig::default();
            let mut full_table = root.clone();
            // Add required top-level fields with defaults if missing
            full_table
                .entry("port".to_string())
                .or_insert(toml::Value::Integer(defaults.port as i64));
            full_table
                .entry("hostname".to_string())
                .or_insert(toml::Value::String(defaults.hostname.clone()));
            full_table
                .entry("log_level".to_string())
                .or_insert(toml::Value::String(defaults.log_level.clone()));
            // Add [memory] section with defaults if missing
            if !full_table.contains_key("memory") {
                let mut mem = toml::value::Table::new();
                // max_entries defaults to usize::MAX (no hard limit). We write
                // the value as i64::MAX for TOML compatibility (usize::MAX overflows i64
                // on 64-bit platforms).
                let max_entries_for_toml = if defaults.memory.max_entries == usize::MAX {
                    i64::MAX
                } else {
                    defaults.memory.max_entries as i64
                };
                mem.insert(
                    "max_entries".into(),
                    toml::Value::Integer(max_entries_for_toml),
                );
                mem.insert(
                    "default_layer".into(),
                    toml::Value::Integer(defaults.memory.default_layer as i64),
                );
                full_table.insert("memory".into(), toml::Value::Table(mem));
            }
            // Add [security] section with defaults if missing
            if !full_table.contains_key("security") {
                let mut sec = toml::value::Table::new();
                sec.insert("allowed_paths".into(), toml::Value::Array(vec![]));
                sec.insert("blocked_commands".into(), toml::Value::Array(vec![]));
                sec.insert(
                    "max_file_size_bytes".into(),
                    toml::Value::Integer(defaults.security.max_file_size_bytes as i64),
                );
                sec.insert(
                    "require_confirmation".into(),
                    toml::Value::Boolean(defaults.security.require_confirmation),
                );
                full_table.insert("security".into(), toml::Value::Table(sec));
            }
            *root = full_table;
        }

        Ok(())
    })
}

/// Persist the loop configuration (quality switches: 语法校验 / 审校) to the
/// config file, preserving all other sections.
///
/// Reads the existing `config.toml` (or starts empty), replaces only the
/// `[loop]` table with the serialized [`LoopConfig`], and writes it back. Other
/// top-level sections (port, memory, security, im, …) are left intact.
pub fn save_loop_config(loop_cfg: &LoopConfig) -> Result<()> {
    with_config_update(|root| {
        // Serialize LoopConfig into a TOML table and replace the [loop] section.
        let mut loop_value =
            toml::Value::try_from(loop_cfg).context("Failed to serialize LoopConfig to TOML")?;
        // Backward-compatibility guard: `max_steps = -1` means "unlimited" (an i32
        // value, matching `default_max_steps()`). Older builds typed this field as
        // `u32`, so a negative value in the TOML would make them fail to deserialize
        // the whole config and refuse to start. To keep rollback safe, we OMIT the
        // field entirely when it equals the default (-1) — older builds then fall back
        // to their own default (200) and start normally, while current builds
        // re-derive -1 from `default_max_steps`. Only explicit positive/zero values
        // are written to disk. The literal -1 must stay in sync with `default_max_steps`.
        if loop_cfg.max_steps == -1
            && let Some(table) = loop_value.as_table_mut() {
                // The serialized key is camelCase (`maxSteps`); also strip the
                // legacy snake_case key so a stale positive value from either
                // spelling can never survive a `-1` save and re-enable the cap.
                table.remove("maxSteps");
                table.remove("max_steps");
            }
        root.insert("loop".to_string(), loop_value);

        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Global mutex to serialize tests that manipulate process-level env vars.
    /// Without this, parallel test threads race on `set_var`/`remove_var` for
    /// `XDG_CONFIG_HOME`, `DUO_PORT`, etc., causing flaky failures.
    static ENV_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// All tests that touch global environment variables are merged into a single
    /// serial test to eliminate race conditions from concurrent `set_var`/`remove_var`
    /// across parallel test threads. Each section sets, asserts, and cleans up its
    /// env var(s) before proceeding to the next section.
    #[test]
    fn env_overrides_and_file_loading() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        // --- load_config returns defaults when no config file exists ---
        {
            let tmp_dir = std::env::temp_dir()
                .join(format!("duoduo_test_noexist_config_{}", std::process::id()));
            // SAFETY: Test-only env var manipulation; single-threaded within this test.
            unsafe {
                std::env::set_var("XDG_CONFIG_HOME", &tmp_dir);
            }

            let config = load_config().expect("load_config should succeed");
            assert_eq!(config.port, 0);
            assert_eq!(config.hostname, duo_types::DEFAULT_HOSTNAME);

            // SAFETY: Restoring env var state.
            unsafe {
                std::env::remove_var("XDG_CONFIG_HOME");
            }
            let _ = std::fs::remove_dir_all(&tmp_dir);
        }

        // --- apply_env_overrides: port ---
        {
            let mut config = SmartLayerConfig::default();
            assert_eq!(config.port, 0);
            // SAFETY: Test-only env var manipulation; single-threaded within this test.
            unsafe {
                std::env::set_var(core::PORT, "8080");
            }
            apply_env_overrides(&mut config);
            assert_eq!(config.port, 8080);
            // SAFETY: Restoring env var state.
            unsafe {
                std::env::remove_var(core::PORT);
            }

            // --- invalid port ignored ---
            let mut config = SmartLayerConfig::default();
            // SAFETY: Test-only env var manipulation.
            unsafe {
                std::env::set_var(core::PORT, "not_a_number");
            }
            apply_env_overrides(&mut config);
            assert_eq!(config.port, 0); // default unchanged
            // SAFETY: Restoring env var state.
            unsafe {
                std::env::remove_var(core::PORT);
            }
        }

        // --- apply_env_overrides: hostname ---
        {
            let mut config = SmartLayerConfig::default();
            // SAFETY: Test-only env var manipulation.
            unsafe {
                std::env::set_var(core::HOSTNAME, "0.0.0.0");
            }
            apply_env_overrides(&mut config);
            assert_eq!(config.hostname, "0.0.0.0");
            // SAFETY: Restoring env var state.
            unsafe {
                std::env::remove_var(core::HOSTNAME);
            }
        }

        // --- apply_env_overrides: auth_token ---
        {
            let mut config = SmartLayerConfig::default();
            assert!(config.auth_token.is_none());
            // SAFETY: Test-only env var manipulation.
            unsafe {
                std::env::set_var(core::AUTH_TOKEN, "secret-token");
            }
            apply_env_overrides(&mut config);
            assert_eq!(config.auth_token, Some("secret-token".to_string()));

            // Empty string explicitly unsets
            // SAFETY: Test-only env var manipulation.
            unsafe {
                std::env::set_var(core::AUTH_TOKEN, "");
            }
            apply_env_overrides(&mut config);
            assert!(config.auth_token.is_none());
            // SAFETY: Restoring env var state.
            unsafe {
                std::env::remove_var(core::AUTH_TOKEN);
            }
        }

        // --- apply_env_overrides: db_path ---
        {
            let mut config = SmartLayerConfig::default();
            assert!(config.memory.db_path.is_none());
            // SAFETY: Test-only env var manipulation.
            unsafe {
                std::env::set_var(core::DB_PATH, "/tmp/duoduo.db");
            }
            apply_env_overrides(&mut config);
            assert_eq!(config.memory.db_path, Some("/tmp/duoduo.db".to_string()));
            // SAFETY: Restoring env var state.
            unsafe {
                std::env::remove_var(core::DB_PATH);
            }
        }

        // --- load from TOML file ---
        {
            let tmp_base =
                std::env::temp_dir().join(format!("duoduo_config_test_{}", std::process::id()));
            let tmp_dir = tmp_base.join("duoduo");
            std::fs::create_dir_all(&tmp_dir).unwrap();
            // SAFETY: Test-only env var manipulation.
            unsafe {
                std::env::set_var("XDG_CONFIG_HOME", &tmp_base);
            }

            let toml_content = r#"
port = 3000
hostname = "0.0.0.0"
log_level = "debug"
auth_token = "my-token"

[memory]
db_path = "/data/duoduo.db"
max_entries = 5000
default_layer = 5


[security]
allowed_paths = ["/home", "/projects"]
blocked_commands = ["rm -rf", "mkfs"]
max_file_size_bytes = 5242880
require_confirmation = false

[im]
enabled = false
"#;
            std::fs::write(tmp_dir.join("config.toml"), toml_content).unwrap();

            let config = load_config().expect("load_config should succeed");
            assert_eq!(config.port, 3000);
            assert_eq!(config.hostname, "0.0.0.0");
            assert_eq!(config.log_level, "debug");
            assert_eq!(config.auth_token, Some("my-token".to_string()));
            assert_eq!(config.memory.db_path, Some("/data/duoduo.db".to_string()));
            assert_eq!(config.memory.max_entries, 5000);
            assert_eq!(config.memory.default_layer, 5);
            assert_eq!(config.security.allowed_paths, vec!["/home", "/projects"]);
            assert_eq!(config.security.blocked_commands, vec!["rm -rf", "mkfs"]);
            assert_eq!(config.security.max_file_size_bytes, 5242880);
            assert!(!config.security.require_confirmation);

            // SAFETY: Restoring env var state.
            unsafe {
                std::env::remove_var("XDG_CONFIG_HOME");
            }
            let _ = std::fs::remove_dir_all(&tmp_base);
        }
    }

    /// Test save_im_config: all scenarios in a single serial test to avoid
    /// env var race conditions (same pattern as env_overrides_and_file_loading).
    #[test]
    fn save_im_config_scenarios() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        // --- Feishu config save + load ---
        {
            let tmp_base = std::env::temp_dir().join(format!(
                "duoduo_save_im_test_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .subsec_nanos()
            ));
            let tmp_dir = tmp_base.join("duoduo");
            std::fs::create_dir_all(&tmp_dir).unwrap();
            // SAFETY: Test-only env var manipulation; single-threaded within this test.
            unsafe {
                std::env::set_var("XDG_CONFIG_HOME", &tmp_base);
            }

            let mut env_vars = HashMap::new();
            env_vars.insert(im::ENABLED.to_string(), "true".to_string());
            env_vars.insert(im::FEISHU_APP_ID.to_string(), "cli_test123".to_string());
            env_vars.insert(im::FEISHU_APP_SECRET.to_string(), "secret456".to_string());
            env_vars.insert(im::FEISHU_DOMAIN.to_string(), "feishu".to_string());
            env_vars.insert(
                im::DEFAULT_PROJECT_PATH.to_string(),
                "/test/project".to_string(),
            );

            save_im_config(&env_vars).expect("save_im_config should succeed");

            let config = load_config().expect("load_config should succeed");
            assert!(config.im.enabled);
            assert_eq!(
                config.im.default_project_path,
                Some("/test/project".to_string())
            );
            let feishu = config.im.feishu.expect("feishu config should be set");
            assert_eq!(feishu.app_id, "cli_test123");
            assert_eq!(feishu.app_secret, "secret456");
            assert_eq!(feishu.domain, "feishu");

            // SAFETY: Restoring env var state.
            unsafe {
                std::env::remove_var("XDG_CONFIG_HOME");
            }
            let _ = std::fs::remove_dir_all(&tmp_base);
        }

        // --- Preserves existing non-IM fields ---
        {
            let tmp_base = std::env::temp_dir().join(format!(
                "duoduo_save_preserve_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .subsec_nanos()
            ));
            let tmp_dir = tmp_base.join("duoduo");
            std::fs::create_dir_all(&tmp_dir).unwrap();
            // SAFETY: Test-only env var manipulation; single-threaded within this test.
            unsafe {
                std::env::set_var("XDG_CONFIG_HOME", &tmp_base);
            }

            let initial_toml = r#"
port = 3000
hostname = "0.0.0.0"
log_level = "debug"

[memory]
max_entries = 5000


[security]
allowed_paths = []
blocked_commands = []
max_file_size_bytes = 10485760
require_confirmation = true

[im]
enabled = false
"#;
            std::fs::write(tmp_dir.join("config.toml"), initial_toml).unwrap();

            let mut env_vars = HashMap::new();
            env_vars.insert(im::ENABLED.to_string(), "true".to_string());
            env_vars.insert(im::FEISHU_APP_ID.to_string(), "cli_preserved".to_string());
            env_vars.insert(
                im::FEISHU_APP_SECRET.to_string(),
                "secret_preserved".to_string(),
            );

            save_im_config(&env_vars).expect("save_im_config should succeed");

            let config = load_config().expect("load_config should succeed");
            assert_eq!(config.port, 3000, "port should be preserved");
            assert_eq!(config.hostname, "0.0.0.0", "hostname should be preserved");
            assert_eq!(config.log_level, "debug", "log_level should be preserved");
            assert_eq!(
                config.memory.max_entries, 5000,
                "memory.max_entries should be preserved"
            );
            assert!(config.im.enabled, "im.enabled should be updated");
            let feishu = config.im.feishu.expect("feishu should be set");
            assert_eq!(
                feishu.app_id, "cli_preserved",
                "feishu.app_id should be updated"
            );

            // SAFETY: Restoring env var state.
            unsafe {
                std::env::remove_var("XDG_CONFIG_HOME");
            }
            let _ = std::fs::remove_dir_all(&tmp_base);
        }

        // --- Disabled when no credentials ---
        {
            let tmp_base = std::env::temp_dir().join(format!(
                "duoduo_save_disabled_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .subsec_nanos()
            ));
            let tmp_dir = tmp_base.join("duoduo");
            std::fs::create_dir_all(&tmp_dir).unwrap();
            // SAFETY: Test-only env var manipulation; single-threaded within this test.
            unsafe {
                std::env::set_var("XDG_CONFIG_HOME", &tmp_base);
            }

            let env_vars = HashMap::new();
            save_im_config(&env_vars).expect("save_im_config should succeed");

            let config = load_config().expect("load_config should succeed");
            assert!(!config.im.enabled);
            assert!(config.im.feishu.is_none());

            // SAFETY: Restoring env var state.
            unsafe {
                std::env::remove_var("XDG_CONFIG_HOME");
            }
            let _ = std::fs::remove_dir_all(&tmp_base);
        }
    }

    /// Regression test for the two-writer race on `config.toml`.
    ///
    /// `save_im_config` (an HTTP handler) and `save_loop_config` (a
    /// `ConfigManager` method) run concurrently on the smart-layer's 4-worker
    /// tokio runtime. Both read the whole file and write it back, so without
    /// the shared write lock the later writer replaces the file with a snapshot
    /// taken *before* the earlier writer's change — silently dropping one
    /// section. This drives both writers at once and asserts neither loses.
    #[test]
    fn concurrent_writers_keep_both_sections() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();

        let tmp_base = std::env::temp_dir().join(format!(
            "duoduo_concurrent_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        let tmp_dir = tmp_base.join("duoduo");
        std::fs::create_dir_all(&tmp_dir).unwrap();
        // SAFETY: Test-only env var manipulation; serialized by ENV_TEST_LOCK.
        unsafe {
            std::env::set_var("XDG_CONFIG_HOME", &tmp_base);
        }

        // Split the two sections across *different* threads. If every writer
        // wrote both sections, a clobbering writer would still leave both
        // behind and the race would stay invisible.
        let mut handles = Vec::new();
        for i in 0..8u32 {
            handles.push(std::thread::spawn(move || {
                for round in 0..30 {
                    if i % 2 == 0 {
                        // Writer A owns [im] only.
                        let mut env_vars = HashMap::new();
                        env_vars.insert(im::ENABLED.to_string(), "true".to_string());
                        env_vars.insert(
                            im::NOTIFY_ON_COMPLETE.to_string(),
                            if round % 2 == 0 { "true" } else { "false" }.to_string(),
                        );
                        save_im_config(&env_vars).expect("save_im_config");
                    } else {
                        // Writer B owns [loop] only.
                        let mut lc = LoopConfig::default();
                        lc.reflect = round % 2 == 0;
                        save_loop_config(&lc).expect("save_loop_config");
                    }
                }
            }));
        }
        for h in handles {
            h.join().expect("writer thread");
        }

        let path = config_file_path().unwrap();
        let content = std::fs::read_to_string(&path).expect("read config");
        let table: toml::Table = toml::from_str(&content).expect("config must be valid TOML");
        assert!(
            table.contains_key("im"),
            "[im] was clobbered by a concurrent writer:\n{}",
            content
        );
        assert!(
            table.contains_key("loop"),
            "[loop] was clobbered by a concurrent writer:\n{}",
            content
        );

        // SAFETY: Restoring env var state.
        unsafe {
            std::env::remove_var("XDG_CONFIG_HOME");
        }
        let _ = std::fs::remove_dir_all(&tmp_base);
    }

    /// `with_config_update` must hold its lock across the *whole*
    /// read → mutate → write cycle, not just the write.
    ///
    /// The end-to-end test above can only observe the race when two writers
    /// happen to overlap within a few microseconds, so it rarely fires. This
    /// test widens the window deliberately: every writer sleeps inside its
    /// mutator, so with an unguarded implementation all of them read the same
    /// starting table and only the last write survives. With the lock in place
    /// the cycles are serialized and every writer's key is preserved.
    #[test]
    fn with_config_update_serializes_concurrent_writers() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();

        let tmp_base = std::env::temp_dir().join(format!(
            "duoduo_update_lock_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        let tmp_dir = tmp_base.join("duoduo");
        std::fs::create_dir_all(&tmp_dir).unwrap();
        // SAFETY: Test-only env var manipulation; serialized by ENV_TEST_LOCK.
        unsafe {
            std::env::set_var("XDG_CONFIG_HOME", &tmp_base);
        }

        let mut handles = Vec::new();
        for i in 0..4u32 {
            handles.push(std::thread::spawn(move || {
                with_config_update(|root| {
                    // Widen the read→write window on purpose so the race is
                    // reproducible rather than a matter of luck.
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    root.insert(format!("writer_{}", i), toml::Value::Integer(i64::from(i)));
                    Ok(())
                })
                .expect("with_config_update");
            }));
        }
        for h in handles {
            h.join().expect("writer thread");
        }

        let content = std::fs::read_to_string(config_file_path().unwrap()).expect("read config");
        let table: toml::Table = toml::from_str(&content).expect("config must be valid TOML");
        for i in 0..4u32 {
            assert!(
                table.contains_key(&format!("writer_{}", i)),
                "writer_{} lost its update — the read-modify-write cycle is not serialized:\n{}",
                i,
                content
            );
        }

        // SAFETY: Restoring env var state.
        unsafe {
            std::env::remove_var("XDG_CONFIG_HOME");
        }
        let _ = std::fs::remove_dir_all(&tmp_base);
    }
}
