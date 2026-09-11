//! Integration tests for blackboard-store.
//!
//! Covers: basic CRUD, concurrent read/write, transaction boundary,
//! in-memory mode, and key APIs: acquire_file_lock, submit_file + last_insert_rowid,
//! dequeue_serial concurrent safety.

use std::sync::Arc;
use std::thread;

use blackboard_store::BlackboardStore;
use duo_types::{AgentFaultType, ChangeLogEntry, ChangeType, CircuitBreakerState, FileLockState, FileSubmissionStatus};

// ─── Helpers ───

fn make_store() -> Arc<BlackboardStore> {
    Arc::new(BlackboardStore::open_in_memory("test-session").unwrap())
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Basic CRUD
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_crud_file_version() {
    let store = make_store();

    // Init: init_file_version(file_path, content, ast_hash)
    store.init_file_version("src/main.rs", "content1", "hash1").unwrap();
    let v = store.get_file_version("src/main.rs").unwrap().unwrap();
    assert_eq!(v.version, 0);
    assert_eq!(v.ast_hash, "hash1");

    // Update
    store.update_file_version("src/main.rs", "content2", "hash2", "agent-a").unwrap();
    let v2 = store.get_file_version("src/main.rs").unwrap().unwrap();
    assert_eq!(v2.version, 1);
    assert_eq!(v2.ast_hash, "hash2");

    // Content
    let content = store.get_file_content("src/main.rs").unwrap();
    assert_eq!(content, Some("content2".to_string()));

    // List
    let files = store.list_files().unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].file_path, "src/main.rs");
}

#[test]
fn integration_crud_file_lock() {
    let store = make_store();

    // Acquire
    let ok = store.acquire_file_lock("src/main.rs", "agent-a", "write").unwrap();
    assert!(ok);

    // Same agent re-acquire
    let ok2 = store.acquire_file_lock("src/main.rs", "agent-a", "write").unwrap();
    assert!(ok2);

    // Different agent denied
    let denied = store.acquire_file_lock("src/main.rs", "agent-b", "write").unwrap();
    assert!(!denied);

    // State
    let state = store.get_file_lock_state("src/main.rs").unwrap();
    match state {
        FileLockState::Locked { agent_id, .. } => assert_eq!(agent_id, "agent-a"),
        FileLockState::Unlocked => panic!("expected locked"),
    }

    // Release
    let released = store.release_file_lock("src/main.rs", "agent-a").unwrap();
    assert!(released);

    // Now other agent can acquire
    let ok3 = store.acquire_file_lock("src/main.rs", "agent-b", "read").unwrap();
    assert!(ok3);

    // Force release
    let prev = store.force_release_file_lock("src/main.rs").unwrap();
    assert_eq!(prev, Some("agent-b".to_string()));

    // Unlocked state
    let state2 = store.get_file_lock_state("src/main.rs").unwrap();
    assert!(matches!(state2, FileLockState::Unlocked));
}

#[test]
fn integration_crud_submission() {
    let store = make_store();

    // Submit draft
    let id = store.submit_file(
        "agent-a", "src/main.rs", "draft content",
        &FileSubmissionStatus::Draft, 0, "hash0",
    ).unwrap();
    assert!(id > 0);

    // last_insert_rowid returns the autoincrement id
    let latest = store.get_latest_submission("agent-a", "src/main.rs").unwrap();
    assert!(latest.is_some());
    let sub = latest.unwrap();
    assert_eq!(sub.id, id);
    assert_eq!(sub.content, "draft content");
    assert!(matches!(sub.status, FileSubmissionStatus::Draft));

    // Submit stable
    let id2 = store.submit_file(
        "agent-a", "src/main.rs", "stable content",
        &FileSubmissionStatus::Stable, 1, "hash1",
    ).unwrap();
    assert!(id2 > id);

    // Get stable
    let stable = store.get_stable_submission("src/main.rs").unwrap();
    assert!(stable.is_some());
    assert_eq!(stable.unwrap().content, "stable content");

    // Promote draft to stable
    store.submit_file("agent-b", "lib.rs", "b draft", &FileSubmissionStatus::Draft, 0, "").unwrap();
    let promoted = store.promote_draft_to_stable("agent-b", "lib.rs").unwrap();
    assert!(promoted);

    // Delete drafts
    let deleted = store.delete_agent_drafts("agent-a").unwrap();
    assert!(deleted > 0);
}

