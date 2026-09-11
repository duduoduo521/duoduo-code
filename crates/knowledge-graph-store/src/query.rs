//! Knowledge graph query algorithms: BFS shortest path & N-hop subgraph.
//!
//! All traversal methods support optional `project_id` filtering.
//! When `project_id` is provided, only nodes/edges within the same project
//! OR global (project_id = "") are traversed.

use std::collections::{HashMap, HashSet, VecDeque};
use anyhow::{anyhow, Result};
use petgraph::graph::NodeIndex;
use petgraph::visit::EdgeRef;

use super::graph::{Inner, KnowledgeGraphStore, matches_project};
use duo_types::*;

/// Resolve an entity id to a graph index.
///
/// Ids are only unique within a project, so the lookup is scoped by
/// `project_id`. `None` filters nothing, hence every project's node with that
/// id is a valid starting point and the first is used.
fn resolve(inner: &Inner, id: &str, project_id: Option<&str>) -> Option<NodeIndex> {
    match project_id {
        Some(pid) => inner.node_index(pid, id),
        None => inner.node_indices_named(id).into_iter().next(),
    }
}

/// BFS shortest path between two nodes with optional project_id filter.
///
/// Only traverses nodes/edges that match the given project_id or are global.
pub fn shortest_path_project(
    store: &KnowledgeGraphStore,
    from_id: &str,
    to_id: &str,
    project_id: Option<&str>,
) -> Result<Vec<String>> {
    if from_id == to_id {
        return Ok(vec![from_id.to_string()]);
    }

    let inner = store.inner.lock().map_err(|e| anyhow!("inner lock failed: {e}"))?;

    // A node that is absent from the filtered scope — or from the graph
    // entirely — simply has no path. This keeps "no path" distinguishable
    // from a real failure (lock poisoning) without inventing an error for a
    // legitimate query.
    let (Some(start), Some(target)) = (
        resolve(&inner, from_id, project_id),
        resolve(&inner, to_id, project_id),
    ) else {
        return Ok(vec![]);
    };

    // Verify start and target match the project filter
    if let Some(start_node) = inner.graph.node_weight(start)
        && !matches_project(start_node.project_id.as_str(), project_id) {
            return Ok(vec![]);
        }
    if let Some(target_node) = inner.graph.node_weight(target)
        && !matches_project(target_node.project_id.as_str(), project_id) {
            return Ok(vec![]);
        }

    // BFS: predecessor map for path reconstruction
    let mut visited: HashMap<NodeIndex, NodeIndex> = HashMap::new();
    let mut queue: VecDeque<NodeIndex> = VecDeque::new();

    queue.push_back(start);
    visited.insert(start, start); // sentinel: predecessor of start is itself

    while let Some(current) = queue.pop_front() {
        if current == target {
            // Reconstruct path
            let mut path = Vec::new();
            let mut node = target;
            while node != start {
                path.push(node);
                node = visited[&node];
            }
            path.push(start);
            path.reverse();

            let id_path: Vec<String> = path
                .iter()
                .map(|&idx| {
                    inner
                        .graph
                        .node_weight(idx)
                        .map(|n| n.id.clone())
                        .unwrap_or_default()
                })
                .collect();
            return Ok(id_path);
        }

        // Collect neighbors via outgoing and incoming edges, filtering by project_id
        let neighbors: Vec<NodeIndex> = inner
            .graph
            .edges(current)
            .filter(|edge| {
                matches_project(edge.weight().project_id.as_str(), project_id)
            })
            .filter_map(|edge| {
                let target_idx = edge.target();
                inner.graph.node_weight(target_idx).and_then(|n| {
                    if matches_project(n.project_id.as_str(), project_id) {
                        Some(target_idx)
                    } else {
                        None
                    }
                })
            })
            .chain(
                inner
                    .graph
                    .edges_directed(current, petgraph::Direction::Incoming)
                    .filter(|edge| {
                        matches_project(edge.weight().project_id.as_str(), project_id)
                    })
                    .filter_map(|edge| {
                        let source_idx = edge.source();
                        inner.graph.node_weight(source_idx).and_then(|n| {
                            if matches_project(n.project_id.as_str(), project_id) {
                                Some(source_idx)
                            } else {
                                None
                            }
                        })
                    }),
            )
            .collect();

        for neighbor in neighbors {
            if let std::collections::hash_map::Entry::Vacant(e) = visited.entry(neighbor) {
                e.insert(current);
                queue.push_back(neighbor);
            }
        }
    }

    // No path found
    Ok(vec![])
}

