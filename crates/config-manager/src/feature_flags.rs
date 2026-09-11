//! Zero-dependency runtime feature flags.
//!
//! Controlled by `DUO_FF_*` environment variables.
//! `"1"` or `"true"` = enabled. Absent / other value = disabled (old behaviour).
//!
//! All flags default to **disabled** — every code path guarded by a flag
//! falls through to the exact legacy behaviour when the env var is not set.

use duo_types::env_keys::feature_flags as ff;

/// Build a stable-prefix send-view each round so the leading messages
/// (system + task) are byte-identical across every LLM call in the session.
pub fn stable_prefix() -> bool {
    flag(ff::STABLE_PREFIX)
}

/// Move dynamic memory context out of the system prompt and inject it as a
/// separate `role="user"` message, keeping the system prompt fully static.
pub fn memory_as_user_msg() -> bool {
    flag(ff::MEMORY_AS_USER_MSG)
}

/// Recursively sort JSON-object keys in `ToolDefinition.parameters` before
/// serialisation.  The current `serde_json::json!` macro already produces
/// `BTreeMap`-ordered output, so this is a **no-op safety net**.
pub fn canonicalize_tools() -> bool {
    flag(ff::CANONICALIZE_TOOLS)
}

/// De-duplicate identical tool calls within a single round.
/// Uses `(tool_name, serde_json::Value)` structural equality.
pub fn tool_dedup() -> bool {
    flag(ff::TOOL_DEDUP)
}

/// Enable mid-loop quality checks (SelfCheck after edit_file/submit_code).
pub fn loop_quality_mid_check() -> bool {
    flag(ff::LOOP_QUALITY_MID_CHECK)
}

// ── helper ─────────────────────────────────────────────────────────

fn flag(name: &str) -> bool {
    std::env::var(name)
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false)
}
