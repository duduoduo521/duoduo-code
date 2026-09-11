//! Comprehensive tests for BlackboardStore.

use crate::BlackboardStore;
use duo_types::*;

fn make_store() -> BlackboardStore {
    BlackboardStore::open_in_memory("test-session").expect("failed to open in-memory store")
}

// =============================================================================
// 1. File Version Operations
// =============================================================================

#[test]
fn test_init_file_version() {
    let store = make_store();

    store
        .init_file_version("src/main.rs", "fn main() {}", "hash1")
        .unwrap();

    let v = store.get_file_version("src/main.rs").unwrap().unwrap();
    assert_eq!(v.file_path, "src/main.rs");
    assert_eq!(v.version, 0);
    assert_eq!(v.ast_hash, "hash1");
}

#[test]
fn test_init_file_version_idempotent() {
    let store = make_store();

    store
        .init_file_version("src/main.rs", "fn main() {}", "hash1")
        .unwrap();
    // Second insert with OR IGNORE should not change data
    store
        .init_file_version("src/main.rs", "fn main2() {}", "hash2")
        .unwrap();

    let v = store.get_file_version("src/main.rs").unwrap().unwrap();
    assert_eq!(v.ast_hash, "hash1");
}

#[test]
fn test_get_file_version_nonexistent() {
    let store = make_store();
    assert!(store.get_file_version("no/such/file.rs").unwrap().is_none());
}

#[test]
fn test_update_file_version() {
    let store = make_store();

    store
        .init_file_version("src/main.rs", "fn main() {}", "hash1")
        .unwrap();

    let new_ver = store
        .update_file_version("src/main.rs", "fn main() { println!() }", "hash2", "agent-1")
        .unwrap();
    assert_eq!(new_ver, 1);

    let v = store.get_file_version("src/main.rs").unwrap().unwrap();
    assert_eq!(v.version, 1);
    assert_eq!(v.ast_hash, "hash2");
    assert_eq!(v.last_modified_by, "agent-1");
}

#[test]
fn test_update_file_version_increments() {
    let store = make_store();

    store
        .init_file_version("src/a.rs", "", "h0")
        .unwrap();
    store
        .update_file_version("src/a.rs", "v1", "h1", "agent-a")
        .unwrap();
    store
        .update_file_version("src/a.rs", "v2", "h2", "agent-b")
        .unwrap();

    let v = store.get_file_version("src/a.rs").unwrap().unwrap();
    assert_eq!(v.version, 2);
}

#[test]
fn test_get_file_content() {
    let store = make_store();

    store
        .init_file_version("src/main.rs", "hello world", "hash1")
        .unwrap();

    let content = store.get_file_content("src/main.rs").unwrap().unwrap();
    assert_eq!(content, "hello world");
}

#[test]
fn test_get_file_content_nonexistent() {
    let store = make_store();
    assert!(store.get_file_content("no/such/file.rs").unwrap().is_none());
}

#[test]
fn test_list_files() {
    let store = make_store();

    assert!(store.list_files().unwrap().is_empty());

    store.init_file_version("src/a.rs", "", "h1").unwrap();
    store.init_file_version("src/b.rs", "", "h2").unwrap();
    store.init_file_version("src/c.rs", "", "h3").unwrap();

    let files = store.list_files().unwrap();
    assert_eq!(files.len(), 3);
    // Ordered by file_path
    assert_eq!(files[0].file_path, "src/a.rs");
    assert_eq!(files[1].file_path, "src/b.rs");
    assert_eq!(files[2].file_path, "src/c.rs");
}

// =============================================================================
// 2. File Lock Operations
// =============================================================================

#[test]
fn test_acquire_file_lock_success() {
    let store = make_store();

    let acquired = store.acquire_file_lock("src/a.rs", "agent-1", "write").unwrap();
    assert!(acquired);
}

#[test]
fn test_acquire_file_lock_already_locked_by_same_agent() {
    let store = make_store();

    assert!(store.acquire_file_lock("src/a.rs", "agent-1", "write").unwrap());
    // Same agent re-acquires should succeed (refresh)
    assert!(store.acquire_file_lock("src/a.rs", "agent-1", "write").unwrap());
}

#[test]
fn test_acquire_file_lock_denied_for_other_agent() {
    let store = make_store();

    assert!(store.acquire_file_lock("src/a.rs", "agent-1", "write").unwrap());
    let acquired = store.acquire_file_lock("src/a.rs", "agent-2", "write").unwrap();
    assert!(!acquired);
}

#[test]
fn test_release_file_lock() {
    let store = make_store();

    store.acquire_file_lock("src/a.rs", "agent-1", "write").unwrap();
    let released = store.release_file_lock("src/a.rs", "agent-1").unwrap();
    assert!(released);

    // After release, the file should be unlocked
    match store.get_file_lock_state("src/a.rs").unwrap() {
        FileLockState::Unlocked => {}
        _ => panic!("expected Unlocked after release"),
    }
}

#[test]
fn test_release_file_lock_not_owner() {
    let store = make_store();

    store.acquire_file_lock("src/a.rs", "agent-1", "write").unwrap();
    let released = store.release_file_lock("src/a.rs", "agent-2").unwrap();
    assert!(!released);
}

#[test]
fn test_release_file_lock_unlocked_file() {
    let store = make_store();

    let released = store.release_file_lock("src/a.rs", "agent-1").unwrap();
    assert!(!released);
}

#[test]
fn test_force_release_file_lock() {
    let store = make_store();

    store.acquire_file_lock("src/a.rs", "agent-1", "write").unwrap();
    let prev_owner = store.force_release_file_lock("src/a.rs").unwrap();
    assert_eq!(prev_owner, Some("agent-1".to_string()));

    match store.get_file_lock_state("src/a.rs").unwrap() {
        FileLockState::Unlocked => {}
        _ => panic!("expected Unlocked after force release"),
    }
}

