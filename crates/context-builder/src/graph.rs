use duo_types::renderer::{
    ElementRole, NarrativeElement, RhetoricEdge, RhetoricGraph, RstRelation,
};
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

// ============ Edge Weight Constants (matching TS graph.ts L27-33) ============

const WEIGHT_CAUSAL: f64 = 0.8;
const WEIGHT_SEQUENCE: f64 = 0.8; // TS uses WEIGHT_CAUSAL for sequence too
const WEIGHT_CONTRAST: f64 = 0.7;
const WEIGHT_CONDITION: f64 = 0.6;
const WEIGHT_ELABORATION: f64 = 0.5;
const WEIGHT_SUMMARY: f64 = 0.5;
const WEIGHT_ARC: f64 = 0.5;
const WEIGHT_IMPLICIT: f64 = 0.3;
const WEIGHT_BACKGROUND: f64 = 0.5;

// ============ Edge Factory (mirrors TS makeEdge, graph.ts L42-51) ============

#[allow(clippy::too_many_arguments)]
fn make_edge(
    source: &str,
    target: &str,
    relation: RstRelation,
    label: String,
    weight: f64,
    is_bidirectional: Option<bool>,
) -> RhetoricEdge {
    RhetoricEdge {
        source: source.to_string(),
        target: target.to_string(),
        relation,
        weight,
        label,
        is_bidirectional,
    }
}

// ============ Pattern Definitions ============

static CONTRAST_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let patterns = [
        r"(?i)\bhowever\b",
        r"(?i)\bbut\b",
        r"(?i)\balthough\b",
        r"(?i)\bnevertheless\b",
        r"(?i)\bon the other hand\b",
        r"(?i)\bin contrast\b",
        r"(?i)\bconversely\b",
        r"(?i)\bwhereas\b",
        "然而",
        "但是",
        "不过",
        "反之",
        "相比之下",
        r"(?i)\bwhile\b",
        r"(?i)\byet\b",
        r"(?i)\bnonetheless\b",
        r"(?i)\binstead\b",
        r"(?i)\bdespite\b",
    ];
    patterns.iter().filter_map(|p| Regex::new(p).ok()).collect()
});

static CAUSE_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let patterns = [
        r"(?i)\bbecause\b",
        r"(?i)\bsince\b",
        r"(?i)\bdue to\b",
        r"(?i)\bas a result of\b",
        r"(?i)\bcaused by\b",
        r"(?i)\bleads to\b",
        r"(?i)\bresulting in\b",
        "因为",
        "由于",
        "导致",
        "归因于",
    ];
    patterns.iter().filter_map(|p| Regex::new(p).ok()).collect()
});

static RESULT_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let patterns = [
        r"(?i)\btherefore\b",
        r"(?i)\bthus\b",
        r"(?i)\bhence\b",
        r"(?i)\bconsequently\b",
        r"(?i)\bas a result\b",
        r"(?i)\bso that\b",
        r"(?i)\bleading to\b",
        "因此",
        "所以",
        "因而",
        "由此可见",
    ];
    patterns.iter().filter_map(|p| Regex::new(p).ok()).collect()
});

static SEQUENCE_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let patterns = [
        r"(?i)\bfirst\b",
        r"(?i)\bthen\b",
        r"(?i)\bnext\b",
        r"(?i)\bafter\b",
        r"(?i)\bbefore\b",
        r"(?i)\bfinally\b",
        r"(?i)\bsubsequently\b",
        r"(?i)\bmeanwhile\b",
        r"(?i)\bpreviously\b",
        "首先",
        "其次",
        "然后",
        "最后",
        "随后",
        r"(?i)\blater\b",
    ];
    patterns.iter().filter_map(|p| Regex::new(p).ok()).collect()
});

static ELABORATION_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let patterns = [
        r"(?i)\bfor example\b",
        r"(?i)\bfor instance\b",
        r"(?i)\bspecifically\b",
        r"(?i)\bin particular\b",
        r"(?i)\bnamely\b",
        r"(?i)\bsuch as\b",
        r"(?i)\bincluding\b",
        r"(?i)\bthat is\b",
        "例如",
        "譬如",
        "具体来说",
        "也就是说",
    ];
    patterns.iter().filter_map(|p| Regex::new(p).ok()).collect()
});

