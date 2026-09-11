//! Child-process environment sanitization.
//!
//! Every place that spawns a child process with `env_clear()` must re-add the
//! same set of variables. Keeping one list here means the shell tool (bash)
//! and the plugin IPC host cannot drift apart — and neither can silently drop
//! a variable Windows needs in order to start a process at all (`SYSTEMROOT`,
//! `COMSPEC`, `PATHEXT`, …).
//!
//! The list is an **allow list**: anything not named here is dropped, so
//! credentials in the host environment (`OPENAI_API_KEY`, `*_TOKEN`, …)
//! never reach a child.

use std::ffi::OsString;

/// Environment variables a child process may inherit, lower-cased for
/// case-insensitive matching (Windows variable names are case-insensitive).
pub const SANITIZED_ENV_WHITELIST: &[&str] = &[
    // Binary / module resolution
    "path",
    "pathext",
    "node_path",
    // Home + temp directories
    "home",
    "userprofile",
    "tmp",
    "temp",
    "tmpdir",
    // Windows essentials
    "systemroot",
    "systemdrive",
    "windir",
    "comspec",
    "appdata",
    "localappdata",
    "programdata",
    // Locale
    "lang",
    "lc_all",
    "lc_ctype",
    "lc_messages",
    // Terminal (informational; callers that pipe stdout may still override,
    // e.g. `TERM=dumb` for the shell tool)
    "term",
    "colorterm",
    "term_program",
    "term_program_version",
    // User identity + editor/shell preferences
    "user",
    "shell",
    "editor",
    // XDG base directories
    "xdg_config_home",
    "xdg_data_home",
    "xdg_cache_home",
];

/// The whitelisted variables of the current process, as `OsString` pairs.
///
/// Works for `std::process::Command` and `tokio::process::Command` alike —
/// pair it with `env_clear()` on either type.
pub fn sanitized_env_vars() -> impl Iterator<Item = (OsString, OsString)> {
    std::env::vars_os().filter(|(key, _)| {
        let normalized = key.to_string_lossy().to_ascii_lowercase();
        SANITIZED_ENV_WHITELIST.contains(&normalized.as_str())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_is_lower_cased_and_duplicate_free() {
        let mut seen = std::collections::HashSet::new();
        for key in SANITIZED_ENV_WHITELIST {
            assert!(seen.insert(*key), "duplicate whitelist entry: {key}");
            assert_eq!(
                *key,
                key.to_ascii_lowercase(),
                "whitelist entries must be lower-cased: {key}"
            );
        }
    }

    #[test]
    fn whitelist_covers_the_windows_process_start_basics() {
        for key in ["systemroot", "comspec", "pathext", "userprofile", "temp"] {
            assert!(
                SANITIZED_ENV_WHITELIST.contains(&key),
                "missing Windows-required variable: {key}"
            );
        }
    }

    #[test]
    fn sanitized_env_vars_only_returns_whitelisted_keys() {
        for (key, _) in sanitized_env_vars() {
            let normalized = key.to_string_lossy().to_ascii_lowercase();
            assert!(
                SANITIZED_ENV_WHITELIST.contains(&normalized.as_str()),
                "non-whitelisted variable survived sanitization: {normalized}"
            );
        }
    }

    #[test]
    fn sanitized_env_vars_keeps_the_variables_children_need() {
        // PATH is set in every process able to run cargo; the point is that a
        // whitelisted key is not accidentally filtered out by normalization.
        let keys: Vec<String> = sanitized_env_vars()
            .map(|(k, _)| k.to_string_lossy().to_ascii_lowercase())
            .collect();
        assert!(
            keys.contains(&"path".to_string()),
            "PATH must survive, got {keys:?}"
        );
    }
}