#[test]
fn test_force_release_unlocked_file() {
    let store = make_store();

    let prev_owner = store.force_release_file_lock("src/a.rs").unwrap();
    assert!(prev_owner.is_none());
}

#[test]
fn test_release_all_locks_for_agent() {
    let store = make_store();

    store.acquire_file_lock("src/a.rs", "agent-1", "write").unwrap();
    store.acquire_file_lock("src/b.rs", "agent-1", "write").unwrap();
    store.acquire_file_lock("src/c.rs", "agent-2", "write").unwrap();

    let released = store.release_all_locks_for_agent("agent-1").unwrap();
    assert_eq!(released.len(), 2);
    assert!(released.contains(&"src/a.rs".to_string()));
    assert!(released.contains(&"src/b.rs".to_string()));

    // agent-2's lock should still be held
    match store.get_file_lock_state("src/c.rs").unwrap() {
        FileLockState::Locked { agent_id, .. } => assert_eq!(agent_id, "agent-2"),
        _ => panic!("expected agent-2's lock to remain"),
    }
}

#[test]
fn test_release_all_locks_for_agent_no_locks() {
    let store = make_store();

    let released = store.release_all_locks_for_agent("agent-1").unwrap();
    assert!(released.is_empty());
}

#[test]
fn test_get_file_lock_state_locked() {
    let store = make_store();

    store.acquire_file_lock("src/a.rs", "agent-1", "write").unwrap();
    match store.get_file_lock_state("src/a.rs").unwrap() {
        FileLockState::Locked { agent_id, .. } => assert_eq!(agent_id, "agent-1"),
        _ => panic!("expected Locked state"),
    }
}

#[test]
fn test_get_file_lock_state_unlocked() {
    let store = make_store();

    match store.get_file_lock_state("src/a.rs").unwrap() {
        FileLockState::Unlocked => {}
        _ => panic!("expected Unlocked state"),
    }
}

#[test]
fn test_get_agent_locks() {
    let store = make_store();

    store.acquire_file_lock("src/a.rs", "agent-1", "write").unwrap();
    store.acquire_file_lock("src/b.rs", "agent-1", "write").unwrap();
    store.acquire_file_lock("src/c.rs", "agent-2", "write").unwrap();

    let locks = store.get_agent_locks("agent-1").unwrap();
    assert_eq!(locks.len(), 2);
    assert!(locks.contains(&"src/a.rs".to_string()));
    assert!(locks.contains(&"src/b.rs".to_string()));
}

#[test]
fn test_get_agent_locks_no_locks() {
    let store = make_store();

    let locks = store.get_agent_locks("agent-1").unwrap();
    assert!(locks.is_empty());
}

#[test]
fn test_get_all_locks() {
    let store = make_store();

    store.acquire_file_lock("src/a.rs", "agent-1", "write").unwrap();
    store.acquire_file_lock("src/b.rs", "agent-2", "write").unwrap();

    let locks = store.get_all_locks().unwrap();
    assert_eq!(locks.len(), 2);
}

// =============================================================================
// 3. Agent Scope Operations
// =============================================================================

#[test]
fn test_register_agent_scope() {
    let store = make_store();

    let files = vec!["src/a.rs".to_string(), "src/b.rs".to_string()];
    store.register_agent_scope("agent-1", &files).unwrap();

    let scope = store.get_agent_scope("agent-1").unwrap().unwrap();
    assert_eq!(scope.agent_id, "agent-1");
    assert_eq!(scope.allowed_files, files);
}

#[test]
fn test_register_agent_scope_overwrite() {
    let store = make_store();

    let files1 = vec!["src/a.rs".to_string()];
    let files2 = vec!["src/b.rs".to_string(), "src/c.rs".to_string()];
    store.register_agent_scope("agent-1", &files1).unwrap();
    store.register_agent_scope("agent-1", &files2).unwrap();

    let scope = store.get_agent_scope("agent-1").unwrap().unwrap();
    assert_eq!(scope.allowed_files, files2);
}

#[test]
fn test_get_agent_scope_nonexistent() {
    let store = make_store();

    assert!(store.get_agent_scope("agent-1").unwrap().is_none());
}

#[test]
fn test_expand_agent_scope() {
    let store = make_store();

    let files = vec!["src/a.rs".to_string()];
    store.register_agent_scope("agent-1", &files).unwrap();

    let expanded = store.expand_agent_scope("agent-1", "src/b.rs").unwrap();
    assert!(expanded);

    let scope = store.get_agent_scope("agent-1").unwrap().unwrap();
    assert!(scope.allowed_files.contains(&"src/a.rs".to_string()));
    assert!(scope.allowed_files.contains(&"src/b.rs".to_string()));
}

#[test]
fn test_expand_agent_scope_already_present() {
    let store = make_store();

    let files = vec!["src/a.rs".to_string()];
    store.register_agent_scope("agent-1", &files).unwrap();

    let expanded = store.expand_agent_scope("agent-1", "src/a.rs").unwrap();
    assert!(!expanded);
}

#[test]
fn test_expand_agent_scope_no_existing_scope() {
    let store = make_store();

    let expanded = store.expand_agent_scope("agent-1", "src/a.rs").unwrap();
    assert!(!expanded);
}

// =============================================================================
// 4. Agent Submission Operations
// =============================================================================

