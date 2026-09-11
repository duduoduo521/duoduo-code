//! Path utility functions for DuoDuo smart layer.
//!
//! Provides helpers for resolving XDG-compliant directories
//! (data, config, cache), ensuring directory existence, and
//! constructing database file paths.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use tracing;

const APP_NAME: &str = "duoduo";

/// Return the XDG data directory for DuoDuo.
///
/// Uses `$XDG_DATA_HOME/duoduo` if `XDG_DATA_HOME` is set,
/// otherwise falls back to `$HOME/.local/share/duoduo`.
pub fn data_dir() -> Result<PathBuf> {
    let base = match std::env::var("XDG_DATA_HOME") {
        // Empty string must fall through to the OS default — an empty base
        // would yield a RELATIVE "duoduo" path, silently diverging from the
        // TypeScript sidecar (xdg-basedir treats empty as unset).
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => dirs::data_dir().context("Could not resolve local data directory")?,
    };
    Ok(base.join(APP_NAME))
}

/// Return the XDG config directory for DuoDuo.
///
/// Uses `$XDG_CONFIG_HOME/duoduo` if `XDG_CONFIG_HOME` is set,
/// otherwise falls back to `$HOME/.config/duoduo`.
pub fn config_dir() -> Result<PathBuf> {
    let base = match std::env::var("XDG_CONFIG_HOME") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => dirs::config_dir().context("Could not resolve config directory")?,
    };
    Ok(base.join(APP_NAME))
}

/// Return the XDG cache directory for DuoDuo.
///
/// Uses `$XDG_CACHE_HOME/duoduo` if `XDG_CACHE_HOME` is set,
/// otherwise falls back to `$HOME/.cache/duoduo`.
pub fn cache_dir() -> Result<PathBuf> {
    let base = match std::env::var("XDG_CACHE_HOME") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => dirs::cache_dir().context("Could not resolve cache directory")?,
    };
    Ok(base.join(APP_NAME))
}

/// Ensure a directory exists, creating it (and any parents) if needed.
///
/// Logs at debug level when a directory is created.
pub fn ensure_dir(path: &std::path::Path) -> Result<()> {
    if !path.exists() {
        std::fs::create_dir_all(path)
            .with_context(|| format!("Failed to create directory: {}", path.display()))?;
        tracing::debug!("Created directory: {}", path.display());
    }
    Ok(())
}

/// Return the full path for a database file inside the data directory.
///
/// Equivalent to `data_dir() / name`.
pub fn db_path(name: &str) -> Result<PathBuf> {
    Ok(data_dir()?.join(name))
}

/// Probe-result cache keyed by the probed directory. The experiment writes a
/// file, so it must not run on every `project_id` call; per-project it runs
/// at most once per process.
fn probe_cache() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, bool>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<PathBuf, bool>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Platform approximation used only when the filesystem itself cannot answer:
/// Windows and macOS ship case-insensitive filesystems by default, Linux is
/// case-sensitive.
const fn case_insensitive_by_platform() -> bool {
    cfg!(windows) || cfg!(target_os = "macos")
}

/// Determine — by asking the filesystem, not by platform guess — whether the
/// filesystem hosting `dir` treats paths case-insensitively.
///
/// The probe is READ-ONLY: it resolves `dir` and a sibling spelled with the
/// case of the last path component flipped, and compares the two canonical
/// paths. Equal ⇒ the filesystem ignored the case change; the flipped name not
/// resolving at all ⇒ it did not. Same idea git uses to set `core.ignoreCase`,
/// but without writing anything: creating a probe file inside the user's
/// project woke every file watcher with a file that no longer existed, needed
/// write access to the project, and left a stray `duoduo_fs_probe_*` file in
/// the repository if the process died between create and delete.
fn volume_is_case_insensitive(dir: &Path) -> bool {
    if let Ok(cache) = probe_cache().lock() {
        if let Some(hit) = cache.get(dir) {
            return *hit;
        }
    }
    let result = probe_case_insensitive(dir);
    if let Ok(mut cache) = probe_cache().lock() {
        cache.insert(dir.to_path_buf(), result);
    }
    result
}