#[test]
fn integration_crud_serial_queue() {
    let store = make_store();

    assert!(store.is_serial_queue_empty().unwrap());

    let id1 = store.enqueue_serial("agent-a", "file1.rs", "content1", 0, "h1").unwrap();
    let id2 = store.enqueue_serial("agent-b", "file2.rs", "content2", 0, "h2").unwrap();
    assert!(id2 > id1);

    assert!(!store.is_serial_queue_empty().unwrap());

    // FIFO dequeue
    let entry = store.dequeue_serial().unwrap();
    assert!(entry.is_some());
    let e = entry.unwrap();
    assert_eq!(e.agent_id, "agent-a");
    assert_eq!(e.file_path, "file1.rs");

    let entry2 = store.dequeue_serial().unwrap();
    assert!(entry2.is_some());
    assert_eq!(entry2.unwrap().agent_id, "agent-b");

    assert!(store.is_serial_queue_empty().unwrap());

    // Empty dequeue
    let entry3 = store.dequeue_serial().unwrap();
    assert!(entry3.is_none());
}

#[test]
fn integration_crud_dependencies() {
    let store = make_store();

    store.register_dependency("a.rs", "b.rs", "import", &["Foo".to_string()]).unwrap();
    store.register_dependency("a.rs", "c.rs", "import", &["Bar".to_string()]).unwrap();

    let deps = store.get_dependencies("a.rs").unwrap();
    assert_eq!(deps.len(), 2);

    let dependents = store.get_dependents("b.rs").unwrap();
    assert_eq!(dependents.len(), 1);
}