#[test]
fn test_submit_file_draft() {
    let store = make_store();

    let id = store
        .submit_file(
            "agent-1",
            "src/a.rs",
            "fn a() {}",
            &FileSubmissionStatus::Draft,
            0,
            "hash0",
        )
        .unwrap();
    assert!(id > 0);

    let sub = store.get_latest_submission("agent-1", "src/a.rs").unwrap().unwrap();
    assert_eq!(sub.agent_id, "agent-1");
    assert_eq!(sub.file_path, "src/a.rs");
    assert_eq!(sub.content, "fn a() {}");
    assert_eq!(sub.status, FileSubmissionStatus::Draft);
}

#[test]
fn test_submit_file_stable() {
    let store = make_store();

    let id = store
        .submit_file(
            "agent-1",
            "src/a.rs",
            "fn a() {}",
            &FileSubmissionStatus::Stable,
            0,
            "hash0",
        )
        .unwrap();
    assert!(id > 0);

    let sub = store.get_latest_submission("agent-1", "src/a.rs").unwrap().unwrap();
    assert_eq!(sub.status, FileSubmissionStatus::Stable);
}

#[test]
fn test_submit_file_draft_replaces_previous_draft() {
    let store = make_store();

    store
        .submit_file(
            "agent-1",
            "src/a.rs",
            "draft v1",
            &FileSubmissionStatus::Draft,
            0,
            "h0",
        )
        .unwrap();
    store
        .submit_file(
            "agent-1",
            "src/a.rs",
            "draft v2",
            &FileSubmissionStatus::Draft,
            0,
            "h0",
        )
        .unwrap();

    let sub = store.get_latest_submission("agent-1", "src/a.rs").unwrap().unwrap();
    assert_eq!(sub.content, "draft v2");
}

#[test]
fn test_get_latest_submission_nonexistent() {
    let store = make_store();

    assert!(store
        .get_latest_submission("agent-1", "src/a.rs")
        .unwrap()
        .is_none());
}

#[test]
fn test_get_stable_submission() {
    let store = make_store();

    // Submit a draft and a stable for the same file
    store
        .submit_file(
            "agent-1",
            "src/a.rs",
            "draft content",
            &FileSubmissionStatus::Draft,
            0,
            "h0",
        )
        .unwrap();
    store
        .submit_file(
            "agent-1",
            "src/a.rs",
            "stable content",
            &FileSubmissionStatus::Stable,
            0,
            "h0",
        )
        .unwrap();

    let stable = store.get_stable_submission("src/a.rs").unwrap().unwrap();
    assert_eq!(stable.content, "stable content");
    assert_eq!(stable.status, FileSubmissionStatus::Stable);
}

#[test]
fn test_get_stable_submission_none() {
    let store = make_store();

    // Only draft, no stable
    store
        .submit_file(
            "agent-1",
            "src/a.rs",
            "draft content",
            &FileSubmissionStatus::Draft,
            0,
            "h0",
        )
        .unwrap();

    assert!(store.get_stable_submission("src/a.rs").unwrap().is_none());
}

// === P1: reset_for_new_task must wipe stable content tables (file_versions /
// agent_submissions) and run VACUUM without panicking. ===
#[test]
fn test_reset_for_new_task_clears_content() {
    let store = make_store();

    store.init_file_version("src/main.rs", "fn main() {}", "h0").unwrap();
    store
        .submit_file(
            "agent-1",
            "src/main.rs",
            "fn main() {}",
            &FileSubmissionStatus::Stable,
            0,
            "h0",
        )
        .unwrap();
    assert!(store.get_file_version("src/main.rs").unwrap().is_some());
    assert!(store.get_stable_submission("src/main.rs").unwrap().is_some());

    // act
    store.reset_for_new_task().unwrap();

    // assert stable content wiped
    assert!(
        store.get_file_version("src/main.rs").unwrap().is_none(),
        "file_versions must be cleared by reset_for_new_task"
    );
    assert!(
        store.get_stable_submission("src/main.rs").unwrap().is_none(),
        "agent_submissions (stable) must be cleared by reset_for_new_task"
    );
    // Reaching here proves VACUUM did not panic on the in-memory backend.
}

#[test]
fn test_promote_draft_to_stable() {
    let store = make_store();

    store
        .submit_file(
            "agent-1",
            "src/a.rs",
            "draft content",
            &FileSubmissionStatus::Draft,
            0,
            "h0",
        )
        .unwrap();

    let promoted = store.promote_draft_to_stable("agent-1", "src/a.rs").unwrap();
    assert!(promoted);

    let sub = store.get_latest_submission("agent-1", "src/a.rs").unwrap().unwrap();
    assert_eq!(sub.status, FileSubmissionStatus::Stable);
}

#[test]
fn test_promote_draft_to_stable_no_draft() {
    let store = make_store();

    let promoted = store.promote_draft_to_stable("agent-1", "src/a.rs").unwrap();
    assert!(!promoted);
}

#[test]
fn test_delete_agent_drafts() {
    let store = make_store();

    store
        .submit_file(
            "agent-1",
            "src/a.rs",
            "draft a",
            &FileSubmissionStatus::Draft,
            0,
            "h0",
        )
        .unwrap();
    store
        .submit_file(
            "agent-1",
            "src/b.rs",
            "draft b",
            &FileSubmissionStatus::Draft,
            0,
            "h0",
        )
        .unwrap();
    store
        .submit_file(
            "agent-1",
            "src/c.rs",
            "stable c",
            &FileSubmissionStatus::Stable,
            0,
            "h0",
        )
        .unwrap();

    let deleted = store.delete_agent_drafts("agent-1").unwrap();
    assert_eq!(deleted, 2);

    // Stable submission should remain
    let stable = store.get_stable_submission("src/c.rs").unwrap().unwrap();
    assert_eq!(stable.content, "stable c");
}

