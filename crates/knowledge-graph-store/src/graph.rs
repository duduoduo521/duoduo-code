//! Knowledge graph store — memory-first with bincode persistence.
//!
//! Architecture: in-memory petgraph as hot cache + bincode snapshot as durable store.
//!
//! - **Write**: write to in-memory graph only (indexing builds the full graph in memory)
//! - **Snapshot**: after indexing completes, `save_to_bincode()` serializes the
//!   in-memory graph to a bincode file for durability
//! - **Load**: on startup, `load_from_bincode()` deserializes the bincode file back
//!   into the in-memory graph
//! - **Query**: pure in-memory — all data must be loaded via `load_from_bincode()`
//!   or built via indexing before querying
//!
//! The in-memory graph is the single source of truth during runtime. Bincode
//! snapshots provide cross-restart persistence.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use duo_types::{KGEdge, KGNode};
use petgraph::Graph;
use petgraph::graph::NodeIndex;
use petgraph::visit::EdgeRef;

use super::bincode_store::{
    BincodeEdge, BincodeNode, CURRENT_SNAPSHOT_VERSION, FileHash, GraphSnapshot,
};
use super::persistence::GraphPersistence;

pub(super) struct Inner {
    pub(super) graph: Graph<KGNode, KGEdge>,
    /// `project_id -> (entity id -> node index)`.
    ///
    /// Entity ids are only unique *inside* one project — `file:src/main.rs`
    /// exists in nearly every project — yet one graph holds every open project.
    /// Nesting by project makes it structurally impossible for project B's
    /// `file:src/main.rs` to resolve to (or overwrite) project A's node, which
    /// is exactly what a flat id-keyed map allowed.
    pub(super) node_index_map: HashMap<String, HashMap<String, NodeIndex>>,
    /// `project_id -> set of edge ids`. Nested for the same reason as
    /// `node_index_map`: edge ids are project-local too.
    pub(super) edge_id_set: HashMap<String, HashSet<String>>,
    /// Tracks which projects have been loaded into memory.
    /// Empty string "" means global project has been loaded.
    pub(super) loaded_projects: HashSet<String>,
}

impl Inner {
    pub(crate) fn node_index(&self, project_id: &str, id: &str) -> Option<NodeIndex> {
        self.node_index_map
            .get(project_id)
            .and_then(|ids| ids.get(id))
            .copied()
    }

    /// Every project's node with this id. Used when the caller deliberately
    /// filters by no project (`None`), which must stay "all projects".
    pub(crate) fn node_indices_named(&self, id: &str) -> Vec<NodeIndex> {
        self.node_index_map
            .values()
            .filter_map(|ids| ids.get(id).copied())
            .collect()
    }

    fn insert_node_index(&mut self, project_id: &str, id: String, idx: NodeIndex) {
        self.node_index_map
            .entry(project_id.to_string())
            .or_default()
            .insert(id, idx);
    }

    pub(crate) fn has_edge_id(&self, project_id: &str, id: &str) -> bool {
        self.edge_id_set
            .get(project_id)
            .is_some_and(|ids| ids.contains(id))
    }

    fn insert_edge_id(&mut self, project_id: &str, id: String) {
        self.edge_id_set
            .entry(project_id.to_string())
            .or_default()
            .insert(id);
    }

    pub(crate) fn remove_edge_id(&mut self, project_id: &str, id: &str) {
        if let Some(ids) = self.edge_id_set.get_mut(project_id) {
            ids.remove(id);
        }
    }

    /// Rebuild both lookup tables from the current petgraph contents.
    ///
    /// Needed after any operation that compacts node indices (`retain_nodes`
    /// renumbers the graph) or bulk-removes edges.
    pub(crate) fn rebuild_indexes(&mut self) {
        // Collect first: the insert helpers need `&mut self`, which cannot be
        // taken while the graph is borrowed for iteration.
        let nodes: Vec<(String, String, NodeIndex)> = self
            .graph
            .node_indices()
            .filter_map(|idx| {
                let node = self.graph.node_weight(idx)?;
                Some((node.project_id.clone(), node.id.clone(), idx))
            })
            .collect();
        self.node_index_map.clear();
        for (project_id, id, idx) in nodes {
            self.insert_node_index(&project_id, id, idx);
        }

        let edges: Vec<(String, String)> = self
            .graph
            .edge_weights()
            .map(|edge| (edge.project_id.clone(), edge.id.clone()))
            .collect();
        self.edge_id_set.clear();
        for (project_id, id) in edges {
            self.insert_edge_id(&project_id, id);
        }
    }
}

pub struct KnowledgeGraphStore {
    pub(super) inner: Mutex<Inner>,
    #[allow(dead_code)]
    pub(crate) persistence: Arc<GraphPersistence>,
    /// Semantic embedding index for `graph_query` query_type="similar".
    /// Self-contained; lazy-built and not persisted (see `embedding` module).
    pub embedding: crate::embedding::EmbeddingIndex,
}

impl KnowledgeGraphStore {
    /// Create a new `KnowledgeGraphStore`.
    ///
    /// The `persistence` field is retained for compatibility (e.g. `graph_stats`
    /// queries) but is no longer used for node/edge writes or reads.
    /// Use `load_from_bincode()` to restore a previously saved snapshot.
    pub fn new(persistence: Arc<GraphPersistence>) -> Result<Self> {
        Ok(Self {
            inner: Mutex::new(Inner {
                graph: Graph::new(),
                node_index_map: HashMap::new(),
                edge_id_set: HashMap::new(),
                loaded_projects: HashSet::new(),
            }),
            persistence,
            embedding: crate::embedding::EmbeddingIndex::default(),
        })
    }

    /// Seed the semantic embedding index with runtime config. No-op if the
    /// embedding endpoint is unavailable; `search_similar` then degrades to
    /// name-based search.
    pub fn set_embedding_config(&self, config: crate::embedding::EmbeddingConfig) {
        self.embedding.set_config(config);
    }