fn probe_case_insensitive(dir: &Path) -> bool {
    let (Some(name), Some(parent)) = (dir.file_name().and_then(|n| n.to_str()), dir.parent()) else {
        // A filesystem root (`/`, `C:\`) has no name to flip.
        return case_insensitive_by_platform();
    };
    let flipped: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() {
                c.to_ascii_uppercase()
            } else if c.is_ascii_uppercase() {
                c.to_ascii_lowercase()
            } else {
                c
            }
        })
        .collect();
    // No ASCII letter to flip (e.g. "123", "我的项目"): nothing to compare.
    if flipped == name {
        return case_insensitive_by_platform();
    }
    match (
        std::fs::canonicalize(dir),
        std::fs::canonicalize(parent.join(&flipped)),
    ) {
        // Both resolve: equal canonical paths ⇒ the same directory under two
        // spellings. Different ⇒ two real directories on a case-sensitive FS.
        (Ok(a), Ok(b)) => a == b,
        // `dir` resolves but the flipped spelling does not ⇒ case-sensitive.
        (Ok(_), Err(_)) => false,
        // `dir` itself cannot be resolved (missing, no permission): unknown.
        _ => case_insensitive_by_platform(),
    }
}

/// Encode a project (or worktree) path into a stable, filesystem-safe, and
/// unique directory name used to isolate per-project data under
/// `<data_dir>/database/<id>/`.
///
/// Project identity follows the **physical filesystem**, not the OS: paths
/// that resolve to the same directory are one project, paths that are
/// distinct directories are distinct projects. Case handling therefore asks
/// the filesystem itself (see [`volume_is_case_insensitive`]) instead of
/// assuming from `cfg!(windows)`:
/// - case-insensitive FS (Windows NTFS, macOS default APFS): `Abc` and `abc`
///   resolve to the same directory, so the id is lowercased — one project;
/// - case-sensitive FS (Linux ext4, macOS sensitive APFS): `abc` and `Abc`
///   are two real directories — two projects, no normalization.
///
/// Algorithm (must stay in sync with the TypeScript `projectDataDir` helper):
/// 1. Resolve to an absolute path, falling back to a relative join if needed.
/// 2. Normalize separators to `/` and strip a trailing slash.
/// 3. If the filesystem hosting the path is case-insensitive, lowercase it.
/// 4. Base64url-encode the UTF-8 bytes (URL-safe, no padding).
///
/// The encoding is injective, so distinct normalized paths map to distinct ids.
pub fn project_id(project_path: &Path) -> String {
    let abs = if project_path.is_absolute() {
        project_path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(project_path)
    };
    let mut norm = abs.to_string_lossy().replace('\\', "/");
    while norm.ends_with('/') {
        norm.pop();
    }
    if volume_is_case_insensitive(&abs) {
        norm = norm.to_lowercase();
    }
    base64url_encode(norm.as_bytes())
}

/// Return the data directory of the TypeScript sidecar (duoduocode-cli).
///
/// This MUST mirror `packages/duoduo/src/global/index.ts` `Path.data` exactly,
/// because the per-project database directory is SHARED between the Rust
/// smart-layer and the TS sidecar. The TS side uses `xdg-basedir`'s `xdgData`,
/// which — on EVERY platform (including Windows) — resolves to
/// `$XDG_DATA_HOME` if set (non-empty), else `<home>/.local/share` whenever a
/// home directory exists. The `LOCALAPPDATA` fallback in the TS code is only
/// reachable when no home directory can be resolved.
///
/// App name: `duoduocode-dev` when `DUODUO_DEV` is set to a non-empty value
/// (TS truthiness: empty string is falsy), else `duoduocode`.
pub fn sidecar_data_dir() -> Result<PathBuf> {
    let app = match std::env::var("DUODUO_DEV") {
        Ok(v) if !v.is_empty() => "duoduocode-dev",
        _ => "duoduocode",
    };
    let base = match std::env::var("XDG_DATA_HOME") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => dirs::home_dir()
            .map(|h| h.join(".local").join("share"))
            .or_else(|| {
                // TS fallback chain: localAppData (Windows) — only reached
                // when the home directory cannot be resolved.
                std::env::var("LOCALAPPDATA").ok().map(PathBuf::from)
            })
            .context("Could not resolve sidecar data directory")?,
    };
    Ok(base.join(app))
}

/// Return the per-project data directory:
/// `<sidecar_data_dir()>/database/<project_id(project_path)>/`.
///
/// All project-scoped state (SQLite DB, memory/patterns/style files, DNA
/// rules, task/summary/blackboard dirs, ...) lives here instead of inside the
/// project directory, keeping the project tree clean.
///
/// NOTE: rooted at the TS sidecar's data dir (NOT the Rust `data_dir()`),
/// because both processes read/write the same per-project files (duoduo.db,
/// memory.md, ...) and must agree on the location. The directory is created
/// best-effort so callers can write into it directly.
pub fn project_data_dir(project_path: &Path) -> Result<PathBuf> {
    let dir = sidecar_data_dir()?
        .join("database")
        .join(project_id(project_path));
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir)
}