#[test]
fn test_delete_agent_drafts_no_drafts() {
    let store = make_store();

    let deleted = store.delete_agent_drafts("agent-1").unwrap();
    assert_eq!(deleted, 0);
}

// =============================================================================
// 5. Agent Intent Operations
// =============================================================================

#[test]
fn test_register_intent() {
    let store = make_store();

    let id = store
        .register_intent("agent-1", "write", &["src/a.rs".to_string()])
        .unwrap();
    assert!(id > 0);
}

#[test]
fn test_get_agent_intents() {
    let store = make_store();

    store
        .register_intent("agent-1", "write", &["src/a.rs".to_string()])
        .unwrap();
    store
        .register_intent("agent-1", "read", &["src/b.rs".to_string()])
        .unwrap();

    let intents = store.get_agent_intents("agent-1").unwrap();
    assert_eq!(intents.len(), 2);

    let write_intent = intents.iter().find(|i| i.intent == IntentKind::Write).unwrap();
    assert_eq!(write_intent.files, vec!["src/a.rs".to_string()]);

    let read_intent = intents.iter().find(|i| i.intent == IntentKind::Read).unwrap();
    assert_eq!(read_intent.files, vec!["src/b.rs".to_string()]);
}

#[test]
fn test_get_agent_intents_no_intents() {
    let store = make_store();

    let intents = store.get_agent_intents("agent-1").unwrap();
    assert!(intents.is_empty());
}

#[test]
fn test_revert_agent_intents() {
    let store = make_store();

    // Register two assigned intents for the agent.
    store
        .register_intent("agent-1", "write", &["src/a.rs".to_string()])
        .unwrap();
    store
        .register_intent("agent-1", "write", &["src/b.rs".to_string()])
        .unwrap();

    // Reverting should flip both to `pending` (status column exists now).
    let reverted = store.revert_agent_intents("agent-1").unwrap();
    assert_eq!(reverted, 2);

    // The intent rows survive (deterministic re-plan), unlike delete which drops them.
    let intents = store.get_agent_intents("agent-1").unwrap();
    assert_eq!(intents.len(), 2);

    // A second revert is a no-op (already pending).
    let reverted2 = store.revert_agent_intents("agent-1").unwrap();
    assert_eq!(reverted2, 0);
}

#[test]
fn test_file_annotations_roundtrip() {
    let store = make_store();

    // Annotations can be attached and read back, keyed by file.
    let id1 = store
        .add_file_annotation("src/a.rs", "reviewer-1", "review", "[L10] unused variable")
        .unwrap();
    let id2 = store
        .add_file_annotation("src/a.rs", "reviewer-2", "review", "[L20] missing error handling")
        .unwrap();
    store
        .add_file_annotation("src/b.rs", "reviewer-1", "review", "[L5] typo")
        .unwrap();
    assert!(id1 > 0 && id2 > 0);

    let a_anns = store.get_annotations_for_files(&["src/a.rs".to_string()]).unwrap();
    assert_eq!(a_anns.len(), 2);
    // Ordering is by file then created_at.
    assert_eq!(a_anns[0].content, "[L10] unused variable");
    assert_eq!(a_anns[1].content, "[L20] missing error handling");

    // Reading multiple files returns the union, still grouped by file.
    let both = store
        .get_annotations_for_files(&["src/a.rs".to_string(), "src/b.rs".to_string()])
        .unwrap();
    assert_eq!(both.len(), 3);

    // Empty input yields no rows.
    assert!(store.get_annotations_for_files(&[]).unwrap().is_empty());

    // Clearing annotations for a file removes only that file's entries.
    let cleared = store.clear_annotations_for_files(&["src/a.rs".to_string()]).unwrap();
    assert_eq!(cleared, 2);
    assert!(store.get_annotations_for_files(&["src/a.rs".to_string()]).unwrap().is_empty());
    assert_eq!(
        store.get_annotations_for_files(&["src/b.rs".to_string()]).unwrap().len(),
        1
    );
}

// =============================================================================
// 6. Agent Fault Operations
// =============================================================================

#[test]
fn test_record_agent_fault() {
    let store = make_store();

    let id = store
        .record_agent_fault("agent-1", &AgentFaultType::LlmTimeout, "timed out after 60s")
        .unwrap();
    assert!(id > 0);
}

#[test]
fn test_record_agent_fault_multiple_types() {
    let store = make_store();

    store
        .record_agent_fault("agent-1", &AgentFaultType::LlmTimeout, "timeout")
        .unwrap();
    store
        .record_agent_fault("agent-1", &AgentFaultType::LlmDegraded, "slow token gen")
        .unwrap();
    store
        .record_agent_fault("agent-1", &AgentFaultType::LlmEmptyResponse, "empty")
        .unwrap();
    store
        .record_agent_fault("agent-1", &AgentFaultType::LlmUnqualified, "unqualified")
        .unwrap();

    let faults = store.get_unhandled_faults("agent-1").unwrap();
    assert_eq!(faults.len(), 4);
}

#[test]
fn test_mark_fault_handled() {
    let store = make_store();

    let id = store
        .record_agent_fault("agent-1", &AgentFaultType::LlmTimeout, "timeout")
        .unwrap();
    store.mark_fault_handled(id).unwrap();

    // Fault should no longer appear in unhandled
    let faults = store.get_unhandled_faults("agent-1").unwrap();
    assert!(faults.is_empty());
}

#[test]
fn test_get_unhandled_faults() {
    let store = make_store();

    store
        .record_agent_fault("agent-1", &AgentFaultType::LlmTimeout, "t1")
        .unwrap();
    store
        .record_agent_fault("agent-1", &AgentFaultType::LlmDegraded, "t2")
        .unwrap();
    store
        .record_agent_fault("agent-2", &AgentFaultType::LlmTimeout, "t3")
        .unwrap();

    let faults1 = store.get_unhandled_faults("agent-1").unwrap();
    assert_eq!(faults1.len(), 2);

    let faults2 = store.get_unhandled_faults("agent-2").unwrap();
    assert_eq!(faults2.len(), 1);
}

