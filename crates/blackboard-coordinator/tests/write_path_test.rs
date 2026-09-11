//! Regression tests for `submit_stable_with_write` — the single write path
//! used in production (`agent-executor`'s `edit_file`/`write_file`).
//!
//! This path was previously untested end-to-end, which let several lock
//! lifetime bugs survive. Every test here pins an invariant that was observed
//! to be broken:
//!
//! * a failed edit must not strand the file lock;
//! * an agent that gives up after being queued must not be handed the lock;
//! * concurrent writers to distinct files must not interfere;
//! * the success path must release exactly once.

use blackboard_coordinator::coordinator::{
    BlackboardConfig, BlackboardCoordinator, StableSubmitResult, StableWriteSubmission,
};
use blackboard_store::BlackboardStore;
use duo_types::{IntentDeclaration, IntentKind};
use std::sync::Arc;

/// Build an isolated coordinator (in-memory DB) plus a scratch workspace dir.
fn setup(tag: &str) -> (Arc<BlackboardCoordinator>, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("bb_wp_{}_{}", tag, uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let store = Arc::new(BlackboardStore::open_in_memory("write-path-test").unwrap());
    let bb = BlackboardCoordinator::from_store(store, BlackboardConfig::default()).unwrap();
    (Arc::new(bb), root)
}

fn grant_full_scope(bb: &BlackboardCoordinator, agent: &str) {
    bb.register_agent_scope(agent, &["*".to_string()]).unwrap();
}

/// Convenience wrapper mirroring how `agent-executor` calls the write path.
async fn edit(
    bb: &BlackboardCoordinator,
    agent: &str,
    root: &std::path::Path,
    file: &str,
    old: &str,
    new: &str,
) -> StableSubmitResult {
    bb.submit_stable_with_write(StableWriteSubmission {
        agent_id: agent,
        file_path: file,
        old_text: old,
        new_text: new,
        project_path: Some(root),
        pipeline_id: None,
        enable_format: false,
        format_callback: None,
        skip_syntax_check: true,
    })
    .await
    .unwrap()
}

/// A failed edit (`old_text` absent — the most common LLM mistake) must release
/// the lock. Previously it returned early and stranded the lock for the full
/// 300s TTL.
#[tokio::test]
async fn failed_edit_does_not_strand_the_lock() {
    let (bb, root) = setup("fail");
    let file = "a.rs";
    std::fs::write(root.join(file), "fn a() {}\n").unwrap();
    grant_full_scope(&bb, "a1");

    let result = edit(&bb, "a1", &root, file, "TEXT_THAT_IS_NOT_THERE", "x").await;

    assert!(
        matches!(result, StableSubmitResult::Conflict { .. }),
        "expected a Conflict, got {:?}",
        result
    );
    assert!(
        bb.store().get_all_locks().unwrap().is_empty(),
        "the failed edit leaked its file lock"
    );
}

/// The lock released by a failed edit must be immediately usable by others.
#[tokio::test]
async fn other_agents_are_not_blocked_by_a_failed_edit() {
    let (bb, root) = setup("unblock");
    let file = "a.rs";
    std::fs::write(root.join(file), "fn a() {}\n").unwrap();
    grant_full_scope(&bb, "a1");
    grant_full_scope(&bb, "a2");

    let _ = edit(&bb, "a1", &root, file, "TEXT_THAT_IS_NOT_THERE", "x").await;
    let result = edit(&bb, "a2", &root, file, "fn a() {}", "fn a() { ok(); }").await;

    assert!(
        matches!(result, StableSubmitResult::Success { .. }),
        "a2 was blocked by a1's stranded lock: {:?}",
        result
    );
    assert!(std::fs::read_to_string(root.join(file)).unwrap().contains("ok()"));
}

/// An agent that receives `QueuedForSerial` abandons the request, so it must
/// leave no queue entry behind. A stale entry would cause the holder's release
/// to hand the lock to an agent that never returns to release it.
#[tokio::test]
async fn abandoned_writer_leaves_no_ghost_in_the_queue() {
    let (bb, root) = setup("ghost");
    let file = "a.rs";
    std::fs::write(root.join(file), "fn a() {}\nfn b() {}\n").unwrap();
    grant_full_scope(&bb, "a1");
    grant_full_scope(&bb, "a2");

    // a1 takes the lock and keeps it.
    bb.declare_intent(&IntentDeclaration {
        agent_id: "a1".into(),
        files: vec![file.to_string()],
        intent: IntentKind::Write,
    })
    .await
    .unwrap();

    let result = edit(&bb, "a2", &root, file, "fn b() {}", "fn b() { B(); }").await;
    assert!(matches!(result, StableSubmitResult::QueuedForSerial));
    assert!(
        bb.lock_manager().get_wait_queue(file).await.is_empty(),
        "the abandoning agent left a ghost queue entry"
    );

    // a1 releases: the lock must be free, not transferred to the ghost.
    bb.lock_manager().release_lock("a1", file).await.unwrap();
    assert!(
        bb.store().get_all_locks().unwrap().is_empty(),
        "the lock was granted to an agent that had already given up"
    );
}

/// The success path releases the lock exactly once and persists the edit.
#[tokio::test]
async fn successful_edit_releases_the_lock_and_persists() {
    let (bb, root) = setup("ok");
    let file = "a.rs";
    std::fs::write(root.join(file), "fn a() {}\n").unwrap();
    grant_full_scope(&bb, "a1");

    let result = edit(&bb, "a1", &root, file, "fn a() {}", "fn a() { ok(); }").await;

    assert!(matches!(result, StableSubmitResult::Success { .. }));
    assert!(bb.store().get_all_locks().unwrap().is_empty());
    assert!(std::fs::read_to_string(root.join(file)).unwrap().contains("ok()"));
}

/// Writers touching distinct files must all succeed and leave no locks behind.
#[tokio::test]
async fn concurrent_writes_to_distinct_files_all_succeed() {
    let (bb, root) = setup("par");
    for name in ["a.rs", "b.rs", "c.rs"] {
        std::fs::write(root.join(name), format!("fn {}() {{}}\n", &name[..1])).unwrap();
        grant_full_scope(&bb, name);
    }

    let mut handles = Vec::new();
    for name in ["a.rs", "b.rs", "c.rs"] {
        let bb = bb.clone();
        let root = root.clone();
        handles.push(tokio::spawn(async move {
            let letter = &name[..1];
            edit(
                &bb,
                name,
                &root,
                name,
                &format!("fn {}() {{}}", letter),
                &format!("fn {}() {{ done(); }}", letter),
            )
            .await
        }));
    }

    for handle in handles {
        let result = handle.await.unwrap();
        assert!(
            matches!(result, StableSubmitResult::Success { .. }),
            "a disjoint-file write failed: {:?}",
            result
        );
    }
    assert!(bb.store().get_all_locks().unwrap().is_empty());
    for name in ["a.rs", "b.rs", "c.rs"] {
        assert!(std::fs::read_to_string(root.join(name)).unwrap().contains("done()"));
    }
}

/// Exactly one of two racing writers may win; the loser must be told to retry
/// rather than silently overwriting. Neither may strand a lock.
#[tokio::test]
async fn racing_writers_on_one_file_leave_no_locks() {
    let (bb, root) = setup("race");
    let file = "a.rs";
    std::fs::write(root.join(file), "fn a() {}\nfn b() {}\n").unwrap();
    grant_full_scope(&bb, "a1");
    grant_full_scope(&bb, "a2");

    let (bb1, bb2) = (bb.clone(), bb.clone());
    let (r1, r2) = (root.clone(), root.clone());
    let h1 = tokio::spawn(async move {
        edit(&bb1, "a1", &r1, "a.rs", "fn a() {}", "fn a() { A(); }").await
    });
    let h2 = tokio::spawn(async move {
        edit(&bb2, "a2", &r2, "a.rs", "fn b() {}", "fn b() { B(); }").await
    });
    let results = [h1.await.unwrap(), h2.await.unwrap()];

    let wins = results
        .iter()
        .filter(|r| matches!(r, StableSubmitResult::Success { .. }))
        .count();
    assert!(wins >= 1, "no writer succeeded: {:?}", results);
    assert!(
        bb.store().get_all_locks().unwrap().is_empty(),
        "a racing writer stranded a lock: {:?}",
        bb.store().get_all_locks().unwrap()
    );
}

/// With no scope registered anywhere (single-agent mode) writes are allowed;
/// once any scope exists, an agent without one is rejected. The pre-check in
/// `submit_stable_with_write` and the check inside `submit_stable` must agree,
/// otherwise a write could pass the pre-check, hit the disk, then be rejected.
#[tokio::test]
async fn no_scope_semantics_are_consistent() {
    // Single-agent mode: no scope registered at all → allowed.
    let (bb, root) = setup("noscope");
    std::fs::write(root.join("a.rs"), "fn a() {}\n").unwrap();
    let result = edit(&bb, "solo", &root, "a.rs", "fn a() {}", "fn a() { ok(); }").await;
    assert!(
        matches!(result, StableSubmitResult::Success { .. }),
        "single-agent mode must not require a scope: {:?}",
        result
    );
    assert!(bb.store().get_all_locks().unwrap().is_empty());

    // Multi-agent mode: some scope exists → an agent without one is rejected.
    let (bb2, root2) = setup("noscope2");
    std::fs::write(root2.join("a.rs"), "fn a() {}\n").unwrap();
    grant_full_scope(&bb2, "someone_else");
    let result = edit(&bb2, "stranger", &root2, "a.rs", "fn a() {}", "fn a() { ok(); }").await;
    assert!(
        matches!(result, StableSubmitResult::OutOfScope { .. }),
        "an unscoped agent must be rejected once scopes are in use: {:?}",
        result
    );
    assert!(
        bb2.store().get_all_locks().unwrap().is_empty(),
        "the rejected write stranded a lock"
    );
}