/// N-hop subgraph without project filter.
pub fn subgraph(store: &KnowledgeGraphStore, center_id: &str, hops: usize) -> Result<Vec<KGNode>> {
    subgraph_project(store, center_id, hops, None)
}

/// N-hop subgraph with optional project_id filter.
///
/// Only collects nodes/edges that match the given project_id or are global.
pub fn subgraph_project(
    store: &KnowledgeGraphStore,
    center_id: &str,
    hops: usize,
    project_id: Option<&str>,
) -> Result<Vec<KGNode>> {
    let inner = store.inner.lock().map_err(|e| anyhow!("inner lock failed: {e}"))?;

    let Some(start) = resolve(&inner, center_id, project_id) else {
        // Not visible under the filter — an empty subgraph, not an error.
        return Ok(vec![]);
    };

    // Verify center matches project filter
    if let Some(center_node) = inner.graph.node_weight(start)
        && !matches_project(center_node.project_id.as_str(), project_id) {
            return Ok(vec![]);
        }

    let mut visited: HashSet<NodeIndex> = HashSet::new();
    let mut queue: VecDeque<(NodeIndex, usize)> = VecDeque::new();

    queue.push_back((start, 0));
    visited.insert(start);

    let mut result_indices: Vec<NodeIndex> = Vec::new();

    while let Some((current, depth)) = queue.pop_front() {
        result_indices.push(current);

        if depth >= hops {
            continue;
        }

        // Collect neighbors, filtering by project_id
        let neighbors: Vec<NodeIndex> = inner
            .graph
            .edges(current)
            .filter(|edge| matches_project(edge.weight().project_id.as_str(), project_id))
            .filter_map(|edge| {
                let target_idx = edge.target();
                inner.graph.node_weight(target_idx).and_then(|n| {
                    if matches_project(n.project_id.as_str(), project_id) {
                        Some(target_idx)
                    } else {
                        None
                    }
                })
            })
            .chain(
                inner
                    .graph
                    .edges_directed(current, petgraph::Direction::Incoming)
                    .filter(|edge| matches_project(edge.weight().project_id.as_str(), project_id))
                    .filter_map(|edge| {
                        let source_idx = edge.source();
                        inner.graph.node_weight(source_idx).and_then(|n| {
                            if matches_project(n.project_id.as_str(), project_id) {
                                Some(source_idx)
                            } else {
                                None
                            }
                        })
                    }),
            )
            .collect();

        for neighbor in neighbors {
            if visited.insert(neighbor) {
                queue.push_back((neighbor, depth + 1));
            }
        }
    }

    let nodes: Vec<KGNode> = result_indices
        .iter()
        .filter_map(|&idx| inner.graph.node_weight(idx).cloned())
        .collect();

    Ok(nodes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use duo_types::{KGEdge, KGNode};
    use crate::persistence::GraphPersistence;

    fn make_node(id: &str, node_type: &str) -> KGNode {
        KGNode {
            id: id.to_string(),
            label: format!("label_{id}"),
            node_type: node_type.to_string(),
            properties: None,
            project_id: String::new(),
        }
    }

    fn make_node_project(id: &str, node_type: &str, project_id: &str) -> KGNode {
        KGNode {
            id: id.to_string(),
            label: format!("label_{id}"),
            node_type: node_type.to_string(),
            properties: None,
            project_id: project_id.to_string(),
        }
    }

    fn make_edge(from: &str, to: &str, relation: &str) -> KGEdge {
        KGEdge {
            id: format!("edge_{from}_{to}"),
            source_id: from.to_string(),
            target_id: to.to_string(),
            relation: relation.to_string(),
            weight: None,
            properties: None,
            project_id: String::new(),
        }
    }

    fn make_edge_project(from: &str, to: &str, relation: &str, project_id: &str) -> KGEdge {
        KGEdge {
            id: format!("edge_{from}_{to}"),
            source_id: from.to_string(),
            target_id: to.to_string(),
            relation: relation.to_string(),
            weight: None,
            properties: None,
            project_id: project_id.to_string(),
        }
    }

    #[test]
    fn test_shortest_path_direct() {
        let store = KnowledgeGraphStore::new(Arc::new(GraphPersistence::new_in_memory().unwrap())).unwrap();
        store.add_node(make_node("a", "t1")).unwrap();
        store.add_node(make_node("b", "t2")).unwrap();
        store.add_edge("a", "b", make_edge("a", "b", "connects")).unwrap();

        let path = shortest_path_project(&store, "a", "b", None).unwrap();
        assert_eq!(path, vec!["a", "b"]);
    }

    #[test]
    fn test_shortest_path_multi_hop() {
        let store = KnowledgeGraphStore::new(Arc::new(GraphPersistence::new_in_memory().unwrap())).unwrap();
        store.add_node(make_node("a", "t1")).unwrap();
        store.add_node(make_node("b", "t2")).unwrap();
        store.add_node(make_node("c", "t3")).unwrap();
        store.add_edge("a", "b", make_edge("a", "b", "connects")).unwrap();
        store.add_edge("b", "c", make_edge("b", "c", "connects")).unwrap();

        let path = shortest_path_project(&store, "a", "c", None).unwrap();
        assert_eq!(path, vec!["a", "b", "c"]);
    }

    #[test]
    fn test_shortest_path_same_node() {
        let store = KnowledgeGraphStore::new(Arc::new(GraphPersistence::new_in_memory().unwrap())).unwrap();
        store.add_node(make_node("a", "t1")).unwrap();

        let path = shortest_path_project(&store, "a", "a", None).unwrap();
        assert_eq!(path, vec!["a"]);
    }

    #[test]
    fn test_shortest_path_no_path() {
        let store = KnowledgeGraphStore::new(Arc::new(GraphPersistence::new_in_memory().unwrap())).unwrap();
        store.add_node(make_node("a", "t1")).unwrap();
        store.add_node(make_node("b", "t2")).unwrap();

        let path = shortest_path_project(&store, "a", "b", None).unwrap();
        assert!(path.is_empty());
    }

    #[test]
    fn test_shortest_path_project_isolation() {
        let store = KnowledgeGraphStore::new(Arc::new(GraphPersistence::new_in_memory().unwrap())).unwrap();
        // Project A: a → b → c
        store.add_node(make_node_project("a1", "t1", "projA")).unwrap();
        store.add_node(make_node_project("b1", "t2", "projA")).unwrap();
        store.add_node(make_node_project("c1", "t3", "projA")).unwrap();
        store.add_edge("a1", "b1", make_edge_project("a1", "b1", "connects", "projA")).unwrap();
        store.add_edge("b1", "c1", make_edge_project("b1", "c1", "connects", "projA")).unwrap();

        // Project B: a → b → d (different project, no c)
        store.add_node(make_node_project("a2", "t1", "projB")).unwrap();
        store.add_node(make_node_project("b2", "t2", "projB")).unwrap();
        store.add_node(make_node_project("d2", "t4", "projB")).unwrap();
        store.add_edge("a2", "b2", make_edge_project("a2", "b2", "connects", "projB")).unwrap();
        store.add_edge("b2", "d2", make_edge_project("b2", "d2", "connects", "projB")).unwrap();

        // Without project filter: path exists across projects (a1→b1→c1)
        let path = shortest_path_project(&store, "a1", "c1", None).unwrap();
        assert_eq!(path, vec!["a1", "b1", "c1"]);

        // With project filter projA: path a1→c1 exists
        let path_a = shortest_path_project(&store, "a1", "c1", Some("projA")).unwrap();
        assert_eq!(path_a, vec!["a1", "b1", "c1"]);

        // With project filter projB: no path from a1 to c1
        let path_b = shortest_path_project(&store, "a1", "c1", Some("projB")).unwrap();
        assert!(path_b.is_empty());

        // With project filter projB: path a2→d2 exists
        let path_b2 = shortest_path_project(&store, "a2", "d2", Some("projB")).unwrap();
        assert_eq!(path_b2, vec!["a2", "b2", "d2"]);
    }

    #[test]
    fn test_subgraph_single_hop() {
        let store = KnowledgeGraphStore::new(Arc::new(GraphPersistence::new_in_memory().unwrap())).unwrap();
        store.add_node(make_node("center", "t1")).unwrap();
        store.add_node(make_node("n1", "t2")).unwrap();
        store.add_node(make_node("n2", "t3")).unwrap();
        store.add_node(make_node("far", "t4")).unwrap();
        store.add_edge("center", "n1", make_edge("center", "n1", "connects")).unwrap();
        store.add_edge("center", "n2", make_edge("center", "n2", "connects")).unwrap();
        store.add_edge("n1", "far", make_edge("n1", "far", "connects")).unwrap();

        let nodes = subgraph(&store, "center", 1).unwrap();
        let ids: Vec<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"center"));
        assert!(ids.contains(&"n1"));
        assert!(ids.contains(&"n2"));
        assert!(!ids.contains(&"far"));
    }

    #[test]
    fn test_subgraph_two_hops() {
        let store = KnowledgeGraphStore::new(Arc::new(GraphPersistence::new_in_memory().unwrap())).unwrap();
        store.add_node(make_node("center", "t1")).unwrap();
        store.add_node(make_node("n1", "t2")).unwrap();
        store.add_node(make_node("far", "t4")).unwrap();
        store.add_edge("center", "n1", make_edge("center", "n1", "connects")).unwrap();
        store.add_edge("n1", "far", make_edge("n1", "far", "connects")).unwrap();

        let nodes = subgraph(&store, "center", 2).unwrap();
        let ids: Vec<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"center"));
        assert!(ids.contains(&"n1"));
        assert!(ids.contains(&"far"));
    }

    #[test]
    fn test_subgraph_project_isolation() {
        let store = KnowledgeGraphStore::new(Arc::new(GraphPersistence::new_in_memory().unwrap())).unwrap();
        // projA: centerA → n1A → farA
        store.add_node(make_node_project("centerA", "t1", "projA")).unwrap();
        store.add_node(make_node_project("n1A", "t2", "projA")).unwrap();
        store.add_node(make_node_project("farA", "t3", "projA")).unwrap();
        store.add_edge("centerA", "n1A", make_edge_project("centerA", "n1A", "c", "projA")).unwrap();
        store.add_edge("n1A", "farA", make_edge_project("n1A", "farA", "c", "projA")).unwrap();

        // projB: centerA has no neighbor (same ID different project)
        // Actually test with different node: centerB → n1B
        store.add_node(make_node_project("centerB", "t1", "projB")).unwrap();
        store.add_node(make_node_project("n1B", "t2", "projB")).unwrap();
        store.add_edge("centerB", "n1B", make_edge_project("centerB", "n1B", "c", "projB")).unwrap();

        // Without filter: subgraph of centerA includes both projects
        let nodes = subgraph(&store, "centerA", 2).unwrap();
        let ids: Vec<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"centerA"));
        assert!(ids.contains(&"n1A"));
        assert!(ids.contains(&"farA"));

        // With projA filter: only projA nodes
        let nodes_a = subgraph_project(&store, "centerA", 2, Some("projA")).unwrap();
        let ids_a: Vec<&str> = nodes_a.iter().map(|n| n.id.as_str()).collect();
        assert!(ids_a.contains(&"centerA"));
        assert!(ids_a.contains(&"n1A"));
        assert!(ids_a.contains(&"farA"));
        assert!(!ids_a.contains(&"n1B"));

        // With projB filter on centerA: empty (centerA belongs to projA)
        let nodes_b = subgraph_project(&store, "centerA", 2, Some("projB")).unwrap();
        assert!(nodes_b.is_empty());
    }

    #[test]
    fn test_matches_project() {
        assert!(matches_project("", None)); // global, no filter
        assert!(matches_project("projA", None)); // any project, no filter
        assert!(matches_project("projA", Some("projA"))); // exact match
        assert!(matches_project("", Some("projA"))); // global matches any project
        assert!(!matches_project("projB", Some("projA"))); // different project
    }
}