#[test]
fn test_count_agent_faults() {
    let store = make_store();

    store
        .record_agent_fault("agent-1", &AgentFaultType::LlmTimeout, "t1")
        .unwrap();
    store
        .record_agent_fault("agent-1", &AgentFaultType::LlmDegraded, "t2")
        .unwrap();

    assert_eq!(store.count_agent_faults("agent-1").unwrap(), 2);
    assert_eq!(store.count_agent_faults("agent-2").unwrap(), 0);
}

#[test]
fn test_count_agent_faults_includes_handled() {
    let store = make_store();

    let id = store
        .record_agent_fault("agent-1", &AgentFaultType::LlmTimeout, "t1")
        .unwrap();
    store.mark_fault_handled(id).unwrap();

    // count_agent_faults counts ALL faults, not just unhandled
    assert_eq!(store.count_agent_faults("agent-1").unwrap(), 1);
}

// =============================================================================
// 7. Change Notification Operations
// =============================================================================

fn sample_changes() -> Vec<ChangeLogEntry> {
    vec![ChangeLogEntry {
        change_type: ChangeType::SignatureChanged,
        symbol: "my_func".to_string(),
        detail: "return type changed".to_string(),
        old_signature: Some("fn my_func() -> i32".to_string()),
        new_signature: Some("fn my_func() -> String".to_string()),
    }]
}

#[test]
fn test_create_change_notification() {
    let store = make_store();

    let id = store
        .create_change_notification(
            "src/a.rs",
            1,
            2,
            &sample_changes(),
            "agent-2",
        )
        .unwrap();
    assert!(!id.is_empty());
}

#[test]
fn test_acknowledge_notification() {
    let store = make_store();

    let id = store
        .create_change_notification(
            "src/a.rs",
            1,
            2,
            &sample_changes(),
            "agent-2",
        )
        .unwrap();

    let acked = store.acknowledge_notification(&id, "adapted").unwrap();
    assert!(acked);
}

#[test]
fn test_acknowledge_notification_nonexistent() {
    let store = make_store();

    let acked = store.acknowledge_notification("nonexistent-id", "adapted").unwrap();
    assert!(!acked);
}

#[test]
fn test_get_unacknowledged_notifications() {
    let store = make_store();

    store
        .create_change_notification("src/a.rs", 1, 2, &sample_changes(), "agent-2")
        .unwrap();
    store
        .create_change_notification("src/b.rs", 3, 4, &sample_changes(), "agent-2")
        .unwrap();

    let notifs = store.get_unacknowledged_notifications("agent-2").unwrap();
    assert_eq!(notifs.len(), 2);
    assert!(!notifs[0].acknowledged);
}

#[test]
fn test_get_unacknowledged_notifications_after_ack() {
    let store = make_store();

    let id = store
        .create_change_notification("src/a.rs", 1, 2, &sample_changes(), "agent-2")
        .unwrap();
    store.acknowledge_notification(&id, "adapted").unwrap();

    let notifs = store.get_unacknowledged_notifications("agent-2").unwrap();
    assert!(notifs.is_empty());
}

#[test]
fn test_get_all_notifications() {
    let store = make_store();

    let id1 = store
        .create_change_notification("src/a.rs", 1, 2, &sample_changes(), "agent-2")
        .unwrap();
    store
        .create_change_notification("src/b.rs", 3, 4, &sample_changes(), "agent-2")
        .unwrap();

    // Ack one
    store.acknowledge_notification(&id1, "adapted").unwrap();

    let all = store.get_all_notifications("agent-2").unwrap();
    assert_eq!(all.len(), 2);

    let acked: Vec<_> = all.iter().filter(|n| n.acknowledged).collect();
    let unacked: Vec<_> = all.iter().filter(|n| !n.acknowledged).collect();
    assert_eq!(acked.len(), 1);
    assert_eq!(unacked.len(), 1);
}

// =============================================================================
// 8. Change Log Operations
// =============================================================================

#[test]
fn test_record_change_log() {
    let store = make_store();

    let diff = StructuredChangeList {
        file: "src/a.rs".to_string(),
        agent_id: "agent-1".to_string(),
        changes: vec![FileChangeEntry {
            symbol_name: "my_func".to_string(),
            change_kind: SymbolChangeKind::Modified,
            old_signature: Some("fn my_func()".to_string()),
            new_signature: Some("fn my_func(x: i32)".to_string()),
        }],
    };

    let id = store
        .record_change_log("src/a.rs", 0, 1, "signature_changed", "agent-1", &diff)
        .unwrap();
    assert!(id > 0);
}

#[test]
fn test_get_change_logs() {
    let store = make_store();

    let diff1 = StructuredChangeList {
        file: "src/a.rs".to_string(),
        agent_id: "agent-1".to_string(),
        changes: vec![],
    };
    let diff2 = StructuredChangeList {
        file: "src/a.rs".to_string(),
        agent_id: "agent-2".to_string(),
        changes: vec![],
    };

    store
        .record_change_log("src/a.rs", 0, 1, "modified", "agent-1", &diff1)
        .unwrap();
    store
        .record_change_log("src/a.rs", 1, 2, "added", "agent-2", &diff2)
        .unwrap();

    let logs = store.get_change_logs("src/a.rs").unwrap();
    assert_eq!(logs.len(), 2);
}