static CONDITION_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let patterns = [
        r"(?i)\bif\b",
        r"(?i)\bunless\b",
        r"(?i)\bprovided that\b",
        r"(?i)\bassuming\b",
        r"(?i)\bin case\b",
        r"(?i)\bwhen\b",
        r"(?i)\bwhenever\b",
        r"(?i)\bonly if\b",
        r"(?i)\bas long as\b",
        "如果",
        "假如",
        "若",
        "除非",
        "只要",
    ];
    patterns.iter().filter_map(|p| Regex::new(p).ok()).collect()
});

static SUMMARY_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let patterns = [
        r"(?i)\bin summary\b",
        r"(?i)\bin conclusion\b",
        r"(?i)\bto summarize\b",
        r"(?i)\bto sum up\b",
        r"(?i)\boverall\b",
        r"(?i)\bin short\b",
        r"(?i)\bbriefly\b",
        r"(?i)\bin brief\b",
        r"(?i)\bto conclude\b",
        "总之",
        "综上",
        "概括来说",
        "简而言之",
    ];
    patterns.iter().filter_map(|p| Regex::new(p).ok()).collect()
});

// ============ §5.2.1 Causal Chain (T23 — mirrors TS buildCausalChain) ============

/// Detect cause/result/sequence edges based on `section_num` continuity.
///
/// Mirrors TS `buildCausalChain` (graph.ts L55-100). Only elements with
/// `section_num > 0` and type `timeline` or `causal_chain` participate in
/// cause/result edges. All sectioned elements participate in sequence edges.
pub fn build_causal_chain(elements: &[NarrativeElement]) -> Vec<RhetoricEdge> {
    let mut edges = Vec::new();

    // Filter and sort sectioned elements by section_num
    let mut sectioned: Vec<&NarrativeElement> = elements
        .iter()
        .filter(|e| e.section_num > 0)
        .collect();
    sectioned.sort_by_key(|e| e.section_num);

    // Loop B: sequence edges for all adjacent sectioned elements
    for i in 0..sectioned.len().saturating_sub(1) {
        let current = sectioned[i];
        let next = sectioned[i + 1];
        if next.section_num == current.section_num + 1 {
            edges.push(make_edge(
                &current.id,
                &next.id,
                RstRelation::Sequence,
                format!(
                    "Section {} → {} sequence",
                    current.section_num, next.section_num
                ),
                WEIGHT_SEQUENCE,
                None,
            ));
        }
    }

    edges
}

// ============ §5.2.5 Contrast Edges (T24 — two-layer detection) ============

/// Detect contrast edges using two-layer detection.
///
/// Mirrors TS `buildContrastFromExpectation` (graph.ts L235-276):
/// - Layer 1: elements with contrast patterns connect to same-section peers
/// - Layer 2: `has_conflicting_assocs` detects same target_id with different
///   target_type → Contrast edge
///
/// Note: This replaces the old global-pairing approach. It now operates on
/// full `NarrativeElement` values (not just (id, content) pairs) to access
/// `section_num` and `entity_assocs`.
pub fn detect_contrast_edges(elements: &[NarrativeElement]) -> Vec<RhetoricEdge> {
    let mut edges = Vec::new();

    // Layer 1: content pattern + same-section peer
    let contrast_elements: Vec<&NarrativeElement> = elements
        .iter()
        .filter(|e| CONTRAST_PATTERNS.iter().any(|r| r.is_match(&e.content)))
        .collect();

    for ce in &contrast_elements {
        for peer in elements {
            if peer.id == ce.id {
                continue;
            }
            // Only connect same-section peers
            if peer.section_num != ce.section_num {
                continue;
            }
            edges.push(make_edge(
                &ce.id,
                &peer.id,
                RstRelation::Contrast,
                format!("Contrast: {} vs {}", ce.id, peer.id),
                WEIGHT_CONTRAST,
                None,
            ));
        }
    }

    // Layer 2: conflicting entity associations
    let assoc_elements: Vec<&NarrativeElement> =
        elements.iter().filter(|e| !e.entity_assocs.is_empty()).collect();

    for i in 0..assoc_elements.len() {
        for j in (i + 1)..assoc_elements.len() {
            let a = assoc_elements[i];
            let b = assoc_elements[j];
            if has_conflicting_assocs(a, b) {
                edges.push(make_edge(
                    &a.id,
                    &b.id,
                    RstRelation::Contrast,
                    format!(
                        "Contrast: conflicting associations between {} and {}",
                        a.id, b.id
                    ),
                    WEIGHT_CONTRAST,
                    None,
                ));
            }
        }
    }

    edges
}

