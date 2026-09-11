//! Blackboard file-scope enforcement — `ScopeEnforcer::validate_write_scope`.
//!
//! Security path: multi-agent write isolation. An agent may only write files
//! within its registered scope; an unregistered agent is rejected by default
//! (fail-closed). The wildcard scope `*` permits anything.

use blackboard_coordinator::scope_enforcer::ScopeValidationResult;
use blackboard_coordinator::{BlackboardStore, ScopeEnforcer};
use std::sync::Arc;
use tempfile::TempDir;

fn setup() -> (TempDir, ScopeEnforcer) {
    let dir = tempfile::tempdir().unwrap();
    let store = BlackboardStore::open(dir.path(), "test-session").unwrap();
    let enforcer = ScopeEnforcer::new(Arc::new(store));
    (dir, enforcer)
}

#[test]
fn no_scope_registered_rejects_by_default() {
    let (_dir, enforcer) = setup();
    let result = enforcer.validate_write_scope("agent1", "/project/file.rs").unwrap();
    assert!(
        matches!(result, ScopeValidationResult::NoScope),
        "unregistered agent must be rejected by default: {result:?}"
    );
}

#[test]
fn in_scope_allowed() {
    let (_dir, enforcer) = setup();
    enforcer
        .register_scope("agent1", &["/project/".to_string()])
        .unwrap();
    let result = enforcer.validate_write_scope("agent1", "/project/file.rs").unwrap();
    assert!(matches!(result, ScopeValidationResult::InScope));
}

#[test]
fn out_of_scope_rejected() {
    let (_dir, enforcer) = setup();
    enforcer
        .register_scope("agent1", &["/project/".to_string()])
        .unwrap();
    let result = enforcer.validate_write_scope("agent1", "/etc/passwd").unwrap();
    assert!(matches!(result, ScopeValidationResult::OutOfScope { .. }));
}

#[test]
fn wildcard_scope_allows_anything() {
    let (_dir, enforcer) = setup();
    enforcer.register_scope("agent1", &["*".to_string()]).unwrap();
    let result = enforcer.validate_write_scope("agent1", "/any/where/file.rs").unwrap();
    assert!(matches!(result, ScopeValidationResult::InScope));
}

#[test]
fn exact_file_scope() {
    let (_dir, enforcer) = setup();
    enforcer
        .register_scope("agent1", &["/project/exact.rs".to_string()])
        .unwrap();
    assert!(matches!(
        enforcer.validate_write_scope("agent1", "/project/exact.rs").unwrap(),
        ScopeValidationResult::InScope
    ));
    assert!(matches!(
        enforcer.validate_write_scope("agent1", "/project/other.rs").unwrap(),
        ScopeValidationResult::OutOfScope { .. }
    ));
}

#[test]
fn different_agents_are_isolated() {
    let (_dir, enforcer) = setup();
    enforcer
        .register_scope("agent1", &["/project/a/".to_string()])
        .unwrap();
    enforcer
        .register_scope("agent2", &["/project/b/".to_string()])
        .unwrap();
    assert!(matches!(
        enforcer.validate_write_scope("agent1", "/project/b/secret.rs").unwrap(),
        ScopeValidationResult::OutOfScope { .. }
    ));
    assert!(matches!(
        enforcer.validate_write_scope("agent2", "/project/b/secret.rs").unwrap(),
        ScopeValidationResult::InScope
    ));
}