#[test]
fn test_get_change_logs_no_logs() {
    let store = make_store();

    let logs = store.get_change_logs("src/a.rs").unwrap();
    assert!(logs.is_empty());
}

// =============================================================================
// 9. File Dependency Operations
// =============================================================================

#[test]
fn test_register_dependency() {
    let store = make_store();

    store
        .register_dependency("src/a.rs", "src/b.rs", "import", &["B".to_string()])
        .unwrap();
}

#[test]
fn test_get_dependents() {
    let store = make_store();

    store
        .register_dependency("src/a.rs", "src/b.rs", "import", &["B".to_string()])
        .unwrap();
    store
        .register_dependency("src/c.rs", "src/b.rs", "call", &["b_func".to_string()])
        .unwrap();

    let dependents = store.get_dependents("src/b.rs").unwrap();
    assert_eq!(dependents.len(), 2);
}

#[test]
fn test_get_dependencies() {
    let store = make_store();

    store
        .register_dependency("src/a.rs", "src/b.rs", "import", &["B".to_string()])
        .unwrap();
    store
        .register_dependency("src/a.rs", "src/c.rs", "call", &["c_func".to_string()])
        .unwrap();

    let deps = store.get_dependencies("src/a.rs").unwrap();
    assert_eq!(deps.len(), 2);
}

#[test]
fn test_get_all_dependencies() {
    let store = make_store();

    store
        .register_dependency("src/a.rs", "src/b.rs", "import", &[])
        .unwrap();
    store
        .register_dependency("src/c.rs", "src/d.rs", "call", &[])
        .unwrap();

    let all = store.get_all_dependencies().unwrap();
    assert_eq!(all.len(), 2);
}

#[test]
fn test_get_dependents_none() {
    let store = make_store();

    let deps = store.get_dependents("src/a.rs").unwrap();
    assert!(deps.is_empty());
}

#[test]
fn test_get_dependencies_none() {
    let store = make_store();

    let deps = store.get_dependencies("src/a.rs").unwrap();
    assert!(deps.is_empty());
}

// =============================================================================
// 10. Metrics Operations
// =============================================================================

#[test]
fn test_record_metric() {
    let store = make_store();

    store
        .record_metric(&MetricName::FileConflictRate, 0.15, None, None, None)
        .unwrap();
}

#[test]
fn test_record_metric_with_all_fields() {
    let store = make_store();

    store
        .record_metric(
            &MetricName::LlmFaultCount,
            3.0,
            Some("agent-1"),
            Some("src/a.rs"),
            Some("{\"detail\":\"timeout\"}"),
        )
        .unwrap();
}

#[test]
fn test_query_metrics() {
    let store = make_store();

    store
        .record_metric(&MetricName::FileConflictRate, 0.1, None, None, None)
        .unwrap();
    store
        .record_metric(&MetricName::FileConflictRate, 0.2, None, None, None)
        .unwrap();
    store
        .record_metric(&MetricName::LlmFaultCount, 1.0, None, None, None)
        .unwrap();

    let records = store.query_metrics("file_conflict_rate", None).unwrap();
    assert_eq!(records.len(), 2);

    let llm_records = store.query_metrics("llm_fault_count", None).unwrap();
    assert_eq!(llm_records.len(), 1);
}

#[test]
fn test_query_metrics_with_limit() {
    let store = make_store();

    for i in 0..5 {
        store
            .record_metric(&MetricName::FileConflictRate, i as f64, None, None, None)
            .unwrap();
    }

    let records = store.query_metrics("file_conflict_rate", Some(3)).unwrap();
    assert_eq!(records.len(), 3);
}

#[test]
fn test_query_metrics_no_match() {
    let store = make_store();

    let records = store.query_metrics("nonexistent_metric", None).unwrap();
    assert!(records.is_empty());
}

// =============================================================================
// 11. Serial Queue Operations
// =============================================================================

#[test]
fn test_enqueue_serial() {
    let store = make_store();

    let id = store
        .enqueue_serial("agent-1", "src/a.rs", "fn a() {}", 0, "hash0")
        .unwrap();
    assert!(id > 0);
}

#[test]
fn test_dequeue_serial() {
    let store = make_store();

    store
        .enqueue_serial("agent-1", "src/a.rs", "content1", 0, "h0")
        .unwrap();
    store
        .enqueue_serial("agent-2", "src/b.rs", "content2", 1, "h1")
        .unwrap();

    let entry = store.dequeue_serial().unwrap().unwrap();
    assert_eq!(entry.agent_id, "agent-1");
    assert_eq!(entry.file_path, "src/a.rs");
    assert_eq!(entry.content, "content1");
    assert_eq!(entry.base_version, 0);
    assert_eq!(entry.base_ast_hash, "h0");
}

#[test]
fn test_dequeue_serial_fifo() {
    let store = make_store();

    store
        .enqueue_serial("agent-1", "src/a.rs", "first", 0, "h0")
        .unwrap();
    store
        .enqueue_serial("agent-2", "src/b.rs", "second", 1, "h1")
        .unwrap();

    let first = store.dequeue_serial().unwrap().unwrap();
    assert_eq!(first.content, "first");

    let second = store.dequeue_serial().unwrap().unwrap();
    assert_eq!(second.content, "second");
}

#[test]
fn test_dequeue_serial_empty() {
    let store = make_store();

    assert!(store.dequeue_serial().unwrap().is_none());
}

#[test]
fn test_is_serial_queue_empty() {
    let store = make_store();

    assert!(store.is_serial_queue_empty().unwrap());

    store
        .enqueue_serial("agent-1", "src/a.rs", "content", 0, "h0")
        .unwrap();
    assert!(!store.is_serial_queue_empty().unwrap());

    store.dequeue_serial().unwrap();
    assert!(store.is_serial_queue_empty().unwrap());
}