/// Check if two elements have conflicting entity associations.
///
/// Mirrors TS `hasConflictingAssocs` (graph.ts L387-405): same `target_id`
/// but different `target_type` → conflict.
fn has_conflicting_assocs(a: &NarrativeElement, b: &NarrativeElement) -> bool {
    // Build a's target_id → target_type map
    let mut a_map: HashMap<String, String> = HashMap::new();
    for assoc in &a.entity_assocs {
        a_map.insert(assoc.entity_id.clone(), assoc.target_type.clone());
    }
    // Check b's assocs for same target_id with different target_type
    for assoc in &b.entity_assocs {
        if let Some(a_type) = a_map.get(&assoc.entity_id)
            && a_type != &assoc.target_type {
                return true;
            }
    }
    false
}

// ============ Regex-based Edge Detectors (content patterns) ============
// These complement the structural detectors above. They operate on (id, content)
// pairs for simple pattern matching without needing full NarrativeElement data.

/// Detect cause edges: element A with a cause pattern is the source of a
/// causal relationship to subsequent elements.
pub fn detect_cause_edges(element_contents: &[(String, String)]) -> Vec<RhetoricEdge> {
    let mut edges = Vec::new();
    for (i, (id_a, content_a)) in element_contents.iter().enumerate() {
        if CAUSE_PATTERNS.iter().any(|r| r.is_match(content_a)) {
            // P2-27: link to the NEXT element only. The original loop fanned
            // out to every later element — an O(N²) Cartesian product whose
            // extra edges are rhetoric noise (and which the renderer then
            // duplicated into annotations without budget accounting).
            if let Some((id_b, _)) = element_contents.get(i + 1) {
                edges.push(make_edge(
                    id_a,
                    id_b,
                    RstRelation::Cause,
                    String::new(),
                    WEIGHT_CAUSAL,
                    None,
                ));
            }
        }
    }
    edges
}

/// Detect result edges: element A with a result pattern indicates A is the
/// consequence of the preceding element B (edge A → B with Result relation).
pub fn detect_result_edges(element_contents: &[(String, String)]) -> Vec<RhetoricEdge> {
    let mut edges = Vec::new();
    for i in 0..element_contents.len() {
        let (id_a, content_a) = &element_contents[i];
        if RESULT_PATTERNS.iter().any(|r| r.is_match(content_a))
            && i > 0 {
                let (id_b, _) = &element_contents[i - 1];
                edges.push(make_edge(
                    id_a,
                    id_b,
                    RstRelation::Result,
                    String::new(),
                    WEIGHT_CAUSAL,
                    None,
                ));
            }
    }
    edges
}

/// Detect sequence edges between adjacent elements with temporal markers.
pub fn detect_sequence_edges(element_contents: &[(String, String)]) -> Vec<RhetoricEdge> {
    let mut edges = Vec::new();
    for i in 0..element_contents.len().saturating_sub(1) {
        let (id_a, content_a) = &element_contents[i];
        let (id_b, content_b) = &element_contents[i + 1];
        let a_has = SEQUENCE_PATTERNS.iter().any(|r| r.is_match(content_a));
        let b_has = SEQUENCE_PATTERNS.iter().any(|r| r.is_match(content_b));
        if a_has || b_has {
            edges.push(make_edge(
                id_a,
                id_b,
                RstRelation::Sequence,
                String::new(),
                WEIGHT_SEQUENCE,
                None,
            ));
        }
    }
    edges
}

