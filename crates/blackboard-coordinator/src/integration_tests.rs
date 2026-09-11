//! Integration tests for the full blackboard-coordinator system.
//!
//! Exercises the complete multi-agent coordination flow through the
//! BlackboardCoordinator unified API surface.

use std::sync::Arc;

use anyhow::Result;
use blackboard_store::BlackboardStore;
use duo_types::*;

use crate::agent_state::AgentOperationalState;
use crate::coordinator::{
    BlackboardConfig, BlackboardCoordinator, StableSubmission, StableSubmitResult,
};


/// Helper: create a fresh in-memory coordinator for each test.
fn make_coordinator() -> BlackboardCoordinator {
    let store = Arc::new(BlackboardStore::open_in_memory("test").unwrap());
    BlackboardCoordinator::from_store(store, BlackboardConfig::default()).unwrap()
}

/// Helper: initialize the coordinator and start background tasks.
async fn init_with_bg(bb: &BlackboardCoordinator, project: &str, scopes: &[AgentScope]) {
    let r: Result<()> = bb.initialize(project, scopes).await;
    r.unwrap();
    bb.start_background_tasks().await;
}

// =============================================================================
// 1. Basic Flow Test
// =============================================================================

#[tokio::test]
async fn test_basic_flow() {
    let bb = make_coordinator();

    // Initialize with 2 agents
    let scopes = vec![
        AgentScope {
            agent_id: "agent-a".into(),
            allowed_files: vec!["file_a.ts".into()],
            assigned_at: String::new(),
        },
        AgentScope {
            agent_id: "agent-b".into(),
            allowed_files: vec!["file_a.ts".into()],
            assigned_at: String::new(),
        },
    ];
    init_with_bg(&bb, "/project", &scopes).await;

    // Agent A declares intent to write file_a.ts
    let decl = IntentDeclaration {
        agent_id: "agent-a".into(),
        files: vec!["file_a.ts".into()],
        intent: IntentKind::Write,
    };
    let results: Vec<LockAcquireResult> = bb.declare_intent(&decl).await.unwrap();
    assert!(matches!(results[0], LockAcquireResult::Granted { .. }));

    // Initialize the file version so the store tracks it
    bb.store().init_file_version("file_a.ts", "// initial", "hash0").unwrap();

    // Agent A submits draft for file_a.ts
    let draft_id = bb.submit_draft("agent-a", "file_a.ts", "const a = 1;", 0, "hash0").unwrap();
    assert!(draft_id > 0);

    // Agent A submits stable
    let result: StableSubmitResult = bb.submit_stable(StableSubmission {
        agent_id: "agent-a",
        file_path: "file_a.ts",
        content: "const a = 1;",
        base_version: 0,
        base_ast_hash: "hash0",
        new_ast_hash: "hash1",
        skip_syntax_check: false,
    }).await.unwrap();
    match result {
        StableSubmitResult::Success { new_version } => assert_eq!(new_version, 1),
        other => panic!("Expected Success, got {:?}", other),
    }

    // Agent B reads file_a.ts and gets the stable version
    let read_result = bb.read_file("agent-b", "file_a.ts").unwrap();
    let (content, version, _hash) = read_result.expect("should have content");
    assert_eq!(content, "const a = 1;");
    assert_eq!(version, 1);
}

#[tokio::test]
async fn test_file_annotations_回流() {
    let bb = make_coordinator();
    let agent_id = "reviewer-1";

    // No annotations yet.
    assert!(bb.get_file_annotations(&["src/a.rs".to_string()]).unwrap().is_empty());

    // Attach review annotations (G5 annotation 回流 producer side).
    let id1 = bb
        .add_file_annotation("src/a.rs", agent_id, "review", "[L10] unused import")
        .unwrap();
    assert!(id1 > 0);
    let id2 = bb
        .add_file_annotation("src/a.rs", agent_id, "review", "[L20] missing null check")
        .unwrap();
    assert!(id2 > 0);

    // Consumer side: the loop's Reflect reads annotations for the touched files.
    let anns = bb.get_file_annotations(&["src/a.rs".to_string()]).unwrap();
    assert_eq!(anns.len(), 2);
    assert_eq!(anns[0].content, "[L10] unused import");

    // Clearing removes only the targeted file's annotations.
    let cleared = bb.clear_file_annotations(&["src/a.rs".to_string()]).unwrap();
    assert_eq!(cleared, 2);
    assert!(bb.get_file_annotations(&["src/a.rs".to_string()]).unwrap().is_empty());
}

// =============================================================================
// 2. Intent Lock Contention Test
// =============================================================================