    /// Find node ids whose `codeSnippet` is semantically similar to `query`.
    /// Returns an empty vec when embeddings are unavailable (caller degrades).
    /// `project_id` filters candidates; `None` means all projects.
    pub fn search_similar(
        &self,
        query: &str,
        project_id: Option<&str>,
        limit: usize,
    ) -> Vec<String> {
        // Collect (node_id, codeSnippet) for Function nodes with a snippet.
        let snippets = {
            let inner = match self.inner.lock() {
                Ok(g) => g,
                Err(_) => return Vec::new(),
            };
            let mut out: Vec<(String, String)> = Vec::new();
            for idx in inner.graph.node_indices() {
                let node = match inner.graph.node_weight(idx) {
                    Some(n) => n,
                    None => continue,
                };
                if node.node_type != "Function" {
                    continue;
                }
                if !matches_project(node.project_id.as_str(), project_id) {
                    continue;
                }
                let snippet = node
                    .properties
                    .as_ref()
                    .and_then(|p| p.get("codeSnippet"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if let Some(s) = snippet
                    && !s.is_empty() {
                        out.push((node.id.clone(), s));
                    }
            }
            out
        };
        // No embedding endpoint configured: degrade to a recall-oriented
        // candidate search. The LLM performs the actual semantic match by
        // reading the returned code snippets — so this layer's job is only to
        // surface *plausibly relevant* candidates, not to rank by meaning.
        //
        // Matching is intentionally broad (recall over precision):
        //   - label contains query  (name match)
        //   - codeSnippet contains query (body / doc-comment / inline match)
        // Both widen the candidate pool so the LLM can spot a semantically
        // related block even when only a fragment of its name/body is known.
        // This keeps the tool functional without an embedding API and never
        // blocks a healthy write path.
        if !self.embedding.has_config() {
            let query_lower = query.to_lowercase();
            let mut scored: Vec<(u32, String)> = Vec::new();
            // 1) label-based candidates (reuse search_nodes scoring: exact>prefix>substring).
            if let Ok(nodes) = self.search_nodes(query, None, project_id, limit) {
                for node in nodes {
                    let score: u32 = if node.label.to_lowercase() == query_lower {
                        4
                    } else if node.label.to_lowercase().starts_with(&query_lower) {
                        3
                    } else {
                        1
                    };
                    scored.push((score, node.id));
                }
            }
            // 2) codeSnippet / body candidates — broad substring match so the
            //    LLM gets to read blocks whose *implementation* mentions query.
            for (id, snippet) in &snippets {
                if snippet.to_lowercase().contains(&query_lower) {
                    // Lower priority than a label hit, but still surfaced.
                    if !scored.iter().any(|(_, sid)| sid == id) {
                        scored.push((2, id.clone()));
                    }
                }
            }
            scored.sort_by_key(|b| std::cmp::Reverse(b.0));
            scored.truncate(limit);
            return scored.into_iter().map(|(_, id)| id).collect();
        }
        self.embedding.search_similar(query, limit, snippets)
    }

    /// No-op — previously loaded project data from SQLite on demand.
    ///
    /// With bincode persistence, data is loaded explicitly via `load_from_bincode()`
    /// after indexing completes. This method is retained for API compatibility
    /// but does nothing.
    fn ensure_project_loaded(&self, _project_id: Option<&str>) -> Result<()> {
        Ok(())
    }

    /// Load a bincode snapshot into the in-memory graph.
    ///
    /// Rebuilds the petgraph from a `GraphSnapshot` previously saved via
    /// `save_to_bincode()`. Nodes are added first, then edges are connected
    /// using the node index map. Edges whose source/target nodes are missing
    /// are silently skipped.
    pub fn load_from_bincode(&self, snapshot: GraphSnapshot) -> Result<()> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        let project_id = snapshot.project_id.clone();

        let project_edges: Vec<_> = inner
            .graph
            .edge_indices()
            .filter(|idx| {
                inner
                    .graph
                    .edge_weight(*idx)
                    .map(|edge| edge.project_id == project_id)
                    .unwrap_or(false)
            })
            .collect();
        // Collect edge IDs to remove from edge_id_set before mutating.
        let edge_ids_to_remove: Vec<String> = project_edges
            .iter()
            .filter_map(|&edge_idx| inner.graph.edge_weight(edge_idx).map(|e| e.id.clone()))
            .collect();
        for edge_idx in project_edges {
            inner.graph.remove_edge(edge_idx);
        }
        for id in edge_ids_to_remove {
            inner.remove_edge_id(&project_id, &id);
        }

        inner.graph.retain_nodes(|graph, idx| {
            graph
                .node_weight(idx)
                .map(|node| node.project_id != project_id)
                .unwrap_or(false)
        });
        // `retain_nodes` compacts petgraph indices, so every lookup table has
        // to be rebuilt from the surviving graph.
        inner.rebuild_indexes();

        // Rebuild in-memory graph from snapshot (with dedup for global nodes/edges)
        for node in snapshot.nodes {
            let kg_node: KGNode = node.into();
            if let Some(existing_idx) = inner.node_index(&project_id, &kg_node.id) {
                // Node already exists (e.g. global node), update its attributes
                if let Some(existing) = inner.graph.node_weight_mut(existing_idx) {
                    *existing = kg_node;
                }
            } else {
                let idx = inner.graph.add_node(kg_node.clone());
                inner.insert_node_index(&project_id, kg_node.id, idx);
            }
        }
        for edge in snapshot.edges {
            let kg_edge: KGEdge = edge.into();
            // Skip if edge already exists (e.g. global edge)
            if inner.has_edge_id(&project_id, &kg_edge.id) {
                continue;
            }
            if let (Some(from_idx), Some(to_idx)) = (
                inner.node_index(&project_id, &kg_edge.source_id),
                inner.node_index(&project_id, &kg_edge.target_id),
            ) {
                inner.graph.add_edge(from_idx, to_idx, kg_edge.clone());
                inner.insert_edge_id(&project_id, kg_edge.id);
            }
        }
        inner.loaded_projects.insert(project_id);

        Ok(())
    }

    /// Serialize the in-memory graph for a project into a `GraphSnapshot`.
    ///
    /// Collects all nodes and edges belonging to `project_id` (plus global
    /// entities with empty `project_id`) from the in-memory graph. The caller
    /// is responsible for writing the snapshot to disk via `BincodeStorage::save()`.
    pub fn save_to_bincode(
        &self,
        project_id: &str,
        file_hashes: HashMap<String, FileHash>,
    ) -> Result<GraphSnapshot> {
        let inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        let nodes: Vec<BincodeNode> = inner
            .graph
            .node_weights()
            .filter(|n| n.project_id == project_id || n.project_id.is_empty())
            .map(BincodeNode::from)
            .collect();
        let edges: Vec<BincodeEdge> = inner
            .graph
            .edge_weights()
            .filter(|e| e.project_id == project_id || e.project_id.is_empty())
            .map(BincodeEdge::from)
            .collect();
        Ok(GraphSnapshot {
            version: CURRENT_SNAPSHOT_VERSION,
            project_id: project_id.to_string(),
            nodes,
            edges,
            file_hashes,
            index_level: "variable".to_string(),
        })
    }

    /// Add a node to the in-memory graph.
    /// Returns the node id.
    ///
    /// Note: persistence to bincode is done explicitly via `save_to_bincode()`
    /// after indexing completes.
    pub fn add_node(&self, node: KGNode) -> Result<String> {
        let id = node.id.clone();
        // Scoped by the node's own project: an id that already exists in a
        // *different* project must not block this insert.
        let project_id = node.project_id.clone();
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        if inner.node_index(&project_id, &id).is_some() {
            bail!("node with id '{}' already exists", id);
        }

        // Add to in-memory graph. Move `node` directly instead of cloning the
        // whole `KGNode` (which may carry a large `codeSnippet`).
        let idx = inner.graph.add_node(node);
        inner.insert_node_index(&project_id, id.clone(), idx);

        // Mark this node's project as loaded
        inner.loaded_projects.insert(project_id.clone());
        if !project_id.is_empty() {
            // Also mark global project as loaded (global nodes are always needed)
            inner.loaded_projects.insert(String::new());
        }

        Ok(id)
    }

    /// Atomic upsert under a single lock.
    ///
    /// Resolves the "add vs. replace" decision in one critical section so the
    /// caller never observes a torn state between the existence check and the
    /// write. This also eliminates the redundant `KGNode` clones that a naive
    /// `add_node`+`get_node`+`replace_node` sequence would perform.
    ///
    /// `should_replace` decides whether an incoming node supersedes the existing
    /// one (e.g. a file-backed node overwriting a call-site stub). The decision
    /// logic lives at the call site so this method stays storage-agnostic.
    pub fn upsert_node_with(
        &self,
        node: KGNode,
        should_replace: fn(&KGNode, &KGNode) -> bool,
    ) -> Result<()> {
        let id = node.id.clone();
        let project_id = node.project_id.clone();
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        match inner.node_index(&project_id, &id) {
            Some(idx) => {
                // Node already exists: replace only when the caller says so.
                let replace = inner
                    .graph
                    .node_weight(idx)
                    .is_some_and(|existing| should_replace(&node, existing));
                if replace
                    && let Some(slot) = inner.graph.node_weight_mut(idx) {
                        *slot = node;
                    }
            }
            None => {
                // New node: add it and mark its project (incl. global) as loaded.
                let idx = inner.graph.add_node(node);
                inner.insert_node_index(&project_id, id, idx);
                inner.loaded_projects.insert(project_id.clone());
                if !project_id.is_empty() {
                    inner.loaded_projects.insert(String::new());
                }
            }
        }

        Ok(())
    }

    /// Replace an existing node's payload in place, keeping its `NodeIndex`.
    ///
    /// Because the `NodeIndex` is preserved, every edge already attached to this
    /// node stays valid. Returns `false` if the node does not exist.
    pub fn replace_node(&self, node: KGNode) -> Result<bool> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        let Some(idx) = inner.node_index(&node.project_id, &node.id) else {
            return Ok(false);
        };

        if let Some(slot) = inner.graph.node_weight_mut(idx) {
            *slot = node;
        }

        Ok(true)
    }

