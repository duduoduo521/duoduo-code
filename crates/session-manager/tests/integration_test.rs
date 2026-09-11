//! Integration tests for session-manager.
//!
//! Covers: create_session, get_session, update_state, concurrent upsert,
//! delete_session, list_active, bind_pipeline, transaction boundary,
//! in-memory mode.
//!
//! ╔══════════════════════════════════════════════════════════════════════════╗
//! ║ Integration tests — now ENABLED (previously #[ignore]`d, fixed) ║
//! ╚══════════════════════════════════════════════════════════════════════════╝
//!
//! History: these tests were once `#[ignore]`d for a documented rusqlite
//! 0.31.0 constructor incompatibility. That incompatibility is no longer
//! present (the constructors build successfully), and the one genuine bug
//! uncovered here -- lost updates under concurrent `increment_message_count`
//! (a read-modify-write race) -- has been fixed in `manager.rs` by performing
//! the in-memory increment atomically under the session HashMap lock.
//!
//! The tests are now enabled (no `#[ignore]`) and pass.
//!
//! Run with: cargo test -p session-manager --test integration_test

use std::sync::Arc;
use std::thread;

use duo_types::SessionState;
use session_manager::SessionManager;

// ─── Helpers ───

/// Create a SessionManager using new_with_path() with a temporary file.
/// NOTE: This currently fails at construction due to rusqlite 0.31.0 bug.
/// When the crate is fixed, this helper will work.
fn make_manager() -> Arc<SessionManager> {
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("test-sessions.db");
    let db_path_str = db_path.to_str().unwrap().to_string();

    // Leak the TempDir so the file persists for the test duration
    std::mem::forget(tmp);

    Arc::new(SessionManager::new_with_path(&db_path_str).unwrap())
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Basic CRUD — create, get, update, delete
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_create_and_get_session() {
    let mgr = make_manager();

    let session = mgr.create_session("/project/test", None).unwrap();
    assert!(!session.id.is_empty());
    assert_eq!(session.project_id, "/project/test");
    assert_eq!(session.state, SessionState::Active);
    assert_eq!(session.message_count, 0);

    // Get by ID
    let fetched = mgr.get_session(&session.id).unwrap();
    assert!(fetched.is_some());
    assert_eq!(fetched.unwrap().id, session.id);
}

#[test]
fn integration_create_session_with_metadata() {
    let mgr = make_manager();

    let meta = serde_json::json!({"env": "test", "version": "1.0"});
    let session = mgr
        .create_session("/project/meta", Some(meta.clone()))
        .unwrap();
    assert_eq!(session.metadata, Some(meta));
}

#[test]
fn integration_get_nonexistent_session() {
    let mgr = make_manager();
    let result = mgr.get_session("nonexistent").unwrap();
    assert!(result.is_none());
}

#[test]
fn integration_update_state() {
    let mgr = make_manager();

    let session = mgr.create_session("/project/state", None).unwrap();

    // Active → Idle
    let updated = mgr.update_state(&session.id, SessionState::Idle).unwrap();
    assert!(updated);

    let fetched = mgr.get_session(&session.id).unwrap().unwrap();
    assert_eq!(fetched.state, SessionState::Idle);

    // Idle → Closed
    let updated2 = mgr.update_state(&session.id, SessionState::Closed).unwrap();
    assert!(updated2);

    let fetched2 = mgr.get_session(&session.id).unwrap().unwrap();
    assert_eq!(fetched2.state, SessionState::Closed);
}

#[test]
fn integration_update_state_nonexistent() {
    let mgr = make_manager();
    let updated = mgr
        .update_state("nonexistent", SessionState::Closed)
        .unwrap();
    assert!(!updated);
}

#[test]
fn integration_increment_message_count() {
    let mgr = make_manager();

    let session = mgr.create_session("/project/msg", None).unwrap();

    for _ in 0..5 {
        mgr.increment_message_count(&session.id).unwrap();
    }

    let fetched = mgr.get_session(&session.id).unwrap().unwrap();
    assert_eq!(fetched.message_count, 5);
}

#[test]
fn integration_increment_message_count_nonexistent() {
    let mgr = make_manager();
    let result = mgr.increment_message_count("nonexistent");
    assert!(result.is_err());
}

#[test]
fn integration_delete_session() {
    let mgr = make_manager();

    let session = mgr.create_session("/project/del", None).unwrap();
    let deleted = mgr.delete_session(&session.id).unwrap();
    assert!(deleted);

    let fetched = mgr.get_session(&session.id).unwrap();
    assert!(fetched.is_none());
}

#[test]
fn integration_delete_session_nonexistent() {
    let mgr = make_manager();
    let deleted = mgr.delete_session("nonexistent").unwrap();
    assert!(!deleted);
}

#[test]
fn integration_list_active() {
    let mgr = make_manager();

    let s1 = mgr.create_session("/project/1", None).unwrap();
    let s2 = mgr.create_session("/project/2", None).unwrap();
    let s3 = mgr.create_session("/project/3", None).unwrap();

    // Close one session
    mgr.update_state(&s2.id, SessionState::Closed).unwrap();

    let active = mgr.list_active().unwrap();
    assert_eq!(active.len(), 2);
    let active_ids: Vec<&str> = active.iter().map(|s| s.id.as_str()).collect();
    assert!(active_ids.contains(&s1.id.as_str()));
    assert!(active_ids.contains(&s3.id.as_str()));
}

#[test]
fn integration_bind_pipeline() {
    let mgr = make_manager();

    let session = mgr.create_session("/project/pipeline", None).unwrap();

    let bound = mgr.bind_pipeline(&session.id, "pipeline-123").unwrap();
    assert!(bound);

    let fetched = mgr.get_session(&session.id).unwrap().unwrap();
    assert_eq!(fetched.pipeline_id, Some("pipeline-123".to_string()));
}

#[test]
fn integration_bind_pipeline_nonexistent() {
    let mgr = make_manager();
    let bound = mgr.bind_pipeline("nonexistent", "pipeline-123").unwrap();
    assert!(!bound);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Concurrent Read/Write — concurrent upsert
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_concurrent_create_sessions() {
    let mgr = make_manager();
    let num_threads = 8;
    let sessions_per_thread = 25;

    let mut handles = Vec::new();
    for t in 0..num_threads {
        let m = Arc::clone(&mgr);
        handles.push(thread::spawn(move || {
            let mut ids = Vec::new();
            for i in 0..sessions_per_thread {
                let s = m
                    .create_session(&format!("/project/t{}-{}", t, i), None)
                    .unwrap();
                ids.push(s.id);
            }
            ids
        }));
    }

    let mut all_ids = Vec::new();
    for h in handles {
        let ids = h.join().unwrap();
        all_ids.extend(ids);
    }

    assert_eq!(all_ids.len(), num_threads * sessions_per_thread);

    // All IDs should be unique
    let unique: std::collections::HashSet<String> = all_ids.into_iter().collect();
    assert_eq!(unique.len(), num_threads * sessions_per_thread);
}

#[test]
fn integration_concurrent_upsert_same_session() {
    let mgr = make_manager();

    let session = mgr
        .create_session("/project/concurrent-upsert", None)
        .unwrap();
    let session_id = session.id;

    let num_threads = 8;
    let increments_per_thread = 50;

    let mut handles = Vec::new();
    for _ in 0..num_threads {
        let m = Arc::clone(&mgr);
        let sid = session_id.clone();
        handles.push(thread::spawn(move || {
            for _ in 0..increments_per_thread {
                m.increment_message_count(&sid).unwrap();
            }
        }));
    }

    for h in handles {
        h.join().unwrap();
    }

    let fetched = mgr.get_session(&session_id).unwrap().unwrap();
    assert_eq!(
        fetched.message_count,
        (num_threads * increments_per_thread) as u64,
        "All concurrent increments should be counted"
    );
}

#[test]
fn integration_concurrent_read_while_creating() {
    let mgr = make_manager();

    // Pre-create one session
    let pre = mgr.create_session("/project/pre", None).unwrap();

    let m_write = Arc::clone(&mgr);
    let m_read = Arc::clone(&mgr);
    let pre_id = pre.id.clone();

    let writer = thread::spawn(move || {
        for i in 0..50 {
            m_write
                .create_session(&format!("/project/concurrent-{}", i), None)
                .unwrap();
        }
    });

    let reader = thread::spawn(move || {
        for _ in 0..50 {
            let _ = m_read.get_session(&pre_id).unwrap();
            let _ = m_read.list_active().unwrap();
        }
    });

    writer.join().unwrap();
    reader.join().unwrap();
}

#[test]
fn integration_concurrent_update_state() {
    let mgr = make_manager();

    let session = mgr
        .create_session("/project/state-concurrent", None)
        .unwrap();
    let session_id = session.id;

    let num_threads = 8;
    let mut handles = Vec::new();
    for _ in 0..num_threads {
        let m = Arc::clone(&mgr);
        let sid = session_id.clone();
        handles.push(thread::spawn(move || {
            // Alternate between states
            m.update_state(&sid, SessionState::Idle).unwrap();
            m.update_state(&sid, SessionState::Active).unwrap();
        }));
    }

    for h in handles {
        h.join().unwrap();
    }

    // Session should still exist and be in a valid state
    let fetched = mgr.get_session(&session_id).unwrap();
    assert!(fetched.is_some());
    let s = fetched.unwrap();
    assert!(s.state == SessionState::Active || s.state == SessionState::Idle);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Transaction Boundary
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_transaction_create_persists_to_sqlite() {
    let mgr = make_manager();

    let session = mgr.create_session("/project/tx-test", None).unwrap();

    // Verify it's in the in-memory cache
    let fetched = mgr.get_session(&session.id).unwrap();
    assert!(fetched.is_some());

    // Update and verify persistence
    mgr.update_state(&session.id, SessionState::Closed).unwrap();
    let fetched2 = mgr.get_session(&session.id).unwrap().unwrap();
    assert_eq!(fetched2.state, SessionState::Closed);
}

#[test]
fn integration_transaction_delete_cleans_up() {
    let mgr = make_manager();

    let session = mgr.create_session("/project/tx-del", None).unwrap();

    // Delete should remove from both cache and SQLite
    mgr.delete_session(&session.id).unwrap();

    // Verify it's gone from cache
    let fetched = mgr.get_session(&session.id).unwrap();
    assert!(fetched.is_none());

    // Verify it doesn't appear in active list
    let active = mgr.list_active().unwrap();
    assert!(active.iter().all(|s| s.id != session.id));
}

#[test]
fn integration_transaction_increment_persists_across_state_update() {
    let mgr = make_manager();

    let session = mgr.create_session("/project/tx-incr", None).unwrap();

    // Increment then update state — both should persist
    mgr.increment_message_count(&session.id).unwrap();
    mgr.increment_message_count(&session.id).unwrap();
    mgr.update_state(&session.id, SessionState::Idle).unwrap();

    let fetched = mgr.get_session(&session.id).unwrap().unwrap();
    assert_eq!(fetched.message_count, 2);
    assert_eq!(fetched.state, SessionState::Idle);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. In-Memory Mode (using temp file as substitute)
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_in_memory_basic_workflow() {
    let mgr = make_manager();

    // Full lifecycle
    let session = mgr.create_session("/project/lifecycle", None).unwrap();
    let id = session.id.clone();

    assert_eq!(session.state, SessionState::Active);

    mgr.increment_message_count(&id).unwrap();
    mgr.increment_message_count(&id).unwrap();
    mgr.update_state(&id, SessionState::Idle).unwrap();
    mgr.bind_pipeline(&id, "pipe-1").unwrap();

    let fetched = mgr.get_session(&id).unwrap().unwrap();
    assert_eq!(fetched.message_count, 2);
    assert_eq!(fetched.state, SessionState::Idle);
    assert_eq!(fetched.pipeline_id, Some("pipe-1".to_string()));

    mgr.delete_session(&id).unwrap();
    assert!(mgr.get_session(&id).unwrap().is_none());
}

#[test]
fn integration_in_memory_multiple_sessions() {
    let mgr = make_manager();

    let mut ids = Vec::new();
    for i in 0..5 {
        let s = mgr
            .create_session(&format!("/project/multi-{}", i), None)
            .unwrap();
        ids.push(s.id);
    }

    let active = mgr.list_active().unwrap();
    assert_eq!(active.len(), 5);

    // Delete some
    mgr.delete_session(&ids[0]).unwrap();
    mgr.delete_session(&ids[2]).unwrap();

    let active2 = mgr.list_active().unwrap();
    assert_eq!(active2.len(), 3);
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_session_updated_at_changes_on_mutation() {
    let mgr = make_manager();

    let session = mgr.create_session("/project/timestamp", None).unwrap();
    let original_updated_at = session.time_updated;

    // Small sleep to ensure timestamp differs
    std::thread::sleep(std::time::Duration::from_millis(10));

    mgr.increment_message_count(&session.id).unwrap();
    let fetched = mgr.get_session(&session.id).unwrap().unwrap();
    assert_ne!(
        fetched.time_updated, original_updated_at,
        "time_updated should change after mutation"
    );
}

#[test]
fn integration_session_state_transitions() {
    let mgr = make_manager();

    let session = mgr.create_session("/project/transitions", None).unwrap();

    // Active → Idle → Closed (normal lifecycle)
    mgr.update_state(&session.id, SessionState::Idle).unwrap();
    mgr.update_state(&session.id, SessionState::Closed).unwrap();

    let fetched = mgr.get_session(&session.id).unwrap().unwrap();
    assert_eq!(fetched.state, SessionState::Closed);

    // Closed session should not appear in active list
    let active = mgr.list_active().unwrap();
    assert!(active.iter().all(|s| s.id != session.id));
}
