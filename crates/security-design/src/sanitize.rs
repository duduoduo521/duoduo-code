//! Sensitive content protection for tool outputs and file paths.
//!
//! Two responsibilities:
//! 1. [`sanitize_tool_output`] — mask secrets (API keys, tokens, passwords,
//!    private keys) in text **before** it is sent to an external LLM API.
//! 2. [`is_sensitive_path`] — path-component based check used to block reading
//!    / indexing / searching project-internal sensitive files.
//!
//! Design notes (why this is safe / 0-risk):
//! - Secret masking only alters key-like substrings; ordinary code and text
//!   pass through untouched, so no functional behaviour changes.
//! - The masking is idempotent (already-redacted text stays redacted), so it
//!   can be applied on every request, including retries.
//! - Path matching is exact component matching, not substring matching, so
//!   `my-env-config.ts` and `.env.example` (non-secret template) are NOT
//!   falsely blocked.

use regex::Regex;
use std::sync::LazyLock;

/// Known sensitive path components (matched exactly against a single path
/// component, after normalizing `\` to `/`).
///
/// Only genuine project-internal secret files/dirs are listed. `.config` is
/// deliberately excluded because a project may legitimately contain a
/// `.config/` build directory.
const SENSITIVE_PATH_COMPONENTS: &[&str] = &[
    // Environment files — exact ".env" only (".env.example" stays readable)
    ".env",
    // Credentials / OAuth tokens
    "auth.json",
    "mcp-auth.json",
    "credentials",
    // Keys
    "duoduo.key",
    ".key-seed",
    "secure-keys",
    // SQLite database
    "duoduo.db",
    // Standard hidden credential directories
    ".ssh",
    ".aws",
    ".gnupg",
];

/// Returns `true` if any path component matches a known sensitive name.
///
/// This blocks both direct file reads (e.g. `keys/duoduo.key`) and traversal
/// into credential directories (e.g. `.ssh/config`).
pub fn is_sensitive_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    for component in normalized.split('/') {
        if SENSITIVE_PATH_COMPONENTS.contains(&component) {
            return true;
        }
        // Encrypted key backup: `secure-keys.enc.json` (and similar variants).
        if component.starts_with("secure-keys.") {
            return true;
        }
    }
    false
}

/// A compiled secret-masking rule.
struct SecretPattern {
    replacement: &'static str,
    regex: Regex,
}

/// Pre-compiled secret-masking rules (compiled once, reused forever).
static SECRET_PATTERNS: LazyLock<Vec<SecretPattern>> = LazyLock::new(|| {
    let patterns: &[(&'static str, &'static str)] = &[
        // key = value / key: value  (api_key, token, secret, password, ...)
        (
            "$1=***",
            r"(?i)(api[_-]?key|token|secret|password|app[_-]?secret|auth[_-]?token)\s*[:=]\s*\S+",
        ),
        // OpenAI key
        ("[REDACTED_API_KEY]", r"(?i)sk-[a-zA-Z0-9]{20,}"),
        // Anthropic key
        ("[REDACTED_API_KEY]", r"(?i)sk-ant-[a-zA-Z0-9]{20,}"),
        // GitHub PAT
        ("[REDACTED_API_KEY]", r"(?i)ghp_[a-zA-Z0-9]{36}"),
        // PEM private key header
        (
            "[REDACTED_PRIVATE_KEY]",
            r"-----BEGIN[A-Z ]*PRIVATE KEY-----",
        ),
    ];
    patterns
        .iter()
        .map(|(replacement, pattern)| SecretPattern {
            replacement,
            regex: Regex::new(pattern)
                .expect("invariant: static secret-masking regex pattern is valid"),
        })
        .collect()
});

/// Mask secrets in tool output before sending it to an external LLM API.
///
/// Only key-like substrings are altered; everything else is returned verbatim.
pub fn sanitize_tool_output(output: &str) -> String {
    let mut result = output.to_string();
    for pattern in SECRET_PATTERNS.iter() {
        result = pattern.regex.replace_all(&result, pattern.replacement).to_string();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_path_exact_match() {
        assert!(is_sensitive_path(".env"));
        assert!(is_sensitive_path("keys/duoduo.key"));
        assert!(is_sensitive_path("auth.json"));
        assert!(is_sensitive_path(".ssh/config"));
        assert!(is_sensitive_path("src/.aws/credentials"));
        assert!(is_sensitive_path("data/duoduo.db"));
        assert!(is_sensitive_path("secure-keys.enc.json"));
    }

    #[test]
    fn sensitive_path_no_false_positive() {
        assert!(!is_sensitive_path("src/main.rs"));
        assert!(!is_sensitive_path("config/my-env-utils.ts"));
        assert!(!is_sensitive_path(".env.example"));
        assert!(!is_sensitive_path(".env.sample"));
        assert!(!is_sensitive_path("authenticate.ts"));
        assert!(!is_sensitive_path("src/environment.ts"));
    }

    #[test]
    fn sanitize_masks_secrets() {
        assert_eq!(sanitize_tool_output("api_key=sk-abc123"), "api_key=***");
        assert_eq!(sanitize_tool_output("token: abc123"), "token=***");
        assert_eq!(
            sanitize_tool_output("password=\"secret123\""),
            "password=***"
        );
        assert_eq!(
            sanitize_tool_output("sk-abcdefghijklmnopqrstuvwxyz"),
            "[REDACTED_API_KEY]"
        );
        assert_eq!(
            sanitize_tool_output("ghp_1234567890abcdefghijklmnopqrstuvwxyz"),
            "[REDACTED_API_KEY]"
        );
        assert_eq!(
            sanitize_tool_output("-----BEGIN RSA PRIVATE KEY-----"),
            "[REDACTED_PRIVATE_KEY]"
        );
    }

    #[test]
    fn sanitize_preserves_normal_text() {
        assert_eq!(
            sanitize_tool_output("function hello() {}"),
            "function hello() {}"
        );
        assert_eq!(sanitize_tool_output("const x = 123"), "const x = 123");
        // Idempotent: already-redacted text is left unchanged.
        assert_eq!(sanitize_tool_output("api_key=***"), "api_key=***");
    }
}
