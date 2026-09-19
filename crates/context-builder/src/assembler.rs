//! Context assembler module.
//!
//! Assembles context using a capacity-percentage budget approach:
//! - L4 (Profile) & L5 (Progressive) are injected first (non-truncatable)
//! - L1/L2/L3 are filled by percentage budget with truncation support
//! - KG (layer=-1) is populated from knowledge graph entity links + 1-hop traversal
//!
//! Includes preprocessing and security sanitization pipeline.

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use duo_types::{
    AssembledContext, ContextSource, CoreMemoryEntry, MemorySearchRequest, PatternEntry,
    PatternQueryRequest, layer_int_to_name,
};
use duo_utils::text::{estimate_tokens, truncate_to_token_budget};
use knowledge_graph_store::graph::KnowledgeGraphStore;
use knowledge_graph_store::project_key;
use memory_system::MemorySystem;
use regex::Regex;
use std::sync::LazyLock;

/// Builds an assembled context from the memory system.
pub struct ContextBuilder {
    memory: Arc<MemorySystem>,
    graph: Option<Arc<KnowledgeGraphStore>>,
}

/// Maximum number of entries to request per layer during search.
const PER_LAYER_LIMIT: usize = 50;

/// Layer budget configuration for capacity-percentage allocation.
struct LayerBudget {
    layer: i32,
    percentage: f64,
}

/// Budget allocation per layer: L4 & L5 are non-truncatable, rest is truncatable.
const LAYER_BUDGETS: [LayerBudget; 6] = [
    LayerBudget {
        layer: 4,
        percentage: 0.15,
    },
    LayerBudget {
        layer: 5,
        percentage: 0.05,
    },
    LayerBudget {
        layer: 1,
        percentage: 0.30,
    },
    LayerBudget {
        layer: 2,
        percentage: 0.25,
    },
    LayerBudget {
        layer: 3,
        percentage: 0.15,
    },
    LayerBudget {
        layer: -1,
        percentage: 0.10,
    },
];

/// PR-01: task intent used to dynamically rebalance the layer budget so that
/// simple single-file edits don't waste tokens on KG context while complex
/// cross-module refactors get more KG / semantic-memory budget.
#[derive(Clone, Copy, PartialEq, Eq)]
enum TaskIntent {
    /// Pure question / explanation — lean on semantic & permanent memory.
    Question,
    /// Localized edit (one or few files) — episode + permanent memory, little KG.
    EditLocal,
    /// Cross-module refactor / multi-file change — needs KG + semantic context.
    Refactor,
}

/// PR-01: keyword-based intent classification (heuristic, cheap, zero network).
/// Matches the report's "按 intent 分类动态调整预算" without a heavy classifier.
fn classify_task_intent(task: &str) -> TaskIntent {
    let t = task.to_lowercase();
    let refactor_kw = [
        "refactor",
        "restructure",
        "cross-module",
        "cross-file",
        "multiple files",
        "multi-file",
        "architecture",
        "redesign",
        "migrate",
    ];
    let edit_kw = [
        "edit",
        "fix",
        "bug",
        "patch",
        "update",
        "change",
        "add",
        "implement",
        "create",
        "write",
    ];
    let question_kw = ["why", "what is", "explain", "how does", "describe", "?", "difference between"];
    if refactor_kw.iter().any(|k| t.contains(k)) {
        return TaskIntent::Refactor;
    }
    if question_kw.iter().any(|k| t.contains(k)) && !edit_kw.iter().any(|k| t.contains(k)) {
        return TaskIntent::Question;
    }
    TaskIntent::EditLocal
}

/// PR-01: reallocates the 0.80 truncatable budget across L1/L2/L3/KG per intent.
/// L4 (0.15) and L5 (0.05) stay constant and non-truncatable.
/// Returns (L1, L2, L3, KG).
fn budget_percentages_for(intent: TaskIntent) -> (f64, f64, f64, f64) {
    match intent {
        // Question: KG has a small base budget so graph-backed answers (e.g. a
        // question about a known symbol) can surface when data exists; empty graph
        // results are dropped naturally at injection time, so this never wastes tokens.
        TaskIntent::Question => (0.15, 0.40, 0.20, 0.05),
        // Localized edit: episode (L1) dominant, with a small KG base for variable-level
        // context (rename/usage lookups) when the graph actually has data.
        TaskIntent::EditLocal => (0.35, 0.25, 0.15, 0.05),
        // Refactor: more KG + semantic for cross-module understanding.
        TaskIntent::Refactor => (0.25, 0.30, 0.10, 0.15),
    }
}