// =============================================================================
// 12. Public Resource Operations
// =============================================================================

#[test]
fn test_register_public_resource() {
    let store = make_store();

    store
        .register_public_resource("src/types.rs", 3, &["module-a".to_string(), "module-b".to_string()])
        .unwrap();
}

#[test]
fn test_get_public_resources() {
    let store = make_store();

    store
        .register_public_resource("src/types.rs", 3, &["module-a".to_string(), "module-b".to_string()])
        .unwrap();
    store
        .register_public_resource("src/utils.rs", 1, &["module-a".to_string()])
        .unwrap();

    let resources = store.get_public_resources().unwrap();
    assert_eq!(resources.len(), 2);

    let types_res = resources.iter().find(|r| r.file_path == "src/types.rs").unwrap();
    assert_eq!(types_res.reference_count, 3);
    assert_eq!(types_res.referencing_modules, vec!["module-a".to_string(), "module-b".to_string()]);
}

#[test]
fn test_get_public_resources_empty() {
    let store = make_store();

    let resources = store.get_public_resources().unwrap();
    assert!(resources.is_empty());
}

#[test]
fn test_register_public_resource_overwrite() {
    let store = make_store();

    store
        .register_public_resource("src/types.rs", 1, &["module-a".to_string()])
        .unwrap();
    store
        .register_public_resource("src/types.rs", 5, &["module-a".to_string(), "module-b".to_string(), "module-c".to_string()])
        .unwrap();

    let resources = store.get_public_resources().unwrap();
    assert_eq!(resources.len(), 1);
    assert_eq!(resources[0].reference_count, 5);
}

// =============================================================================
// 13. Scope Expansion Operations
// =============================================================================

#[test]
fn test_submit_scope_expansion() {
    let store = make_store();

    let id = store
        .submit_scope_expansion("agent-1", "src/new.rs", "need access for refactoring", Some("src/new.rs"))
        .unwrap();
    assert!(id > 0);
}

#[test]
fn test_approve_scope_expansion() {
    let store = make_store();

    let id = store
        .submit_scope_expansion("agent-1", "src/new.rs", "reason", None)
        .unwrap();

    let approved = store.approve_scope_expansion(id).unwrap();
    assert!(approved);
}

#[test]
fn test_reject_scope_expansion() {
    let store = make_store();

    let id = store
        .submit_scope_expansion("agent-1", "src/new.rs", "reason", None)
        .unwrap();

    let rejected = store.reject_scope_expansion(id).unwrap();
    assert!(rejected);
}

#[test]
fn test_approve_scope_expansion_nonexistent() {
    let store = make_store();

    let approved = store.approve_scope_expansion(99999).unwrap();
    assert!(!approved);
}

#[test]
fn test_reject_scope_expansion_nonexistent() {
    let store = make_store();

    let rejected = store.reject_scope_expansion(99999).unwrap();
    assert!(!rejected);
}

// =============================================================================
// 14. Tool Need Declaration Operations
// =============================================================================

#[test]
fn test_declare_tool_need() {
    let store = make_store();

    let id = store
        .declare_tool_need("agent-1", "fn read_file(path: &str) -> String", "Read a file from disk")
        .unwrap();
    assert!(id > 0);
}

#[test]
fn test_get_tool_need_declarations() {
    let store = make_store();

    store
        .declare_tool_need("agent-1", "fn read_file(path: &str) -> String", "Read a file")
        .unwrap();
    store
        .declare_tool_need("agent-2", "fn write_file(path: &str, content: &str)", "Write a file")
        .unwrap();

    let declarations = store.get_tool_need_declarations().unwrap();
    assert_eq!(declarations.len(), 2);
}

#[test]
fn test_get_tool_need_declarations_empty() {
    let store = make_store();

    let declarations = store.get_tool_need_declarations().unwrap();
    assert!(declarations.is_empty());
}

// =============================================================================
// 15. Status Operations
// =============================================================================

#[test]
fn test_get_status_empty() {
    let store = make_store();

    let status = store.get_status(&CircuitBreakerState::Normal).unwrap();
    assert_eq!(status.session_id, "test-session");
    assert_eq!(status.total_files, 0);
    assert_eq!(status.locked_files, 0);
    assert_eq!(status.total_agents, 0);
    assert_eq!(status.active_agents, 0);
    assert_eq!(status.circuit_breaker_state, CircuitBreakerState::Normal);
    assert_eq!(status.global_conflict_rate, 0.0);
}

#[test]
fn test_get_status_with_data() {
    let store = make_store();

    // Add files
    store.init_file_version("src/a.rs", "", "h1").unwrap();
    store.init_file_version("src/b.rs", "", "h2").unwrap();

    // Register scopes
    store
        .register_agent_scope("agent-1", &["src/a.rs".to_string()])
        .unwrap();
    store
        .register_agent_scope("agent-2", &["src/b.rs".to_string()])
        .unwrap();

    // Lock a file
    store.acquire_file_lock("src/a.rs", "agent-1", "write").unwrap();

    let status = store.get_status(&CircuitBreakerState::Normal).unwrap();
    assert_eq!(status.total_files, 2);
    assert_eq!(status.locked_files, 1);
    assert_eq!(status.total_agents, 2);
    assert_eq!(status.active_agents, 1);
}

#[test]
fn test_get_status_circuit_breaker_broken() {
    let store = make_store();

    let status = store.get_status(&CircuitBreakerState::Broken).unwrap();
    assert_eq!(status.circuit_breaker_state, CircuitBreakerState::Broken);
}

