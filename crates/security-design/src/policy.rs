//! Security policy module — path access control and command filtering.

use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

/// Resolve `path` as far as it exists on disk, keeping the non-existent tail
/// verbatim.
///
/// `Path::canonicalize()` fails when the final component does not exist (the
/// normal "create a new file" case). In that failure case it also does NOT
/// resolve symlinks in the existing prefix: a project-internal symlink
/// pointing outside the project would let a write to `<symlink>/new.txt`
/// escape the project root while the raw string still starts with the project
/// path. Canonicalizing the deepest EXISTING prefix (and appending the
/// verbatim tail) closes that escape. Used as the fallback when full
/// canonicalization is impossible.
fn resolve_existing_prefix(path: &str) -> PathBuf {
    let p = Path::new(path);
    let mut acc = PathBuf::new();
    let mut best: Option<PathBuf> = None;
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    for comp in p.components() {
        acc.push(comp.as_os_str());
        if acc.exists()
            && let Ok(canon) = acc.canonicalize()
        {
            best = Some(canon);
            tail.clear();
            continue;
        }
        tail.push(comp.as_os_str().to_os_string());
    }
    let mut out = best.unwrap_or_else(|| p.to_path_buf());
    for t in tail {
        out.push(t);
    }
    out
}

/// Whitelist of known safe format commands.
/// Only these command names (or their full-path equivalents) are permitted
/// for the `format_file` operation. Everything else is rejected.
pub const FORMAT_WHITELIST: &[&str] = &[
    "prettier",
    "black",
    "gofmt",
    "rustfmt",
    "clang-format",
    "pint",
];

/// Shell/package managers and interpreters that must NEVER be used as formatters.
/// These can download/execute arbitrary code and are explicitly denied even if
/// someone tries to use them for formatting.
pub const FORMAT_BLACKLIST: &[&str] = &[
    "npx",
    "pip",
    "curl",
    "wget",
    "npm",
    "yarn",
    "apt",
    "brew",
    "sudo",
    "sh",
    "bash",
    "zsh",
    "python",
    "python3",
    "ruby",
    "node",
    "perl",
    "php",
];

/// Security policy configuration for path access and command execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityPolicy {
    /// Allowed file paths. Empty vector means the `project_path` or allow-all fallback applies.
    pub allowed_paths: Vec<String>,
    /// Project root path. When `allowed_paths` is empty, access is restricted
    /// to this directory (if set). If both are empty, all paths are permitted
    /// for backward compatibility.
    pub project_path: Option<PathBuf>,
    /// Blocked shell commands. Supports prefix matching (e.g. "rm -rf" blocks "rm -rf /").
    pub blocked_commands: Vec<String>,
    /// Maximum allowed file size in bytes. Default: 10 MB.
    pub max_file_size_bytes: u64,
    /// Whether dangerous operations require user confirmation.
    pub require_confirmation: bool,
    /// Whether to enable RTK (Runtime Kompressor) prefix for shell commands.
    /// When true and `rtk` binary is available on PATH, shell commands are
    /// automatically prefixed with `rtk` for output compression.
    /// Default: true (use rtk if available).
    #[serde(default = "default_enable_rtk")]
    pub enable_rtk: bool,
}

fn default_enable_rtk() -> bool {
    true
}

impl Default for SecurityPolicy {
    fn default() -> Self {
        Self {
            allowed_paths: Vec::new(),
            project_path: None,
            blocked_commands: vec![
                "rm -rf /".to_string(),
                "format".to_string(),
                "del /s /q C:\\".to_string(),
                "shutdown".to_string(),
                "reboot".to_string(),
                "chmod 777".to_string(),
                "chmod -R 777".to_string(),
                "mkfs".to_string(),
                "dd if=".to_string(),
                "curl | sh".to_string(),
                "curl | bash".to_string(),
                "wget | sh".to_string(),
                "wget | bash".to_string(),
                ":(){:|:&};:".to_string(),
                "> /dev/sd".to_string(),
                "mv /* ".to_string(),
            ],
            max_file_size_bytes: 10 * 1024 * 1024, // 10 MB
            require_confirmation: true,
            enable_rtk: true,
        }
    }
}

impl SecurityPolicy {
    /// Create a security policy scoped to a project directory.
    ///
    /// When `allowed_paths` is empty, path access will be restricted to
    /// the given `project_path`. This is the recommended constructor for
    /// production use.
    pub fn with_project_path(path: PathBuf) -> Self {
        Self {
            project_path: Some(path),
            ..SecurityPolicy::default()
        }
    }