/// Detect elaboration edges: element A with an elaboration pattern
/// (for example, specifically, …) elaborates on subsequent elements.
pub fn detect_elaboration_edges(element_contents: &[(String, String)]) -> Vec<RhetoricEdge> {
    let mut edges = Vec::new();
    for (i, (id_a, content_a)) in element_contents.iter().enumerate() {
        if ELABORATION_PATTERNS.iter().any(|r| r.is_match(content_a)) {
            // P2-27: adjacent element only (see detect_cause_edges).
            if let Some((id_b, _)) = element_contents.get(i + 1) {
                edges.push(make_edge(
                    id_a,
                    id_b,
                    RstRelation::Elaboration,
                    String::new(),
                    WEIGHT_ELABORATION,
                    None,
                ));
            }
        }
    }
    edges
}

/// Detect condition edges: element A with a condition pattern (if, unless, …)
/// is a prerequisite for subsequent elements.
pub fn detect_condition_edges(element_contents: &[(String, String)]) -> Vec<RhetoricEdge> {
    let mut edges = Vec::new();
    for (i, (id_a, content_a)) in element_contents.iter().enumerate() {
        if CONDITION_PATTERNS.iter().any(|r| r.is_match(content_a)) {
            // P2-27: adjacent element only (see detect_cause_edges).
            if let Some((id_b, _)) = element_contents.get(i + 1) {
                edges.push(make_edge(
                    id_a,
                    id_b,
                    RstRelation::Condition,
                    String::new(),
                    WEIGHT_CONDITION,
                    None,
                ));
            }
        }
    }
    edges
}

/// Detect summary edges: element A with a summary pattern (in conclusion, …)
/// summarizes the preceding elements.
pub fn detect_summary_edges(element_contents: &[(String, String)]) -> Vec<RhetoricEdge> {
    let mut edges = Vec::new();
    for (i, (id_a, content_a)) in element_contents.iter().enumerate() {
        if SUMMARY_PATTERNS.iter().any(|r| r.is_match(content_a)) {
            // P2-27: summarize the PRECEDING element, not every earlier one.
            if i > 0 {
                let (id_b, _) = &element_contents[i - 1];
                edges.push(make_edge(
                    id_a,
                    id_b,
                    RstRelation::Summary,
                    String::new(),
                    WEIGHT_SUMMARY,
                    None,
                ));
            }
        }
    }
    edges
}

// ============ §5.2.3 Development Arc Edges ============