/// G-01: collect KG edges for an entity up to 2 hops (previously 1 hop only),
/// bounded per level to avoid graph explosion. Returns the formatted edge lines
/// and the set of distinct node TYPES encountered (used for coverage stats).
fn collect_kg_edges(
    graph_store: &KnowledgeGraphStore,
    entity_id: &str,
    project_id: &str,
) -> (Vec<String>, std::collections::HashSet<String>) {
    let mut lines = Vec::new();
    let mut types = std::collections::HashSet::new();
    if let Ok(mut neighbors) = graph_store.get_neighbors_project(entity_id, Some(project_id)) {
        neighbors.sort_by_key(|b| std::cmp::Reverse(edge_priority(&b.1.relation)));
        for (neighbor, edge) in neighbors.iter().take(3) {
            types.insert(neighbor.node_type.clone());
            let direction = if edge.source_id == entity_id {
                format!(
                    "[self] {} --[{}]--> [{}] {}",
                    entity_id, edge.relation, neighbor.node_type, neighbor.label
                )
            } else {
                format!(
                    "[{}] {} --[{}]--> [self] {}",
                    neighbor.node_type, neighbor.label, edge.relation, entity_id
                )
            };
            lines.push(format!("- {}\n", direction));
            // 2-hop: one bounded edge per 1-hop neighbor.
            if let Ok(mut n2) = graph_store.get_neighbors_project(&neighbor.id, Some(project_id)) {
                n2.sort_by_key(|b| std::cmp::Reverse(edge_priority(&b.1.relation)));
                if let Some((n2n, n2e)) = n2.first() {
                    types.insert(n2n.node_type.clone());
                    let d2 = if n2e.source_id == neighbor.id {
                        format!(
                            "[self] {} --[{}]--> [{}] {}",
                            neighbor.id, n2e.relation, n2n.node_type, n2n.label
                        )
                    } else {
                        format!(
                            "[{}] {} --[{}]--> [self] {}",
                            n2n.node_type, n2n.label, n2e.relation, neighbor.id
                        )
                    };
                    lines.push(format!("  └─(2-hop) {}\n", d2));
                }
            }
        }
    }
    (lines, types)
}

impl ContextBuilder {
    /// Create a new `ContextBuilder` backed by the given `MemorySystem`.
    pub fn new(memory: Arc<MemorySystem>) -> Self {
        Self {
            memory,
            graph: None,
        }
    }

    /// Create a new `ContextBuilder` with an optional knowledge graph store.
    pub fn with_graph(memory: Arc<MemorySystem>, graph: Option<Arc<KnowledgeGraphStore>>) -> Self {
        Self { memory, graph }
    }

    /// Assemble context for the given task description within a token budget.
    pub fn assemble(
        &self,
        task_description: &str,
        token_budget: usize,
    ) -> Result<AssembledContext> {
        self.assemble_with_project(task_description, token_budget, None)
    }

