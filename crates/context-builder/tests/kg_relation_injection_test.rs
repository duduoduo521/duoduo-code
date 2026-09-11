//! Regression: KG relations must actually reach the assembled elements.
//!
//! `assemble` stores KG entities under a namespaced node key (`kg:{type}:{id}`)
//! but KG relations reference the **bare** entity id. The relation loop used to
//! look up `rel.source` directly against the node map, which could never match
//! a namespaced key, so `entity_assocs` stayed empty for every KG element.
//!
//! That silently disabled the association-driven edge detectors downstream
//! (`detect_entity_section_edges`, `detect_implicit_edges`, ...). These tests
//! drive the real assembler against a real in-memory graph + memory store so
//! the ID-space contract is locked by behaviour, not by inspection.
//!
//! Note: `assemble` derives the KG `project_id` from `project_path` via
//! `knowledge_graph_store::project_key` (see `fetch_kg_context`), so fixtures
//! must tag their nodes with that derived key — not with the raw directory.

use std::sync::Arc;

use context_builder::StructuredAssembler;
use duo_types::{ElementRole, KGEdge, KGNode, TaskPhase};
use knowledge_graph_store::graph::KnowledgeGraphStore;
use knowledge_graph_store::persistence::GraphPersistence;
use memory_system::MemorySystem;
use tempfile::TempDir;

fn node(project: &str, id: &str, node_type: &str) -> KGNode {
    KGNode {
        id: id.to_string(),
        label: id.to_string(),
        node_type: node_type.to_string(),
        properties: None,
        project_id: project.to_string(),
    }
}

fn edge(project: &str, id: &str, source: &str, target: &str, relation: &str) -> KGEdge {
    KGEdge {
        id: id.to_string(),
        source_id: source.to_string(),
        target_id: target.to_string(),
        relation: relation.to_string(),
        weight: Some(1.0),
        properties: None,
        project_id: project.to_string(),
    }
}

/// (node id, node type) pairs plus (edge id, source, target, relation) tuples.
type Fixture = (
    Vec<(&'static str, &'static str)>,
    Vec<(&'static str, &'static str, &'static str, &'static str)>,
);

fn build(fixture: Fixture) -> (StructuredAssembler, TempDir) {
    let dir = tempfile::tempdir().unwrap();

    let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
    let graph = KnowledgeGraphStore::new(persistence).unwrap();

    // Same derivation `assemble` performs internally.
    let key = knowledge_graph_store::project_key(dir.path());

    for (id, ty) in fixture.0 {
        graph.add_node(node(&key, id, ty)).unwrap();
    }
    for (eid, src, tgt, rel) in fixture.1 {
        graph
            .add_edge(src, tgt, edge(&key, eid, src, tgt, rel))
            .unwrap();
    }

    let memory = Arc::new(MemorySystem::new_in_memory().unwrap());
    (
        StructuredAssembler::new(memory, Some(Arc::new(graph))),
        dir,
    )
}

/// `AuthService -[calls]-> TokenValidator`
fn auth_fixture() -> (StructuredAssembler, TempDir) {
    build((
        vec![("AuthService", "Class"), ("TokenValidator", "Class")],
        vec![("e1", "AuthService", "TokenValidator", "calls")],
    ))
}

#[test]
fn kg_relations_are_attached_to_namespaced_nodes() {
    let (assembler, dir) = auth_fixture();

    let elements = assembler
        .assemble(
            "sess-kg-1",
            Some("AuthService"),
            4000,
            dir.path().to_str().unwrap(),
            true,
            TaskPhase::Execute,
        )
        .expect("assemble must succeed");

    // The entity is stored under the namespaced key, never the bare id.
    let key = "kg:Class:AuthService";
    let source = elements
        .get(key)
        .unwrap_or_else(|| panic!("expected node {key}; got keys {:?}", elements.keys()));

    assert!(
        !source.entity_assocs.is_empty(),
        "KG relation must be attached to {key}; entity_assocs was empty, which means \
         the bare id `AuthService` failed to resolve to the namespaced node key"
    );
    assert!(
        source
            .entity_assocs
            .iter()
            .any(|a| a.entity_id == "TokenValidator" && a.role == "calls"),
        "expected a `calls -> TokenValidator` association, got {:?}",
        source.entity_assocs
    );
}

#[test]
fn bare_entity_id_is_never_used_as_a_node_key() {
    // Locks the ID-space contract itself: if someone reverts to inserting KG
    // entities under their bare id, this fails and the mapping becomes moot.
    let (assembler, dir) = auth_fixture();

    let elements = assembler
        .assemble(
            "sess-kg-2",
            Some("AuthService"),
            4000,
            dir.path().to_str().unwrap(),
            true,
            TaskPhase::Execute,
        )
        .expect("assemble must succeed");

    assert!(
        !elements.contains_key("AuthService"),
        "KG entities must be namespaced as kg:{{type}}:{{id}}, not stored under a bare id"
    );
    assert!(
        elements.keys().any(|k| k.starts_with("kg:")),
        "expected at least one namespaced KG element; got {:?}",
        elements.keys()
    );
}