    /// Add an edge to the in-memory graph.
    ///
    /// Both source and target nodes must already exist in memory (nodes are
    /// added before edges during indexing).
    pub fn add_edge(&self, from_id: &str, to_id: &str, edge: KGEdge) -> Result<()> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        // Dedup check: symmetric with add_node's node_index lookup. Scoped by
        // the edge's project so two projects can hold equally-named edges.
        let project_id = edge.project_id.clone();
        if inner.has_edge_id(&project_id, &edge.id) {
            bail!("edge with id '{}' already exists", edge.id);
        }

        let from_idx = inner
            .node_index(&project_id, from_id)
            .ok_or_else(|| anyhow::anyhow!("source node '{}' not found", from_id))?;
        let to_idx = inner
            .node_index(&project_id, to_id)
            .ok_or_else(|| anyhow::anyhow!("target node '{}' not found", to_id))?;

        inner.graph.add_edge(from_idx, to_idx, edge.clone());
        inner.insert_edge_id(&project_id, edge.id.clone());

        // Mark edge's project as loaded
        inner.loaded_projects.insert(edge.project_id.clone());

        Ok(())
    }

    /// Find all nodes matching the given node_type with project_id filter.
    pub fn find_nodes_by_type_project(
        &self,
        node_type: &str,
        project_id: Option<&str>,
    ) -> Result<Vec<KGNode>> {
        // ensure_project_loaded is a no-op with bincode persistence;
        // data must be loaded via load_from_bincode() before querying.
        self.ensure_project_loaded(project_id)?;

        let inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        let nodes: Vec<KGNode> = inner
            .graph
            .node_indices()
            .filter_map(|idx| {
                let node = inner.graph.node_weight(idx)?;
                if node.node_type != node_type {
                    return None;
                }
                if !matches_project(node.project_id.as_str(), project_id) {
                    return None;
                }
                Some(node.clone())
            })
            .collect();

        // The in-memory graph is the authoritative source.
        // If it returns empty, the data simply doesn't exist.
        Ok(nodes)
    }

    /// Search nodes by case-insensitive substring match on label.
    /// Pure in-memory search — data must be loaded via `load_from_bincode()`
    /// or built via indexing first.
    pub fn search_nodes(
        &self,
        query: &str,
        node_type: Option<&str>,
        project_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<KGNode>> {
        self.ensure_project_loaded(project_id)?;

        let query_lower = query.to_lowercase();
        let inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        // Collect all matches with relevance score, then sort by score.
        // Score: exact match (4) > prefix match (3) > substring match (1).
        // Type bonus: Function/Class (+2) > other types (+0).
        let mut scored: Vec<(u32, KGNode)> = inner
            .graph
            .node_indices()
            .filter_map(|idx| {
                let node = inner.graph.node_weight(idx)?;
                let label_lower = node.label.to_lowercase();
                if !label_lower.contains(&query_lower) {
                    return None;
                }
                if let Some(nt) = node_type
                    && node.node_type != nt {
                        return None;
                    }
                if !matches_project(node.project_id.as_str(), project_id) {
                    return None;
                }

                // Relevance scoring
                let mut score: u32 = if label_lower == query_lower {
                    4 // exact match
                } else if label_lower.starts_with(&query_lower) {
                    3 // prefix match
                } else {
                    1 // substring match
                };
                // Type bonus: symbols with definitions (Function/Class) rank higher
                if node.node_type == "Function" || node.node_type == "Class" || node.node_type == "Method" {
                    score += 2;
                }
                Some((score, node.clone()))
            })
            .collect();

        // Sort by score descending (stable sort preserves insertion order for ties)
        scored.sort_by_key(|b| std::cmp::Reverse(b.0));

        let nodes: Vec<KGNode> = scored.into_iter()
            .take(limit)
            .map(|(_, node)| node)
            .collect();

        Ok(nodes)
    }

    /// Get all neighbor nodes and the connecting edges for a given node id.
    pub fn get_neighbors(&self, node_id: &str) -> Result<Vec<(KGNode, KGEdge)>> {
        self.get_neighbors_project(node_id, None)
    }

    /// Get neighbors filtered by project_id.
    ///
    /// Pure in-memory query — data must be loaded via `load_from_bincode()`
    /// or built via indexing first.
    pub fn get_neighbors_project(
        &self,
        node_id: &str,
        project_id: Option<&str>,
    ) -> Result<Vec<(KGNode, KGEdge)>> {
        self.ensure_project_loaded(project_id)?;

        let inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        // `None` means "no project filter", so every project's node with this
        // id is a legitimate starting point — not just the first one found.
        let indices: Vec<NodeIndex> = match project_id {
            Some(pid) => inner.node_index(pid, node_id).into_iter().collect(),
            None => inner.node_indices_named(node_id),
        };
        if indices.is_empty() {
            // Node not found in memory — return empty
            return Ok(Vec::new());
        }

        let mut result = Vec::new();
        for idx in indices {
            // Outgoing neighbors
            for edge_ref in inner.graph.edges(idx) {
                let neighbor_idx = edge_ref.target();
                if let Some(neighbor) = inner.graph.node_weight(neighbor_idx).cloned() {
                    let edge = edge_ref.weight().clone();
                    if matches_project(neighbor.project_id.as_str(), project_id)
                        && matches_project(edge.project_id.as_str(), project_id)
                    {
                        result.push((neighbor, edge));
                    }
                }
            }

            // Incoming neighbors
            for edge_ref in inner
                .graph
                .edges_directed(idx, petgraph::Direction::Incoming)
            {
                let neighbor_idx = edge_ref.source();
                if let Some(neighbor) = inner.graph.node_weight(neighbor_idx).cloned() {
                    let edge = edge_ref.weight().clone();
                    if matches_project(neighbor.project_id.as_str(), project_id)
                        && matches_project(edge.project_id.as_str(), project_id)
                    {
                        result.push((neighbor, edge));
                    }
                }
            }
        }

        Ok(result)
    }

    /// Get a node by its ID. Pure in-memory query.
    ///
    /// Has no project parameter, so it resolves across every loaded project.
    /// Callers that need isolation must use the `*_project` APIs.
    pub fn get_node(&self, node_id: &str) -> Result<Option<KGNode>> {
        let inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        Ok(inner
            .node_indices_named(node_id)
            .into_iter()
            .next()
            .and_then(|idx| inner.graph.node_weight(idx).cloned()))
    }

    /// Count nodes for a given project_id. Traverses the in-memory graph.
    pub fn node_count_project(&self, project_id: Option<&str>) -> Result<usize> {
        let inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        let count = inner
            .graph
            .node_indices()
            .filter(|idx| {
                if let Some(node) = inner.graph.node_weight(*idx) {
                    matches_project(node.project_id.as_str(), project_id)
                } else {
                    false
                }
            })
            .count();

        Ok(count)
    }

    /// Count edges for a given project_id. Traverses the in-memory graph.
    pub fn edge_count_project(&self, project_id: Option<&str>) -> Result<usize> {
        let inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        let count = inner
            .graph
            .edge_weights()
            .filter(|edge| matches_project(edge.project_id.as_str(), project_id))
            .count();

        Ok(count)
    }

    /// Count file nodes for a given project_id. Traverses the in-memory graph.
    pub fn file_count_project(&self, project_id: Option<&str>) -> Result<usize> {
        let inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        let count = inner
            .graph
            .node_weights()
            .filter(|node| {
                node.node_type == "File" && matches_project(node.project_id.as_str(), project_id)
            })
            .count();

        Ok(count)
    }

    pub fn count_edges_by_relation_project(
        &self,
        relation: &str,
        project_id: Option<&str>,
    ) -> Result<usize> {
        let inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        let count = inner
            .graph
            .edge_weights()
            .filter(|edge| {
                edge.relation == relation && matches_project(edge.project_id.as_str(), project_id)
            })
            .count();

        Ok(count)
    }

    /// Clear all in-memory graph data for a project.
    ///
    /// Removes all nodes and edges where `project_id` matches.
    /// Global entities (project_id = "") are NOT removed — they are shared across projects.
    /// Does not touch bincode storage — caller must use `BincodeStorage::delete()` for that.
    pub fn clear_project_memory(&self, project_id: &str) -> Result<()> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        // Collect node indices to remove (only this project's nodes, NOT global)
        let indices_to_remove: Vec<(String, petgraph::graph::NodeIndex)> = inner
            .graph
            .node_indices()
            .filter_map(|idx| {
                let node = inner.graph.node_weight(idx)?;
                if node.project_id == project_id {
                    Some((node.id.clone(), idx))
                } else {
                    None
                }
            })
            .collect();

        // Remove all edges connected to these nodes
        let mut edge_indices: Vec<petgraph::graph::EdgeIndex> = Vec::new();
        for (_, idx) in &indices_to_remove {
            let outgoing: Vec<petgraph::graph::EdgeIndex> = inner
                .graph
                .edges_directed(*idx, petgraph::Direction::Outgoing)
                .map(|e| e.id())
                .collect();
            let incoming: Vec<petgraph::graph::EdgeIndex> = inner
                .graph
                .edges_directed(*idx, petgraph::Direction::Incoming)
                .map(|e| e.id())
                .collect();
            edge_indices.extend(outgoing);
            edge_indices.extend(incoming);
        }
        edge_indices.sort();
        edge_indices.dedup();

        // Collect edge IDs to remove from edge_id_set before mutating.
        let edge_ids_to_remove: Vec<String> = edge_indices
            .iter()
            .filter_map(|&edge_idx| inner.graph.edge_weight(edge_idx).map(|e| e.id.clone()))
            .collect();
        for edge_idx in edge_indices {
            inner.graph.remove_edge(edge_idx);
        }
        for id in edge_ids_to_remove {
            inner.remove_edge_id(project_id, &id);
        }

        // Also remove edges whose project_id matches but both endpoints are global
        // (these edges belong to the project even though their endpoints don't).
        // Without this, a DependsOn edge from a global Module node to a global Module
        // node with project_id = "my_project" would survive in memory but be deleted
        // from SQLite by clear_project(), causing inconsistency.
        let orphan_project_edges: Vec<petgraph::graph::EdgeIndex> = inner
            .graph
            .edge_indices()
            .filter_map(|edge_idx| {
                let edge = inner.graph.edge_weight(edge_idx)?;
                if edge.project_id == project_id {
                    // Check if both endpoints survived (not in indices_to_remove)
                    let (source_idx, target_idx) = inner.graph.edge_endpoints(edge_idx)?;
                    let source_survives =
                        !indices_to_remove.iter().any(|(_, ni)| *ni == source_idx);
                    let target_survives =
                        !indices_to_remove.iter().any(|(_, ni)| *ni == target_idx);
                    if source_survives && target_survives {
                        return Some(edge_idx);
                    }
                }
                None
            })
            .collect();

        // Collect edge IDs to remove from edge_id_set before mutating.
        let orphan_edge_ids_to_remove: Vec<String> = orphan_project_edges
            .iter()
            .filter_map(|&edge_idx| inner.graph.edge_weight(edge_idx).map(|e| e.id.clone()))
            .collect();
        for edge_idx in orphan_project_edges {
            inner.graph.remove_edge(edge_idx);
        }
        for id in orphan_edge_ids_to_remove {
            inner.remove_edge_id(project_id, &id);
        }

        // Remove nodes in one retain pass to avoid petgraph remove_node swap-index invalidation.
        inner.graph.retain_nodes(|graph, idx| {
            graph
                .node_weight(idx)
                .map(|node| node.project_id != project_id)
                .unwrap_or(false)
        });

        // `retain_nodes` compacts petgraph indices, so every lookup table has
        // to be rebuilt from the surviving graph.
        inner.rebuild_indexes();

        // Unmark project as loaded so it can be re-loaded later
        inner.loaded_projects.remove(project_id);
        // NOTE: Do NOT remove global ("") from loaded_projects — global entities are shared.

        tracing::info!(
            project_id = project_id,
            "Cleared project data from in-memory graph"
        );
        Ok(())
    }

    /// Count nodes grouped by `node_type` for a given project_id.
    /// Traverses the in-memory graph.
    pub fn node_type_distribution(
        &self,
        project_id: Option<&str>,
    ) -> Result<HashMap<String, usize>> {
        let inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        let mut dist: HashMap<String, usize> = HashMap::new();
        for node in inner.graph.node_weights() {
            if !matches_project(node.project_id.as_str(), project_id) {
                continue;
            }
            *dist.entry(node.node_type.clone()).or_insert(0) += 1;
        }

        Ok(dist)
    }

    /// Count edges grouped by `relation` for a given project_id.
    /// Traverses the in-memory graph.
    pub fn relation_type_distribution(
        &self,
        project_id: Option<&str>,
    ) -> Result<HashMap<String, usize>> {
        let inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        let mut dist: HashMap<String, usize> = HashMap::new();
        for edge in inner.graph.edge_weights() {
            if !matches_project(edge.project_id.as_str(), project_id) {
                continue;
            }
            *dist.entry(edge.relation.clone()).or_insert(0) += 1;
        }

        Ok(dist)
    }

    /// Find File nodes sorted by `properties.indexed_at` descending.
    /// Returns up to `limit` nodes. Nodes without `indexed_at` are placed last.
    pub fn recent_files(&self, project_id: Option<&str>, limit: usize) -> Result<Vec<KGNode>> {
        let inner = self
            .inner
            .lock()
            .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

        let mut files: Vec<KGNode> = inner
            .graph
            .node_weights()
            .filter(|node| {
                node.node_type == "File" && matches_project(node.project_id.as_str(), project_id)
            })
            .cloned()
            .collect();

        // Sort by indexed_at descending; nodes without indexed_at go last
        files.sort_by(|a, b| {
            let a_time = a
                .properties
                .as_ref()
                .and_then(|p| p.get("indexed_at"))
                .and_then(|v| v.as_str());
            let b_time = b
                .properties
                .as_ref()
                .and_then(|p| p.get("indexed_at"))
                .and_then(|v| v.as_str());
            match (a_time, b_time) {
                (Some(at), Some(bt)) => bt.cmp(at),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        });

        files.truncate(limit);
        Ok(files)
    }
}