#[tokio::test]
async fn test_intent_lock_contention() {
    let bb = make_coordinator();

    let scopes = vec![
        AgentScope {
            agent_id: "agent-a".into(),
            allowed_files: vec!["shared.ts".into()],
            assigned_at: String::new(),
        },
        AgentScope {
            agent_id: "agent-b".into(),
            allowed_files: vec!["shared.ts".into()],
            assigned_at: String::new(),
        },
    ];
    init_with_bg(&bb, "/project", &scopes).await;

    // Agent A acquires lock on shared.ts
    let decl_a = IntentDeclaration {
        agent_id: "agent-a".into(),
        files: vec!["shared.ts".into()],
        intent: IntentKind::Write,
    };
    let results: Vec<LockAcquireResult> = bb.declare_intent(&decl_a).await.unwrap();
    assert!(matches!(results[0], LockAcquireResult::Granted { .. }));

    // Agent B tries to acquire lock on shared.ts → should be queued
    let decl_b = IntentDeclaration {
        agent_id: "agent-b".into(),
        files: vec!["shared.ts".into()],
        intent: IntentKind::Write,
    };
    let results: Vec<LockAcquireResult> = bb.declare_intent(&decl_b).await.unwrap();
    match &results[0] {
        LockAcquireResult::Queued { position, .. } => assert_eq!(*position, 1),
        other => panic!("Expected Queued, got {:?}", other),
    }

    // Verify queue state before release
    let queue = bb.lock_manager().get_wait_queue("shared.ts").await;
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].agent_id, "agent-b");

    // Agent A releases lock → Agent B should get the lock
    let r: Result<()> = bb.lock_manager().release_lock("agent-a", "shared.ts").await;
    r.unwrap();

    // Verify Agent B now holds the lock
    let lock_state = bb.lock_manager().get_lock_state("shared.ts").unwrap();
    match lock_state {
        FileLockState::Locked { agent_id, .. } => assert_eq!(agent_id, "agent-b"),
        FileLockState::Unlocked => panic!("Expected file to be locked by agent-b"),
    }

    // Queue should now be empty
    let queue = bb.lock_manager().get_wait_queue("shared.ts").await;
    assert!(queue.is_empty());
}

// =============================================================================
// 3. Optimistic Lock Conflict Test
// =============================================================================

#[tokio::test]
async fn test_optimistic_lock_conflict() {
    let bb = make_coordinator();

    let scopes = vec![
        AgentScope {
            agent_id: "agent-a".into(),
            allowed_files: vec!["conflict.ts".into()],
            assigned_at: String::new(),
        },
        AgentScope {
            agent_id: "agent-b".into(),
            allowed_files: vec!["conflict.ts".into()],
            assigned_at: String::new(),
        },
    ];
    init_with_bg(&bb, "/project", &scopes).await;

    // Initialize the file so both agents can read it
    bb.store().init_file_version("conflict.ts", "// v0", "hash_v0").unwrap();

    // Both agents "read" the file — note: read_file returns content only if there's
    // a stable submission or own draft. Since neither agent has submitted yet,
    // we verify the version directly from the store.
    let version_info = bb.store().get_file_version("conflict.ts").unwrap();
    assert!(version_info.is_some());
    let base_version = version_info.unwrap().version; // 0
    let base_hash = "hash_v0";

    // Agent B submits stable based on version 0 → success, version becomes 1
    bb.store().acquire_file_lock("conflict.ts", "agent-b", "write").unwrap();
    let result_b: StableSubmitResult = bb.submit_stable(StableSubmission {
        agent_id: "agent-b",
        file_path: "conflict.ts",
        content: "// v1 by B",
        base_version: base_version,
        base_ast_hash: base_hash,
        new_ast_hash: "hash_v1",
        skip_syntax_check: false,
    }).await.unwrap();
    match result_b {
        StableSubmitResult::Success { new_version } => assert_eq!(new_version, 1),
        other => panic!("Expected Success for B, got {:?}", other),
    }

    // Agent A tries to submit stable based on version 0 → should get conflict
    bb.store().acquire_file_lock("conflict.ts", "agent-a", "write").unwrap();
    let result_a: StableSubmitResult = bb.submit_stable(StableSubmission {
        agent_id: "agent-a",
        file_path: "conflict.ts",
        content: "// v1 by A",
        base_version: base_version,
        base_ast_hash: base_hash,
        new_ast_hash: "hash_v1a",
        skip_syntax_check: false,
    }).await.unwrap();
    match result_a {
        StableSubmitResult::Conflict { expected_version, actual_version, .. } => {
            assert_eq!(expected_version, 0);
            assert_eq!(actual_version, 1);
        }
        other => panic!("Expected Conflict for A, got {:?}", other),
    }
}

// =============================================================================
// 4. Draft Visibility Test
// =============================================================================

#[tokio::test]
async fn test_draft_visibility() {
    let bb = make_coordinator();

    let scopes = vec![
        AgentScope {
            agent_id: "agent-a".into(),
            allowed_files: vec!["file.ts".into()],
            assigned_at: String::new(),
        },
        AgentScope {
            agent_id: "agent-b".into(),
            allowed_files: vec!["file.ts".into()],
            assigned_at: String::new(),
        },
    ];
    init_with_bg(&bb, "/project", &scopes).await;

    // Agent A submits draft for file.ts
    bb.submit_draft("agent-a", "file.ts", "// draft by A", 0, "hash0").unwrap();

    // Agent B tries to read file.ts → should NOT see Agent A's draft
    let read_b = bb.read_file("agent-b", "file.ts").unwrap();
    assert!(read_b.is_none(), "Agent B should not see A's draft");

    // Agent A can read their own draft
    let read_a = bb.read_file("agent-a", "file.ts").unwrap();
    match read_a {
        Some((content, _, _)) => assert_eq!(content, "// draft by A"),
        None => panic!("Agent A should see their own draft"),
    }
}

