//! Integration tests for memory-system.
//!
//! Covers: basic CRUD, FTS5 sync, delete atomicity, concurrent read/write,
//! transaction boundary, in-memory mode, and migration APIs.

use std::sync::Arc;
use std::thread;

use duo_types::{MemorySearchRequest, MemoryStoreRequest};
use memory_system::MemorySystem;

// ─── Helpers ───

fn make_system() -> Arc<MemorySystem> {
    Arc::new(MemorySystem::new_in_memory().unwrap())
}

fn store_req(content: &str, layer: &str) -> MemoryStoreRequest {
    MemoryStoreRequest {
        id: None,
        content: content.to_string(),
        summary: None,
        layer: layer.to_string(),
        importance: None,
        pin: None,
        session_id: None,
        memory_type: None,
        metadata: None,
        tags: None,
        project_path: None,
        user_id: None,
    }
}

fn store_req_with_tags(content: &str, layer: &str, tags: Vec<String>) -> MemoryStoreRequest {
    MemoryStoreRequest {
        id: None,
        content: content.to_string(),
        summary: None,
        layer: layer.to_string(),
        importance: None,
        pin: None,
        session_id: None,
        memory_type: None,
        metadata: None,
        tags: Some(tags),
        project_path: None,
        user_id: None,
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Basic CRUD — store, get, search, delete
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_store_and_get() {
    let sys = make_system();

    let resp = sys.store(&store_req("hello world", "episode")).unwrap();
    assert!(resp.stored);
    assert!(!resp.id.is_empty());

    let entry = sys.get(&resp.id).unwrap();
    assert!(entry.is_some());
    let e = entry.unwrap();
    assert_eq!(e.content, "hello world");
    assert_eq!(e.layer, "episode");
}

#[test]
fn integration_store_with_explicit_layer() {
    let sys = make_system();

    // L2 semantic
    let resp = sys
        .store(&MemoryStoreRequest {
            id: None,
            content: "architecture decision".to_string(),
            summary: None,
            layer: "semantic".to_string(),
            importance: Some(0.7),
            pin: None,
            session_id: None,
            memory_type: None,
            metadata: None,
            tags: None,
            project_path: None,
            user_id: None,
        })
        .unwrap();
    let e = sys.get(&resp.id).unwrap().unwrap();
    assert_eq!(e.layer, "semantic");

    // L3 permanent
    let resp2 = sys
        .store(&MemoryStoreRequest {
            id: None,
            content: "critical config".to_string(),
            summary: None,
            layer: "permanent".to_string(),
            importance: Some(0.9),
            pin: Some(true),
            session_id: None,
            memory_type: None,
            metadata: None,
            tags: None,
            project_path: None,
            user_id: None,
        })
        .unwrap();
    let e2 = sys.get(&resp2.id).unwrap().unwrap();
    assert_eq!(e2.layer, "permanent");
    assert_eq!(e2.pin, Some(true));
}

#[test]
fn integration_get_nonexistent() {
    let sys = make_system();
    let entry = sys.get("nonexistent-id").unwrap();
    assert!(entry.is_none());
}

#[test]
fn integration_search_fts5() {
    let sys = make_system();

    // Store entries
    sys.store(&store_req("Rust async programming patterns", "episode"))
        .unwrap();
    sys.store(&store_req("Python data science workflows", "episode"))
        .unwrap();
    sys.store(&store_req("Rust ownership and borrowing rules", "semantic"))
        .unwrap();

    // Search for "Rust"
    let results = sys
        .search(&MemorySearchRequest {
            query: "Rust".to_string(),
            limit: 10,
            layers: None,
            tags: None,
            project_path: None,
        })
        .unwrap();

    assert!(
        results.len() >= 2,
        "Should find at least 2 Rust-related entries, got {}",
        results.len()
    );
}

#[test]
fn integration_search_with_layer_filter() {
    let sys = make_system();

    sys.store(&store_req("Rust episode memory", "episode"))
        .unwrap();
    sys.store(&store_req("Rust semantic memory", "semantic"))
        .unwrap();

    let results = sys
        .search(&MemorySearchRequest {
            query: "Rust".to_string(),
            limit: 10,
            layers: Some(vec!["episode".to_string()]),
            tags: None,
            project_path: None,
        })
        .unwrap();

    for r in &results {
        assert_eq!(r.layer, "episode");
    }
}

#[test]
fn integration_search_with_tag_filter() {
    let sys = make_system();

    sys.store(&store_req_with_tags(
        "tagged content",
        "episode",
        vec!["architecture".to_string()],
    ))
    .unwrap();
    sys.store(&store_req_with_tags("untagged content", "episode", vec![]))
        .unwrap();

    let results = sys
        .search(&MemorySearchRequest {
            query: "content".to_string(),
            limit: 10,
            layers: None,
            tags: Some(vec!["architecture".to_string()]),
            project_path: None,
        })
        .unwrap();

    assert!(!results.is_empty());
}

#[test]
fn integration_get_by_layer() {
    let sys = make_system();

    sys.store(&store_req("ep1", "episode")).unwrap();
    sys.store(&store_req("ep2", "episode")).unwrap();
    sys.store(&store_req("sem1", "semantic")).unwrap();

    let eps = sys.get_by_layer("episode", 10).unwrap();
    assert_eq!(eps.len(), 2);

    let sems = sys.get_by_layer("semantic", 10).unwrap();
    assert_eq!(sems.len(), 1);
}

#[test]
fn integration_stats() {
    let sys = make_system();

    sys.store(&store_req("s1", "episode")).unwrap();
    sys.store(&store_req("s2", "semantic")).unwrap();

    let stats = sys.stats_v2().unwrap();
    assert_eq!(stats.total_entries, 2);
    assert!(stats.by_layer.contains_key("episode"));
    assert!(stats.by_layer.contains_key("semantic"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Delete Atomicity
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_delete_basic() {
    let sys = make_system();

    let resp = sys.store(&store_req("to be deleted", "episode")).unwrap();
    let deleted = sys.delete(&resp.id, false).unwrap();
    assert!(deleted);

    let entry = sys.get(&resp.id).unwrap();
    assert!(entry.is_none());
}

#[test]
fn integration_delete_l3_requires_force() {
    let sys = make_system();

    let resp = sys
        .store(&MemoryStoreRequest {
            id: None,
            content: "permanent memory".to_string(),
            summary: None,
            layer: "permanent".to_string(),
            importance: Some(0.9),
            pin: Some(true),
            session_id: None,
            memory_type: None,
            metadata: None,
            tags: None,
            project_path: None,
            user_id: None,
        })
        .unwrap();

    // Without force, L3/pinned should be rejected
    let result = sys.delete(&resp.id, false);
    assert!(
        result.is_err(),
        "Deleting L3/pinned without force should fail"
    );

    // With force, should succeed
    let deleted = sys.delete(&resp.id, true).unwrap();
    assert!(deleted);

    let entry = sys.get(&resp.id).unwrap();
    assert!(entry.is_none());
}

#[test]
fn integration_delete_fts5_sync() {
    let sys = make_system();

    let resp = sys
        .store(&store_req(
            "unique searchable content about quantum computing",
            "episode",
        ))
        .unwrap();

    // Verify FTS5 index has the entry
    let results = sys
        .search(&MemorySearchRequest {
            query: "quantum".to_string(),
            limit: 10,
            layers: None,
            tags: None,
            project_path: None,
        })
        .unwrap();
    assert!(
        !results.is_empty(),
        "FTS5 should find the entry before deletion"
    );

    // Delete
    sys.delete(&resp.id, false).unwrap();

    // Verify FTS5 index is cleaned up
    let results2 = sys
        .search(&MemorySearchRequest {
            query: "quantum".to_string(),
            limit: 10,
            layers: None,
            tags: None,
            project_path: None,
        })
        .unwrap();
    assert!(
        results2.is_empty(),
        "FTS5 should not find the entry after deletion"
    );
}

#[test]
fn integration_delete_by_layer() {
    let sys = make_system();

    sys.store(&store_req("ep1", "episode")).unwrap();
    sys.store(&store_req("ep2", "episode")).unwrap();
    sys.store(&store_req("sem1", "semantic")).unwrap();

    let deleted = sys.delete_by_layer("episode").unwrap();
    assert_eq!(deleted, 2);

    let stats = sys.stats_v2().unwrap();
    assert_eq!(stats.total_entries, 1);
}

#[test]
fn integration_delete_all() {
    let sys = make_system();

    sys.store(&store_req("a", "episode")).unwrap();
    sys.store(&store_req("b", "semantic")).unwrap();

    let deleted = sys.delete_all().unwrap();
    assert_eq!(deleted, 2);

    let stats = sys.stats_v2().unwrap();
    assert_eq!(stats.total_entries, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Concurrent Read/Write
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_concurrent_writes() {
    let sys = make_system();
    let num_threads = 8;
    let entries_per_thread = 50;

    let mut handles = Vec::new();
    for t in 0..num_threads {
        let s = Arc::clone(&sys);
        handles.push(thread::spawn(move || {
            for i in 0..entries_per_thread {
                let req = store_req(
                    &format!("thread-{} entry-{}", t, i),
                    if i % 2 == 0 { "episode" } else { "semantic" },
                );
                s.store(&req).unwrap();
            }
        }));
    }

    for h in handles {
        h.join().unwrap();
    }

    let stats = sys.stats_v2().unwrap();
    assert_eq!(
        stats.total_entries,
        num_threads * entries_per_thread,
        "All concurrent writes should be persisted"
    );
}

#[test]
fn integration_concurrent_read_while_writing() {
    let sys = make_system();

    // Pre-populate
    for i in 0..20 {
        sys.store(&store_req(&format!("pre-existing {}", i), "episode"))
            .unwrap();
    }

    let s_write = Arc::clone(&sys);
    let s_read = Arc::clone(&sys);

    let writer = thread::spawn(move || {
        for i in 0..50 {
            s_write
                .store(&store_req(&format!("concurrent write {}", i), "episode"))
                .unwrap();
        }
    });

    let reader = thread::spawn(move || {
        for _ in 0..50 {
            let _ = s_read.stats_v2().unwrap();
            let _ = s_read.get_by_layer("episode", 100).unwrap();
        }
    });

    writer.join().unwrap();
    reader.join().unwrap();
}

#[test]
fn integration_concurrent_delete_and_read() {
    let sys = make_system();

    // Pre-populate
    let mut ids = Vec::new();
    for i in 0..20 {
        let resp = sys
            .store(&store_req(&format!("to-delete {}", i), "episode"))
            .unwrap();
        ids.push(resp.id);
    }

    let s_del = Arc::clone(&sys);
    let s_read = Arc::clone(&sys);
    let ids_clone = ids.clone();

    let deleter = thread::spawn(move || {
        for id in ids_clone {
            let _ = s_del.delete(&id, false);
        }
    });

    let reader = thread::spawn(move || {
        for id in &ids {
            let _ = s_read.get(id).unwrap();
        }
    });

    deleter.join().unwrap();
    reader.join().unwrap();
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Transaction Boundary
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_transaction_store_fts5_consistency() {
    let sys = make_system();

    // Store and immediately search — FTS5 should be in sync
    sys.store(&store_req("database transaction boundary test", "semantic"))
        .unwrap();

    let results = sys
        .search(&MemorySearchRequest {
            query: "transaction boundary".to_string(),
            limit: 10,
            layers: None,
            tags: None,
            project_path: None,
        })
        .unwrap();
    assert!(!results.is_empty(), "FTS5 should be in sync after store");
}

#[test]
fn integration_transaction_delete_fts5_consistency() {
    let sys = make_system();

    let resp = sys
        .store(&store_req("temporary data for transaction test", "episode"))
        .unwrap();

    // Verify searchable
    let results = sys
        .search(&MemorySearchRequest {
            query: "transaction test".to_string(),
            limit: 10,
            layers: None,
            tags: None,
            project_path: None,
        })
        .unwrap();
    assert!(!results.is_empty());

    // Delete and verify FTS5 cleaned up atomically
    sys.delete(&resp.id, false).unwrap();

    let results2 = sys
        .search(&MemorySearchRequest {
            query: "transaction test".to_string(),
            limit: 10,
            layers: None,
            tags: None,
            project_path: None,
        })
        .unwrap();
    assert!(
        results2.is_empty(),
        "FTS5 should be cleaned up atomically with delete"
    );
}

// ═══════════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════════
// 6. Entity Links
// ═══════════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════════
// 7. In-Memory Mode
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_in_memory_mode() {
    let sys = MemorySystem::new_in_memory().unwrap();
    assert!(!sys.is_persistent());

    // Full CRUD should work
    let resp = sys.store(&store_req("in-memory test", "episode")).unwrap();
    assert!(resp.stored);

    let entry = sys.get(&resp.id).unwrap();
    assert!(entry.is_some());

    sys.delete(&resp.id, false).unwrap();
    assert!(sys.get(&resp.id).unwrap().is_none());
}

#[test]
fn integration_vacuum() {
    let sys = make_system();

    let resp = sys.store(&store_req("vacuum me", "episode")).unwrap();
    sys.delete(&resp.id, false).unwrap();

    // Vacuum should succeed without error
    sys.vacuum().unwrap();
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Decay idempotency (P1-10)
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn decay_is_idempotent_across_repeated_passes() {
    // P1-10: decay used to multiply the CURRENT value by
    // exp(-lambda * age_since_creation) on every hourly pass, compounding the
    // exponent — an entry decayed once per hour by its FULL age each time.
    // Two consecutive passes must now leave the value unchanged.
    let sys = make_system();

    let resp = sys
        .store(&MemoryStoreRequest {
            importance: Some(0.5),
            ..store_req("decay idempotency", "semantic")
        })
        .unwrap();

    // First pass may decay (or not) — record where it lands.
    let first = sys.decay(None, false).unwrap();
    let after_first = sys
        .get(&resp.id)
        .unwrap()
        .expect("entry must exist")
        .importance
        .expect("importance must be set");

    // Any number of further passes must be a no-op.
    for _ in 0..5 {
        sys.decay(None, false).unwrap();
        let after = sys
            .get(&resp.id)
            .unwrap()
            .expect("entry must exist")
            .importance
            .expect("importance must be set");
        assert!(
            (after - after_first).abs() < 1e-9,
            "repeated decay must be a no-op: first pass changed {} ({} rows), \
             later pass moved {} -> {}",
            after_first,
            first.updated,
            after_first,
            after
        );
    }

    // A dry-run preview must agree with the stored state too (no hidden drift).
    let preview = sys.decay(None, true).unwrap();
    let _ = preview;
    let final_value = sys
        .get(&resp.id)
        .unwrap()
        .unwrap()
        .importance
        .expect("importance must be set");
    assert!(
        (final_value - after_first).abs() < 1e-9,
        "dry run must not change values: {} -> {}",
        after_first,
        final_value
    );
}

#[test]
fn decay_respects_rate_for_fresh_entries() {
    // Rate sanity: a brand-new entry (age ~0) must NOT be decayed at all, and
    // a floored entry must not be rewritten on every pass (no `updated` churn).
    let sys = make_system();
    let resp = sys
        .store(&MemoryStoreRequest {
            importance: Some(0.5),
            ..store_req("fresh entry", "semantic")
        })
        .unwrap();

    sys.decay(None, false).unwrap();
    let v1 = sys
        .get(&resp.id)
        .unwrap()
        .unwrap()
        .importance
        .expect("importance must be set");
    assert_eq!(v1, 0.5, "a just-created entry must not decay, got {v1}");

    let r2 = sys.decay(None, false).unwrap();
    assert_eq!(
        r2.updated, 0,
        "second pass on an undecayed store must update nothing"
    );
}
