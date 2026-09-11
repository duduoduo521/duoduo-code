//! Secret masking & sensitive-path detection.
//!
//! Security paths:
//! - Secret masking: `sanitize_tool_output` must redact API keys / tokens /
//!   passwords / private keys before text leaves for an external LLM, and must
//!   be idempotent so it can run on every request.
//! - Sensitive-path: `is_sensitive_path` must flag credential files/dirs while
//!   NOT flagging look-alikes (`.env.example`, `my-env-config.ts`).

use proptest::prelude::*;
use security_design::sanitize::{is_sensitive_path, sanitize_tool_output};

#[test]
fn masks_known_key_formats() {
    assert_eq!(sanitize_tool_output("api_key=sk-abc123def456"), "api_key=***");
    assert_eq!(sanitize_tool_output("token: abc123"), "token=***");
    assert_eq!(sanitize_tool_output("password=\"secret123\""), "password=***");
    assert_eq!(
        sanitize_tool_output("sk-abcdefghijklmnopqrstuvwxyz"),
        "[REDACTED_API_KEY]"
    );
    assert_eq!(
        sanitize_tool_output("sk-ant-abcdefghijklmnopqrstuvwx"),
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
fn preserves_normal_text() {
    assert_eq!(sanitize_tool_output("function hello() {}"), "function hello() {}");
    assert_eq!(sanitize_tool_output("const x = 123"), "const x = 123");
    // Idempotent: already-redacted text is untouched.
    assert_eq!(sanitize_tool_output("api_key=***"), "api_key=***");
}

#[test]
fn nested_and_multiline() {
    let input = "config = {\n  api_key: sk-verysecretkey1234567890,\n  region: us\n}";
    let out = sanitize_tool_output(input);
    assert!(!out.contains("sk-verysecretkey1234567890"), "secret leaked: {out}");
    assert!(out.contains("region: us"));
}

#[test]
fn sensitive_path_detection() {
    assert!(is_sensitive_path(".env"));
    assert!(is_sensitive_path("src/.env"));
    assert!(is_sensitive_path("keys/duoduo.key"));
    assert!(is_sensitive_path(".ssh/config"));
    assert!(is_sensitive_path("secure-keys.enc.json"));
    // Look-alikes must NOT be flagged (false positives break legitimate reads).
    assert!(!is_sensitive_path(".env.example"));
    assert!(!is_sensitive_path("my-env-config.ts"));
    assert!(!is_sensitive_path("src/main.rs"));
    assert!(!is_sensitive_path("secure-keys-readme.md"));
}

proptest! {
    /// Never panics on arbitrary input.
    #[test]
    fn sanitize_never_panics(s in ".*") {
        let _ = sanitize_tool_output(&s);
    }

    /// Idempotent: running twice equals running once (safe to apply per-request).
    #[test]
    fn sanitize_idempotent(s in ".*") {
        let once = sanitize_tool_output(&s);
        let twice = sanitize_tool_output(&once);
        prop_assert_eq!(once, twice);
    }

    /// Never panics on arbitrary path input.
    #[test]
    fn sensitive_path_never_panics(p in ".*") {
        let _ = is_sensitive_path(&p);
    }
}