// =============================================================================
// 5. Scope Enforcement Test
// =============================================================================

#[tokio::test]
async fn test_scope_enforcement() {
    let bb = make_coordinator();

    // Register agent-a with scope ["file_a.ts", "file_b.ts"]
    let scopes = vec![AgentScope {
        agent_id: "agent-a".into(),
        allowed_files: vec!["file_a.ts".into(), "file_b.ts".into()],
        assigned_at: String::new(),
    }];
    init_with_bg(&bb, "/project", &scopes).await;

    // Agent A writes file_a.ts → should succeed
    bb.store().init_file_version("file_a.ts", "// v0", "h0").unwrap();
    bb.store().acquire_file_lock("file_a.ts", "agent-a", "write").unwrap();
    let result: StableSubmitResult = bb.submit_stable(StableSubmission {
        agent_id: "agent-a",
        file_path: "file_a.ts",
        content: "// updated",
        base_version: 0,
        base_ast_hash: "h0",
        new_ast_hash: "h1",
        skip_syntax_check: false,
    }).await.unwrap();
    match result {
        StableSubmitResult::Success { new_version } => assert_eq!(new_version, 1),
        other => panic!("Expected Success for in-scope write, got {:?}", other),
    }

    // Agent A writes file_c.ts → should be out of scope
    bb.store().init_file_version("file_c.ts", "// v0", "h0").unwrap();
    bb.store().acquire_file_lock("file_c.ts", "agent-a", "write").unwrap();
    let result: StableSubmitResult = bb.submit_stable(StableSubmission {
        agent_id: "agent-a",
        file_path: "file_c.ts",
        content: "// out of scope",
        base_version: 0,
        base_ast_hash: "h0",
        new_ast_hash: "h1",
        skip_syntax_check: false,
    }).await.unwrap();
    match result {
        StableSubmitResult::OutOfScope { allowed_files } => {
            assert!(allowed_files.contains(&"file_a.ts".to_string()));
            assert!(allowed_files.contains(&"file_b.ts".to_string()));
            assert!(!allowed_files.contains(&"file_c.ts".to_string()));
        }
        other => panic!("Expected OutOfScope, got {:?}", other),
    }
}

// =============================================================================
// 6. Conflict Degradation Test
// =============================================================================


// =============================================================================
// 7. Agent Fault Handling Test
// =============================================================================


// =============================================================================
// 8. Circuit Breaker Test
// =============================================================================


// =============================================================================
// 9. Change Notification Test
// =============================================================================

#[tokio::test]
async fn test_change_notification() {
    let bb = make_coordinator();

    let scopes = vec![
        AgentScope {
            agent_id: "agent-a".into(),
            allowed_files: vec!["dep_source.ts".into()],
            assigned_at: String::new(),
        },
        AgentScope {
            agent_id: "agent-b".into(),
            allowed_files: vec!["dep_target.ts".into()],
            assigned_at: String::new(),
        },
    ];
    init_with_bg(&bb, "/project", &scopes).await;

    // Initialize both files
    bb.store().init_file_version("dep_source.ts", "// v0", "h0").unwrap();
    bb.store().init_file_version("dep_target.ts", "// v0", "h0").unwrap();

    // Register dependency: dep_target.ts depends on dep_source.ts
    bb.store().register_dependency("dep_target.ts", "dep_source.ts", "import", &["fn_a".into()]).unwrap();

    // Agent B has a stable submission for dep_target.ts (so they're an "affected agent")
    bb.store().acquire_file_lock("dep_target.ts", "agent-b", "write").unwrap();
    bb.store().submit_file(
        "agent-b", "dep_target.ts", "// target content", &FileSubmissionStatus::Stable, 0, "h0",
    ).unwrap();

    // Agent A submits stable for dep_source.ts
    // This now automatically triggers change notification to dependent agents
    bb.store().acquire_file_lock("dep_source.ts", "agent-a", "write").unwrap();
    let result: StableSubmitResult = bb.submit_stable(StableSubmission {
        agent_id: "agent-a",
        file_path: "dep_source.ts",
        content: "// updated source",
        base_version: 0,
        base_ast_hash: "h0",
        new_ast_hash: "h1",
        skip_syntax_check: false,
    }).await.unwrap();
    match result {
        StableSubmitResult::Success { new_version } => assert_eq!(new_version, 1),
        other => panic!("Expected Success, got {:?}", other),
    }

    // Verify Agent B has pending notification (auto-generated by submit_stable)
    let pending = bb.get_pending_notifications("agent-b").unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].file, "dep_source.ts");
    assert_eq!(pending[0].from_version, 0);
    assert_eq!(pending[0].to_version, 1);

    // Verify change log was recorded
    let logs = bb.store().get_change_logs("dep_source.ts").unwrap();
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].change_type, "modified");
}

// =============================================================================
// 10. Full Pipeline Test
// =============================================================================