    /// Assemble context with an optional project path filter.
    ///
    /// Uses capacity-percentage allocation:
    /// 1. Preprocess & sanitize query (pipeline layers 1-2)
    /// 2. Inject L4 profiles (full, non-truncatable)
    /// 3. Inject L5 patterns (filtered by confidence ≥ 0.6, sample_count ≥ 3)
    /// 4. Fill L1/L2/L3 by percentage budget (truncatable)
    /// 5. KG reserved for phase 3
    /// 6. Final truncation fallback
    pub fn assemble_with_project(
        &self,
        task_description: &str,
        token_budget: usize,
        project_path: Option<&str>,
    ) -> Result<AssembledContext> {
        let _assemble_span = tracing::info_span!("context_assemble").entered();
        let mut assembled_parts: Vec<String> = Vec::new();
        let mut remaining_budget = token_budget;
        let mut sources: Vec<ContextSource> = Vec::new();

        // PR-01: classify intent and derive a dynamic budget allocation so the
        // hardcoded LAYER_BUDGETS percentages adapt to task complexity. L4 (0.15)
        // and L5 (0.05) are constant; the remaining 0.80 is rebalanced per intent.
        let intent = classify_task_intent(task_description);
        let (l1_pct, l2_pct, l3_pct, kg_pct) = budget_percentages_for(intent);
        let mut dyn_pct: std::collections::HashMap<i32, f64> = std::collections::HashMap::new();
        dyn_pct.insert(1, l1_pct);
        dyn_pct.insert(2, l2_pct);
        dyn_pct.insert(3, l3_pct);
        dyn_pct.insert(-1, kg_pct);

        // ─── Pipeline Layer 1: Preprocess ───
        let task_description = preprocess_query(task_description);

        // ─── Pipeline Layer 2: Security sanitization ───
        let sanitized = sanitize_query(&task_description);

        // ─── L4 Profile: Full injection ───
        let profiles = self.memory.get_core_memories("default", project_path)?;
        if !profiles.is_empty() {
            let profile_text = format_profiles(&profiles);
            let profile_tokens = estimate_tokens(&profile_text);

            if profile_tokens <= remaining_budget {
                assembled_parts.push(profile_text);
                remaining_budget = remaining_budget.saturating_sub(profile_tokens);
                sources.push(ContextSource {
                    layer: "profile".to_string(),
                    count: profiles.len(),
                });
            }
            // L4 is non-truncatable: if it exceeds budget, we skip it entirely
        }

        // ─── L5 Progressive Pattern: Filtered injection ───
        let pattern_req = PatternQueryRequest {
            user_id: "default".to_string(),
            pattern_type: None,
            project_id: project_path.map(|p| p.to_string()),
            limit: PER_LAYER_LIMIT,
            offset: 0,
        };
        let pattern_result = self.memory.query_patterns(&pattern_req)?;
        let filtered_patterns: Vec<&PatternEntry> = pattern_result
            .patterns
            .iter()
            .filter(|p| p.confidence >= 0.6 && p.sample_count >= 3)
            .collect();

        if !filtered_patterns.is_empty() {
            let pattern_text = format_patterns(&filtered_patterns);
            let pattern_tokens = estimate_tokens(&pattern_text);

            if pattern_tokens <= remaining_budget {
                assembled_parts.push(pattern_text);
                remaining_budget = remaining_budget.saturating_sub(pattern_tokens);
                sources.push(ContextSource {
                    layer: "progressive".to_string(),
                    count: filtered_patterns.len(),
                });
            }
            // L5 is non-truncatable: if it exceeds budget, we skip it entirely
        }

        // ─── L1/L2/L3: Percentage budget search ───
        for budget in &LAYER_BUDGETS {
            // Skip L4, L5 (already injected), and KG (phase 3)
            if budget.layer == 4 || budget.layer == 5 || budget.layer == -1 {
                continue;
            }

            let layer_budget_tokens =
                (token_budget as f64 * dyn_pct.get(&budget.layer).copied().unwrap_or(budget.percentage)) as usize;
            if layer_budget_tokens == 0 || remaining_budget == 0 {
                continue;
            }

            let layer_name = layer_int_to_name(budget.layer);
            let request = MemorySearchRequest {
                query: sanitized.clone(),
                limit: PER_LAYER_LIMIT,
                layers: Some(vec![layer_name.clone()]),
                tags: None,
                project_path: project_path.map(|p| p.to_string()),
                session_id: None,
            };

            let entries = self.memory.search(&request)?;
            if entries.is_empty() {
                continue;
            }

            // Sort by relevance score descending
            let mut sorted = entries;
            sorted.sort_by(|a, b| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

            let mut layer_count: usize = 0;
            let mut layer_used_tokens: usize = 0;

            for entry in sorted {
                // Tag every retrieved memory as HISTORICAL so the model does not
                // mistake a past user question (e.g. from a previous session) for
                // the current task. The model must act only on the latest user
                // input. This is a pure-text prefix: no downstream code parses the
                // `[layer N]` format, so adding `[historical]` is zero-risk.
                let entry_text = format!("[layer {}][historical] {}\n", entry.layer, entry.content);
                let entry_tokens = estimate_tokens(&entry_text);

                // Skip if entry exceeds remaining layer budget or global budget
                if entry_tokens > layer_budget_tokens.saturating_sub(layer_used_tokens) {
                    continue; // skip oversized entries
                }
                if entry_tokens > remaining_budget {
                    continue;
                }

                assembled_parts.push(entry_text);
                remaining_budget = remaining_budget.saturating_sub(entry_tokens);
                layer_used_tokens = layer_used_tokens.saturating_add(entry_tokens);
                layer_count += 1;

                if remaining_budget == 0 {
                    break;
                }
            }

            if layer_count > 0 {
                sources.push(ContextSource {
                    layer: layer_name,
                    count: layer_count,
                });
            }

            if remaining_budget == 0 {
                break;
            }
        }

        // ─── KG (layer=-1): Knowledge Graph context injection ───
        // The passive mechanism (ProjectIndexer) builds the graph from source code.
        // Here we traverse the graph to enrich the assembled context.
        if let Some(ref graph_store) = self.graph {
            let kg_budget_tokens = (token_budget as f64 * kg_pct) as usize;
            if kg_budget_tokens > 0 && remaining_budget > 0 {
                let mut kg_parts: Vec<String> = Vec::new();
                let mut coverage_types: std::collections::HashSet<String> = std::collections::HashSet::new();
                // The graph is keyed by a derived project identity, not by the
                // raw directory — see `knowledge_graph_store::project_key`.
                let project_id = match project_path {
                    Some(p) => project_key(Path::new(p)),
                    None => String::new(),
                };

                // Strategy 1: Traverse from memory-entity links
                for source in &sources {
                    if let Ok(links) = self
                        .memory
                        .get_memory_links_by_layer(&source.layer, project_path)
                    {
                        for link in links.iter().take(5) {
                            // G-01: traverse up to 2 hops (was 1-hop) for richer context.
                            let (edges, types) = collect_kg_edges(graph_store, &link.entity_id, &project_id);
                            coverage_types.extend(types);
                            kg_parts.extend(edges);
                        }
                    }
                }

                // Strategy 2: Search KG entities matching the query directly
                // This leverages the passive-built graph even without memory-entity links
                if kg_parts.len() < 5 {
                    let query_lower = sanitized.to_lowercase();
                    if let Ok(nodes) =
                        graph_store.find_nodes_by_type_project("Function", Some(&project_id))
                    {
                        // Substring match with noise filtering:
                        // - Forward match (label contains query) always allowed
                        // - Reverse match (query contains label) only if label is long enough
                        //   to avoid short names like "get", "run" matching everything
                        for node in nodes
                            .iter()
                            .filter(|n| {
                                let label_lower = n.label.to_lowercase();
                                label_lower.contains(&query_lower)
                                    || (label_lower.len() >= 3
                                        && query_lower.contains(&label_lower))
                            })
                            .take(5)
                        {
                            kg_parts.push(format!(
                                "- [{}] {} (id: {})\n",
                                node.node_type, node.label, node.id
                            ));
                            // G-01: 2-hop traversal for matched entities, consistent
                            // with Strategy 1. Collects node-type coverage stats too.
                            let (edges, types) = collect_kg_edges(graph_store, &node.id, &project_id);
                            coverage_types.extend(types);
                            kg_parts.extend(edges);
                        }
                    }
                    // Also try File and Module entities
                    if kg_parts.len() < 5 {
                        if let Ok(nodes) =
                            graph_store.find_nodes_by_type_project("File", Some(&project_id))
                        {
                            for node in nodes
                                .iter()
                                .filter(|n| {
                                    let label_lower = n.label.to_lowercase();
                                    label_lower.contains(&query_lower)
                                        || (label_lower.len() >= 3
                                            && query_lower.contains(&label_lower))
                                })
                                .take(3)
                            {
                                kg_parts.push(format!("- [{}] {}\n", node.node_type, node.label));
                            }
                        }
                        // Also search Module entities (import targets)
                        if kg_parts.len() < 5
                            && let Ok(nodes) =
                                graph_store.find_nodes_by_type_project("Module", Some(&project_id))
                            {
                                for node in nodes
                                    .iter()
                                    .filter(|n| {
                                        let label_lower = n.label.to_lowercase();
                                        label_lower.contains(&query_lower)
                                            || (label_lower.len() >= 3
                                                && query_lower.contains(&label_lower))
                                    })
                                    .take(3)
                                {
                                    kg_parts
                                        .push(format!("- [{}] {}\n", node.node_type, node.label));
                                }
                            }
                    }
                }

                if !kg_parts.is_empty() {
                    let kg_text = format!("=== Knowledge Graph (KG) ===\n{}", kg_parts.join(""));
                    let kg_tokens = estimate_tokens(&kg_text);
                    if kg_tokens <= kg_budget_tokens && kg_tokens <= remaining_budget {
                        assembled_parts.push(kg_text);
                        sources.push(ContextSource {
                            layer: "kg".to_string(),
                            count: kg_parts.len(),
                        });
                    }
                }
            }
        }

        // ─── Final truncation fallback ───
        let raw_context = assembled_parts.join("");
        let token_count = estimate_tokens(&raw_context);
        let assembled_context = if token_count > token_budget {
            // PR-02: truncate to token budget first, then snap back to a
            // semantic boundary (line edge + closed fenced code blocks) so we
            // never leave a half-cut code block, XML tag, or JSON structure.
            let rough = truncate_to_token_budget(&raw_context, token_budget);
            truncate_at_semantic_boundary(&rough)
        } else {
            raw_context
        };

        let final_token_count = estimate_tokens(&assembled_context);

        Ok(AssembledContext {
            assembled_context,
            token_count: final_token_count,
            sources,
        })
    }
}

/// PR-02: Snap a roughly-truncated string back to a semantic boundary so the
/// final context never ends mid-line inside a fenced code block or with an
/// unclosed ``` fence. Mirrors the logic in `renderer.rs::truncate_at_char_boundary`.
fn truncate_at_semantic_boundary(s: &str) -> String {
    // Trim trailing partial line (keep up to the last newline).
    let trimmed = match s.rfind('\n') {
        Some(idx) if idx > 0 => &s[..idx],
        _ => s,
    };
    // If an odd number of ``` fences remain, the last code block is unclosed —
    // remove everything from the last opening fence onward.
    if trimmed.matches("```").count() % 2 != 0
        && let Some(fence_start) = trimmed.rfind("```") {
            // Walk back to the beginning of that line.
            let line_start = trimmed[..fence_start].rfind('\n').map(|i| i + 1).unwrap_or(0);
            let mut result = trimmed[..line_start].trim_end().to_string();
            result.push_str("\n...[truncated]");
            return result;
        }
    trimmed.to_string()
}

/// Returns the sorting weight for a KG edge relation type.
///
/// Higher weight = higher priority in neighbor selection.
/// Order: Implements(6) > Method(5) > Inherits(4) > Contains(3) > DependsOn(2) > Calls(1)
fn edge_priority(relation: &str) -> u8 {
    match relation {
        "Implements" => 6,
        "Method" => 5,
        "Inherits" => 4,
        "Contains" => 3,
        "DependsOn" => 2,
        "Calls" => 1,
        _ => 0, // Unknown relation types get lowest priority
    }
}

// ─── Formatting helpers ───

/// Format L4 profile entries as a context block.
fn format_profiles(profiles: &[CoreMemoryEntry]) -> String {
    let mut parts = Vec::new();
    parts.push("=== User Profile (L4) ===\n".to_string());
    for p in profiles {
        parts.push(format!("- [{}] {}: {}\n", p.category, p.id, p.content));
    }
    parts.join("")
}

/// Format L5 pattern entries as a context block.
fn format_patterns(patterns: &[&PatternEntry]) -> String {
    let mut parts = Vec::new();
    parts.push("=== Learned Patterns (L5) ===\n".to_string());
    for p in patterns {
        parts.push(format!(
            "- [{}] {}: {} (confidence: {:.2}, samples: {})\n",
            p.pattern_type, p.pattern_key, p.preferred_value, p.confidence, p.sample_count
        ));
    }
    parts.join("")
}

// ─── Pipeline Layer 1: Preprocess ───

/// Preprocess query text: remove control characters, collapse whitespace, unify encoding.
fn preprocess_query(query: &str) -> String {
    query
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ─── Pipeline Layer 2: Security sanitization ───

/// Pre-compiled regexes for security sanitization (compiled once, reused across calls).
static API_KEY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*\S+")
        .expect("invariant: static regex pattern is valid")
});
static PII_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b[\w.+-]+@[\w-]+\.[\w.]+\b|\b1[3-9]\d{9}\b",
    )
    .expect("invariant: static regex pattern is valid")
});