/// Robust variant of `project_data_dir` that NEVER fails and NEVER resolves
/// inside the project tree.
///
/// Returns `<sidecar_data_dir()>/database/<project_id>/` on success. If the
/// sidecar data dir cannot be resolved (no home / XDG / LOCALAPPDATA), falls
/// back to `<temp_dir>/duoduo/database/<project_id>/` — mirroring the existing
/// `data_dir().unwrap_or_else(|_| std::env::temp_dir().join("duoduo"))` pattern
/// used elsewhere in the smart layer.
///
/// Callers that previously did `project_data_dir(p).unwrap_or_else(|_| p.join(".duoduo"))`
/// MUST switch to this so the project directory is never written into.
pub fn project_data_dir_robust(project_path: &Path) -> PathBuf {
    match project_data_dir(project_path) {
        Ok(dir) => dir,
        Err(_) => {
            let fallback = std::env::temp_dir()
                .join("duoduo")
                .join("database")
                .join(project_id(project_path));
            let _ = std::fs::create_dir_all(&fallback);
            fallback
        }
    }
}

/// URL-safe base64 without padding (RFC 4648 §5), dependency-free.
fn base64url_encode(input: &[u8]) -> String {
    const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    let len = input.len();
    let mut i = 0;
    while i + 2 < len {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | (input[i + 2] as u32);
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push(CHARS[((n >> 6) & 63) as usize] as char);
        out.push(CHARS[(n & 63) as usize] as char);
        i += 3;
    }
    let rem = len - i;
    if rem == 1 {
        let n = (input[i] as u32) << 16;
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
    } else if rem == 2 {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push(CHARS[((n >> 6) & 63) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_dir_ends_with_app_name() {
        let dir = data_dir().unwrap();
        assert!(dir.ends_with(APP_NAME));
    }

    #[test]
    fn config_dir_ends_with_app_name() {
        let dir = config_dir().unwrap();
        assert!(dir.ends_with(APP_NAME));
    }

    #[test]
    fn cache_dir_ends_with_app_name() {
        let dir = cache_dir().unwrap();
        assert!(dir.ends_with(APP_NAME));
    }

    #[test]
    fn db_path_appends_name() {
        let path = db_path("test.db").unwrap();
        assert!(path.ends_with("test.db"));
        assert!(path.parent().unwrap().ends_with(APP_NAME));
    }

    #[test]
    fn project_data_dir_robust_never_panics_and_never_in_project() {
        let p = std::env::temp_dir().join("duo-utils-test-robust-proj");
        let dir = project_data_dir_robust(&p);
        // Returns a usable path and never resolves inside the project dir.
        assert!(!dir.as_os_str().is_empty());
        assert!(!dir.starts_with(&p));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_dir_creates_and_idempotent() {
        let tmp = std::env::temp_dir().join("duo-utils-test-ensure-dir");
        // Clean up from prior runs
        let _ = std::fs::remove_dir_all(&tmp);

        assert!(!tmp.exists());
        ensure_dir(&tmp).unwrap();
        assert!(tmp.exists());

        // Calling again should not error
        ensure_dir(&tmp).unwrap();
        assert!(tmp.exists());

        // Cleanup
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn probe_matches_real_fs_semantics() {
        // Self-consistency: the probe's verdict must agree with what the
        // filesystem actually does — write a lowercase file and check whether
        // it is visible under the upper-cased name. Holds on any platform,
        // any filesystem kind.
        let tmp = std::env::temp_dir().join("duo-utils-test-probe-semantics");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let check = tmp.join("duoduo_probe_semantics_check");
        std::fs::write(&check, b"").unwrap();
        let fs_is_insensitive = tmp.join("DUODUO_PROBE_SEMANTICS_CHECK").exists();
        std::fs::remove_file(&check).ok();

        assert_eq!(
            volume_is_case_insensitive(&tmp),
            fs_is_insensitive,
            "probe verdict must match the real filesystem behaviour"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn project_id_follows_fs_case_semantics() {
        let tmp = std::env::temp_dir().join("duo-utils-test-pid-case");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let lower = tmp.join("duoidcase");
        std::fs::create_dir_all(&lower).unwrap();
        let id_lower = project_id(&lower);

        if volume_is_case_insensitive(&lower) {
            // Case-insensitive FS: `duoidcase` / `DuoIdCase` / `DUOIDCASE` are
            // all the same physical directory → one project id.
            assert_eq!(project_id(&tmp.join("DuoIdCase")), id_lower);
            assert_eq!(project_id(&tmp.join("DUOIDCASE")), id_lower);
        } else {
            // Case-sensitive FS: `DuoIdCase` is a distinct (here: nonexistent)
            // directory → distinct project id.
            assert_ne!(project_id(&tmp.join("DuoIdCase")), id_lower);
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
