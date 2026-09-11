//! Wait-for graph deadlock observer (G13 deadlock boundary).
//!
//! Builds a directed "wait-for" graph from the current set of `assigned`
//! agent intents and held file locks, then detects cycles (potential
//! deadlocks) via depth-first search.
//!
//! # Zero-risk by design
//!
//! This observer is **strictly read-only**. It never acquires, releases, or
//! reassigns any lock, intent, or task. When a cycle is found it only:
//!   1. emits a `DeadlockCycleDetectCount` metric, and
//!   2. logs a warning naming the agents in the cycle.
//!
//! Cycles are broken **passively** by the independently-running lock-TTL
//! (`check_expired_locks`) and intent-TTL (`expire_stale_intents`) sweepers:
//! once a stuck holder's lock/intent times out, the edge disappears and the
//! cycle resolves on the next tick. Because this module mutates nothing, it
//! cannot introduce double-writes or corrupt coordination state — satisfying
//! the "detect, never force" zero-risk requirement.

use std::collections::{HashMap, HashSet};

/// A detected wait-for cycle, expressed as the ordered list of agent ids that
/// form the loop (e.g. `["A", "B"]` means A waits for B and B waits for A).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WaitCycle {
    /// Agents participating in the cycle, in traversal order.
    pub agents: Vec<String>,
}

/// Read-only wait-for graph detector.
///
/// The graph is rebuilt from a fresh snapshot on every [`detect_cycles`] call,
/// so there is no long-lived mutable state to corrupt.
pub struct WaitGraphDetector;

impl WaitGraphDetector {
    /// Detect wait-for cycles from an intent + lock snapshot.
    ///
    /// # Arguments
    /// * `assigned_intents` — `(agent_id, target_files)` for every intent whose
    ///   status is `assigned`. An agent is considered to *want* each of its
    ///   target files.
    /// * `locks` — `(file_path, holder_agent_id)` for every currently held file
    ///   lock.
    ///
    /// # Returns
    /// The list of distinct cycles found. An empty vec means no deadlock.
    ///
    /// An edge `A -> B` is added when agent `A` wants a file that is currently
    /// locked by a *different* agent `B` (A is blocked waiting on B). A cycle in
    /// this graph is a set of agents each transitively waiting on the next,
    /// i.e. a classic wait-for deadlock.
    pub fn detect_cycles(
        assigned_intents: &[(String, Vec<String>)],
        locks: &[(String, String)],
    ) -> Vec<WaitCycle> {
        // file -> holder agent
        let holder: HashMap<&str, &str> = locks
            .iter()
            .map(|(file, agent)| (file.as_str(), agent.as_str()))
            .collect();

        // Build adjacency: agent -> set of agents it waits for.
        let mut adj: HashMap<String, HashSet<String>> = HashMap::new();
        for (agent, files) in assigned_intents {
            for file in files {
                if let Some(&h) = holder.get(file.as_str())
                    && h != agent {
                        adj.entry(agent.clone()).or_default().insert(h.to_string());
                    }
            }
        }

        // DFS-based cycle detection with an explicit recursion stack so we can
        // reconstruct the participating agents when a back-edge is found.
        let mut cycles: Vec<WaitCycle> = Vec::new();
        let mut visited: HashSet<String> = HashSet::new();
        // Signatures of already-recorded cycles (sorted agent set) to dedup.
        let mut seen_signatures: HashSet<Vec<String>> = HashSet::new();

        let nodes: Vec<String> = adj.keys().cloned().collect();
        for start in nodes {
            if visited.contains(&start) {
                continue;
            }
            let mut stack: Vec<String> = Vec::new();
            let mut on_stack: HashSet<String> = HashSet::new();
            Self::dfs(
                &start,
                &adj,
                &mut visited,
                &mut stack,
                &mut on_stack,
                &mut cycles,
                &mut seen_signatures,
            );
        }

        cycles
    }

    #[allow(clippy::too_many_arguments)]
    fn dfs(
        node: &str,
        adj: &HashMap<String, HashSet<String>>,
        visited: &mut HashSet<String>,
        stack: &mut Vec<String>,
        on_stack: &mut HashSet<String>,
        cycles: &mut Vec<WaitCycle>,
        seen_signatures: &mut HashSet<Vec<String>>,
    ) {
        visited.insert(node.to_string());
        stack.push(node.to_string());
        on_stack.insert(node.to_string());

        if let Some(neighbors) = adj.get(node) {
            for next in neighbors {
                if on_stack.contains(next) {
                    // Back-edge: extract the cycle segment from `next` to top.
                    if let Some(pos) = stack.iter().position(|a| a == next) {
                        let agents: Vec<String> = stack[pos..].to_vec();
                        let mut signature = agents.clone();
                        signature.sort();
                        if seen_signatures.insert(signature) {
                            cycles.push(WaitCycle { agents });
                        }
                    }
                } else if !visited.contains(next) {
                    Self::dfs(next, adj, visited, stack, on_stack, cycles, seen_signatures);
                }
            }
        }

        stack.pop();
        on_stack.remove(node);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_cycle_when_no_contention() {
        let intents = vec![
            ("A".to_string(), vec!["a.rs".to_string()]),
            ("B".to_string(), vec!["b.rs".to_string()]),
        ];
        let locks = vec![
            ("a.rs".to_string(), "A".to_string()),
            ("b.rs".to_string(), "B".to_string()),
        ];
        assert!(WaitGraphDetector::detect_cycles(&intents, &locks).is_empty());
    }

    #[test]
    fn detects_two_agent_deadlock() {
        // A holds a.rs and wants b.rs; B holds b.rs and wants a.rs.
        let intents = vec![
            ("A".to_string(), vec!["a.rs".to_string(), "b.rs".to_string()]),
            ("B".to_string(), vec!["b.rs".to_string(), "a.rs".to_string()]),
        ];
        let locks = vec![
            ("a.rs".to_string(), "A".to_string()),
            ("b.rs".to_string(), "B".to_string()),
        ];
        let cycles = WaitGraphDetector::detect_cycles(&intents, &locks);
        assert_eq!(cycles.len(), 1);
        let mut agents = cycles[0].agents.clone();
        agents.sort();
        assert_eq!(agents, vec!["A".to_string(), "B".to_string()]);
    }

    #[test]
    fn no_self_wait_edge() {
        // Agent waiting on a file it already holds is not a deadlock.
        let intents = vec![("A".to_string(), vec!["a.rs".to_string()])];
        let locks = vec![("a.rs".to_string(), "A".to_string())];
        assert!(WaitGraphDetector::detect_cycles(&intents, &locks).is_empty());
    }

    #[test]
    fn detects_three_agent_cycle() {
        // A->B->C->A
        let intents = vec![
            ("A".to_string(), vec!["b.rs".to_string()]),
            ("B".to_string(), vec!["c.rs".to_string()]),
            ("C".to_string(), vec!["a.rs".to_string()]),
        ];
        let locks = vec![
            ("a.rs".to_string(), "A".to_string()),
            ("b.rs".to_string(), "B".to_string()),
            ("c.rs".to_string(), "C".to_string()),
        ];
        let cycles = WaitGraphDetector::detect_cycles(&intents, &locks);
        assert_eq!(cycles.len(), 1);
        assert_eq!(cycles[0].agents.len(), 3);
    }
}