/// Security rules: detect and redact sensitive information in query.
/// - API keys/tokens/secrets/passwords: masked as `key=***`
/// - PII (phone numbers, email addresses, IP addresses): replaced with `[REDACTED]`
fn sanitize_query(query: &str) -> String {
    if API_KEY_RE.is_match(query) {
        tracing::warn!("Security: API key/token detected in query, masking in context");
    }
    if PII_RE.is_match(query) {
        tracing::warn!("Security: PII detected in query, redacting in context");
    }

    // Mask API keys, then redact PII (phone, email, IP) with [REDACTED]
    let masked = API_KEY_RE.replace_all(query, "$1=***");
    let masked = PII_RE.replace_all(&masked, "[REDACTED]");
    masked.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use duo_types::MemoryStoreRequest;

    /// Helper: create an in-memory MemorySystem for testing.
    fn test_memory_system() -> Arc<MemorySystem> {
        Arc::new(MemorySystem::new_in_memory().expect("in-memory db"))
    }

    fn setup() -> ContextBuilder {
        let memory = test_memory_system();
        ContextBuilder::new(memory)
    }

    fn setup_with_data() -> ContextBuilder {
        let memory = test_memory_system();
        // Fill test data: layer 3 (permanent, high importance) and layer 1 (episode)
        memory
            .store(&MemoryStoreRequest {
                id: None,
                content: "Important architecture decision".to_string(),
                summary: None,
                layer: "permanent".to_string(),
                importance: Some(0.9),
                pin: None,
                session_id: None,
                memory_type: None,
                tags: Some(vec!["architecture".to_string()]),
                metadata: None,
                project_path: None,
                user_id: None,
            })
            .unwrap();
        memory
            .store(&MemoryStoreRequest {
                id: None,
                content: "Bug fix pattern for null pointer".to_string(),
                summary: None,
                layer: "episode".to_string(),
                importance: None,
                pin: None,
                session_id: None,
                memory_type: None,
                tags: Some(vec!["bug".to_string()]),
                metadata: None,
                project_path: None,
                user_id: None,
            })
            .unwrap();
        ContextBuilder::new(memory)
    }

    #[test]
    fn assemble_empty_memory_returns_empty_context() {
        let builder = setup();
        let result = builder.assemble("test query", 1000).unwrap();
        assert_eq!(result.assembled_context, "");
        assert_eq!(result.token_count, 0);
        assert!(result.sources.is_empty());
    }

    #[test]
    fn assemble_with_data_returns_layered_context() {
        let builder = setup_with_data();
        let result = builder.assemble("architecture", 10000).unwrap();
        assert!(!result.assembled_context.is_empty());
        assert!(result.assembled_context.contains("architecture"));
    }

    #[test]
    fn assemble_respects_token_budget() {
        let builder = setup_with_data();
        let result = builder.assemble("architecture", 1).unwrap();
        assert!(
            result.token_count <= 2,
            "token_count ({}) should be close to budget (1)",
            result.token_count,
        );
    }

    #[test]
    fn assemble_zero_budget_returns_empty() {
        let builder = setup_with_data();
        let result = builder.assemble("test", 0).unwrap();
        assert_eq!(result.assembled_context, "");
        assert_eq!(result.token_count, 0);
        assert!(result.sources.is_empty());
    }

    #[test]
    fn preprocess_removes_control_chars() {
        let result = preprocess_query("hello\x07world\x1b test");
        // Control chars are removed; they don't add spaces
        assert_eq!(result, "helloworld test");
    }

    #[test]
    fn preprocess_collapses_whitespace() {
        let result = preprocess_query("foo   bar\n\nbaz");
        assert_eq!(result, "foo bar baz");
    }

    #[test]
    fn sanitize_masks_api_keys() {
        let result = sanitize_query("api_key=sk-1234567890 token=abc123");
        assert!(result.contains("api_key=***"));
        assert!(result.contains("token=***"));
    }

    #[test]
    fn sanitize_preserves_normal_text() {
        let result = sanitize_query("hello world test query");
        assert_eq!(result, "hello world test query");
    }

    #[test]
    fn sanitize_redacts_phone_numbers() {
        let result = sanitize_query("call me at 13812345678");
        assert!(result.contains("[REDACTED]"));
        assert!(!result.contains("13812345678"));
    }

    #[test]
    fn sanitize_redacts_email_addresses() {
        let result = sanitize_query("send to user@example.com please");
        assert!(result.contains("[REDACTED]"));
        assert!(!result.contains("user@example.com"));
    }

    #[test]
    fn sanitize_redacts_ip_addresses() {
        let result = sanitize_query("connect to 192.168.1.100");
        assert!(result.contains("[REDACTED]"));
        assert!(!result.contains("192.168.1.100"));
    }
}