    /// The directories that are in bounds under this policy, as paths.
    ///
    /// Encodes the same precedence as [`check_path_access`]: `allowed_paths`
    /// wins outright when set, otherwise the policy falls back to
    /// `project_path`. An empty result means "unrestricted" (rule 3) and
    /// callers must treat it as *no boundary to enforce* rather than as
    /// "nothing is allowed".
    ///
    /// Exists for callers that must check something other than a single path
    /// string — notably the bash path scan, which extracts candidate paths from
    /// a command line and needs the roots to compare them against.
    pub fn effective_allowed_paths(&self) -> Vec<PathBuf> {
        if !self.allowed_paths.is_empty() {
            return self.allowed_paths.iter().map(PathBuf::from).collect();
        }
        self.project_path.iter().cloned().collect()
    }

    /// Check whether a given path is accessible under the current policy.
    ///
    /// Rules (evaluated in order):
    /// 1. If `allowed_paths` is non-empty, the path must reside within one of the
    ///    allowed directories (directory-boundary matching, not simple prefix).
    /// 2. Otherwise, if `project_path` is set, the path must reside within the
    ///    project directory.
    /// 3. If both are empty, all paths are allowed (backward-compatible fallback).
    /// 4. The path must not contain path traversal sequences (`..`).
    /// 5. File size is not checked here — callers should use `max_file_size_bytes` separately.
    pub fn check_path_access(&self, path: &str) -> Result<(), String> {
        // Rule 1: Whitelist check — explicit allowed_paths list takes precedence.
        if !self.allowed_paths.is_empty() {
            let canonical = std::path::Path::new(path)
                .canonicalize()
                .unwrap_or_else(|_| std::path::PathBuf::from(path));
            let canonical_str = canonical.to_string_lossy();

            let permitted = self.allowed_paths.iter().any(|allowed| {
                let allowed_path = std::path::Path::new(allowed);
                let canonical_allowed = allowed_path
                    .canonicalize()
                    .unwrap_or_else(|_| allowed_path.to_path_buf());
                let allowed_str = canonical_allowed.to_string_lossy();

                // Directory-boundary matching:
                // - exact match (path is the allowed dir itself)
                // - path starts with allowed_dir + "/" (Unix)
                // - path starts with allowed_dir + "\" (Windows)
                canonical_str == allowed_str
                    || canonical_str.starts_with(&format!("{}/", allowed_str))
                    || canonical_str.starts_with(&format!("{}\\", allowed_str))
            });

            if !permitted {
                return Err(format!(
                    "Path '{}' is not in the allowed paths list",
                    path
                ));
            }
        } else if let Some(ref project_path) = self.project_path {
            // Rule 2: Project-path scoping — restrict access to the project directory.
            // Full canonicalize succeeds only when the whole path exists. For a
            // not-yet-existing path (the "create a new file" case), fall back to
            // canonicalizing the deepest existing prefix so symlinks inside the
            // project are still resolved; falling back to the raw string would
            // let `<project>/<symlink-to-outside>/new.txt` escape the root.
            let canonical = std::path::Path::new(path)
                .canonicalize()
                .unwrap_or_else(|_| resolve_existing_prefix(path));
            let canonical_str = canonical.to_string_lossy();

            let canonical_project = project_path
                .canonicalize()
                .unwrap_or_else(|_| resolve_existing_prefix(
                    project_path.to_string_lossy().as_ref(),
                ));
            let project_str = canonical_project.to_string_lossy();

            let permitted = canonical_str == project_str
                || canonical_str.starts_with(&format!("{}/", project_str))
                || canonical_str.starts_with(&format!("{}\\", project_str));

            if !permitted {
                return Err(format!(
                    "Path '{}' is outside project directory '{}'",
                    path, project_str
                ));
            }
        }
        // Rule 3: Both empty — allow all (backward compatible).

        // Rule 4: Path traversal detection.
        // Normalize separators so that both forward and backslash variants are caught.
        let normalized = path.replace('\\', "/");
        if normalized.contains("/..") || normalized.contains("../") {
            return Err(format!(
                "Path '{}' contains forbidden traversal sequence '..'",
                path
            ));
        }

        Ok(())
    }

    /// Check whether a given command is allowed under the current policy.
    ///
    /// Uses prefix matching: if any entry in `blocked_commands` is a prefix of
    /// the provided command (case-insensitive), the command is rejected.
    pub fn check_command_allowed(&self, command: &str) -> Result<(), String> {
        let command_lower = command.to_lowercase();

        for blocked in &self.blocked_commands {
            let blocked_lower = blocked.to_lowercase();
            if command_lower.starts_with(blocked_lower.as_str()) {
                return Err(format!(
                    "Command '{}' is blocked by policy (matched rule: '{}')",
                    command, blocked
                ));
            }
        }

        Ok(())
    }