#[test]
fn integration_crud_notifications_and_faults() {
    let store = make_store();

    // Faults
    store.record_agent_fault("agent-a", &AgentFaultType::LlmTimeout, "took too long").unwrap();
    store.record_agent_fault("agent-a", &AgentFaultType::LlmDegraded, "slow response").unwrap();
    let faults = store.get_unhandled_faults("agent-a").unwrap();
    assert_eq!(faults.len(), 2);

    let count = store.count_agent_faults("agent-a").unwrap();
    assert_eq!(count, 2);

    store.mark_fault_handled(faults[0].id).unwrap();
    let unhandled = store.get_unhandled_faults("agent-a").unwrap();
    assert_eq!(unhandled.len(), 1);

    // Notifications
    let notif_id = store.create_change_notification(
        "src/main.rs", 0, 1,
        &[ChangeLogEntry { change_type: ChangeType::Modified, symbol: "main".to_string(), detail: "edited".to_string(), old_signature: None, new_signature: None }],
        "agent-b",
    ).unwrap();
    let unack = store.get_unacknowledged_notifications("agent-b").unwrap();
    assert_eq!(unack.len(), 1);

    store.acknowledge_notification(&notif_id, "accepted").unwrap();
    let unack2 = store.get_unacknowledged_notifications("agent-b").unwrap();
    assert!(unack2.is_empty());
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Concurrent Read/Write
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_concurrent_file_lock_contention() {
    let store = make_store();
    let store = Arc::new(store);

    let num_threads = 8;
    let mut handles = Vec::new();

    // Multiple agents compete for the same file lock
    for i in 0..num_threads {
        let s = Arc::clone(&store);
        handles.push(thread::spawn(move || {
            let agent = format!("agent-{}", i);
            s.acquire_file_lock("contended.rs", &agent, "write").unwrap()
        }));
    }

    let results: Vec<bool> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let acquired_count = results.iter().filter(|&&b| b).count();
    // Only one agent should acquire the lock (first one wins)
    assert_eq!(acquired_count, 1, "Exactly one agent should acquire the lock, got {}", acquired_count);
}

/// [B1-场景1] 并行两 agent 基于同一 base_version 提交同一文件 —— 恰好一个
/// Committed、其余 Conflict（B-04 CAS 防丢失更新的端到端自动化证据）。
#[test]
fn integration_concurrent_cas_commit_exactly_one_wins() {
    use blackboard_store::FileVersionCas;

    let store = make_store();

    // Base state: file tracked at version 0 (init) → bump to 1 so both agents
    // capture the same non-trivial base_version.
    store.init_file_version("shared_cas.rs", "base", "h0").unwrap();
    store.update_file_version("shared_cas.rs", "v1", "h1", "setup").unwrap();
    let base_version = store.get_file_version("shared_cas.rs").unwrap().unwrap().version;
    assert_eq!(base_version, 1);

    // Two (and more) agents race to commit against the SAME base version.
    let num_agents = 4;
    let barrier = Arc::new(std::sync::Barrier::new(num_agents));
    let mut handles = Vec::new();
    for i in 0..num_agents {
        let s = Arc::clone(&store);
        let b = Arc::clone(&barrier);
        handles.push(thread::spawn(move || {
            let agent = format!("agent-{}", i);
            b.wait(); // maximize contention: all commit at once
            s.commit_file_version_cas(
                "shared_cas.rs",
                &format!("content from {}", agent),
                &format!("hash-{}", i),
                &agent,
                base_version,
            )
            .unwrap()
        }));
    }

    let outcomes: Vec<FileVersionCas> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let committed = outcomes
        .iter()
        .filter(|o| matches!(o, FileVersionCas::Committed { .. }))
        .count();
    let conflicts = outcomes
        .iter()
        .filter(|o| matches!(o, FileVersionCas::Conflict { .. }))
        .count();
    assert_eq!(committed, 1, "exactly one agent must win the CAS commit");
    assert_eq!(conflicts, num_agents - 1, "all other agents must receive Conflict");

    // Conflict responses must report the actual (bumped) version.
    for o in &outcomes {
        if let FileVersionCas::Conflict { actual_version } = o {
            assert_eq!(*actual_version, Some(base_version + 1));
        }
    }

    // Final state: version bumped exactly once; content is the winner's.
    let final_v = store.get_file_version("shared_cas.rs").unwrap().unwrap();
    assert_eq!(final_v.version, base_version + 1, "version must be bumped exactly once");
    let winner_idx = outcomes
        .iter()
        .position(|o| matches!(o, FileVersionCas::Committed { .. }))
        .unwrap();
    assert_eq!(
        store.get_file_content("shared_cas.rs").unwrap(),
        Some(format!("content from agent-{}", winner_idx)),
        "persisted content must belong to the single committed writer"
    );
}

#[test]
fn integration_concurrent_submit_file() {
    let store = make_store();
    let store = Arc::new(store);

    let num_threads = 4;
    let mut handles = Vec::new();

    for i in 0..num_threads {
        let s = Arc::clone(&store);
        handles.push(thread::spawn(move || {
            let agent = format!("agent-{}", i);
            let id = s.submit_file(
                &agent, "shared.rs", &format!("content from {}", i),
                &FileSubmissionStatus::Draft, 0, "",
            ).unwrap();
            id
        }));
    }

    let ids: Vec<i64> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    // All ids should be unique and positive
    for &id in &ids {
        assert!(id > 0);
    }
    // All ids should be distinct
    let unique: std::collections::HashSet<i64> = ids.iter().copied().collect();
    assert_eq!(unique.len(), num_threads as usize);
}

#[test]
fn integration_concurrent_enqueue_dequeue_serial() {
    let store = make_store();
    let store = Arc::new(store);

    // Enqueue from multiple threads
    let num_enqueue = 10;
    let mut handles = Vec::new();
    for i in 0..num_enqueue {
        let s = Arc::clone(&store);
        handles.push(thread::spawn(move || {
            let agent = format!("agent-{}", i);
            s.enqueue_serial(&agent, &format!("file{}.rs", i), &format!("content{}", i), 0, "").unwrap()
        }));
    }
    for h in handles {
        h.join().unwrap();
    }

    // Dequeue all — should get exactly num_enqueue entries, no duplicates, no losses
    let mut dequeued = Vec::new();
    while !store.is_serial_queue_empty().unwrap() {
        if let Some(entry) = store.dequeue_serial().unwrap() {
            dequeued.push(entry.agent_id.clone());
        }
    }
    assert_eq!(dequeued.len(), num_enqueue, "All enqueued items should be dequeued");

    // Verify no duplicates
    let unique: std::collections::HashSet<String> = dequeued.into_iter().collect();
    assert_eq!(unique.len(), num_enqueue, "All dequeued items should be unique");
}

#[test]
fn integration_concurrent_read_while_writing() {
    let store = make_store();
    let store = Arc::new(store);

    // Pre-populate
    store.init_file_version("read_test.rs", "h0", "initial").unwrap();

    let s_read = Arc::clone(&store);
    let s_write = Arc::clone(&store);

    // Writer thread: update version repeatedly
    let writer = thread::spawn(move || {
        for i in 1..=50 {
            s_write.update_file_version("read_test.rs", &format!("v{}", i), &format!("hash{}", i), "writer").unwrap();
        }
    });

    // Reader thread: read version repeatedly — should never panic
    let reader = thread::spawn(move || {
        for _ in 0..50 {
            let _ = s_read.get_file_version("read_test.rs").unwrap();
            let _ = s_read.get_file_content("read_test.rs").unwrap();
        }
    });

    writer.join().unwrap();
    reader.join().unwrap();

    // Final state should be consistent
    let v = store.get_file_version("read_test.rs").unwrap().unwrap();
    assert_eq!(v.version, 50);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Transaction Boundary
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_transaction_boundary_submission_consistency() {
    let store = make_store();

    // Submit a draft and a stable for the same file
    store.submit_file("agent-a", "tx_test.rs", "draft1", &FileSubmissionStatus::Draft, 0, "h0").unwrap();
    store.submit_file("agent-a", "tx_test.rs", "stable1", &FileSubmissionStatus::Stable, 1, "h1").unwrap();

    // Both should be retrievable independently
    let draft = store.get_latest_submission("agent-a", "tx_test.rs").unwrap();
    // Latest submission is the stable one (higher id)
    assert!(draft.is_some());

    let stable = store.get_stable_submission("tx_test.rs").unwrap();
    assert!(stable.is_some());
    assert_eq!(stable.unwrap().content, "stable1");
}

#[test]
fn integration_transaction_boundary_lock_release_on_force() {
    let store = make_store();

    // Agent acquires lock, then "crashes" — force release should clean up
    store.acquire_file_lock("crash.rs", "agent-crash", "write").unwrap();
    store.register_agent_scope("agent-crash", &["crash.rs".to_string()]).unwrap();

    // Simulate crash: force release all locks
    let released_files = store.release_all_locks_for_agent("agent-crash").unwrap();
    assert_eq!(released_files.len(), 1);
    assert_eq!(released_files[0], "crash.rs");

    // Lock should be gone
    let state = store.get_file_lock_state("crash.rs").unwrap();
    assert!(matches!(state, FileLockState::Unlocked));

    // Scope should still exist (not deleted by lock release)
    let scope = store.get_agent_scope("agent-crash").unwrap();
    assert!(scope.is_some());
}

#[test]
fn integration_transaction_boundary_delete_drafts_preserves_stable() {
    let store = make_store();

    // Agent has both draft and stable submissions
    store.submit_file("agent-x", "mixed.rs", "draft content", &FileSubmissionStatus::Draft, 0, "").unwrap();
    store.submit_file("agent-x", "mixed.rs", "stable content", &FileSubmissionStatus::Stable, 1, "").unwrap();

    // Delete drafts should only remove draft, not stable
    let deleted = store.delete_agent_drafts("agent-x").unwrap();
    assert!(deleted > 0);

    // Stable should still be there
    let stable = store.get_stable_submission("mixed.rs").unwrap();
    assert!(stable.is_some());
    assert_eq!(stable.unwrap().content, "stable content");
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. In-Memory Mode
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_in_memory_basic_workflow() {
    let store = BlackboardStore::open_in_memory("mem-test").unwrap();
    assert_eq!(store.session_id(), "mem-test");

    // Full workflow in memory
    store.init_file_version("mem.rs", "h0", "init").unwrap();
    store.acquire_file_lock("mem.rs", "agent-1", "write").unwrap();
    store.submit_file("agent-1", "mem.rs", "new content", &FileSubmissionStatus::Draft, 0, "h0").unwrap();
    store.promote_draft_to_stable("agent-1", "mem.rs").unwrap();
    store.release_file_lock("mem.rs", "agent-1").unwrap();

    let stable = store.get_stable_submission("mem.rs").unwrap();
    assert!(stable.is_some());
    assert_eq!(stable.unwrap().content, "new content");
}

#[test]
fn integration_in_memory_isolation() {
    let store1 = BlackboardStore::open_in_memory("session-1").unwrap();
    let store2 = BlackboardStore::open_in_memory("session-2").unwrap();

    store1.init_file_version("iso.rs", "from-store1", "h1").unwrap();
    store2.init_file_version("iso.rs", "from-store2", "h2").unwrap();

    // Each store has its own data
    let c1 = store1.get_file_content("iso.rs").unwrap();
    let c2 = store2.get_file_content("iso.rs").unwrap();
    assert_eq!(c1, Some("from-store1".to_string()));
    assert_eq!(c2, Some("from-store2".to_string()));
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Status & Cleanup
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_status_and_cleanup() {
    let store = make_store();

    // Populate some data
    store.init_file_version("a.rs", "h", "c").unwrap();
    store.acquire_file_lock("a.rs", "agent-a", "write").unwrap();
    store.enqueue_serial("agent-a", "a.rs", "content", 0, "").unwrap();

    let status = store.get_status(&CircuitBreakerState::Normal).unwrap();
    assert!(status.total_files >= 1);
    assert!(status.locked_files >= 1);

    // Cleanup
    store.cleanup().unwrap();
    let status2 = store.get_status(&CircuitBreakerState::Normal).unwrap();
    assert_eq!(status2.locked_files, 0);
    assert!(store.is_serial_queue_empty().unwrap());
}
