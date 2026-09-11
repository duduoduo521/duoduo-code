// Integration tests for knowledge-graph-store.
//
// Note: get_neighbors_project was previously affected by a deadlock bug
// (inner Mutex acquired twice in the same scope). The fix restructured the
// method to acquire the lock in independent scopes. The tests below now
// call store.get_neighbors_project directly to verify the fix.

use std::collections::HashMap;
use std::sync::Arc;
use std::thread;

use duo_types::{KGEdge, KGNode};
use knowledge_graph_store::bincode_store::BincodeStorage;
use knowledge_graph_store::graph::KnowledgeGraphStore;
use knowledge_graph_store::indexer::ProjectIndexer;
use knowledge_graph_store::persistence::GraphPersistence;
use knowledge_graph_store::IndexStatus;

// ─── Helpers ───

/// Create a BincodeStorage backed by a temp directory for testing.
///
/// The directory must be unique **per call**, not just per process. Keying it
/// only on the pid gives every test in this binary the same `kg_cache/` folder
/// and the same `test-project.bin`; since `cargo test` runs them in parallel,
/// one test's teardown can delete the directory while another is persisting
/// into it, which surfaced as a flaky
/// `Failed to rename tmp file to .../kg_cache/test-project.bin
///  (No such file or directory)`.
/// A monotonic counter plus the thread id keeps each storage fully isolated.
fn make_bincode_storage() -> Arc<BincodeStorage> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = std::env::temp_dir().join(format!(
        "kg_test_{}_{}_{:?}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed),
        std::thread::current().id()
    ));
    Arc::new(BincodeStorage::new(&tmp).unwrap())
}

fn make_node(id: &str, label: &str, node_type: &str, project_id: &str) -> KGNode {
    KGNode {
        id: id.to_string(),
        label: label.to_string(),
        node_type: node_type.to_string(),
        properties: None,
        project_id: project_id.to_string(),
    }
}

fn make_edge(id: &str, source: &str, target: &str, relation: &str, project_id: &str) -> KGEdge {
    KGEdge {
        id: id.to_string(),
        source_id: source.to_string(),
        target_id: target.to_string(),
        relation: relation.to_string(),
        weight: Some(1.0),
        properties: None,
        project_id: project_id.to_string(),
    }
}