#[tokio::test]
async fn test_full_pipeline() {
    let bb = make_coordinator();

    let scopes = vec![
        AgentScope {
            agent_id: "agent-a".into(),
            allowed_files: vec!["pipeline.ts".into(), "other.ts".into()],
            assigned_at: String::new(),
        },
        AgentScope {
            agent_id: "agent-b".into(),
            allowed_files: vec!["pipeline.ts".into()],
            assigned_at: String::new(),
        },
    ];
    init_with_bg(&bb, "/project", &scopes).await;

    // Initialize file with version 0
    bb.store().init_file_version("pipeline.ts", "// initial content", "initial_hash").unwrap();

    // Step 1: Declare intent
    let decl = IntentDeclaration {
        agent_id: "agent-a".into(),
        files: vec!["pipeline.ts".into()],
        intent: IntentKind::Write,
    };
    let results: Vec<LockAcquireResult> = bb.declare_intent(&decl).await.unwrap();
    assert!(matches!(results[0], LockAcquireResult::Granted { .. }));

    // Step 2: Lock is acquired (verified above), submit draft
    let draft_id = bb.submit_draft(
        "agent-a", "pipeline.ts", "export function hello() { return 42; }", 0, "initial_hash",
    ).unwrap();
    assert!(draft_id > 0);

    // Step 3: Promote draft to stable
    let result: StableSubmitResult = bb.submit_stable(StableSubmission {
        agent_id: "agent-a",
        file_path: "pipeline.ts",
        content: "export function hello() { return 42; }",
        base_version: 0,
        base_ast_hash: "initial_hash",
        new_ast_hash: "new_hash",
        skip_syntax_check: false,
    }).await.unwrap();
    let new_version = match result {
        StableSubmitResult::Success { new_version } => new_version,
        other => panic!("Expected Success, got {:?}", other),
    };
    assert_eq!(new_version, 1);

    // Step 4: Verify lock was released after stable submission
    let lock_state = bb.lock_manager().get_lock_state("pipeline.ts").unwrap();
    assert!(matches!(lock_state, FileLockState::Unlocked));

    // Step 5: Setup dependency and notification
    bb.store().init_file_version("other.ts", "// other", "h0").unwrap();
    bb.store().register_dependency("other.ts", "pipeline.ts", "import", &["hello".into()]).unwrap();
    bb.store().submit_file(
        "agent-a", "other.ts", "// other content", &FileSubmissionStatus::Stable, 0, "h0",
    ).unwrap();

    let changes = vec![ChangeLogEntry {
        change_type: ChangeType::Added,
        symbol: "hello".into(),
        detail: "Function added".into(),
        old_signature: None,
        new_signature: Some("hello(): number".into()),
    }];
    let notification_ids: Vec<String> = bb.notification_manager()
        .notify_file_change("pipeline.ts", 0, 1, &changes)
        .await.unwrap();
    assert!(!notification_ids.is_empty());

    // Step 6: Agent acknowledges notification
    let pending = bb.get_pending_notifications("agent-a").unwrap();
    if !pending.is_empty() {
        let acked: bool = bb.ack_notification(&pending[0].id, "agent-a", "re-read file").await.unwrap();
        assert!(acked);
    }

    // Step 7: Cleanup
    bb.stop_background_tasks().await;
    bb.cleanup().await.unwrap();

    // Verify serial queue is cleared after cleanup
    assert!(bb.store().is_serial_queue_empty().unwrap());
}

// =============================================================================
// 11. Crash Recovery Test
// =============================================================================

