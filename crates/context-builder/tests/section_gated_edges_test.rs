//! Regression: the `section_num > 0` gate in the graph layer.
//!
//! Three edge detectors in `graph.rs` filter their input on `section_num > 0`:
//! `build_causal_chain`, `detect_arc_edges` and `detect_background_edges` (the
//! last one requires *active* elements to be sectioned). Every `make_element`
//! call site in the assembler leaves `section_num` at 0, so all three returned
//! nothing in production until the assembler started assigning section numbers
//! centrally.
//!
//! (`detect_foreshadow_edges` was removed entirely — it filtered on
//! `r#type == "todo"/"pending"`, types the assembler never produces.)
//!
//! These tests pin the gate itself, independently of the assembler, so that a
//! future change to either side is caught.

use context_builder::graph;
use duo_types::{ElementRole, EntityAssociation, NarrativeElement};

fn elem(
    id: &str,
    ty: &str,
    role: ElementRole,
    section_num: i64,
    status: Option<&str>,
) -> NarrativeElement {
    NarrativeElement {
        id: id.to_string(),
        r#type: ty.to_string(),
        role,
        priority: 0.5,
        content: format!("content for {id}"),
        source: "test".to_string(),
        sub_elements: vec![],
        discourse_links: vec![],
        entity_assocs: vec![EntityAssociation {
            entity_id: "shared_module".to_string(),
            target_type: "module".to_string(),
            role: "uses".to_string(),
            relevance: 0.9,
        }],
        tokens: 10.0,
        is_hard_rule: false,
        section_num,
        volume_num: 0,
        status: status.map(|s| s.to_string()),
    }
}

/// Active narrative elements of the shapes each detector looks for, plus a
/// background element. `sectioned` toggles between the old all-zero state and
/// the assigned state.
fn corpus(sectioned: bool) -> Vec<NarrativeElement> {
    let n = |i: usize| if sectioned { i as i64 + 1 } else { 0 };
    vec![
        elem("todo:1", "todo", ElementRole::Active, n(0), Some("pending")),
        elem("todo:2", "todo", ElementRole::Active, n(1), Some("pending")),
        elem("time:1", "timeline", ElementRole::Active, n(2), Some("done")),
        elem("time:2", "timeline", ElementRole::Active, n(3), Some("done")),
        elem("goal:1", "goal_progress", ElementRole::Active, n(4), None),
        elem("goal:2", "goal_progress", ElementRole::Active, n(5), None),
        elem("bg:1", "background", ElementRole::Background, 0, None),
    ]
}

#[test]
fn unsectioned_elements_produce_no_gated_edges() {
    // Documents the defect: this is exactly what production used to look like.
    let els = corpus(false);
    assert_eq!(
        graph::build_causal_chain(&els).len(),
        0,
        "causal chain requires section_num > 0"
    );
    assert_eq!(
        graph::detect_arc_edges(&els).len(),
        0,
        "arc requires section_num > 0"
    );
    assert_eq!(
        graph::detect_background_edges(&els).len(),
        0,
        "background edges require sectioned active elements"
    );
}

#[test]
fn sectioned_elements_revive_the_gated_detectors() {
    let els = corpus(true);
    assert!(
        !graph::build_causal_chain(&els).is_empty(),
        "causal chain must produce edges once elements are sectioned"
    );
    assert!(
        !graph::detect_arc_edges(&els).is_empty(),
        "arc detection must produce edges once elements are sectioned"
    );
    assert!(
        !graph::detect_background_edges(&els).is_empty(),
        "background edges must appear once active elements are sectioned"
    );
}

#[test]
fn background_elements_stay_global_at_section_zero() {
    // `detect_background_edges` treats a background element with
    // `section_num == 0` as applying to every section. Numbering background
    // elements would silently narrow them to one section.
    let sectioned = corpus(true);
    let global_bg_edges = graph::detect_background_edges(&sectioned).len();

    let mut narrowed = corpus(true);
    for e in narrowed.iter_mut() {
        if e.role == ElementRole::Background {
            e.section_num = 1;
        }
    }
    let narrowed_edges = graph::detect_background_edges(&narrowed).len();

    assert!(
        global_bg_edges > narrowed_edges,
        "a section-0 background must reach more sections than a pinned one \
         (global={global_bg_edges}, pinned={narrowed_edges})"
    );
}

#[test]
fn contrast_detection_survives_sectioning() {
    // `detect_contrast_edges` pairs elements that SHARE a section number.
    // Giving every element a distinct number would nearly eliminate contrast
    // edges — the reason non-active elements deliberately stay at 0.
    let all_distinct: Vec<NarrativeElement> = (0..6)
        .map(|i| {
            elem(
                &format!("c:{i}"),
                "constraint",
                ElementRole::Constraint,
                i as i64 + 1,
                None,
            )
        })
        .collect();
    let all_shared: Vec<NarrativeElement> = (0..6)
        .map(|i| {
            elem(
                &format!("c:{i}"),
                "constraint",
                ElementRole::Constraint,
                0,
                None,
            )
        })
        .collect();

    assert!(
        graph::detect_contrast_edges(&all_shared).len()
            >= graph::detect_contrast_edges(&all_distinct).len(),
        "elements sharing a section must not detect fewer contrasts than fully distinct ones"
    );
}

#[test]
fn edge_detection_is_order_independent_for_sectioned_input() {
    // The production call sites feed these detectors from `HashMap::into_values()`.
    // With section numbers assigned, the resulting edge SET must not depend on
    // the order the elements arrive in.
    let mut a = corpus(true);
    let mut b = corpus(true);
    b.reverse();

    let key = |els: &mut Vec<NarrativeElement>| {
        let mut edges: Vec<String> = graph::build_causal_chain(els)
            .into_iter()
            .chain(graph::detect_arc_edges(els))
            .chain(graph::detect_background_edges(els))
            .map(|e| format!("{}->{}:{:?}", e.source, e.target, e.relation))
            .collect();
        edges.sort();
        edges
    };

    assert_eq!(key(&mut a), key(&mut b));
}