/// Project matching logic: a node/edge matches if its project_id equals the
/// requested project_id OR its project_id is empty (global).
pub(super) fn matches_project(entity_project_id: &str, filter_project_id: Option<&str>) -> bool {
    match filter_project_id {
        None => true,
        Some(pid) => entity_project_id == pid || entity_project_id.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bincode_store::{BincodeEdge, BincodeNode, FileHash, GraphSnapshot};

    /// Helper: create a `KnowledgeGraphStore` backed by in-memory SQLite
    /// (the persistence field is retained but unused for reads/writes).
    fn make_store() -> KnowledgeGraphStore {
        let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
        KnowledgeGraphStore::new(persistence).unwrap()
    }

    /// Helper: create a simple KGNode.
    fn make_node(id: &str, label: &str, node_type: &str, project_id: &str) -> KGNode {
        KGNode {
            id: id.to_string(),
            label: label.to_string(),
            node_type: node_type.to_string(),
            properties: None,
            project_id: project_id.to_string(),
        }
    }

    /// Helper: create a simple KGEdge.
    fn make_edge(
        id: &str,
        source_id: &str,
        target_id: &str,
        relation: &str,
        project_id: &str,
    ) -> KGEdge {
        KGEdge {
            id: id.to_string(),
            source_id: source_id.to_string(),
            target_id: target_id.to_string(),
            relation: relation.to_string(),
            weight: None,
            properties: None,
            project_id: project_id.to_string(),
        }
    }

    #[test]
    fn test_add_node_no_sqlite() {
        // Verify add_node writes only to memory — the store has in-memory SQLite
        // that should remain empty after add_node.
        let store = make_store();

        let node = make_node("function:foo@main.rs", "foo", "Function", "proj1");
        let id = store.add_node(node).unwrap();
        assert_eq!(id, "function:foo@main.rs");

        // Node should be retrievable from memory
        let got = store.get_node("function:foo@main.rs").unwrap();
        assert!(got.is_some());
        assert_eq!(got.unwrap().label, "foo");

        // "No SQLite" is now guaranteed structurally: the node/edge write APIs
        // were removed from GraphPersistence (P3-04), so add_node cannot touch
        // SQLite even if it tried.
    }

    #[test]
    fn test_add_edge_no_sqlite() {
        // Verify add_edge writes only to memory and requires nodes to exist first.
        let store = make_store();

        // Add two nodes first
        let n1 = make_node("function:foo@a.rs", "foo", "Function", "proj1");
        let n2 = make_node("function:bar@b.rs", "bar", "Function", "proj1");
        store.add_node(n1).unwrap();
        store.add_node(n2).unwrap();

        // Add edge
        let edge = make_edge(
            "calls:foo→bar",
            "function:foo@a.rs",
            "function:bar@b.rs",
            "Calls",
            "proj1",
        );
        store
            .add_edge("function:foo@a.rs", "function:bar@b.rs", edge)
            .unwrap();

        // Verify edge exists in memory via neighbors
        let neighbors = store
            .get_neighbors_project("function:foo@a.rs", Some("proj1"))
            .unwrap();
        assert_eq!(neighbors.len(), 1);
        assert_eq!(neighbors[0].0.label, "bar");
        assert_eq!(neighbors[0].1.relation, "Calls");

        // Adding an edge with non-existent source should fail
        let edge2 = make_edge(
            "calls:missing→bar",
            "missing",
            "function:bar@b.rs",
            "Calls",
            "proj1",
        );
        let result = store.add_edge("missing", "function:bar@b.rs", edge2);
        assert!(
            result.is_err(),
            "add_edge should fail if source node is missing"
        );
    }

    #[test]
    fn test_load_from_bincode() {
        let store = make_store();

        // Build a snapshot
        let node1 = BincodeNode {
            id: "function:foo@a.rs".to_string(),
            label: "foo".to_string(),
            node_type: "Function".to_string(),
            properties_json: None,
            project_id: "proj1".to_string(),
        };
        let node2 = BincodeNode {
            id: "function:bar@b.rs".to_string(),
            label: "bar".to_string(),
            node_type: "Function".to_string(),
            properties_json: None,
            project_id: "proj1".to_string(),
        };
        let edge = BincodeEdge {
            id: "calls:foo→bar".to_string(),
            source_id: "function:foo@a.rs".to_string(),
            target_id: "function:bar@b.rs".to_string(),
            relation: "Calls".to_string(),
            weight: Some(0.5),
            properties_json: None,
            project_id: "proj1".to_string(),
        };

        let snapshot = GraphSnapshot {
            version: CURRENT_SNAPSHOT_VERSION,
            project_id: "proj1".to_string(),
            nodes: vec![node1, node2],
            edges: vec![edge],
            file_hashes: HashMap::new(),
            index_level: "variable".to_string(),
        };

        // Load snapshot into memory
        store.load_from_bincode(snapshot).unwrap();

        // Verify nodes are in memory
        let n = store.get_node("function:foo@a.rs").unwrap();
        assert!(n.is_some());
        assert_eq!(n.unwrap().label, "foo");

        // Verify edge via neighbors
        let neighbors = store
            .get_neighbors_project("function:foo@a.rs", Some("proj1"))
            .unwrap();
        assert_eq!(neighbors.len(), 1);
        assert_eq!(neighbors[0].0.label, "bar");
        assert_eq!(neighbors[0].1.relation, "Calls");

        // Verify node count
        let count = store.node_count_project(Some("proj1")).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn test_save_to_bincode() {
        let store = make_store();

        // Add nodes and edges to memory
        let n1 = make_node("function:foo@a.rs", "foo", "Function", "proj1");
        let n2 = make_node("function:bar@b.rs", "bar", "Function", "proj1");
        store.add_node(n1).unwrap();
        store.add_node(n2).unwrap();
        let edge = make_edge(
            "calls:foo→bar",
            "function:foo@a.rs",
            "function:bar@b.rs",
            "Calls",
            "proj1",
        );
        store
            .add_edge("function:foo@a.rs", "function:bar@b.rs", edge)
            .unwrap();

        // Add a global node
        let global_node = make_node("module:utils", "utils", "Module", "");
        store.add_node(global_node).unwrap();

        // Save to snapshot
        let mut file_hashes = HashMap::new();
        file_hashes.insert(
            "a.rs".to_string(),
            FileHash {
                mtime: 1000,
                size: 4096,
                content_hash: "abc123".to_string(),
            },
        );
        let snapshot = store.save_to_bincode("proj1", file_hashes).unwrap();

        // Verify snapshot
        assert_eq!(snapshot.version, CURRENT_SNAPSHOT_VERSION);
        assert_eq!(snapshot.project_id, "proj1");
        assert_eq!(snapshot.index_level, "variable");
        // 2 project nodes + 1 global node
        assert_eq!(snapshot.nodes.len(), 3);
        assert_eq!(snapshot.edges.len(), 1);
        assert_eq!(snapshot.file_hashes.len(), 1);

        // Verify round-trip: load snapshot into a fresh store
        let store2 = make_store();
        store2.load_from_bincode(snapshot).unwrap();

        let count = store2.node_count_project(Some("proj1")).unwrap();
        assert_eq!(count, 3, "should have 2 project + 1 global node");

        let neighbors = store2
            .get_neighbors_project("function:foo@a.rs", Some("proj1"))
            .unwrap();
        assert_eq!(neighbors.len(), 1);
    }

    /// Regression (P1-05): two projects share one in-memory graph and both
    /// contain `file:src/main.rs`. Because ids are project-local, a flat
    /// id-keyed index let the second project's node overwrite the first's —
    /// loading B silently destroyed A's node and A's edges.
    #[test]
    fn loading_a_second_project_does_not_steal_the_first_projects_nodes() {
        let store = make_store();

        // Project A owns `src/main.rs` and an edge out of it.
        store
            .add_node(make_node("file:src/main.rs", "main.rs", "File", "projA"))
            .unwrap();
        store
            .add_node(make_node("function:boot@src/main.rs", "boot", "Function", "projA"))
            .unwrap();
        store
            .add_edge(
                "file:src/main.rs",
                "function:boot@src/main.rs",
                make_edge(
                    "contains:a",
                    "file:src/main.rs",
                    "function:boot@src/main.rs",
                    "Contains",
                    "projA",
                ),
            )
            .unwrap();

        // Project B has the SAME relative path but different content.
        store
            .add_node(make_node("file:src/main.rs", "main.rs", "File", "projB"))
            .unwrap();

        // Both nodes must coexist.
        assert_eq!(store.node_count_project(Some("projA")).unwrap(), 2);
        assert_eq!(store.node_count_project(Some("projB")).unwrap(), 1);

        // A's node still resolves to A's data — B did not overwrite it.
        let a = store
            .find_nodes_by_type_project("Function", Some("projA"))
            .unwrap();
        assert_eq!(a.len(), 1, "projA lost its Function node to projB");

        // And A's neighbours are untouched.
        let neighbours = store
            .get_neighbors_project("file:src/main.rs", Some("projA"))
            .unwrap();
        assert_eq!(neighbours.len(), 1, "projA lost its edge to projB");

        // B's equally-named node has no neighbours.
        let b_neighbours = store
            .get_neighbors_project("file:src/main.rs", Some("projB"))
            .unwrap();
        assert!(b_neighbours.is_empty());
    }

    /// Same scenario through the snapshot path, which is where the overwrite
    /// actually happened in production (`load_from_bincode`).
    #[test]
    fn load_from_bincode_does_not_overwrite_another_projects_same_id_node() {
        let source = make_store();
        source
            .add_node(make_node("file:src/main.rs", "A main", "File", "projA"))
            .unwrap();
        source
            .add_node(make_node("file:src/main.rs", "B main", "File", "projB"))
            .unwrap();
        let snap_a = source.save_to_bincode("projA", HashMap::new()).unwrap();
        let snap_b = source.save_to_bincode("projB", HashMap::new()).unwrap();

        let store = make_store();
        store.load_from_bincode(snap_a).unwrap();
        store.load_from_bincode(snap_b).unwrap();

        let a = store
            .find_nodes_by_type_project("File", Some("projA"))
            .unwrap();
        let b = store
            .find_nodes_by_type_project("File", Some("projB"))
            .unwrap();
        assert_eq!(a.len(), 1, "projA's node was stolen by projB");
        assert_eq!(b.len(), 1);
        assert_eq!(a[0].label, "A main");
        assert_eq!(b[0].label, "B main");
    }

    #[test]
    fn test_get_node_pure_memory() {
        let store = make_store();

        // Node not in memory — should return None
        let result = store.get_node("nonexistent").unwrap();
        assert!(result.is_none());

        // Add node to memory
        let node = make_node("function:baz@main.rs", "baz", "Function", "proj1");
        store.add_node(node).unwrap();

        // Now should find it
        let result = store.get_node("function:baz@main.rs").unwrap();
        assert!(result.is_some());
        assert_eq!(result.unwrap().label, "baz");
        // get_node is pure memory; no SQLite read/write path exists any more (P3-04).
    }

    #[test]
    fn test_search_nodes_pure_memory() {
        let store = make_store();

        // Add nodes
        let n1 = make_node("function:foo@a.rs", "fooBar", "Function", "proj1");
        let n2 = make_node("function:bar@b.rs", "barBaz", "Function", "proj1");
        store.add_node(n1).unwrap();
        store.add_node(n2).unwrap();

        // Search for "bar" (case-insensitive) — should match both
        let results = store.search_nodes("bar", None, Some("proj1"), 10).unwrap();
        assert_eq!(results.len(), 2);

        // Search with type filter
        let results = store
            .search_nodes("bar", Some("Function"), Some("proj1"), 10)
            .unwrap();
        assert_eq!(results.len(), 2);

        let results = store
            .search_nodes("bar", Some("Class"), Some("proj1"), 10)
            .unwrap();
        assert_eq!(results.len(), 0);

        // Search for non-existent
        let results = store.search_nodes("qux", None, Some("proj1"), 10).unwrap();
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_node_count_project() {
        let store = make_store();

        // Add 3 project nodes + 1 global node
        store
            .add_node(make_node("n1", "n1", "Function", "proj1"))
            .unwrap();
        store
            .add_node(make_node("n2", "n2", "Function", "proj1"))
            .unwrap();
        store
            .add_node(make_node("n3", "n3", "Class", "proj1"))
            .unwrap();
        store.add_node(make_node("g1", "g1", "Module", "")).unwrap();

        // Count for proj1: 3 project + 1 global = 4
        let count = store.node_count_project(Some("proj1")).unwrap();
        assert_eq!(count, 4);

        // Count all (None): all 4 nodes
        let count = store.node_count_project(None).unwrap();
        assert_eq!(count, 4);

        // Count for another project: only global node
        let count = store.node_count_project(Some("proj2")).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_clear_project_memory() {
        let store = make_store();

        // Add project nodes + global node
        store
            .add_node(make_node("n1", "n1", "Function", "proj1"))
            .unwrap();
        store
            .add_node(make_node("n2", "n2", "Function", "proj1"))
            .unwrap();
        store.add_node(make_node("g1", "g1", "Module", "")).unwrap();
        store
            .add_edge("n1", "n2", make_edge("e1", "n1", "n2", "Calls", "proj1"))
            .unwrap();

        // Clear proj1 from memory
        store.clear_project_memory("proj1").unwrap();

        // Project nodes should be gone
        assert!(store.get_node("n1").unwrap().is_none());
        assert!(store.get_node("n2").unwrap().is_none());

        // Global node should survive
        let g = store.get_node("g1").unwrap();
        assert!(g.is_some());

        // Node count should be 1 (global only)
        let count = store.node_count_project(Some("proj1")).unwrap();
        assert_eq!(count, 1);
    }

    // ── Code-reuse directive (Step 3): semantic `similar` degrades to name
    // search when no embedding API is configured ──
    //
    // Without an embedding config, `search_similar` must NOT error/panic and
    // must degrade to a name/label based search (consistent with the TS-side
    // `graph_query` "similar" branch). It should recall label-matching symbols
    // and must NOT invent/recall unrelated ones.

    #[test]
    fn search_similar_degrades_to_name_search_without_embedding_config() {
        let store = make_store();

        // A Function node with a codeSnippet but no embedding endpoint configured.
        let mut props = std::collections::HashMap::new();
        props.insert(
            "codeSnippet".to_string(),
            serde_json::json!("fn formatDate(ts: i64) -> String { /* ... */ }"),
        );
        store
            .add_node(KGNode {
                id: "func:formatDate".to_string(),
                label: "formatDate".to_string(),
                node_type: "Function".to_string(),
                properties: Some(props),
                project_id: "proj1".to_string(),
            })
            .unwrap();

        // No set_embedding_config() call → embedding index is unconfigured.
        assert!(!store.embedding.has_config());

        // A query that shares the symbol name must recall it via name search.
        let results = store.search_similar("formatDate", Some("proj1"), 5);
        assert!(
            results.contains(&"func:formatDate".to_string()),
            "without embedding config, search_similar must degrade to name search and recall the label-matching node; got {results:?}"
        );

        // An unrelated query must NOT recall it (no false semantic match).
        let unrelated = store.search_similar("totally_unrelated_query_xyz", Some("proj1"), 5);
        assert!(
            !unrelated.contains(&"func:formatDate".to_string()),
            "unrelated query must not recall the node under name-search degradation; got {unrelated:?}"
        );
    }

    // Without embedding config, `search_similar` must never error even when the
    // store is empty — it simply returns no candidates.
    #[test]
    fn search_similar_empty_store_no_config_does_not_panic() {
        let store = make_store();
        assert!(!store.embedding.has_config());
        let results = store.search_similar("anything", Some("proj1"), 5);
        assert!(results.is_empty(), "empty store + no config must yield empty, not panic");
    }
}