#[tokio::test]
async fn test_crash_recovery() {
    // Phase 1: Create coordinator, acquire locks, create notifications
    let store = Arc::new(BlackboardStore::open_in_memory("crash-test").unwrap());
    let bb = BlackboardCoordinator::from_store(store.clone(), BlackboardConfig::default()).unwrap();

    let scopes = vec![
        AgentScope {
            agent_id: "agent-a".into(),
            allowed_files: vec!["file_a.ts".into()],
            assigned_at: String::new(),
        },
        AgentScope {
            agent_id: "agent-b".into(),
            allowed_files: vec!["file_b.ts".into()],
            assigned_at: String::new(),
        },
    ];
    init_with_bg(&bb, "/project", &scopes).await;

    // Initialize file versions
    bb.store().init_file_version("file_a.ts", "// v0", "h0").unwrap();
    bb.store().init_file_version("file_b.ts", "// v0", "h0").unwrap();

    // Agent A acquires lock on file_a.ts
    let decl_a = IntentDeclaration {
        agent_id: "agent-a".into(),
        files: vec!["file_a.ts".into()],
        intent: IntentKind::Write,
    };
    let results: Vec<LockAcquireResult> = bb.declare_intent(&decl_a).await.unwrap();
    assert!(matches!(results[0], LockAcquireResult::Granted { .. }));

    // Agent B acquires lock on file_b.ts
    let decl_b = IntentDeclaration {
        agent_id: "agent-b".into(),
        files: vec!["file_b.ts".into()],
        intent: IntentKind::Write,
    };
    let results: Vec<LockAcquireResult> = bb.declare_intent(&decl_b).await.unwrap();
    assert!(matches!(results[0], LockAcquireResult::Granted { .. }));

    // Setup dependency and create change notification
    bb.store().register_dependency("file_b.ts", "file_a.ts", "import", &["fn_a".into()]).unwrap();
    bb.store().submit_file(
        "agent-b", "file_b.ts", "// content", &FileSubmissionStatus::Stable, 0, "h0",
    ).unwrap();

    let changes = vec![ChangeLogEntry {
        change_type: ChangeType::Modified,
        symbol: "fn_a".into(),
        detail: "Signature changed".into(),
        old_signature: Some("fn_a(): void".into()),
        new_signature: Some("fn_a(): string".into()),
    }];
    let notification_ids: Vec<String> = bb.notification_manager()
        .notify_file_change("file_a.ts", 0, 1, &changes)
        .await.unwrap();
    assert!(!notification_ids.is_empty(), "Should have created notifications");

    // Verify locks are held and notifications are pending
    let lock_state_a = bb.lock_manager().get_lock_state("file_a.ts").unwrap();
    assert!(matches!(lock_state_a, FileLockState::Locked { .. }));
    let lock_state_b = bb.lock_manager().get_lock_state("file_b.ts").unwrap();
    assert!(matches!(lock_state_b, FileLockState::Locked { .. }));
    let pending = bb.get_pending_notifications("agent-b").unwrap();
    assert_eq!(pending.len(), 1, "Agent B should have one pending notification");

    // Phase 2: Simulate crash - create a NEW coordinator on the same store
    // (In a real crash, the process restarts but the SQLite DB persists)
    let bb2 = BlackboardCoordinator::from_store(store.clone(), BlackboardConfig::default()).unwrap();

    // Before recovery: the new coordinator's in-memory state is empty,
    // but SQLite still has the locks and notifications
    let lock_before = bb2.lock_manager().get_lock_state("file_a.ts").unwrap();
    assert!(matches!(lock_before, FileLockState::Locked { .. }), "SQLite still has the lock");

    // Run crash recovery
    let recovery_result = bb2.recover_from_crash().await.unwrap();

    // Verify all locks were released
    assert_eq!(recovery_result.released_locks.len(), 2, "Should have released 2 locks");
    let lock_after_a = bb2.lock_manager().get_lock_state("file_a.ts").unwrap();
    assert!(matches!(lock_after_a, FileLockState::Unlocked), "Lock should be released after recovery");
    let lock_after_b = bb2.lock_manager().get_lock_state("file_b.ts").unwrap();
    assert!(matches!(lock_after_b, FileLockState::Unlocked), "Lock should be released after recovery");

    // Verify pending ACKs were reconstructed
    assert!(recovery_result.pending_acks > 0, "Should have reconstructed pending ACKs");

    // Verify notifications are still accessible through the new coordinator
    let pending_after = bb2.get_pending_notifications("agent-b").unwrap();
    assert_eq!(pending_after.len(), 1, "Agent B should still have one pending notification after recovery");

    // Verify conflict degradation was reset (no serial mode files)
    assert!(!bb2.conflict_degradation().is_serial_mode("file_a.ts").await);
    assert!(!bb2.conflict_degradation().is_serial_mode("file_b.ts").await);

    // Verify agents can now re-acquire locks on the recovered coordinator
    let scopes2 = vec![
        AgentScope {
            agent_id: "agent-a".into(),
            allowed_files: vec!["file_a.ts".into()],
            assigned_at: String::new(),
        },
    ];
    init_with_bg(&bb2, "/project", &scopes2).await;
    let decl_recovery = IntentDeclaration {
        agent_id: "agent-a".into(),
        files: vec!["file_a.ts".into()],
        intent: IntentKind::Write,
    };
    let results: Vec<LockAcquireResult> = bb2.declare_intent(&decl_recovery).await.unwrap();
    assert!(matches!(results[0], LockAcquireResult::Granted { .. }), "Agent should be able to re-acquire lock after recovery");
}

// =============================================================================
// Dependency Change Adaptation Tests
// =============================================================================

#[tokio::test]
async fn test_scenario1_dependency_version_changed_during_draft() {
    let bb = make_coordinator();

    let scopes = vec![
        AgentScope {
            agent_id: "agent-a".into(),
            allowed_files: vec!["src.ts".into(), "dep.ts".into()],
            assigned_at: String::new(),
        },
    ];
    init_with_bg(&bb, "/project", &scopes).await;

    // Initialize file versions
    bb.store().init_file_version("src.ts", "// v0", "h0").unwrap();
    bb.store().init_file_version("dep.ts", "// v0", "h0").unwrap();

    // Register dependency: src.ts imports from dep.ts
    bb.register_dependency("src.ts", "dep.ts", "import", &["fn_a".into()]).unwrap();

    // Agent A checks dependency version (still at 0) - should be up-to-date
    let result = bb.check_dependency_version("agent-a", "src.ts", "dep.ts", 0).unwrap();
    assert!(result.is_none(), "Dependency version is up-to-date");

    // Another agent updates dep.ts
    bb.store().update_file_version("dep.ts", "// v1", "h1", "agent-b").unwrap();
    let diff = StructuredChangeList {
        file: "dep.ts".to_string(),
        agent_id: "agent-b".to_string(),
        changes: vec![FileChangeEntry {
            symbol_name: "fn_a".to_string(),
            change_kind: SymbolChangeKind::Modified,
            old_signature: Some("fn_a(): void".into()),
            new_signature: Some("fn_a(): string".into()),
        }],
    };
    bb.store().record_change_log("dep.ts", 0, 1, "modified", "agent-b", &diff).unwrap();

    // Agent A checks again - now version has changed
    let result = bb.check_dependency_version("agent-a", "src.ts", "dep.ts", 0).unwrap();
    assert!(result.is_some(), "Dependency version has changed");
    let check = result.unwrap();
    assert_eq!(check.known_version, 0);
    assert_eq!(check.current_version, 1);
    assert!(check.must_adapt, "Should need to adapt since change logs exist");
}

