//! Secure API key storage for LLM providers, backed by the OS keyring.
//!
//! This module is a **naming layer**: it maps a provider id to a secret id and
//! delegates every read/write to `duo_utils::secret_store`, which owns the
//! actual keyring + encrypted-file implementation and is shared with every
//! other credential in the app (IM app secrets included).
//!
//! - **Primary storage**: OS keyring (macOS Keychain / Windows Credential
//!   Manager / Linux Secret Service via DBus)
//! - **Fallback storage**: AES-256-GCM encrypted file (keyring unavailable)
//! - **Runtime**: `LlmConfig.api_key` in memory
//!
//! The keyring is a **persistence layer**, not a real-time read layer.
//! `resolve_api_config()` reads from `LlmConfig.api_key` (memory) only — it
//! never hits the keyring directly, avoiding blocking I/O on the tokio runtime.

use std::path::{Path, PathBuf};

// ─── Constants ───────────────────────────────────────────────────────────

/// Prefix separating provider keys from other secrets in the shared store.
const KEY_PREFIX: &str = "llm-";
const MIGRATION_MARKER_FILENAME: &str = ".keyring-migrated";

// ─── Public API ──────────────────────────────────────────────────────────

/// Store an API key for the given provider.
///
/// Writes to the OS keyring first; falls back to encrypted file storage if
/// the keyring is unavailable (e.g. headless Linux).
pub fn store_api_key(provider: &str, key: &str) -> anyhow::Result<()> {
    duo_utils::secret_store::store_secret(&secret_id(provider), key)
}

/// Load an API key for the given provider.
///
/// Tries the OS keyring first, then the encrypted-file fallback.
/// Returns `None` if the key is not found in either source.
pub fn load_api_key(provider: &str) -> Option<String> {
    duo_utils::secret_store::load_secret(&secret_id(provider))
}

/// Delete an API key for the given provider (both stores).
pub fn delete_api_key(provider: &str) -> anyhow::Result<()> {
    duo_utils::secret_store::delete_secret(&secret_id(provider))
}

/// Check whether an API key exists for the given provider.
///
/// Does **not** return the key value itself — safe to expose to the frontend
/// via a Tauri command.
pub fn has_api_key(provider: &str) -> bool {
    duo_utils::secret_store::has_secret(&secret_id(provider))
}

fn secret_id(provider: &str) -> String {
    format!("{KEY_PREFIX}{provider}")
}

// ─── Migration ───────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct MigrationResult {
    pub migrated: usize,
    pub failed: usize,
    pub skipped: usize,
}

/// Migrate API keys from `auth.json` to the OS keyring.
///
/// This is a **best-effort, idempotent** operation:
/// - Keys are copied to the keyring; `auth.json` keys are **not** deleted.
/// - If keyring is unavailable, keys remain in `auth.json` untouched.
/// - A marker file prevents re-running on every startup.
/// - Re-running is safe (keyring writes are idempotent).
pub fn migrate_from_auth_json(
    auth_json_path: &Path,
    data_dir: &Path,
) -> anyhow::Result<MigrationResult> {
    let marker = data_dir.join(MIGRATION_MARKER_FILENAME);

    // Skip if already migrated (unless marker is corrupted, which is fine — idempotent)
    if marker.exists() {
        tracing::debug!("Keyring migration marker found, skipping");
        return Ok(MigrationResult {
            migrated: 0,
            failed: 0,
            skipped: 0,
        });
    }

    let Some(obj) = read_auth_json(auth_json_path) else {
        return Ok(MigrationResult {
            migrated: 0,
            failed: 0,
            skipped: 0,
        });
    };

    let mut migrated = 0;
    let mut failed = 0;
    let mut skipped = 0;

    for (provider_id, entry) in obj {
        // Only migrate entries that have a "key" field (Api or WellKnown auth types)
        let key_value = entry.get("key").and_then(|k| k.as_str());
        let Some(key) = key_value else {
            skipped += 1;
            continue;
        };

        if key.is_empty() {
            skipped += 1;
            continue;
        }

        match store_api_key(&provider_id, key) {
            Ok(()) => {
                tracing::info!(provider = provider_id, "Migrated API key to keyring");
                migrated += 1;
            }
            Err(e) => {
                tracing::warn!(
                    provider = provider_id,
                    error = %e,
                    "Failed to migrate API key to keyring"
                );
                failed += 1;
            }
        }
    }

    // Write migration marker (even if some keys failed — prevents retrying
    // failed keys on every startup; user can re-enter them via UI)
    if (migrated > 0 || failed == 0)
        && let Err(e) = std::fs::write(&marker, chrono::Utc::now().to_rfc3339()) {
            tracing::warn!(path = %marker.display(), error = %e, "Failed to write migration marker");
        }

    tracing::info!(
        migrated,
        failed,
        skipped,
        "Keyring migration complete"
    );

    Ok(MigrationResult {
        migrated,
        failed,
        skipped,
    })
}

/// Path to the persisted set of provider ids we have written into the keyring
/// via [`sync_keyring_from_auth_json`]. Used to safely clean up orphaned keyring
/// entries when a provider is removed from `auth.json` (we only ever delete
/// providers we ourselves tracked — no OS keyring enumeration required).
fn synced_providers_path() -> Option<PathBuf> {
    get_data_dir().ok().map(|d| d.join("synced-keyring-providers.json"))
}