#[test]
fn test_cleanup() {
    let store = make_store();

    // Create some data
    store.acquire_file_lock("src/a.rs", "agent-1", "write").unwrap();
    store.register_intent("agent-1", "write", &["src/a.rs".to_string()]).unwrap();
    store.enqueue_serial("agent-1", "src/a.rs", "content", 0, "h0").unwrap();
    store.submit_scope_expansion("agent-1", "src/b.rs", "reason", None).unwrap();
    store.declare_tool_need("agent-1", "fn foo()", "desc").unwrap();

    // Cleanup should clear transient data
    store.cleanup().unwrap();

    // Locks should be gone
    assert!(store.get_all_locks().unwrap().is_empty());

    // Serial queue should be empty
    assert!(store.is_serial_queue_empty().unwrap());

    // Tool need declarations should be cleared
    assert!(store.get_tool_need_declarations().unwrap().is_empty());
}

// =============================================================================
// 16. In-memory store creation
// =============================================================================

#[test]
fn test_open_in_memory() {
    let store = BlackboardStore::open_in_memory("my-session").unwrap();
    assert_eq!(store.session_id(), "my-session");
}

#[test]
fn test_open_in_memory_different_sessions() {
    let store1 = BlackboardStore::open_in_memory("session-1").unwrap();
    let store2 = BlackboardStore::open_in_memory("session-2").unwrap();

    // They should be independent
    store1.init_file_version("src/a.rs", "content1", "h1").unwrap();
    store2.init_file_version("src/a.rs", "content2", "h2").unwrap();

    let c1 = store1.get_file_content("src/a.rs").unwrap().unwrap();
    let c2 = store2.get_file_content("src/a.rs").unwrap().unwrap();
    assert_eq!(c1, "content1");
    assert_eq!(c2, "content2");
}

// =============================================================================
// Integration / cross-feature tests
// =============================================================================

#[test]
fn test_full_workflow() {
    let store = make_store();

    // 1. Init files
    store.init_file_version("src/a.rs", "fn a() {}", "hash_a0").unwrap();
    store.init_file_version("src/b.rs", "fn b() {}", "hash_b0").unwrap();

    // 2. Register scopes
    store.register_agent_scope("agent-1", &["src/a.rs".to_string()]).unwrap();
    store.register_agent_scope("agent-2", &["src/b.rs".to_string()]).unwrap();

    // 3. Acquire locks
    assert!(store.acquire_file_lock("src/a.rs", "agent-1", "write").unwrap());

    // 4. Submit draft
    store
        .submit_file(
            "agent-1",
            "src/a.rs",
            "fn a(x: i32) {}",
            &FileSubmissionStatus::Draft,
            0,
            "hash_a0",
        )
        .unwrap();

    // 5. Promote to stable
    assert!(store.promote_draft_to_stable("agent-1", "src/a.rs").unwrap());

    // 6. Update file version
    let new_ver = store
        .update_file_version("src/a.rs", "fn a(x: i32) {}", "hash_a1", "agent-1")
        .unwrap();
    assert_eq!(new_ver, 1);

    // 7. Create change notification
    let changes = vec![ChangeLogEntry {
        change_type: ChangeType::SignatureChanged,
        symbol: "a".to_string(),
        detail: "parameter added".to_string(),
        old_signature: Some("fn a()".to_string()),
        new_signature: Some("fn a(x: i32)".to_string()),
    }];
    let notif_id = store
        .create_change_notification("src/a.rs", 0, 1, &changes, "agent-2")
        .unwrap();

    // 8. Acknowledge notification
    assert!(store.acknowledge_notification(&notif_id, "adapted").unwrap());

    // 9. Release lock
    assert!(store.release_file_lock("src/a.rs", "agent-1").unwrap());

    // 10. Verify final state
    let v = store.get_file_version("src/a.rs").unwrap().unwrap();
    assert_eq!(v.version, 1);

    let stable = store.get_stable_submission("src/a.rs").unwrap().unwrap();
    assert_eq!(stable.content, "fn a(x: i32) {}");

    match store.get_file_lock_state("src/a.rs").unwrap() {
        FileLockState::Unlocked => {}
        _ => panic!("expected unlocked after release"),
    }
}

// =============================================================================
// 17. Conflict-rate windowing (P0-05)
// =============================================================================

/// Regression (P0-05): numerator and denominator must come from the SAME
/// window. The old implementation counted the last N *conflict rows* in the
/// numerator regardless of age, so old conflicts leaked in and the rate could
/// stay at 1.0 even when every recent write succeeded — which tripped the
/// circuit breaker permanently.
#[test]
fn conflict_rate_uses_single_window() {
    let store = make_store();

    // 2 conflicts + 8 successes in a 10-sample window → rate 0.2.
    for _ in 0..2 {
        store
            .record_metric(&MetricName::FileConflictRate, 1.0, None, None, None)
            .unwrap();
    }
    for _ in 0..8 {
        store
            .record_metric(&MetricName::FileConflictRate, 0.0, None, None, None)
            .unwrap();
    }
    let rate = store.compute_conflict_rate(10).unwrap();
    assert!((rate - 0.2).abs() < 1e-9, "expected 0.2, got {rate}");

    // 40 older conflicts, then 10 fresh successes. The window is the last 10
    // samples (all successes) → rate must be 0.
    for _ in 0..40 {
        store
            .record_metric(&MetricName::FileConflictRate, 1.0, None, None, None)
            .unwrap();
    }
    for _ in 0..10 {
        store
            .record_metric(&MetricName::FileConflictRate, 0.0, None, None, None)
            .unwrap();
    }
    let rate2 = store.compute_conflict_rate(10).unwrap();
    assert_eq!(
        rate2, 0.0,
        "conflicts outside the window must not leak in; got {rate2}"
    );
}