#[tokio::test]
async fn test_scenario2_dependency_check_before_stable() {
    let bb = make_coordinator();

    let scopes = vec![
        AgentScope {
            agent_id: "agent-a".into(),
            allowed_files: vec!["src.ts".into()],
            assigned_at: String::new(),
        },
    ];
    init_with_bg(&bb, "/project", &scopes).await;

    // Initialize file versions
    bb.store().init_file_version("src.ts", "// v0", "h0").unwrap();
    bb.store().init_file_version("dep.ts", "// v0", "h0").unwrap();

    // Register dependency
    bb.register_dependency("src.ts", "dep.ts", "import", &["fn_a".into()]).unwrap();

    // Agent A acquires lock
    let decl = IntentDeclaration {
        agent_id: "agent-a".into(),
        files: vec!["src.ts".into()],
        intent: IntentKind::Write,
    };
    let results: Vec<LockAcquireResult> = bb.declare_intent(&decl).await.unwrap();
    assert!(matches!(results[0], LockAcquireResult::Granted { .. }));

    // Agent A submits a draft first
    bb.submit_draft("agent-a", "src.ts", "// draft content", 0, "h0").unwrap();

    // dep.ts gets updated by another agent
    bb.store().update_file_version("dep.ts", "// v1", "h1", "agent-b").unwrap();

    // Now try to submit stable - should fail with DependencyChanged
    let result = bb.submit_stable(StableSubmission {
        agent_id: "agent-a",
        file_path: "src.ts",
        content: "// stable content",
        base_version: 0,
        base_ast_hash: "h0",
        new_ast_hash: "h1",
        skip_syntax_check: false,
    }).await.unwrap();

    match result {
        StableSubmitResult::DependencyChanged { changes } => {
            assert_eq!(changes.len(), 1, "Should detect one changed dependency");
            assert_eq!(changes[0].file, "dep.ts");
        }
        other => panic!("Expected DependencyChanged, got {:?}", other),
    }
}

#[tokio::test]
async fn test_scenario2_no_dependency_changes_passes() {
    let bb = make_coordinator();

    let scopes = vec![
        AgentScope {
            agent_id: "agent-a".into(),
            allowed_files: vec!["src.ts".into()],
            assigned_at: String::new(),
        },
    ];
    init_with_bg(&bb, "/project", &scopes).await;

    // Initialize file versions
    bb.store().init_file_version("src.ts", "// v0", "h0").unwrap();

    // Agent A acquires lock
    let decl = IntentDeclaration {
        agent_id: "agent-a".into(),
        files: vec!["src.ts".into()],
        intent: IntentKind::Write,
    };
    let results: Vec<LockAcquireResult> = bb.declare_intent(&decl).await.unwrap();
    assert!(matches!(results[0], LockAcquireResult::Granted { .. }));

    // No dependencies, no changes - should succeed
    let result = bb.submit_stable(StableSubmission {
        agent_id: "agent-a",
        file_path: "src.ts",
        content: "// stable content",
        base_version: 0,
        base_ast_hash: "h0",
        new_ast_hash: "h1",
        skip_syntax_check: false,
    }).await.unwrap();

    assert!(matches!(result, StableSubmitResult::Success { .. }), "Should succeed with no dependency changes");
}

