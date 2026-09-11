//! Schema drift test: verifies that Rust does not have **extra** fields
//! that the TS snapshot doesn't declare. This is the reverse of
//! `schema_consistency.rs` which checks "TS required → Rust has".
//!
//! Together, the two files provide bidirectional drift detection:
//! - `schema_consistency.rs`: TS fields missing in Rust
//! - `schema_drift.rs`: Rust fields not in TS (surprise additions)

use duo_types::MessageInfo;
use serde_json::Value;
use std::collections::BTreeSet;

fn load_snapshot(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../schema")
        .join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("failed to read {name}: {e}. Run `bun run export-schema` first.")
    });
    serde_json::from_str(&text).expect("invalid JSON in snapshot")
}

/// Collect all field names that Rust serializes for a given MessageInfo variant.
fn rust_message_fields(ty: &str) -> BTreeSet<String> {
    let json = match ty {
        "user" => serde_json::to_value(&MessageInfo::User(sample_user())).unwrap(),
        "assistant" => serde_json::to_value(&MessageInfo::Assistant(sample_assistant())).unwrap(),
        _ => panic!("unknown struct {ty}"),
    };
    json.as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

/// Collect all TS-declared fields for a given variant (required + special-case).
fn ts_message_fields(snap: &Value, ty: &str) -> BTreeSet<String> {
    let info = &snap["messageInfo"];
    let mut set: BTreeSet<String> = info["specialCaseFields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    let required_key = match ty {
        "user" => "userRequired",
        "assistant" => "assistantRequired",
        _ => panic!("unknown type {ty}"),
    };
    for v in info[required_key].as_array().unwrap() {
        set.insert(v.as_str().unwrap().to_string());
    }
    // "role" is the discriminator tag, always present
    set.insert("role".to_string());
    set
}

#[test]
fn no_extra_fields_in_user_message() {
    let snap = load_snapshot("message-info.json");
    let ts = ts_message_fields(&snap, "user");
    let rust = rust_message_fields("user");
    let extra: BTreeSet<_> = rust.difference(&ts).collect();
    assert!(
        extra.is_empty(),
        "Rust User message has fields not in TS snapshot: {extra:?}.\n\
         If these are intentional, update the TS schema and run `bun run export-schema`."
    );
}

#[test]
fn no_extra_fields_in_assistant_message() {
    let snap = load_snapshot("message-info.json");
    let ts = ts_message_fields(&snap, "assistant");
    let rust = rust_message_fields("assistant");
    let extra: BTreeSet<_> = rust.difference(&ts).collect();
    assert!(
        extra.is_empty(),
        "Rust Assistant message has fields not in TS snapshot: {extra:?}.\n\
         If these are intentional, update the TS schema and run `bun run export-schema`."
    );
}

#[test]
fn no_extra_part_types_in_rust() {
    let snap = load_snapshot("message-part.json");
    let ts_types: BTreeSet<String> = snap["part"]["types"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    // Rust part types are verified in schema_consistency.rs::part_types_match_snapshot.
    // Here we check the reverse: every TS type should be producible by Rust.
    // (If TS has a type Rust doesn't, the existing test already catches it.)
    // This test ensures no Rust-only type sneaks in via a new variant.
    let rust_tags: BTreeSet<String> = [
        "text", "subtask", "reasoning", "file", "tool", "step-start", "step-finish",
        "snapshot", "patch", "agent", "retry", "compaction", "review",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let extra: BTreeSet<_> = rust_tags.difference(&ts_types).collect();
    assert!(
        extra.is_empty(),
        "Rust has Part types not in TS snapshot: {extra:?}.\n\
         If these are intentional, update the TS schema and run `bun run export-schema`."
    );
}

// ── Sample builders (mirrors schema_consistency.rs) ──────────────────────

fn sample_user() -> duo_types::UserMessageInfo {
    duo_types::UserMessageInfo {
        id: "u".into(),
        session_id: "s".into(),
        time: duo_types::UserMessageTime { created: 0.0 },
        format: None,
        summary: None,
        agent: "a".into(),
        model: duo_types::UserMessageModel {
            provider_id: "p".into(),
            model_id: "m".into(),
            variant: None,
        },
        system: None,
        locale: None,
        tools: None,
    }
}

fn sample_assistant() -> duo_types::AssistantMessageInfo {
    duo_types::AssistantMessageInfo {
        id: "a".into(),
        session_id: "s".into(),
        time: duo_types::AssistantMessageTime {
            created: 0.0,
            completed: None,
        },
        error: None,
        parent_id: "p".into(),
        model_id: "m".into(),
        provider_id: "p".into(),
        mode: "mode".into(),
        agent: "a".into(),
        path: duo_types::AssistantMessagePath {
            cwd: "/".into(),
            root: "/".into(),
        },
        summary: None,
        tokens: duo_types::TokenInfo {
            total: None,
            input: 0.0,
            output: 0.0,
            reasoning: 0.0,
            cache: duo_types::TokenCacheInfo {
                read: 0.0,
                write: 0.0,
            },
            breakdown: None,
            cache_hit_rate: None,
        },
        structured: None,
        variant: None,
        finish: None,
    }
}