    /// Check whether a format command is allowed using the `FORMAT_WHITELIST`.
    ///
    /// This performs exact command-name matching (not substring matching):
    /// - Extracts the base command name from the full command string.
    /// - For full paths, extracts the last path component (e.g. `/usr/bin/prettier` → `prettier`).
    /// - The base name must appear in `FORMAT_WHITELIST`.
    /// - The base name must NOT appear in `FORMAT_BLACKLIST` (defense-in-depth).
    ///
    /// Returns `Ok(())` if the command is a known safe formatter, `Err` otherwise.
    pub fn check_format_command_allowed(&self, command: &str) -> Result<(), String> {
        // Extract the base command name: strip leading whitespace, take first token,
        // then extract the filename from any path.
        let trimmed = command.trim();
        let first_token = trimmed.split_whitespace().next().unwrap_or("");
        let base_name = std::path::Path::new(first_token)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(first_token);

        let base_lower = base_name.to_lowercase();

        // Defense-in-depth: reject blacklisted commands first
        for denied in FORMAT_BLACKLIST {
            if base_lower == denied.to_lowercase() {
                return Err(format!(
                    "Format command '{}' is denied: '{}' is in the format blacklist",
                    command, base_name
                ));
            }
        }

        // Whitelist check: must be a known safe formatter
        let allowed = FORMAT_WHITELIST.iter().any(|w| base_lower == w.to_lowercase());
        if allowed {
            Ok(())
        } else {
            Err(format!(
                "Format command '{}' is not in the whitelist (base: '{}'). Allowed: {}",
                command,
                base_name,
                FORMAT_WHITELIST.join(", ")
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_allows_all_paths_when_whitelist_empty() {
        let policy = SecurityPolicy::default();
        assert!(policy.check_path_access("/any/path").is_ok());
        assert!(policy.check_path_access("C:\\Users\\test").is_ok());
    }

    #[test]
    fn default_policy_blocks_path_traversal() {
        let policy = SecurityPolicy::default();
        assert!(policy.check_path_access("/etc/../shadow").is_err());
        assert!(policy.check_path_access("..\\secret").is_err());
        assert!(policy.check_path_access("/foo/../bar").is_err());
    }

    #[test]
    fn whitelist_restricts_access() {
        let policy = SecurityPolicy {
            allowed_paths: vec!["/home/user/project".to_string()],
            ..SecurityPolicy::default()
        };
        assert!(policy.check_path_access("/home/user/project/src/main.rs").is_ok());
        assert!(policy.check_path_access("/etc/passwd").is_err());
    }

    #[test]
    fn whitelist_directory_boundary_not_bypassed() {
        // Regression: prefix matching should NOT allow /home/user_evil when
        // /home/user is whitelisted.
        let policy = SecurityPolicy {
            allowed_paths: vec!["/home/user".to_string()],
            ..SecurityPolicy::default()
        };
        // Exact dir is OK
        assert!(policy.check_path_access("/home/user").is_ok());
        // Sub-path is OK
        assert!(policy.check_path_access("/home/user/src/main.rs").is_ok());
        // Sibling that shares prefix but is NOT a child — must be denied
        assert!(policy.check_path_access("/home/user_evil").is_err());
        assert!(policy.check_path_access("/home/user_evil/secret").is_err());
    }

    #[test]
    fn project_path_restricts_access_when_no_whitelist() {
        let policy = SecurityPolicy::with_project_path(PathBuf::from("/home/user/project"));
        // Sub-path is OK
        assert!(policy.check_path_access("/home/user/project/src/main.rs").is_ok());
        // Exact project root is OK
        assert!(policy.check_path_access("/home/user/project").is_ok());
        // Outside project — must be denied
        assert!(policy.check_path_access("/etc/passwd").is_err());
        assert!(policy.check_path_access("/home/user/other").is_err());
    }

    #[test]
    fn project_path_directory_boundary_not_bypassed() {
        let policy = SecurityPolicy::with_project_path(PathBuf::from("/home/user"));
        assert!(policy.check_path_access("/home/user").is_ok());
        assert!(policy.check_path_access("/home/user/src/main.rs").is_ok());
        assert!(policy.check_path_access("/home/user_evil").is_err());
    }

    #[test]
    fn whitelist_takes_precedence_over_project_path() {
        let policy = SecurityPolicy {
            allowed_paths: vec!["/opt/data".to_string()],
            project_path: Some(PathBuf::from("/home/user/project")),
            ..SecurityPolicy::default()
        };
        // Only whitelist is enforced; project_path is ignored when whitelist is non-empty
        assert!(policy.check_path_access("/opt/data/file.txt").is_ok());
        assert!(policy.check_path_access("/home/user/project/src/main.rs").is_err());
    }

    #[test]
    fn blocked_commands_are_rejected() {
        let policy = SecurityPolicy::default();
        assert!(policy.check_command_allowed("rm -rf /").is_err());
        assert!(policy.check_command_allowed("shutdown now").is_err());
        assert!(policy.check_command_allowed("reboot").is_err());
    }

    #[test]
    fn allowed_commands_pass() {
        let policy = SecurityPolicy::default();
        assert!(policy.check_command_allowed("ls -la").is_ok());
        assert!(policy.check_command_allowed("cargo build").is_ok());
        assert!(policy.check_command_allowed("git status").is_ok());
    }

    #[test]
    fn blocked_command_prefix_matching() {
        let policy = SecurityPolicy {
            blocked_commands: vec!["rm -rf".to_string()],
            ..SecurityPolicy::default()
        };
        assert!(policy.check_command_allowed("rm -rf /home").is_err());
        assert!(policy.check_command_allowed("rm file.txt").is_ok());
    }

    #[test]
    fn blocked_command_case_insensitive() {
        let policy = SecurityPolicy {
            blocked_commands: vec!["FORMAT".to_string()],
            ..SecurityPolicy::default()
        };
        assert!(policy.check_command_allowed("format C:").is_err());
        assert!(policy.check_command_allowed("Format D:").is_err());
    }

    // ── 4.8: Format command whitelist tests ──

    #[test]
    fn format_whitelist_allows_known_formatters() {
        let policy = SecurityPolicy::default();
        assert!(policy.check_format_command_allowed("prettier --write src/main.ts").is_ok());
        assert!(policy.check_format_command_allowed("black main.py").is_ok());
        assert!(policy.check_format_command_allowed("gofmt -w main.go").is_ok());
        assert!(policy.check_format_command_allowed("rustfmt src/main.rs").is_ok());
        assert!(policy.check_format_command_allowed("clang-format -i main.c").is_ok());
        assert!(policy.check_format_command_allowed("pint app/Models/User.php").is_ok());
    }

    #[test]
    fn format_whitelist_allows_full_path_formatters() {
        let policy = SecurityPolicy::default();
        assert!(policy.check_format_command_allowed("/usr/bin/prettier --write file.ts").is_ok());
        assert!(policy.check_format_command_allowed("/usr/local/bin/black file.py").is_ok());
        assert!(policy.check_format_command_allowed("./vendor/bin/pint file.php").is_ok());
    }

    #[test]
    fn format_whitelist_rejects_npx() {
        let policy = SecurityPolicy::default();
        assert!(policy.check_format_command_allowed("npx prettier --write file.ts").is_err());
    }

    #[test]
    fn format_whitelist_rejects_dangerous_commands() {
        let policy = SecurityPolicy::default();
        assert!(policy.check_format_command_allowed("curl http://evil.com").is_err());
        assert!(policy.check_format_command_allowed("wget http://evil.com").is_err());
        assert!(policy.check_format_command_allowed("npm install something").is_err());
        assert!(policy.check_format_command_allowed("yarn add something").is_err());
        assert!(policy.check_format_command_allowed("pip install evil").is_err());
        assert!(policy.check_format_command_allowed("sudo rm -rf /").is_err());
        assert!(policy.check_format_command_allowed("sh -c 'rm -rf /'").is_err());
        assert!(policy.check_format_command_allowed("bash -c 'rm -rf /'").is_err());
        assert!(policy.check_format_command_allowed("zsh -c 'rm -rf /'").is_err());
        assert!(policy.check_format_command_allowed("python -c 'import os'").is_err());
        assert!(policy.check_format_command_allowed("ruby -e 'puts 1'").is_err());
        assert!(policy.check_format_command_allowed("apt install evil").is_err());
        assert!(policy.check_format_command_allowed("brew install evil").is_err());
    }

    #[test]
    fn format_whitelist_rejects_unknown_commands() {
        let policy = SecurityPolicy::default();
        assert!(policy.check_format_command_allowed("unknown-formatter file.txt").is_err());
        assert!(policy.check_format_command_allowed("custom_tool --fix file.js").is_err());
    }

    #[test]
    fn format_whitelist_case_insensitive() {
        let policy = SecurityPolicy::default();
        assert!(policy.check_format_command_allowed("Prettier --write file.ts").is_ok());
        assert!(policy.check_format_command_allowed("BLACK main.py").is_ok());
        assert!(policy.check_format_command_allowed("NPX prettier --write file.ts").is_err());
    }

    #[test]
    fn format_whitelist_not_substring_match() {
        let policy = SecurityPolicy::default();
        // "prettierx" should NOT match "prettier" — exact name match only
        assert!(policy.check_format_command_allowed("prettierx --write file.ts").is_err());
        // "blacklist" should NOT match "black"
        assert!(policy.check_format_command_allowed("blacklist file.txt").is_err());
    }
}