#[tokio::test]
async fn test_scenario3_forced_adaptation() {
    let bb = make_coordinator();

    let scopes = vec![
        AgentScope {
            agent_id: "agent-a".into(),
            allowed_files: vec!["src.ts".into()],
            assigned_at: String::new(),
        },
        AgentScope {
            agent_id: "agent-b".into(),
            allowed_files: vec!["dep.ts".into()],
            assigned_at: String::new(),
        },
    ];
    init_with_bg(&bb, "/project", &scopes).await;

    // Initialize file versions
    bb.store().init_file_version("src.ts", "// v0", "h0").unwrap();
    bb.store().init_file_version("dep.ts", "// v0", "h0").unwrap();

    // Register dependency: src.ts depends on dep.ts
    bb.register_dependency("src.ts", "dep.ts", "import", &["fn_a".into()]).unwrap();

    // Agent A submits stable (without dependency changes)
    let decl = IntentDeclaration {
        agent_id: "agent-a".into(),
        files: vec!["src.ts".into()],
        intent: IntentKind::Write,
    };
    let results: Vec<LockAcquireResult> = bb.declare_intent(&decl).await.unwrap();
    assert!(matches!(results[0], LockAcquireResult::Granted { .. }));

    let result = bb.submit_stable(StableSubmission {
        agent_id: "agent-a",
        file_path: "src.ts",
        content: "// content",
        base_version: 0,
        base_ast_hash: "h0",
        new_ast_hash: "h1",
        skip_syntax_check: false,
    }).await.unwrap();
    assert!(matches!(result, StableSubmitResult::Success { .. }));

    // Now dep.ts changes - agent B modifies it
    bb.store().update_file_version("dep.ts", "// v1", "h1", "agent-b").unwrap();

    // A notification is created for agent-a about the dep.ts change
    let changes = vec![ChangeLogEntry {
        change_type: ChangeType::Modified,
        symbol: "fn_a".into(),
        detail: "Signature changed".into(),
        old_signature: Some("fn_a(): void".into()),
        new_signature: Some("fn_a(): string".into()),
    }];

    let notification = ChangeNotification {
        id: "notif-1".to_string(),
        file: "dep.ts".to_string(),
        from_version: 0,
        to_version: 1,
        changes: changes.clone(),
        target_agent_id: "agent-a".to_string(),
        created_at: String::new(),
        acknowledged: false,
    };

    // Process forced adaptation
    let result = bb.process_forced_adaptation("agent-a", &notification).unwrap();
    assert!(result.must_adapt, "Agent A must adapt because it depends on dep.ts");
    assert_eq!(result.affected_files, vec!["src.ts"]);
    assert_eq!(result.changes.len(), 1);

    // Agent B has no dependency on dep.ts through stable submission
    let result_b = bb.process_forced_adaptation("agent-b", &notification).unwrap();
    assert!(!result_b.must_adapt, "Agent B does not depend on dep.ts");
}

// =============================================================================
// Agent Backoff, Fault, and Reassignment Tests
// =============================================================================

#[tokio::test]
async fn test_agent_backoff_state() {
    let bb = make_coordinator();

    let scopes = vec![
        AgentScope {
            agent_id: "agent-a".into(),
            allowed_files: vec!["backoff.ts".into()],
            assigned_at: String::new(),
        },
    ];
    init_with_bg(&bb, "/project", &scopes).await;

    // Manually enter backoff state
    bb.agent_state_manager()
        .enter_backoff("agent-a", "backoff.ts", 1, 10)
        .await;

    // Verify agent is in backoff
    let state = bb.get_agent_state("agent-a").await;
    assert!(matches!(state, AgentOperationalState::InBackoff { .. }));

    // Agent should not be able to accept intents during backoff
    assert!(!bb.agent_state_manager().can_accept_intents("agent-a").await);

    // Attempt to declare intent should be denied
    let decl = IntentDeclaration {
        agent_id: "agent-a".into(),
        files: vec!["backoff.ts".into()],
        intent: IntentKind::Write,
    };
    let results: Vec<LockAcquireResult> = bb.declare_intent(&decl).await.unwrap();
    match &results[0] {
        LockAcquireResult::Denied { reason, .. } => {
            assert!(reason.contains("backoff") || reason.contains("faulted"));
        }
        other => panic!("Expected Denied due to backoff, got {:?}", other),
    }
}




// =============================================================================
// Metrics Collector Tests
// =============================================================================




#[tokio::test]
async fn test_runtime_config_update() {
    let bb = make_coordinator();
    let cb = bb.circuit_breaker();

    // Get initial config
    let initial_config = cb.config().await;
    let initial_threshold = initial_config.conflict_rate_threshold;

    // Update config at runtime through &self (not &mut self)
    let new_config = CircuitBreakerConfig {
        conflict_rate_threshold: 0.8,
        agent_failure_ratio_threshold: 0.7,
        blackboard_crash_threshold: 5,
        recovery_success_count: 10,
    };
    cb.update_config(new_config.clone()).await;

    // Verify config was updated
    let updated_config = cb.config().await;
    assert!((updated_config.conflict_rate_threshold - 0.8).abs() < f64::EPSILON, "Conflict rate threshold should be 0.8");
    assert!((updated_config.agent_failure_ratio_threshold - 0.7).abs() < f64::EPSILON, "Agent failure ratio threshold should be 0.7");
    assert_eq!(updated_config.blackboard_crash_threshold, 5, "Crash threshold should be 5");
    assert_eq!(updated_config.recovery_success_count, 10, "Recovery success count should be 10");

    // Restore original config
    cb.update_config(initial_config).await;
    let restored = cb.config().await;
    assert!((restored.conflict_rate_threshold - initial_threshold).abs() < f64::EPSILON, "Config should be restored");
}

// =========================================================================
// Public Resource & Closing Phase Tests
// =========================================================================

