//! Temporary benchmarking harness for the knowledge-graph indexer.
//!
//! Measures end-to-end indexing time for a real sub-crate. Run with:
//!   cargo test -p knowledge-graph-store --test bench_index_speed -- --nocapture --ignored
//!
//! The `ignored` flag keeps it out of the normal `cargo test` suite.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use knowledge_graph_store::graph::KnowledgeGraphStore;
use knowledge_graph_store::indexer::ProjectIndexer;
use knowledge_graph_store::persistence::GraphPersistence;
use knowledge_graph_store::BincodeStorage;

fn workspace_root() -> PathBuf {
    // tests/ lives in crates/knowledge-graph-store/tests
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest.parent().unwrap().parent().unwrap().to_path_buf()
}

#[tokio::test]
#[ignore]
async fn bench_index_ast_engine() {
    let ws = workspace_root();
    // Allow overriding the target via BENCH_TARGET (absolute or relative to workspace).
    let target = match std::env::var("BENCH_TARGET") {
        Ok(t) if !t.trim().is_empty() => {
            if Path::new(&t).is_absolute() {
                PathBuf::from(t)
            } else {
                ws.join(t)
            }
        }
        _ => ws.join("crates/ast-engine"),
    };
    assert!(target.exists(), "target crate missing: {:?}", target);

    let tmp = std::env::temp_dir().join(format!("kg_bench_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();

    let persistence = Arc::new(GraphPersistence::new().unwrap());
    let graph = Arc::new(KnowledgeGraphStore::new(persistence.clone()).unwrap());
    let bincode_storage = Arc::new(BincodeStorage::new(&tmp).unwrap());

    let indexer = ProjectIndexer::new(graph, persistence, bincode_storage).unwrap();

    let start = Instant::now();
    let result = indexer
        .index_project_filtered(target.to_str().unwrap(), "", None)
        .await;
    let elapsed = start.elapsed();
    match &result {
        Ok((files, entities, edges)) => {
            println!(
                "[BENCH] indexed files={} entities={} edges={} in {:?}",
                files, entities, edges, elapsed
            );
        }
        Err(e) => println!("[BENCH] indexing failed after {:?}: {:?}", elapsed, e),
    }
    let _ = std::fs::remove_dir_all(&tmp);
    result.unwrap();
}