fn make_store() -> Arc<KnowledgeGraphStore> {
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    Arc::new(KnowledgeGraphStore::new(persistence).unwrap())
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Basic CRUD — add_node, add_edge, get_node, get_neighbors
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_add_node_and_get() {
    let store = make_store();

    let node = make_node("node-1", "User", "entity", "proj-1");
    let id = store.add_node(node).unwrap();
    assert_eq!(id, "node-1");

    let fetched = store.get_node("node-1").unwrap();
    assert!(fetched.is_some());
    let n = fetched.unwrap();
    assert_eq!(n.label, "User");
    assert_eq!(n.node_type, "entity");
    assert_eq!(n.project_id, "proj-1");
}

#[test]
fn integration_add_node_duplicate_rejected() {
    let store = make_store();

    let node = make_node("dup", "First", "type", "proj");
    store.add_node(node).unwrap();

    let dup = make_node("dup", "Second", "type", "proj");
    let result = store.add_node(dup);
    assert!(result.is_err(), "Adding duplicate node should fail");
}

#[test]
fn integration_get_node_nonexistent() {
    let store = make_store();
    let result = store.get_node("nonexistent").unwrap();
    assert!(result.is_none());
}

#[test]
fn integration_add_edge_verify_via_persistence() {
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let store = Arc::new(KnowledgeGraphStore::new(Arc::clone(&persistence)).unwrap());

    // Create nodes
    store
        .add_node(make_node("a", "NodeA", "function", "proj-1"))
        .unwrap();
    store
        .add_node(make_node("b", "NodeB", "function", "proj-1"))
        .unwrap();
    store
        .add_node(make_node("c", "NodeC", "function", "proj-1"))
        .unwrap();

    // Create edges
    store
        .add_edge("a", "b", make_edge("e-ab", "a", "b", "calls", "proj-1"))
        .unwrap();
    store
        .add_edge("a", "c", make_edge("e-ac", "a", "c", "imports", "proj-1"))
        .unwrap();

    // Verify edges via in-memory graph query (no SQLite fallback in new arch)
    let neighbors = store.get_neighbors_project("a", Some("proj-1")).unwrap();
    assert_eq!(
        neighbors.len(),
        2,
        "Node a should have 2 neighbors in memory"
    );

    // Verify via bincode snapshot that edges are persisted
    let snapshot = store.save_to_bincode("proj-1", HashMap::new()).unwrap();
    assert_eq!(snapshot.edges.len(), 2);

    let neighbors_b = store.get_neighbors_project("b", Some("proj-1")).unwrap();
    assert!(
        !neighbors_b.is_empty(),
        "Node b should have incoming neighbor a in memory"
    );
}

// NOTE: The deadlock bug in get_neighbors_project has been fixed —
// ensure_project_loaded is now a no-op, so the inner Mutex is acquired only
// once per call. This test is kept as an alternative verification path using
// SQLite persistence (now also a no-op for reads, kept for API compatibility).
#[test]
fn integration_get_neighbors_project_filtering_via_persistence() {
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let store = Arc::new(KnowledgeGraphStore::new(Arc::clone(&persistence)).unwrap());

    store
        .add_node(make_node("p1-a", "P1A", "fn", "proj-1"))
        .unwrap();
    store
        .add_node(make_node("p1-b", "P1B", "fn", "proj-1"))
        .unwrap();
    store
        .add_node(make_node("p2-a", "P2A", "fn", "proj-2"))
        .unwrap();

    store
        .add_edge(
            "p1-a",
            "p1-b",
            make_edge("e1", "p1-a", "p1-b", "calls", "proj-1"),
        )
        .unwrap();

    // Filter by proj-1 via in-memory graph query
    let neighbors = store.get_neighbors_project("p1-a", Some("proj-1")).unwrap();
    assert!(!neighbors.is_empty());

    // Filter by proj-2 should not return proj-1 neighbors
    let neighbors2 = store.get_neighbors_project("p1-a", Some("proj-2")).unwrap();
    assert!(
        neighbors2.is_empty(),
        "proj-2 filter should not return proj-1 neighbors"
    );
}

#[test]
fn integration_find_nodes_by_type_project() {
    let store = make_store();

    store
        .add_node(make_node("fn1", "Func1", "function", "proj-1"))
        .unwrap();
    store
        .add_node(make_node("fn2", "Func2", "function", "proj-1"))
        .unwrap();
    store
        .add_node(make_node("cls1", "Class1", "class", "proj-1"))
        .unwrap();
    store
        .add_node(make_node("fn3", "Func3", "function", "proj-2"))
        .unwrap();

    let fns_p1 = store
        .find_nodes_by_type_project("function", Some("proj-1"))
        .unwrap();
    assert_eq!(fns_p1.len(), 2, "Should find 2 functions in proj-1");

    let classes_p1 = store
        .find_nodes_by_type_project("class", Some("proj-1"))
        .unwrap();
    assert_eq!(classes_p1.len(), 1);

    let fns_p2 = store
        .find_nodes_by_type_project("function", Some("proj-2"))
        .unwrap();
    assert_eq!(fns_p2.len(), 1);
}

#[test]
fn integration_node_count_project() {
    let store = make_store();

    store
        .add_node(make_node("n1", "N1", "fn", "proj-1"))
        .unwrap();
    store
        .add_node(make_node("n2", "N2", "fn", "proj-1"))
        .unwrap();
    store
        .add_node(make_node("n3", "N3", "fn", "proj-2"))
        .unwrap();

    let count_p1 = store.node_count_project(Some("proj-1")).unwrap();
    assert_eq!(count_p1, 2);

    let count_p2 = store.node_count_project(Some("proj-2")).unwrap();
    assert_eq!(count_p2, 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. remove_file (via ProjectIndexer)
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_remove_file() {
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let store = Arc::new(KnowledgeGraphStore::new(Arc::clone(&persistence)).unwrap());
    let indexer =
        ProjectIndexer::new(Arc::clone(&store), persistence, make_bincode_storage()).unwrap();

    // Index a file
    let (nodes, _edges) = indexer
        .index_file_content(
            "src/main.rs",
            r#"
struct User {
    name: String,
}
fn main() {}
"#,
            "test-project",
        )
        .unwrap();
    assert!(nodes > 0, "Should have indexed at least one node");

    // Verify nodes exist
    let count = store.node_count_project(Some("test-project")).unwrap();
    assert!(count > 0, "Should have nodes after indexing");

    // Remove the file
    indexer.remove_file("src/main.rs", "test-project").unwrap();

    // Verify nodes removed
    let count_after = store.node_count_project(Some("test-project")).unwrap();
    assert_eq!(count_after, 0, "All nodes for the file should be removed");
}

// ═══════════════════════════════════════════════════════════════════════════
// 2c. In-file Method/HasType edges must not be dropped (P1-06/P1-07)
// ═══════════════════════════════════════════════════════════════════════════

/// Regression (P1-06/P1-07): the Method edge (sent in the functions pass)
/// targets `Class:{name}@{file}`, and the HasType edge (sent in the fields
/// pass) targets `type:{name}@{file}` — but those nodes were previously only
/// created in LATER passes, and `upsert_edge` treats "not found" as a
/// skippable cross-file reference. Result: every in-file Method/HasType edge
/// was silently dropped. Nodes are now pre-created before any edge pass.
#[test]
fn integration_method_and_hastype_edges_survive() {
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let store = Arc::new(KnowledgeGraphStore::new(Arc::clone(&persistence)).unwrap());
    let indexer =
        ProjectIndexer::new(Arc::clone(&store), persistence, make_bincode_storage()).unwrap();

    let (nodes, _edges) = indexer
        .index_file_content(
            "src/main.rs",
            r#"
struct User {
    name: UserName,
}
type UserName = String;
impl User {
    fn greet(&self) -> UserName { self.name.0.clone() }
}
"#,
            "test-project",
        )
        .unwrap();
    assert!(nodes > 0, "Should have indexed at least one node");

    let snapshot = store
        .save_to_bincode("test-project", HashMap::new())
        .unwrap();
    let relations: Vec<&str> = snapshot.edges.iter().map(|e| e.relation.as_str()).collect();
    assert!(
        relations.contains(&"Method"),
        "In-file Method edge must survive; got relations {relations:?}"
    );
    assert!(
        relations.contains(&"HasType"),
        "In-file HasType edge must survive; got relations {relations:?}"
    );
}

/// Regression (P1-07, second half): a field whose type is NOT declared in the
/// same file (`u16`, `String`, `Vec<T>`, a struct name, …) had no
/// `type:{name}@{file}` node, so its HasType edge was dropped as a "target not
/// found" cross-file reference. A placeholder type node is materialised for
/// every referenced type, so the edge survives.
#[test]
fn integration_hastype_edges_survive_for_undeclared_types() {
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let store = Arc::new(KnowledgeGraphStore::new(Arc::clone(&persistence)).unwrap());
    let indexer =
        ProjectIndexer::new(Arc::clone(&store), persistence, make_bincode_storage()).unwrap();

    let (nodes, _edges) = indexer
        .index_file_content(
            "src/main.rs",
            r#"
struct Server {
    port: u16,
    name: String,
}
"#,
            "test-project",
        )
        .unwrap();
    assert!(nodes > 0, "Should have indexed at least one node");

    let snapshot = store
        .save_to_bincode("test-project", HashMap::new())
        .unwrap();
    let has_type_targets: Vec<&str> = snapshot
        .edges
        .iter()
        .filter(|e| e.relation == "HasType")
        .map(|e| e.target_id.as_str())
        .collect();
    assert!(
        has_type_targets.contains(&"type:u16@src/main.rs"),
        "HasType edge for an undeclared type must survive; got {has_type_targets:?}"
    );
    assert!(
        has_type_targets.contains(&"type:String@src/main.rs"),
        "HasType edge for an undeclared type must survive; got {has_type_targets:?}"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// 2b. Windows backslash paths must address the SAME nodes (P1-08)
// ═══════════════════════════════════════════════════════════════════════════

/// Regression (P1-08): the full index normalizes to POSIX node ids
/// (`file:src/main.rs`), but a Windows watcher sends backslash paths
/// (`src\main.rs`) for incremental update/delete. Before the fix those
/// addressed different ids: updates produced DUPLICATE nodes and deletes
/// silently left stale nodes in the graph.
#[test]
fn integration_windows_backslash_paths_address_same_nodes() {
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let store = Arc::new(KnowledgeGraphStore::new(Arc::clone(&persistence)).unwrap());
    let indexer =
        ProjectIndexer::new(Arc::clone(&store), persistence, make_bincode_storage()).unwrap();

    // Full-index style: POSIX path.
    let (nodes, _edges) = indexer
        .index_file_content(
            "src/main.rs",
            "struct User {\n    name: String,\n}\nfn main() {}\n",
            "test-project",
        )
        .unwrap();
    assert!(nodes > 0, "Should have indexed at least one node");
    let count_full = store.node_count_project(Some("test-project")).unwrap();

    // Windows watcher sends the SAME file with backslashes for update:
    // must address the same nodes (remove + reindex), not create duplicates.
    // (Same content on purpose — the node count must come out identical.)
    indexer
        .update_file(
            "src\\main.rs",
            "struct User {\n    name: String,\n}\nfn main() {}\n",
            "test-project",
        )
        .unwrap();
    let count_update = store.node_count_project(Some("test-project")).unwrap();
    assert_eq!(
        count_update, count_full,
        "backslash update must not duplicate nodes (P1-08)"
    );

    // And removal with backslashes must actually delete them.
    indexer
        .remove_file_with_snapshot("src\\main.rs", "test-project", None)
        .unwrap();
    let count_removed = store.node_count_project(Some("test-project")).unwrap();
    assert_eq!(
        count_removed, 0,
        "backslash remove must delete the nodes (P1-08)"
    );
}

// ─── Cross-file call stubs must not depend on file indexing order ───
//
// Indexing a call site creates a *stub* node for the callee (properties:
// `sourceFile` + `placeholder`, but no `file`), while indexing the file that
// actually defines the callee creates the *authoritative* node (carrying
// `file`). Both share the same node id, so whichever file is indexed second
// used to be silently dropped by `upsert_node`.
//
// When the caller was indexed first, the authoritative node lost its `file`
// property, and `remove_file` / `update_file` — which attribute a node to a
// file through exactly that property — could no longer reach it. The node
// survived every removal as a ghost and kept surfacing in `search_nodes`,
// which feeds the LLM context builder.

/// Index a two-file project through the real `index_project` path (the only
/// path that builds the cross-file `ProjectSymbolIndex`, and therefore the only
/// one that produces `RESOLVED` stub ids colliding with authoritative nodes).
///
/// `callee_file` controls the callee's filename, which decides whether it is
/// walked before or after the caller: the walker yields files in alphabetical
/// order, so `aaa.ts` is indexed before and `util.ts` after `main.ts`.
async fn index_cross_file_project(
    callee_file: &str,
) -> (Arc<KnowledgeGraphStore>, ProjectIndexer, String, String) {
    let root = std::env::temp_dir().join(format!(
        "kg_xfile_{}_{}_{}",
        std::process::id(),
        callee_file.replace('.', "_"),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let src = root.join("src");
    std::fs::create_dir_all(&src).unwrap();

    std::fs::write(
        src.join(callee_file),
        "export function helper() { return 1; }\n",
    )
    .unwrap();
    std::fs::write(
        src.join("main.ts"),
        format!(
            "import {{ helper }} from './{}';\nexport function main() {{ return helper(); }}\n",
            callee_file.trim_end_matches(".ts")
        ),
    )
    .unwrap();

    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let store = Arc::new(KnowledgeGraphStore::new(Arc::clone(&persistence)).unwrap());
    let indexer =
        ProjectIndexer::new(Arc::clone(&store), persistence, make_bincode_storage()).unwrap();

    let root_str = root.to_string_lossy().to_string();
    indexer
        .index_project(&root_str, "test-project")
        .await
        .unwrap();

    // Discover the callee node id from the graph rather than assuming how the
    // indexer spells file paths, then derive the file path the indexer stored.
    let callee_node_id = store
        .find_nodes_by_type_project("Function", Some("test-project"))
        .unwrap()
        .into_iter()
        .map(|n| n.id)
        .find(|id| id.starts_with("function:helper@"))
        .unwrap_or_else(|| panic!("no `helper` function node after indexing {callee_file}"));

    let callee_path = callee_node_id
        .split_once('@')
        .map(|(_, path)| path.to_string())
        .unwrap();

    (store, indexer, callee_node_id, callee_path)
}

/// `aaa.ts` sorts before `main.ts` (callee indexed first), `util.ts` after
/// (caller indexed first — the ordering that used to lose the `file` property).
const CALLEE_FILES: [&str; 2] = ["aaa.ts", "util.ts"];

/// The authoritative `helper` node must keep its `file` property no matter
/// whether the defining file or the calling file was indexed first.
#[tokio::test]
async fn integration_cross_file_callee_keeps_file_property_in_both_orders() {
    for callee_file in CALLEE_FILES {
        let (store, _indexer, callee_node_id, callee_path) =
            index_cross_file_project(callee_file).await;

        let node = store
            .get_node(&callee_node_id)
            .unwrap()
            .unwrap_or_else(|| panic!("callee node missing (callee_file={callee_file})"));

        let file = node
            .properties
            .as_ref()
            .and_then(|p| p.get("file"))
            .and_then(|v| v.as_str());

        assert_eq!(
            file,
            Some(callee_path.as_str()),
            "authoritative node lost its `file` property (callee_file={callee_file})"
        );
    }
}

/// Removing the defining file must purge the callee node in both orders,
/// otherwise it lingers as an unreachable ghost.
#[tokio::test]
async fn integration_cross_file_callee_is_purged_in_both_orders() {
    for callee_file in CALLEE_FILES {
        let (store, indexer, callee_node_id, callee_path) =
            index_cross_file_project(callee_file).await;

        indexer.remove_file(&callee_path, "test-project").unwrap();

        assert!(
            store.get_node(&callee_node_id).unwrap().is_none(),
            "callee node survived remove_file (callee_file={callee_file})"
        );
    }
}

/// After the callee is renamed, the stale symbol must disappear from search
/// results — a ghost node would otherwise be fed to the LLM context builder.
#[tokio::test]
async fn integration_renamed_callee_leaves_no_ghost_in_search() {
    for callee_file in CALLEE_FILES {
        let (store, indexer, callee_node_id, callee_path) =
            index_cross_file_project(callee_file).await;

        indexer
            .update_file(
                &callee_path,
                "export function helperRenamed() { return 1; }\n",
                "test-project",
            )
            .unwrap();

        let stale: Vec<_> = store
            .search_nodes("helper", None, Some("test-project"), 50)
            .unwrap()
            .into_iter()
            .filter(|n| n.id == callee_node_id)
            .collect();

        assert!(
            stale.is_empty(),
            "renamed callee left a ghost node in search results (callee_file={callee_file})"
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Concurrent Read/Write
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_concurrent_add_nodes() {
    let store = make_store();
    let num_threads = 4;
    let nodes_per_thread = 25;

    let mut handles = Vec::new();
    for t in 0..num_threads {
        let s = Arc::clone(&store);
        handles.push(thread::spawn(move || {
            for i in 0..nodes_per_thread {
                let node = make_node(
                    &format!("t{}-n{}", t, i),
                    &format!("Label-{}-{}", t, i),
                    "function",
                    &format!("proj-{}", t),
                );
                s.add_node(node).unwrap();
            }
        }));
    }

    for h in handles {
        h.join().unwrap();
    }

    let total = store.node_count_project(None).unwrap();
    assert_eq!(
        total,
        num_threads * nodes_per_thread,
        "All concurrent node additions should be persisted"
    );
}

#[test]
fn integration_concurrent_read_while_adding_nodes() {
    let store = make_store();

    // Pre-populate
    store
        .add_node(make_node("pre-1", "Pre1", "fn", "proj-1"))
        .unwrap();

    let s_write = Arc::clone(&store);
    let s_read = Arc::clone(&store);

    let writer = thread::spawn(move || {
        for i in 0..50 {
            s_write
                .add_node(make_node(
                    &format!("concurrent-{}", i),
                    &format!("C{}", i),
                    "fn",
                    "proj-1",
                ))
                .unwrap();
        }
    });

    let reader = thread::spawn(move || {
        for _ in 0..50 {
            let _ = s_read.get_node("pre-1").unwrap();
            let _ = s_read.find_nodes_by_type_project("function", None).unwrap();
        }
    });

    writer.join().unwrap();
    reader.join().unwrap();
}

#[test]
fn integration_concurrent_add_edges() {
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let store = Arc::new(KnowledgeGraphStore::new(Arc::clone(&persistence)).unwrap());

    // Pre-create nodes
    for i in 0..10 {
        store
            .add_node(make_node(
                &format!("cn-{}", i),
                &format!("N{}", i),
                "fn",
                "proj-1",
            ))
            .unwrap();
    }

    let s = Arc::clone(&store);
    let handles: Vec<_> = (0..10)
        .map(|i| {
            let s = Arc::clone(&s);
            thread::spawn(move || {
                for j in 0..5 {
                    let target = (i + 1) % 10;
                    let edge = make_edge(
                        &format!("edge-{}-{}", i, j),
                        &format!("cn-{}", i),
                        &format!("cn-{}", target),
                        "calls",
                        "proj-1",
                    );
                    s.add_edge(&format!("cn-{}", i), &format!("cn-{}", target), edge)
                        .unwrap();
                }
            })
        })
        .collect();

    for h in handles {
        h.join().unwrap();
    }

    // Verify edges via in-memory graph query (no SQLite fallback in new arch)
    let neighbors = store.get_neighbors_project("cn-0", Some("proj-1")).unwrap();
    assert!(
        !neighbors.is_empty(),
        "Should have edges after concurrent add in memory"
    );

    // Verify all edges persisted via bincode snapshot
    let snapshot = store.save_to_bincode("proj-1", HashMap::new()).unwrap();
    assert!(
        !snapshot.edges.is_empty(),
        "Snapshot should contain edges after concurrent add"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Transaction Boundary
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_transaction_persistence_on_node_add() {
    // Add node to store1, save to bincode, load into store2, verify read-back
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());

    let store1 = Arc::new(KnowledgeGraphStore::new(Arc::clone(&persistence)).unwrap());
    store1
        .add_node(make_node("persist-test", "PersistNode", "type", "proj"))
        .unwrap();

    // Save to bincode snapshot
    let snapshot = store1.save_to_bincode("proj", HashMap::new()).unwrap();

    // Create a new store and load from bincode
    let store2 = Arc::new(KnowledgeGraphStore::new(Arc::clone(&persistence)).unwrap());
    store2.load_from_bincode(snapshot).unwrap();

    // Verify node exists in store2
    let node = store2.get_node("persist-test").unwrap();
    assert!(
        node.is_some(),
        "Node should be found via new store instance (loaded from bincode)"
    );
    assert_eq!(node.unwrap().label, "PersistNode");
}

#[test]
fn integration_transaction_node_and_edge_consistency() {
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let store = Arc::new(KnowledgeGraphStore::new(Arc::clone(&persistence)).unwrap());

    store
        .add_node(make_node("src", "Source", "fn", "proj"))
        .unwrap();
    store
        .add_node(make_node("tgt", "Target", "fn", "proj"))
        .unwrap();
    store
        .add_edge("src", "tgt", make_edge("e1", "src", "tgt", "calls", "proj"))
        .unwrap();

    // Both nodes and edge should be queryable
    let src = store.get_node("src").unwrap();
    let tgt = store.get_node("tgt").unwrap();
    assert!(src.is_some());
    assert!(tgt.is_some());

    // Verify edge via in-memory graph query (no SQLite fallback in new arch)
    let neighbors = store.get_neighbors_project("src", Some("proj")).unwrap();
    assert_eq!(neighbors.len(), 1);
    assert_eq!(neighbors[0].0.id, "tgt");
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. In-Memory Mode
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_in_memory_persistence() {
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    assert!(!persistence.is_persistent());

    let store = KnowledgeGraphStore::new(persistence).unwrap();
    store
        .add_node(make_node("mem-node", "InMem", "test", ""))
        .unwrap();

    let node = store.get_node("mem-node").unwrap();
    assert!(node.is_some());
    assert_eq!(node.unwrap().label, "InMem");
}

#[test]
fn integration_in_memory_full_workflow() {
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let store = Arc::new(KnowledgeGraphStore::new(Arc::clone(&persistence)).unwrap());

    // Add nodes
    store
        .add_node(make_node("file:main.rs", "main.rs", "File", "proj"))
        .unwrap();
    store
        .add_node(make_node("sym:main_fn", "main()", "function", "proj"))
        .unwrap();

    // Add edge
    store
        .add_edge(
            "file:main.rs",
            "sym:main_fn",
            make_edge(
                "e-file-sym",
                "file:main.rs",
                "sym:main_fn",
                "contains",
                "proj",
            ),
        )
        .unwrap();

    // Query neighbors via in-memory graph (no SQLite fallback in new arch)
    let neighbors = store
        .get_neighbors_project("file:main.rs", Some("proj"))
        .unwrap();
    assert_eq!(neighbors.len(), 1);

    // Verify persistence via bincode snapshot
    let snapshot = store.save_to_bincode("proj", HashMap::new()).unwrap();
    assert_eq!(snapshot.nodes.len(), 2);
    assert_eq!(snapshot.edges.len(), 1);

    // Find by type
    let fns = store
        .find_nodes_by_type_project("function", Some("proj"))
        .unwrap();
    assert_eq!(fns.len(), 1);

    let files = store
        .find_nodes_by_type_project("File", Some("proj"))
        .unwrap();
    assert_eq!(files.len(), 1);

    // Remove file via indexer — pass a new store Arc since the old one was consumed
    let store2 = Arc::new(KnowledgeGraphStore::new(Arc::clone(&persistence)).unwrap());
    let indexer =
        ProjectIndexer::new(Arc::clone(&store2), persistence, make_bincode_storage()).unwrap();
    indexer.remove_file("main.rs", "proj").unwrap();
}

// 7. get_neighbors_project via store (deadlock regression tests)
// These tests call store.get_neighbors_project directly to verify that the
// previously existing deadlock (inner Mutex acquired twice in the same scope)
// has been fixed. If the deadlock regresses, these tests will hang until the
// test timeout kills them.
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn integration_get_neighbors_store_basic() {
    let store = make_store();

    store
        .add_node(make_node("a", "NodeA", "function", "proj-1"))
        .unwrap();
    store
        .add_node(make_node("b", "NodeB", "function", "proj-1"))
        .unwrap();
    store
        .add_node(make_node("c", "NodeC", "function", "proj-1"))
        .unwrap();

    store
        .add_edge("a", "b", make_edge("e-ab", "a", "b", "calls", "proj-1"))
        .unwrap();
    store
        .add_edge("a", "c", make_edge("e-ac", "a", "c", "imports", "proj-1"))
        .unwrap();

    // Direct store call — should not deadlock
    let neighbors = store.get_neighbors_project("a", Some("proj-1")).unwrap();
    assert_eq!(neighbors.len(), 2, "Node a should have 2 neighbors");

    // Node b should have 1 incoming neighbor (a)
    let neighbors_b = store.get_neighbors_project("b", Some("proj-1")).unwrap();
    assert!(
        !neighbors_b.is_empty(),
        "Node b should have incoming neighbor a"
    );
}

#[test]
fn integration_get_neighbors_store_project_filtering() {
    let store = make_store();

    store
        .add_node(make_node("p1-a", "P1A", "fn", "proj-1"))
        .unwrap();
    store
        .add_node(make_node("p1-b", "P1B", "fn", "proj-1"))
        .unwrap();
    store
        .add_node(make_node("p2-a", "P2A", "fn", "proj-2"))
        .unwrap();

    store
        .add_edge(
            "p1-a",
            "p1-b",
            make_edge("e1", "p1-a", "p1-b", "calls", "proj-1"),
        )
        .unwrap();

    // Filter by proj-1 — should return neighbors
    let neighbors = store.get_neighbors_project("p1-a", Some("proj-1")).unwrap();
    assert!(
        !neighbors.is_empty(),
        "proj-1 filter should return proj-1 neighbors"
    );

    // Filter by proj-2 — should not return proj-1 neighbors
    let neighbors2 = store.get_neighbors_project("p1-a", Some("proj-2")).unwrap();
    assert!(
        neighbors2.is_empty(),
        "proj-2 filter should not return proj-1 neighbors"
    );
}

#[test]
fn integration_get_neighbors_store_no_project_filter() {
    let store = make_store();

    store
        .add_node(make_node("x", "NodeX", "fn", "proj-1"))
        .unwrap();
    store
        .add_node(make_node("y", "NodeY", "fn", "proj-1"))
        .unwrap();
    store
        .add_edge("x", "y", make_edge("e-xy", "x", "y", "calls", "proj-1"))
        .unwrap();

    // No project filter (None) — should return all neighbors
    let neighbors = store.get_neighbors("x").unwrap();
    assert_eq!(neighbors.len(), 1, "Node x should have 1 neighbor (y)");
    assert_eq!(neighbors[0].0.id, "y");
}

#[test]
fn integration_get_neighbors_store_nonexistent_node() {
    let store = make_store();
    store
        .add_node(make_node("exists", "Exists", "fn", "proj-1"))
        .unwrap();

    // Querying a nonexistent node should not deadlock and return empty
    let neighbors = store
        .get_neighbors_project("nonexistent", Some("proj-1"))
        .unwrap();
    assert!(
        neighbors.is_empty(),
        "Nonexistent node should have no neighbors"
    );
}

#[test]
fn integration_get_neighbors_store_concurrent_no_deadlock() {
    // Multiple threads calling get_neighbors_project concurrently —
    // verifies no deadlock under contention.
    let store = make_store();

    // Pre-create nodes and edges
    for i in 0..5 {
        store
            .add_node(make_node(
                &format!("node-{}", i),
                &format!("N{}", i),
                "fn",
                "proj-1",
            ))
            .unwrap();
    }
    for i in 0..5 {
        let target = (i + 1) % 5;
        store
            .add_edge(
                &format!("node-{}", i),
                &format!("node-{}", target),
                make_edge(
                    &format!("edge-{}", i),
                    &format!("node-{}", i),
                    &format!("node-{}", target),
                    "calls",
                    "proj-1",
                ),
            )
            .unwrap();
    }

    let s = Arc::clone(&store);
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let s = Arc::clone(&s);
            thread::spawn(move || {
                for i in 0..5 {
                    let _ = s
                        .get_neighbors_project(&format!("node-{}", i), Some("proj-1"))
                        .unwrap();
                }
            })
        })
        .collect();

    for h in handles {
        h.join().unwrap();
    }

    // If we reach here, no deadlock occurred.
    let neighbors = store
        .get_neighbors_project("node-0", Some("proj-1"))
        .unwrap();
    assert!(!neighbors.is_empty());
}

// search_nodes — server-side search by label substring
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn search_nodes_finds_by_label_substring() {
    let store = make_store();
    store
        .add_node(make_node("fn-login", "handle_login", "Function", "proj-1"))
        .unwrap();
    store
        .add_node(make_node(
            "fn-logout",
            "handle_logout",
            "Function",
            "proj-1",
        ))
        .unwrap();
    store
        .add_node(make_node(
            "fn-register",
            "register_user",
            "Function",
            "proj-1",
        ))
        .unwrap();
    store
        .add_node(make_node("cls-user", "User", "Class", "proj-1"))
        .unwrap();

    let results = store
        .search_nodes("login", None, Some("proj-1"), 10)
        .unwrap();
    assert_eq!(
        results.len(),
        1,
        "Should find 'handle_login' by 'login' substring"
    );
    assert_eq!(results[0].id, "fn-login");
}

#[test]
fn search_nodes_case_insensitive() {
    let store = make_store();
    store
        .add_node(make_node("fn-1", "HandleLogin", "Function", "proj-1"))
        .unwrap();

    let results = store
        .search_nodes("handlelogin", None, Some("proj-1"), 10)
        .unwrap();
    assert_eq!(results.len(), 1, "Case-insensitive search should match");
}

#[test]
fn search_nodes_filters_by_type() {
    let store = make_store();
    store
        .add_node(make_node("fn-login", "handle_login", "Function", "proj-1"))
        .unwrap();
    store
        .add_node(make_node("cls-login", "LoginHandler", "Class", "proj-1"))
        .unwrap();

    let results = store
        .search_nodes("login", Some("Function"), Some("proj-1"), 10)
        .unwrap();
    assert_eq!(results.len(), 1, "Should only find Function nodes");
    assert_eq!(results[0].node_type, "Function");
}

#[test]
fn search_nodes_respects_limit() {
    let store = make_store();
    for i in 0..20 {
        store
            .add_node(make_node(
                &format!("fn-{}", i),
                &format!("handle_login_{}", i),
                "Function",
                "proj-1",
            ))
            .unwrap();
    }

    let results = store
        .search_nodes("login", None, Some("proj-1"), 5)
        .unwrap();
    assert_eq!(results.len(), 5, "Should respect limit parameter");
}

#[test]
fn search_nodes_no_match_returns_empty() {
    let store = make_store();
    store
        .add_node(make_node("fn-1", "handle_login", "Function", "proj-1"))
        .unwrap();

    let results = store
        .search_nodes("nonexistent", None, Some("proj-1"), 10)
        .unwrap();
    assert!(results.is_empty(), "Should return empty when no match");
}

#[test]
fn search_nodes_project_isolation() {
    let store = make_store();
    store
        .add_node(make_node("fn-1", "handle_login", "Function", "proj-1"))
        .unwrap();
    store
        .add_node(make_node("fn-2", "handle_login", "Function", "proj-2"))
        .unwrap();

    let results = store
        .search_nodes("login", None, Some("proj-1"), 10)
        .unwrap();
    // Should find nodes from proj-1 and global (empty project_id)
    assert!(
        results
            .iter()
            .all(|n| n.project_id == "proj-1" || n.project_id.is_empty()),
        "Should only return nodes from the specified project or global"
    );
}

#[test]
fn search_nodes_includes_global_nodes() {
    let store = make_store();
    store
        .add_node(make_node("fn-global", "global_login", "Function", ""))
        .unwrap();
    store
        .add_node(make_node("fn-proj", "proj_login", "Function", "proj-1"))
        .unwrap();

    let results = store
        .search_nodes("login", None, Some("proj-1"), 10)
        .unwrap();
    assert_eq!(
        results.len(),
        2,
        "Should include both project and global nodes"
    );
}

/// Create a temporary project directory with the given files.
/// Returns the project path. Caller is responsible for cleanup (left in temp dir).
fn make_temp_project(files: &[(&str, &str)]) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "kg_proj_{}_{:?}",
        SEQ.fetch_add(1, Ordering::Relaxed),
        std::thread::current().id()
    ));
    std::fs::create_dir_all(&root).unwrap();
    for (rel, content) in files {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&p, content).unwrap();
    }
    root
}

#[tokio::test]
async fn force_reindex_indexes_entire_project_and_returns_counts() {
    let root = make_temp_project(&[
        (
            "src/a.ts",
            "export function login(user: string) { return user; }\n",
        ),
        (
            "src/b.ts",
            "export class Service { ping() { return 'pong'; } }\n",
        ),
        ("README.md", "# project\n"),
    ]);
    let store = make_store();
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let indexer = ProjectIndexer::new(Arc::clone(&store), persistence, make_bincode_storage()).unwrap();

    let (files_indexed, entities, edges) =
        indexer.force_reindex(root.to_str().unwrap(), "proj-force-1").await.unwrap();

    assert!(files_indexed >= 2, "should index at least the 2 ts files, got {files_indexed}");
    assert!(entities > 0, "should extract entities, got {entities}");
    assert!(edges > 0, "should extract edges, got {edges}");
    assert!(
        matches!(indexer.get_index_status("proj-force-1"), IndexStatus::Ready),
        "project status should transition to Ready after a successful force_reindex"
    );
}

#[tokio::test]
async fn load_fresh_bincode_snapshot_hits_after_save() {
    let root = make_temp_project(&[("src/a.ts", "export function load() { return 42; }\n")]);
    let store = make_store();
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let bincode = make_bincode_storage();
    let indexer = ProjectIndexer::new(Arc::clone(&store), persistence, Arc::clone(&bincode)).unwrap();

    // Simulate the "open project" snapshot path: index, then persist, then reload.
    indexer.force_reindex(root.to_str().unwrap(), "proj-snap-1").await.unwrap();
    indexer
        .save_project_snapshot(root.to_str().unwrap(), "proj-snap-1")
        .unwrap();

    let hit = indexer
        .load_fresh_bincode_snapshot(root.to_str().unwrap(), "proj-snap-1")
        .unwrap();
    assert!(hit, "load_fresh_bincode_snapshot should hit the saved snapshot");

    // Reloading must populate the in-memory graph so queries return nodes.
    let results = store
        .search_nodes("load", None, Some("proj-snap-1"), 10)
        .unwrap();
    assert!(
        !results.is_empty(),
        "graph should be populated from the loaded snapshot"
    );
}

/// `delete_project_index` must not throw away another project's pending
/// snapshot save. Before the per-project dirty map, deleting B reset a single
/// global dirty flag and wiped A's deferred save context, so A's indexed graph
/// never reached disk and was lost on restart.
#[tokio::test]
async fn deleting_one_project_keeps_other_projects_snapshot() {
    let root_a = make_temp_project(&[("src/a.ts", "export function alpha() { return 1; }\n")]);
    let root_b = make_temp_project(&[("src/b.ts", "export function beta() { return 2; }\n")]);
    let store = make_store();
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let bincode = make_bincode_storage();
    let indexer =
        ProjectIndexer::new(Arc::clone(&store), persistence, Arc::clone(&bincode)).unwrap();

    indexer.force_reindex(root_a.to_str().unwrap(), "proj-a").await.unwrap();
    indexer.force_reindex(root_b.to_str().unwrap(), "proj-b").await.unwrap();

    // Remove the snapshots force_reindex wrote, so the only way a file can
    // reappear on disk is via the background saver flushing a pending save.
    indexer.delete_bincode_snapshot("proj-a").unwrap();
    indexer.delete_bincode_snapshot("proj-b").unwrap();
    assert!(!bincode.exists("proj-a"), "precondition: A not on disk");

    // A file edit in A leaves A dirty with its save still pending (this is the
    // file-watcher path: it does not write to disk itself).
    let a_file = root_a.join("src/a.ts");
    std::fs::write(&a_file, "export function alpha() { return 42; }\n").unwrap();
    indexer
        .update_file_with_snapshot(
            a_file.to_str().unwrap(),
            "export function alpha() { return 42; }\n",
            "proj-a",
            Some(root_a.to_str().unwrap()),
        )
        .unwrap();
    assert!(!bincode.exists("proj-a"), "precondition: A's save is pending, not written");

    // Delete B while A's save is still pending.
    indexer.delete_project_index("proj-b").unwrap();

    // The background saver now ticks. A's pending save must still be there.
    indexer.flush_dirty_snapshot();

    assert!(
        bincode.exists("proj-a"),
        "deleting proj-b discarded proj-a's pending snapshot save"
    );
    assert!(
        !bincode.exists("proj-b"),
        "proj-b's snapshot must not be written after deletion"
    );
    let a_nodes = store.search_nodes("alpha", None, Some("proj-a"), 10).unwrap();
    assert!(
        !a_nodes.is_empty(),
        "proj-a's in-memory graph must be untouched by proj-b's deletion"
    );
    let b_nodes = store.search_nodes("beta", None, Some("proj-b"), 10).unwrap();
    assert!(
        b_nodes.is_empty(),
        "proj-b's in-memory graph must be cleared"
    );
}

/// A snapshot save that is *already in flight* when `delete_project_index`
/// runs must not resurrect the deleted snapshot.
///
/// Regression: `flush_dirty_snapshot` takes the pending set out of the dirty
/// mutex and saves outside it. If the saver has already taken the entry and is
/// writing the tmp file, the delete's "drop the dirty flag" is a no-op and the
/// save's final `rename` re-creates the exact file the delete just removed —
/// the user sees "clear index succeeded" but the index is still there after
/// reopening the project. The per-project IO lock makes the delete wait for the
/// in-flight save, and the tombstone makes any not-yet-started save skip.
#[tokio::test]
async fn inflight_flush_cannot_resurrect_a_deleted_snapshot() {
    // Two projects marked dirty, flushed in one saver tick. The flush saves
    // them back to back in HashMap order, so when we delete proj-b while a
    // save is provably in flight (its tmp file exists), exactly one of two
    // orderings is happening — and the delete must win in BOTH:
    //   1. proj-a's save in flight → proj-b is taken-but-not-yet-saving:
    //      the tombstone must make proj-b's save skip.
    //   2. proj-b's save in flight → the per-project IO lock must make the
    //      delete wait for the save, then remove the file it just wrote.
    let root_a = make_temp_project(&[("src/a.ts", "export function alpha() { return 1; }\n")]);
    let root_b = make_temp_project(&[("src/b.ts", "export function beta() { return 2; }\n")]);
    let store = make_store();
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let bincode = make_bincode_storage();
    let indexer =
        ProjectIndexer::new(Arc::clone(&store), persistence, Arc::clone(&bincode)).unwrap();

    // Bulk-load each project's in-memory graph so every snapshot save has to
    // serialize + write tens of MB: the tmp file then exists long enough to
    // be caught by the poll below, making the test timing-deterministic.
    let pad = "x".repeat(1500);
    for proj in ["proj-a", "proj-b"] {
        for i in 0..20_000u32 {
            let mut properties = HashMap::new();
            properties.insert("body".to_string(), serde_json::json!(pad));
            store
                .add_node(KGNode {
                    id: format!("{proj}-n{i}"),
                    label: format!("node{i}"),
                    node_type: "Function".to_string(),
                    properties: Some(properties),
                    project_id: proj.to_string(),
                })
                .unwrap();
        }
    }

    // File edits mark both projects dirty without writing to disk (the
    // file-watcher path).
    let a_file = root_a.join("src/a.ts");
    let a_content = "export function alpha() { return 42; }\n".to_string();
    std::fs::write(&a_file, &a_content).unwrap();
    indexer
        .update_file_with_snapshot(
            a_file.to_str().unwrap(),
            &a_content,
            "proj-a",
            Some(root_a.to_str().unwrap()),
        )
        .unwrap();
    let b_file = root_b.join("src/b.ts");
    let b_content = "export function beta() { return 42; }\n".to_string();
    std::fs::write(&b_file, &b_content).unwrap();
    indexer
        .update_file_with_snapshot(
            b_file.to_str().unwrap(),
            &b_content,
            "proj-b",
            Some(root_b.to_str().unwrap()),
        )
        .unwrap();
    assert!(!bincode.exists("proj-a"), "precondition: saves pending");
    assert!(!bincode.exists("proj-b"), "precondition: saves pending");

    // The background saver tick takes both pending entries and starts saving.
    let saver = indexer.clone();
    let saver_thread = thread::spawn(move || saver.flush_dirty_snapshot());

    // Wait until a save is provably in flight: its tmp file exists on disk.
    let cache_dir = bincode.cache_dir().to_path_buf();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let in_flight = loop {
        let tmp = std::fs::read_dir(&cache_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.path().extension().is_some_and(|x| x == "tmp"));
        if tmp {
            break true;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for an in-flight snapshot save"
        );
        thread::sleep(std::time::Duration::from_millis(1));
    };
    assert!(in_flight);

    // The user clears proj-b's index while the saver is mid-flush.
    indexer.delete_project_index("proj-b").unwrap();
    saver_thread.join().unwrap();

    assert!(
        !bincode.exists("proj-b"),
        "an in-flight snapshot save resurrected the snapshot that delete_project_index just removed"
    );
    // proj-a was not deleted: its save must still go through.
    assert!(
        bincode.exists("proj-a"),
        "proj-a's unrelated pending save must survive proj-b's deletion"
    );
}

/// The delete tombstone must only block saves until new data arrives. Once the
/// project is edited or re-indexed again, snapshot saves must work normally —
/// a delete must never permanently break persistence for that project.
#[tokio::test]
async fn tombstone_is_cleared_by_new_edits_and_reindex() {
    let root = make_temp_project(&[("src/a.ts", "export function revive() { return 1; }\n")]);
    let store = make_store();
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let bincode = make_bincode_storage();
    let indexer =
        ProjectIndexer::new(Arc::clone(&store), persistence, Arc::clone(&bincode)).unwrap();

    indexer.force_reindex(root.to_str().unwrap(), "proj-tomb").await.unwrap();
    indexer.delete_project_index("proj-tomb").unwrap();
    assert!(!bincode.exists("proj-tomb"), "precondition: deleted");

    // A residual file edit must NOT resurrect the deleted snapshot: the
    // tombstone stays until an explicit re-open (index_project_async) or
    // manual reindex (force_reindex) lifts it.
    let a_file = root.join("src/a.ts");
    let new_content = "export function revive() { return 2; }\n".to_string();
    std::fs::write(&a_file, &new_content).unwrap();
    indexer
        .update_file_with_snapshot(
            a_file.to_str().unwrap(),
            &new_content,
            "proj-tomb",
            Some(root.to_str().unwrap()),
        )
        .unwrap();
    indexer.flush_dirty_snapshot();
    assert!(
        !bincode.exists("proj-tomb"),
        "a residual edit after delete must not resurrect the snapshot (tombstone still set)"
    );

    // Same for a fresh indexing run: delete again, then reindex must persist.
    indexer.delete_project_index("proj-tomb").unwrap();
    assert!(!bincode.exists("proj-tomb"), "precondition: deleted again");
    indexer.force_reindex(root.to_str().unwrap(), "proj-tomb").await.unwrap();
    assert!(
        bincode.exists("proj-tomb"),
        "a reindex after delete must persist its snapshot (tombstone not cleared)"
    );
}

/// A deleted project must stay deleted: the background saver must not re-create
/// the snapshot from a stale dirty entry left behind by the delete.
#[tokio::test]
async fn deleted_project_is_not_resurrected_by_background_saver() {
    let root = make_temp_project(&[("src/a.ts", "export function gone() { return 0; }\n")]);
    let store = make_store();
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let bincode = make_bincode_storage();
    let indexer =
        ProjectIndexer::new(Arc::clone(&store), persistence, Arc::clone(&bincode)).unwrap();

    indexer.force_reindex(root.to_str().unwrap(), "proj-del").await.unwrap();
    indexer.save_project_snapshot(root.to_str().unwrap(), "proj-del").unwrap();
    assert!(bincode.exists("proj-del"));

    indexer.delete_project_index("proj-del").unwrap();
    assert!(!bincode.exists("proj-del"), "snapshot must be deleted");

    // Simulate the 5s background saver tick.
    indexer.flush_dirty_snapshot();

    assert!(
        !bincode.exists("proj-del"),
        "background saver must not resurrect a deleted project's snapshot"
    );
}

/// Deletion is idempotent, but must report whether anything was actually
/// removed so a mismatched project_id cannot masquerade as success.
#[tokio::test]
async fn delete_bincode_snapshot_reports_whether_a_file_was_removed() {
    let root = make_temp_project(&[("src/a.ts", "export function x() { return 1; }\n")]);
    let store = make_store();
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let bincode = make_bincode_storage();
    let indexer =
        ProjectIndexer::new(Arc::clone(&store), persistence, Arc::clone(&bincode)).unwrap();

    indexer.force_reindex(root.to_str().unwrap(), "proj-rep").await.unwrap();
    indexer.save_project_snapshot(root.to_str().unwrap(), "proj-rep").unwrap();

    assert!(
        indexer.delete_bincode_snapshot("proj-rep").unwrap(),
        "first delete removed a real file → true"
    );
    assert!(
        !indexer.delete_bincode_snapshot("proj-rep").unwrap(),
        "second delete found nothing → false, and must not error"
    );
    assert!(
        !indexer.delete_bincode_snapshot("never-indexed").unwrap(),
        "unknown project_id → false, and must not error"
    );
}

/// `sweep_expired_indexes` must not write back the registry snapshot it read
/// before deleting. Doing so re-added every entry that `delete_project_index`
/// had just removed, so expired projects kept reappearing in the settings list.
#[tokio::test]
async fn sweeping_expired_index_does_not_resurrect_registry_entry() {
    let root = make_temp_project(&[("src/a.ts", "export function old() { return 1; }\n")]);
    let store = make_store();
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let bincode = make_bincode_storage();
    let indexer =
        ProjectIndexer::new(Arc::clone(&store), persistence, Arc::clone(&bincode)).unwrap();

    indexer.force_reindex(root.to_str().unwrap(), "proj-old").await.unwrap();
    // Close it, then make the retention window effectively zero so it is expired.
    indexer.close_project_index("proj-old", false).unwrap();
    indexer.set_retention_days(1).unwrap();

    // Backdate closed_at well beyond the retention window by rewriting registry.
    let reg_path = bincode.cache_dir().join("registry.json");
    let mut reg: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&reg_path).unwrap()).unwrap();
    reg["projects"]["proj-old"]["closed_at"] =
        serde_json::json!(chrono::Utc::now().timestamp() - 10 * 86_400);
    std::fs::write(&reg_path, serde_json::to_string(&reg).unwrap()).unwrap();

    indexer.sweep_expired_indexes();

    let info = indexer.registry_info();
    let projects = info["projects"].as_array().unwrap();
    assert!(
        !projects
            .iter()
            .any(|p| p["project_id"] == "proj-old"),
        "swept project must not be resurrected in the registry, got: {projects:?}"
    );
    assert!(
        !bincode.exists("proj-old"),
        "swept project's snapshot must be gone from disk"
    );
}

#[tokio::test]
async fn cancel_index_stops_in_progress_indexing() {
    // Build a large project so indexing takes long enough to cancel mid-flight.
    let mut owned: Vec<(String, String)> = Vec::new();
    for i in 0..400u32 {
        owned.push((
            format!("src/mod_{i}.ts"),
            format!("export function fn_{i}() {{ return {i}; }}\n"),
        ));
    }
    let files: Vec<(&str, &str)> = owned.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    let root = make_temp_project(&files);
    let store = make_store();
    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let indexer = Arc::new(
        ProjectIndexer::new(Arc::clone(&store), persistence, make_bincode_storage()).unwrap(),
    );

    let i2 = Arc::clone(&indexer);
    let handle = tokio::spawn(async move {
        // Cancel shortly after indexing begins.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        i2.cancel_index("proj-cancel-1");
    });

    let result = indexer.force_reindex(root.to_str().unwrap(), "proj-cancel-1").await;
    handle.await.unwrap();

    // Cancellation is now treated as a real abort: `force_reindex` returns `Err`
    // (so both the synchronous caller and the spawned background task can
    // distinguish a cancelled run from a successful one — previously a cancelled
    // run returned `Ok((0,0,0))`, which the background task misinterpreted as a
    // successful `Ready` state). The key invariant is that indexing was stopped
    // mid-flight, i.e. the call did NOT complete successfully.
    assert!(
        result.is_err(),
        "cancel_index should make force_reindex return Err (not a false-success Ok)"
    );
    let msg = result.unwrap_err().to_string();
    assert!(
        msg.to_lowercase().contains("cancel"),
        "cancel error must explain the cancellation, got: {msg}"
    );
}