#[tokio::test]
async fn test_public_resource_identification() {
    let bb = make_coordinator();

    let scopes = vec![
        AgentScope {
            agent_id: "agent-a".into(),
            allowed_files: vec!["src/main.rs".into(), "src/lib.rs".into()],
            assigned_at: String::new(),
        },
        AgentScope {
            agent_id: "agent-b".into(),
            allowed_files: vec!["src/utils.rs".into(), "src/lib.rs".into()],
            assigned_at: String::new(),
        },
    ];
    init_with_bg(&bb, "/project", &scopes).await;

    // Register dependencies: both agent-a and agent-b reference src/lib.rs
    bb.register_dependency(
        "src/main.rs",
        "src/lib.rs",
        "import",
        &["LibStruct".into()],
    ).unwrap();
    bb.register_dependency(
        "src/utils.rs",
        "src/lib.rs",
        "import",
        &["helper_fn".into()],
    ).unwrap();
    // Also register a dependency that is NOT public (only one module refs it)
    bb.register_dependency(
        "src/main.rs",
        "src/only_a.rs",
        "import",
        &["OnlyA".into()],
    ).unwrap();

    let resources = bb.identify_public_resources().unwrap();

    // src/lib.rs should be identified as a public resource
    assert_eq!(resources.len(), 1);
    assert_eq!(resources[0].file_path, "src/lib.rs");
    assert_eq!(resources[0].reference_count, 2);
    assert!(resources[0].referencing_modules.contains(&"src/main.rs".to_string()));
    assert!(resources[0].referencing_modules.contains(&"src/utils.rs".to_string()));

    // src/only_a.rs should NOT be a public resource (only 1 reference)
    assert!(!resources.iter().any(|r| r.file_path == "src/only_a.rs"));
}





// =========================================================================
// Tree-sitter Integration Tests
// =========================================================================

#[test]
fn test_treesitter_ast_hash() {
    let bb = make_coordinator();
    let ts = bb.treesitter();

    // Same code should produce same AST hash
    let code = "fn main() { println!(\"hello\"); }";
    let h1 = ts.compute_ast_hash(code, "rust");
    let h2 = ts.compute_ast_hash(code, "rust");
    assert_eq!(h1, h2, "Same code should produce same AST hash");
    assert!(!h1.is_empty(), "AST hash should not be empty");

    // Formatting changes should not affect AST hash
    let code_compact = "fn main(){println!(\"hello\");}";
    let h_compact = ts.compute_ast_hash(code_compact, "rust");
    assert_eq!(h1, h_compact, "Formatting changes should not affect AST hash");

    // Semantic changes should produce different hash
    let code_different = "fn main() { println!(\"world\"); }\nfn foo() {}";
    let h_different = ts.compute_ast_hash(code_different, "rust");
    assert_ne!(h1, h_different, "Semantic changes should produce different hashes");
}

#[test]
fn test_treesitter_syntax_validation() {
    let bb = make_coordinator();
    let ts = bb.treesitter();

    // Valid Rust code should pass
    let valid_code = "fn main() { println!(\"hello\"); }";
    let result = ts.validate_syntax(valid_code, "rust", false);
    assert!(result.is_none(), "Valid Rust code should pass syntax validation");

    // Invalid Rust code should fail
    let invalid_code = "fn main( {";
    let result = ts.validate_syntax(invalid_code, "rust", false);
    assert!(result.is_some(), "Invalid Rust code should fail syntax validation");

    // Valid TypeScript code should pass
    let valid_ts = "function add(a: number, b: number): number { return a + b; }";
    let result = ts.validate_syntax(valid_ts, "typescript", false);
    assert!(result.is_none(), "Valid TypeScript should pass");
}

#[test]
fn test_treesitter_structural_diff() {
    let bb = make_coordinator();
    let ts = bb.treesitter();

    let old_code = "fn add(a: i32, b: i32) -> i32 { a + b }";
    let new_code = "fn add(a: i32, b: i32) -> i32 { a + b }\nfn multiply(a: i32, b: i32) -> i32 { a * b }";

    let diff = ts.generate_structural_diff(
        "src/math.rs",
        old_code,
        new_code,
        "rust",
        "agent-a",
    );

    assert_eq!(diff.file, "src/math.rs");
    assert_eq!(diff.agent_id, "agent-a");
    // Should detect the added `multiply` function
    assert!(!diff.changes.is_empty(), "Should detect structural changes");
    let has_added = diff.changes.iter().any(|c| c.symbol_name == "multiply");
    assert!(has_added, "Should detect added `multiply` function");
}

#[test]
fn test_treesitter_rename_detection() {
    let bb = make_coordinator();
    let ts = bb.treesitter();

    let old_exports = vec!["formatTime".to_string(), "getUser".to_string()];
    let new_exports = vec!["formatTimestamp".to_string(), "getUser".to_string()];

    let renames = ts.detect_renames(&old_exports, &new_exports, &[]);

    assert_eq!(renames.len(), 1, "Should detect exactly one rename");
    assert_eq!(renames[0].0, "formatTime", "Old name should be formatTime");
    assert_eq!(renames[0].1, "formatTimestamp", "New name should be formatTimestamp");

    // Test safety: already-renamed symbols should not be detected again
    let already_renamed = vec!["formatTime".to_string()];
    let renames_blocked = ts.detect_renames(&old_exports, &new_exports, &already_renamed);
    assert!(renames_blocked.is_empty(), "Should block double rename in same cycle");
}
