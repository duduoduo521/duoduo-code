//! Lifecycle tests for `FileLockManager`.
//!
//! The queue hand-off is the subtle part: releasing a lock transfers it to the
//! next waiter. That is only correct while every queued agent is still waiting
//! — an agent that gave up must remove itself, or it will be handed a lock it
//! never releases, blocking the file until the timeout reaper runs.

use blackboard_store::BlackboardStore;
use duo_types::{FileLockState, IntentDeclaration, IntentKind, LockAcquireResult};
use file_lock_manager::{FileLockConfig, FileLockManager};
use std::sync::Arc;

fn setup() -> (Arc<BlackboardStore>, FileLockManager) {
    let store = Arc::new(BlackboardStore::open_in_memory("lock-test").unwrap());
    let manager = FileLockManager::new(store.clone(), FileLockConfig::default());
    (store, manager)
}

/// Request write locks on `files` for `agent`.
async fn acquire(
    manager: &FileLockManager,
    agent: &str,
    files: &[&str],
) -> Vec<LockAcquireResult> {
    manager
        .acquire_locks(&IntentDeclaration {
            agent_id: agent.to_string(),
            files: files.iter().map(|f| f.to_string()).collect(),
            intent: IntentKind::Write,
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn first_acquirer_is_granted_and_second_is_queued() {
    let (_store, manager) = setup();

    let granted = acquire(&manager, "a1", &["a.rs"]).await;
    assert!(matches!(granted[0], LockAcquireResult::Granted { .. }));

    let queued = acquire(&manager, "a2", &["a.rs"]).await;
    match &queued[0] {
        LockAcquireResult::Queued { position, .. } => assert_eq!(*position, 1),
        other => panic!("expected Queued, got {:?}", other),
    }
}

#[tokio::test]
async fn releasing_hands_the_lock_to_the_next_waiter() {
    let (store, manager) = setup();

    acquire(&manager, "a1", &["a.rs"]).await;
    acquire(&manager, "a2", &["a.rs"]).await;
    manager.release_lock("a1", "a.rs").await.unwrap();

    match store.get_file_lock_state("a.rs").unwrap() {
        FileLockState::Locked { agent_id, .. } => assert_eq!(agent_id, "a2"),
        other => panic!("expected the lock to pass to a2, got {:?}", other),
    }
    assert!(manager.get_wait_queue("a.rs").await.is_empty());
}

/// An agent that gives up must be able to drop out of the queue, so the lock is
/// not later handed to it. Without this the file stays locked by an absent
/// agent until the timeout reaper reclaims it.
#[tokio::test]
async fn removed_waiter_is_not_granted_the_lock() {
    let (store, manager) = setup();

    acquire(&manager, "a1", &["a.rs"]).await;
    acquire(&manager, "a2", &["a.rs"]).await;

    manager.remove_from_queue("a.rs", "a2").await;
    assert!(manager.get_wait_queue("a.rs").await.is_empty());

    manager.release_lock("a1", "a.rs").await.unwrap();
    assert!(
        matches!(store.get_file_lock_state("a.rs").unwrap(), FileLockState::Unlocked),
        "the lock was handed to an agent that had already given up"
    );
}

#[tokio::test]
async fn same_agent_may_reacquire_its_own_lock() {
    let (_store, manager) = setup();

    acquire(&manager, "a1", &["a.rs"]).await;
    let again = acquire(&manager, "a1", &["a.rs"]).await;
    assert!(
        matches!(again[0], LockAcquireResult::Granted { .. }),
        "an agent must not deadlock against itself"
    );
}

#[tokio::test]
async fn releasing_a_lock_not_held_is_a_no_op() {
    let (store, manager) = setup();

    manager.release_lock("nobody", "a.rs").await.unwrap();
    assert!(matches!(store.get_file_lock_state("a.rs").unwrap(), FileLockState::Unlocked));

    // Releasing someone else's lock must not steal it.
    acquire(&manager, "a1", &["a.rs"]).await;
    manager.release_lock("a2", "a.rs").await.unwrap();
    match store.get_file_lock_state("a.rs").unwrap() {
        FileLockState::Locked { agent_id, .. } => assert_eq!(agent_id, "a1"),
        other => panic!("a1 should still hold the lock, got {:?}", other),
    }
}

#[tokio::test]
async fn locks_on_distinct_files_are_independent() {
    let (_store, manager) = setup();

    let a = acquire(&manager, "a1", &["a.rs"]).await;
    let b = acquire(&manager, "a2", &["b.rs"]).await;

    assert!(matches!(a[0], LockAcquireResult::Granted { .. }));
    assert!(matches!(b[0], LockAcquireResult::Granted { .. }));
}
