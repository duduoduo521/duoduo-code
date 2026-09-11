//! Centralized security-path test crate for the DuoDuo smart layer.
//!
//! This crate is a `lib` target whose only purpose is to host the security
//! integration tests under `tests/`. The tests live in a single folder so the
//! whole security regression suite can be exercised with:
//!
//! ```text
//! cargo test -p security-tests
//! ```
//!
//! Covered security paths (see `项目完整安全关键路径清单.md`):
//! - SSRF (`is_url_host_private`)
//! - Secret masking / sensitive-path (`sanitize_tool_output`, `is_sensitive_path`)
//! - Auth token validation (`AuthToken::validate_token`)
//! - Wildcard pattern matching (`normalize_pattern_to_regex`, `wildcard_match`, `evaluate`)
//! - Tool permission + path sandbox (`check_permission`, `check_tool_permission`)
//! - Blackboard file-scope enforcement (`ScopeEnforcer::validate_write_scope`)

// Intentionally empty: the real tests are integration tests in `tests/`.