/// Detect development arc edges: goal_progress elements get goal_progress self-edges,
/// and entity elements sharing entity_assocs with arc elements get motivation edges.
///
/// Mirrors TS `buildArcRelations`.
pub fn detect_arc_edges(elements: &[NarrativeElement]) -> Vec<RhetoricEdge> {
    let mut edges = Vec::new();

    let arc_elements: Vec<&NarrativeElement> = elements
        .iter()
        .filter(|e| e.r#type == "goal_progress" && e.section_num > 0)
        .collect();

    // arc_progress: development arc at section K
    for arc in &arc_elements {
        edges.push(make_edge(
            &arc.id,
            &arc.id,
            RstRelation::GoalProgress,
            format!("Goal progress: {} at section {}", arc.id, arc.section_num),
            WEIGHT_ARC,
            None,
        ));
    }

    // NOTE: the old motivation branch (entity elements sharing entity_assocs
    // with arc elements) is removed — it filtered on `r#type == "entity"`, a
    // type the assembler never produces (it emits `module_entity` /
    // `kg_entity` / ...), so the branch could never fire.

    edges
}

// ============ §5.4 Implicit Edges from Shared EntityAssociation ============

/// Detect implicit edges: elements sharing the same entity association target_id
/// get bidirectional evidence edges.
///
/// Mirrors TS `buildImplicitRelations`.
pub fn detect_implicit_edges(elements: &[NarrativeElement]) -> Vec<RhetoricEdge> {
    let mut edges = Vec::new();

    // Build target_map: target_id → elements that reference it
    let mut target_map: HashMap<String, Vec<&NarrativeElement>> = HashMap::new();
    for element in elements {
        for assoc in &element.entity_assocs {
            target_map
                .entry(assoc.entity_id.clone())
                .or_default()
                .push(element);
        }
    }

    // For each target with 2+ elements, add bidirectional evidence edges
    for (target_id, linked_elements) in &target_map {
        if linked_elements.len() < 2 {
            continue;
        }
        for i in 0..linked_elements.len() {
            for j in (i + 1)..linked_elements.len() {
                let a = linked_elements[i];
                let b = linked_elements[j];
                edges.push(make_edge(
                    &a.id,
                    &b.id,
                    RstRelation::Evidence,
                    format!("Implicit link via shared entity {}", target_id),
                    WEIGHT_IMPLICIT,
                    Some(true),
                ));
                edges.push(make_edge(
                    &b.id,
                    &a.id,
                    RstRelation::Evidence,
                    format!("Implicit link via shared entity {}", target_id),
                    WEIGHT_IMPLICIT,
                    Some(true),
                ));
            }
        }
    }

    edges
}

// ============ §5.2.7 Background Edges ============

/// Detect background edges: constraint/background elements provide background
/// for active elements in the same section, or globally if section_num == 0.
///
/// Mirrors TS `buildBackgroundRelations`.
pub fn detect_background_edges(elements: &[NarrativeElement]) -> Vec<RhetoricEdge> {
    let mut edges = Vec::new();

    let bg_elements: Vec<&NarrativeElement> = elements
        .iter()
        .filter(|e| e.role == ElementRole::Constraint || e.r#type == "background")
        .collect();
    let active_elements: Vec<&NarrativeElement> = elements
        .iter()
        .filter(|e| {
            e.role != ElementRole::Constraint && e.r#type != "background" && e.section_num > 0
        })
        .collect();

    for bg in &bg_elements {
        for active in &active_elements {
            // Linked via shared section_num
            if bg.section_num == active.section_num && bg.section_num > 0 {
                edges.push(make_edge(
                    &bg.id,
                    &active.id,
                    RstRelation::Background,
                    format!("{} provides background for {}", bg.id, active.id),
                    WEIGHT_BACKGROUND,
                    None,
                ));
            }
            // Background elements with section_num 0 apply globally
            if bg.section_num == 0 {
                edges.push(make_edge(
                    &bg.id,
                    &active.id,
                    RstRelation::Background,
                    format!("{} provides global background for {}", bg.id, active.id),
                    WEIGHT_BACKGROUND,
                    None,
                ));
            }
        }
    }

    edges
}

// ============ Utility Functions ============

// ============ Graph Builder ============

///
/// Populates both `nodes` and `edges`. Runs the full edge detection pipeline:
/// 1. Structural detectors (causal chain, foreshadow, arc, entity-section,
///    contrast two-layer, implicit, background) — mirror TS `build()` order
/// 2. Content-pattern detectors (cause/result/sequence/elaboration/condition/summary)
///    as supplementary regex-based detection
/// 3. Deduplicate edges (same source+target+relation → keep higher weight)
/// 4. Write back discourse_links to each source element (T25)
pub fn build_rhetoric_graph_from_elements(elements: &[NarrativeElement]) -> RhetoricGraph {
    // Extract (id, content) pairs for content-pattern detectors
    let element_contents: Vec<(String, String)> = elements
        .iter()
        .map(|e| (e.id.clone(), e.content.clone()))
        .collect();

    let mut edges = Vec::new();

    // Structural detectors (mirror TS build() order, graph.ts L435-460).
    // The old foreshadow / entity-section detectors were removed: they filtered
    // on `r#type == "todo"/"pending"/"entity"`, types the assembler never
    // produces (its full type inventory lives in 机制缺陷.md §1.6).
    edges.extend(build_causal_chain(elements)); // T23
    edges.extend(detect_arc_edges(elements));
    edges.extend(detect_contrast_edges(elements)); // T24 (now element-aware, two-layer)
    edges.extend(detect_implicit_edges(elements));
    edges.extend(detect_background_edges(elements));

    // Content-pattern detectors (supplementary, regex-based)
    edges.extend(detect_cause_edges(&element_contents));
    edges.extend(detect_result_edges(&element_contents));
    edges.extend(detect_sequence_edges(&element_contents));
    edges.extend(detect_elaboration_edges(&element_contents));
    edges.extend(detect_condition_edges(&element_contents));
    edges.extend(detect_summary_edges(&element_contents));

    // Deduplicate edges: same source+target+relation → keep the one with higher weight
    let mut seen: HashMap<(String, String, String), usize> = HashMap::new();
    let mut deduped: Vec<RhetoricEdge> = Vec::new();
    for edge in &edges {
        let key = (
            edge.source.clone(),
            edge.target.clone(),
            format!("{:?}", edge.relation),
        );
        if let Some(&prev_idx) = seen.get(&key) {
            if edge.weight > deduped[prev_idx].weight {
                deduped[prev_idx] = edge.clone();
            }
        } else {
            seen.insert(key, deduped.len());
            deduped.push(edge.clone());
        }
    }

    // Write back discourse_links to each source element (T25)
    // Build a lookup for target element types (T25 fix: target_type should be target.type)
    let element_type_map: HashMap<String, String> =
        elements.iter().map(|e| (e.id.clone(), e.r#type.clone())).collect();

    let mut nodes: HashMap<String, NarrativeElement> =
        elements.iter().map(|e| (e.id.clone(), e.clone())).collect();
    for edge in &deduped {
        if let Some(source_elem) = nodes.get_mut(&edge.source) {
            let target_type = element_type_map
                .get(&edge.target)
                .cloned()
                .unwrap_or_default();
            source_elem
                .discourse_links
                .push(duo_types::renderer::DiscourseLink {
                    target_id: edge.target.clone(),
                    target_type, // T25 fix: use target element's type, not empty string
                    relation: edge.relation.clone(),
                    is_nucleus: true,
                    label: edge.label.clone(),
                    weight: Some(edge.weight),
                });
        }
    }

    RhetoricGraph {
        nodes,
        edges: deduped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use duo_types::renderer::EntityAssociation;

    fn make_test_element(
        id: &str,
        type_: &str,
        role: ElementRole,
        content: &str,
        section_num: i64,
        status: Option<&str>,
        entity_assocs: Vec<EntityAssociation>,
    ) -> NarrativeElement {
        NarrativeElement {
            id: id.to_string(),
            r#type: type_.to_string(),
            role,
            priority: 0.5,
            content: content.to_string(),
            source: "test".to_string(),
            sub_elements: vec![],
            discourse_links: vec![],
            entity_assocs,
            tokens: 10.0,
            is_hard_rule: false,
            section_num,
            volume_num: 0,
            status: status.map(|s| s.to_string()),
        }
    }

    #[test]
    fn test_build_causal_chain() {
        let elements = vec![
            make_test_element(
                "a",
                "timeline",
                ElementRole::Active,
                "Event A",
                1,
                None,
                vec![],
            ),
            make_test_element(
                "b",
                "timeline",
                ElementRole::Active,
                "Event B",
                2,
                None,
                vec![],
            ),
            make_test_element(
                "c",
                "timeline",
                ElementRole::Active,
                "Event C",
                3,
                None,
                vec![],
            ),
        ];
        let edges = build_causal_chain(&elements);
        // Loop A (timeline cause/result) was removed — the assembler never
        // produces `timeline`/`causal_chain` elements. Loop B (sequence) is the
        // only surviving behavior: a→b and b→c sequence edges.
        assert_eq!(edges.len(), 2, "only the two sequence edges survive");
        assert!(edges.iter().any(|e| matches!(e.relation, RstRelation::Sequence) && e.source == "a" && e.target == "b"));
        assert!(edges.iter().any(|e| matches!(e.relation, RstRelation::Sequence) && e.source == "b" && e.target == "c"));
    }

    /// Regression (P2-27): a cause-pattern element links to the NEXT element
    /// only. The original loop fanned out to every later element, producing an
    /// O(N²) Cartesian product of rhetoric noise that the renderer then fed to
    /// the model as discourse structure.
    #[test]
    fn cause_edges_link_only_the_next_element() {
        let contents: Vec<(String, String)> = vec![
            ("a".to_string(), "Because the config is missing".to_string()),
            ("b".to_string(), "the build fails".to_string()),
            ("c".to_string(), "the user is blocked".to_string()),
            ("d".to_string(), "so we patch it".to_string()),
        ];
        let edges = detect_cause_edges(&contents);
        assert_eq!(
            edges.len(),
            1,
            "only the immediately-following element may be linked; got {:?}",
            edges
                .iter()
                .map(|e| (e.source.as_str(), e.target.as_str()))
                .collect::<Vec<_>>()
        );
        assert_eq!(edges[0].source, "a");
        assert_eq!(edges[0].target, "b");
    }

    /// A cause-pattern element in the LAST position has no next element, so it
    /// must produce no edge at all (rather than an edge to itself or to a
    /// wrapped-around neighbour).
    #[test]
    fn cause_edge_on_the_last_element_is_not_emitted() {
        let contents: Vec<(String, String)> = vec![
            ("a".to_string(), "plain statement".to_string()),
            ("b".to_string(), "because the tail is not a cause".to_string()),
        ];
        assert!(detect_cause_edges(&contents).is_empty());
    }

    #[test]
    fn test_detect_contrast_two_layer() {
        // Layer 1: same-section peer with contrast pattern
        let elements = vec![
            make_test_element(
                "a",
                "event",
                ElementRole::Active,
                "However this is different",
                1,
                None,
                vec![],
            ),
            make_test_element(
                "b",
                "event",
                ElementRole::Active,
                "Normal content",
                1,
                None,
                vec![],
            ),
            make_test_element(
                "c",
                "event",
                ElementRole::Active,
                "Other content",
                2,
                None,
                vec![],
            ),
        ];
        let edges = detect_contrast_edges(&elements);
        // a (section 1, has contrast) → b (section 1, peer). Not → c (different section)
        assert!(edges.iter().any(|e| e.source == "a" && e.target == "b"));
        assert!(!edges.iter().any(|e| e.source == "a" && e.target == "c"));
    }

    #[test]
    fn test_has_conflicting_assocs() {
        let a = make_test_element(
            "a",
            "entity",
            ElementRole::Active,
            "Entity A",
            0,
            None,
            vec![EntityAssociation {
                entity_id: "target1".to_string(),
                target_type: "module".to_string(),
                role: String::new(),
                relevance: 1.0,
            }],
        );
        let b_conflict = make_test_element(
            "b",
            "entity",
            ElementRole::Active,
            "Entity B",
            0,
            None,
            vec![EntityAssociation {
                entity_id: "target1".to_string(),
                target_type: "function".to_string(), // different type → conflict
                role: String::new(),
                relevance: 1.0,
            }],
        );
        let b_no_conflict = make_test_element(
            "c",
            "entity",
            ElementRole::Active,
            "Entity C",
            0,
            None,
            vec![EntityAssociation {
                entity_id: "target1".to_string(),
                target_type: "module".to_string(), // same type → no conflict
                role: String::new(),
                relevance: 1.0,
            }],
        );
        assert!(has_conflicting_assocs(&a, &b_conflict));
        assert!(!has_conflicting_assocs(&a, &b_no_conflict));
    }

    #[test]
    fn test_detect_contrast_conflicting_assocs() {
        let elements = vec![
            make_test_element(
                "a",
                "entity",
                ElementRole::Active,
                "Entity A",
                0,
                None,
                vec![EntityAssociation {
                    entity_id: "shared".to_string(),
                    target_type: "module".to_string(),
                    role: String::new(),
                    relevance: 1.0,
                }],
            ),
            make_test_element(
                "b",
                "entity",
                ElementRole::Active,
                "Entity B",
                0,
                None,
                vec![EntityAssociation {
                    entity_id: "shared".to_string(),
                    target_type: "function".to_string(),
                    role: String::new(),
                    relevance: 1.0,
                }],
            ),
        ];
        let edges = detect_contrast_edges(&elements);
        // Layer 2 should detect conflicting assocs
        assert!(edges.iter().any(|e| matches!(e.relation, RstRelation::Contrast)));
    }

    #[test]
    fn test_discourse_links_target_type() {
        // T25 fix: discourse_links should have target_type = target element's type
        let elements = vec![
            make_test_element(
                "entity1",
                "entity",
                ElementRole::Active,
                "Entity detail",
                1,
                None,
                vec![EntityAssociation {
                    entity_id: "target_a".to_string(),
                    target_type: "module".to_string(),
                    role: String::new(),
                    relevance: 1.0,
                }],
            ),
            make_test_element(
                "evt1",
                "event",
                ElementRole::Active,
                "Event with entity",
                1,
                None,
                vec![EntityAssociation {
                    entity_id: "target_a".to_string(),
                    target_type: "module".to_string(),
                    role: String::new(),
                    relevance: 1.0,
                }],
            ),
        ];
        let graph = build_rhetoric_graph_from_elements(&elements);
        // entity1 should have discourse_links with target_type = "event" (evt1's type)
        let entity1 = graph.nodes.get("entity1").unwrap();
        assert!(
            entity1
                .discourse_links
                .iter()
                .any(|dl| dl.target_id == "evt1" && dl.target_type == "event")
        );
    }

    #[test]
    fn test_detect_implicit_edges_bidirectional() {
        let elements = vec![
            make_test_element(
                "a",
                "event",
                ElementRole::Active,
                "event A",
                1,
                None,
                vec![EntityAssociation {
                    entity_id: "shared".to_string(),
                    target_type: "person".to_string(),
                    role: String::new(),
                    relevance: 1.0,
                }],
            ),
            make_test_element(
                "b",
                "event",
                ElementRole::Active,
                "event B",
                2,
                None,
                vec![EntityAssociation {
                    entity_id: "shared".to_string(),
                    target_type: "person".to_string(),
                    role: String::new(),
                    relevance: 1.0,
                }],
            ),
        ];
        let edges = detect_implicit_edges(&elements);
        // Bidirectional evidence edges
        assert!(edges.iter().any(|e| e.source == "a" && e.target == "b" && e.is_bidirectional == Some(true)));
        assert!(edges.iter().any(|e| e.source == "b" && e.target == "a" && e.is_bidirectional == Some(true)));
    }

    #[test]
    fn test_detect_background_edges() {
        let elements = vec![
            make_test_element(
                "bg1",
                "background",
                ElementRole::Constraint,
                "World context",
                0,
                None,
                vec![],
            ),
            make_test_element(
                "act1",
                "event",
                ElementRole::Active,
                "An event happens",
                1,
                None,
                vec![],
            ),
        ];
        let edges = detect_background_edges(&elements);
        assert!(
            edges
                .iter()
                .any(|e| matches!(e.relation, RstRelation::Background)
                    && e.source == "bg1"
                    && e.target == "act1")
        );
    }

    #[test]
    fn test_build_rhetoric_graph_dedup() {
        let elements = vec![
            make_test_element(
                "a",
                "timeline",
                ElementRole::Active,
                "Because it rained",
                1,
                None,
                vec![],
            ),
            make_test_element(
                "b",
                "timeline",
                ElementRole::Active,
                "However the sky cleared",
                2,
                None,
                vec![],
            ),
        ];
        let graph = build_rhetoric_graph_from_elements(&elements);
        // Should have edges but no exact duplicates (same source+target+relation)
        let mut seen = std::collections::HashSet::new();
        for edge in &graph.edges {
            let key = (&edge.source, &edge.target, format!("{:?}", edge.relation));
            assert!(seen.insert(key.clone()), "Duplicate edge found: {:?}", key);
        }
    }
}