fn load_synced_providers() -> std::collections::HashSet<String> {
    match synced_providers_path().and_then(|p| std::fs::read_to_string(p).ok()) {
        Some(s) => serde_json::from_str(&s).unwrap_or_default(),
        None => std::collections::HashSet::new(),
    }
}

fn save_synced_providers(set: &std::collections::HashSet<String>) {
    if let Some(path) = synced_providers_path() {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
        if let Ok(s) = serde_json::to_string(set) {
            let _ = std::fs::write(path, s);
        }
    }
}

/// Synchronize the OS keyring with the latest keys from `auth.json`.
///
/// Unlike [`migrate_from_auth_json`], this runs **every startup** (no marker
/// file) and only writes to the keyring when the keyring value differs from,
/// or is missing relative to, `auth.json`. This keeps the keyring aligned with
/// the authoritative `auth.json` written by the Node.js sidecar, closing the
/// gap where a key edited in the UI is reflected in `auth.json` but never
/// reaches the keyring (which is the source the agent path falls back to on
/// restart).
///
/// It also removes keyring entries for providers that were previously synced
/// but are no longer present in `auth.json` (e.g. the user deleted the
/// provider in the UI), keeping the keyring free of stale credentials. We only
/// ever delete providers recorded in our own persisted set, so this is safe and
/// portable (delete by id — no OS keyring enumeration, which `keyring` v3 does
/// not support reliably across platforms).
///
/// Idempotent: when `auth.json` is unchanged, no keyring writes or deletes
/// occur (avoids repeated macOS Keychain prompts). Safe to call when
/// `auth.json` is absent or unreadable.
pub fn sync_keyring_from_auth_json(auth_json_path: &Path) -> anyhow::Result<MigrationResult> {
    let Some(obj) = read_auth_json(auth_json_path) else {
        return Ok(MigrationResult {
            migrated: 0,
            failed: 0,
            skipped: 0,
        });
    };

    let mut migrated = 0;
    let mut failed = 0;
    let mut skipped = 0;
    let mut current: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (provider_id, entry) in obj {
        let key_value = entry.get("key").and_then(|k| k.as_str());
        let Some(key) = key_value else {
            skipped += 1;
            continue;
        };
        if key.is_empty() {
            skipped += 1;
            continue;
        }

        // Only write when the keyring lacks this key or holds a different value,
        // mirroring the A1 path in routes/agent.rs (avoids repeated Keychain prompts).
        let needs_store = match load_api_key(&provider_id) {
            Some(existing) => existing != *key,
            None => true,
        };
        if !needs_store {
            continue;
        }

        match store_api_key(&provider_id, key) {
            Ok(()) => {
                tracing::info!(provider = provider_id, "Synced API key to keyring from auth.json");
                migrated += 1;
            }
            Err(e) => {
                tracing::warn!(
                    provider = provider_id,
                    error = %e,
                    "Failed to sync API key to keyring"
                );
                failed += 1;
            }
        }
        current.insert(provider_id.clone());
    }

    // Orphan cleanup: delete keyring entries we previously synced but that are no
    // longer present in auth.json. We only ever delete providers in our own
    // persisted set, so this is safe and portable (delete by id).
    let mut synced = load_synced_providers();
    let to_delete: Vec<String> = synced.difference(&current).cloned().collect();
    for provider_id in to_delete {
        match delete_api_key(&provider_id) {
            Ok(()) => {
                tracing::info!(
                    provider = %provider_id,
                    "Removed stale API key from keyring (provider no longer in auth.json)"
                );
                synced.remove(&provider_id);
            }
            Err(e) => {
                tracing::warn!(
                    provider = provider_id,
                    error = %e,
                    "Failed to remove stale API key from keyring"
                );
            }
        }
    }
    for p in &current {
        synced.insert(p.clone());
    }
    save_synced_providers(&synced);

    Ok(MigrationResult {
        migrated,
        failed,
        skipped,
    })
}

/// Parse `auth.json` into its top-level object, or `None` when absent/unreadable.
fn read_auth_json(path: &Path) -> Option<serde_json::Map<String, serde_json::Value>> {
    if !path.exists() {
        return None;
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "Failed to read auth.json"
            );
            return None;
        }
    };
    match serde_json::from_str::<serde_json::Value>(&content) {
        Ok(serde_json::Value::Object(obj)) => Some(obj),
        Ok(_) => None,
        Err(e) => {
            tracing::warn!(error = %e, "Failed to parse auth.json");
            None
        }
    }
}

/// Resolve the application data directory (mirrors the shared secret store).
fn get_data_dir() -> anyhow::Result<PathBuf> {
    dirs::data_dir()
        .map(|d| d.join("duoduo-ai"))
        .ok_or_else(|| anyhow::anyhow!("Could not determine app data directory"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_id_namespaces_provider_keys() {
        assert_eq!(secret_id("openai"), "llm-openai");
        assert_eq!(secret_id(""), "llm-");
    }

    #[test]
    fn read_auth_json_missing_file_returns_none() {
        assert!(read_auth_json(Path::new("/nonexistent/auth.json")).is_none());
    }
}