#[test]
fn every_outgoing_relation_is_attached() {
    // The bare-id → node-key mapping is one-to-many; no relation may be lost.
    let (assembler, dir) = build((
        vec![
            ("Handler", "Class"),
            ("Logger", "Class"),
            ("Config", "Module"),
        ],
        vec![
            ("e1", "Handler", "Logger", "uses"),
            ("e2", "Handler", "Config", "reads"),
        ],
    ));

    let elements = assembler
        .assemble(
            "sess-kg-3",
            Some("Handler"),
            4000,
            dir.path().to_str().unwrap(),
            true,
            TaskPhase::Execute,
        )
        .expect("assemble must succeed");

    let source = elements
        .get("kg:Class:Handler")
        .unwrap_or_else(|| panic!("Handler node must exist; got {:?}", elements.keys()));
    let targets: Vec<&str> = source
        .entity_assocs
        .iter()
        .map(|a| a.entity_id.as_str())
        .collect();

    assert!(
        targets.contains(&"Logger") && targets.contains(&"Config"),
        "all outgoing relations must be attached, got {targets:?}"
    );
}

#[test]
fn assembled_active_elements_are_sectioned() {
    // Cross-check of the section_num fix at the real `assemble` boundary:
    // every active element must leave the assembler with a positive section
    // number, otherwise the graph-layer detectors that gate on
    // `section_num > 0` stay dead in production.
    let (assembler, dir) = auth_fixture();

    let elements = assembler
        .assemble(
            "sess-kg-4",
            Some("AuthService"),
            4000,
            dir.path().to_str().unwrap(),
            true,
            TaskPhase::Execute,
        )
        .expect("assemble must succeed");

    let actives: Vec<_> = elements
        .values()
        .filter(|e| e.role == ElementRole::Active)
        .collect();
    assert!(
        !actives.is_empty(),
        "fixture should produce at least one active element; got {:?}",
        elements.keys()
    );
    for e in &actives {
        assert!(
            e.section_num > 0,
            "active element {} left unsectioned (section_num=0)",
            e.id
        );
    }

    // Non-active elements must stay at 0 (= globally applicable).
    for e in elements.values() {
        if e.role != ElementRole::Active {
            assert_eq!(
                e.section_num, 0,
                "non-active element {} must remain unsectioned",
                e.id
            );
        }
    }

    // Section numbers must be a contiguous 1..=n permutation.
    let mut nums: Vec<i64> = actives.iter().map(|e| e.section_num).collect();
    nums.sort_unstable();
    let expected: Vec<i64> = (1..=actives.len() as i64).collect();
    assert_eq!(nums, expected, "section numbers must be contiguous and 1-based");
}

#[test]
fn assemble_is_deterministic_for_identical_input() {
    // End-to-end determinism: identical inputs must yield identical element
    // ids, roles and section numbers.
    let (assembler, dir) = auth_fixture();
    let path = dir.path().to_str().unwrap();

    let snapshot = |a: &StructuredAssembler| {
        let e = a
            .assemble("sess-kg-5", Some("AuthService"), 4000, path, true, TaskPhase::Execute)
            .unwrap();
        let mut v: Vec<(String, i64, String)> = e
            .into_iter()
            .map(|(k, el)| (k, el.section_num, format!("{:?}", el.role)))
            .collect();
        v.sort();
        v
    };

    let baseline = snapshot(&assembler);
    for _ in 0..8 {
        assert_eq!(snapshot(&assembler), baseline);
    }
}

#[test]
fn kg_disabled_yields_no_kg_elements() {
    // Guard the opposite direction: the mapping must not cause KG elements to
    // appear when KG retrieval is switched off.
    let (assembler, dir) = auth_fixture();

    let elements = assembler
        .assemble(
            "sess-kg-6",
            Some("AuthService"),
            4000,
            dir.path().to_str().unwrap(),
            false,
            TaskPhase::Execute,
        )
        .expect("assemble must succeed");

    assert!(
        !elements.keys().any(|k| k.starts_with("kg:")),
        "kg_enabled=false must not inject KG elements; got {:?}",
        elements.keys()
    );
}

#[test]
fn missing_user_message_disables_kg_retrieval() {
    // `assemble` gates KG retrieval on `user_message.is_some()`. This pins the
    // contract that `agentic_loop` previously violated by passing `None`.
    let (assembler, dir) = auth_fixture();

    let elements = assembler
        .assemble("sess-kg-7", None, 4000, dir.path().to_str().unwrap(), true, TaskPhase::Execute)
        .expect("assemble must succeed");

    assert!(
        !elements.keys().any(|k| k.starts_with("kg:")),
        "a None user_message must not produce KG elements; got {:?}",
        elements.keys()
    );
}
