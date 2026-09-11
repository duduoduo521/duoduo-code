//! DNA Rule Engine — rule storage, management, and persistence.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::Result;
use duo_types::DnaRule;

/// Default filename for DNA rules persistence.
const DNA_RULES_FILE: &str = "dna_rules.json";

/// Rule engine that stores DNA rules, keeping them sorted by priority (descending).
///
/// When created via [`DnaEngine::new_with_persistence`], rules are loaded from
/// a JSON file on startup and automatically saved on every mutation
/// (`add_rule` / `remove_rule`).
pub struct DnaEngine {
    rules: Mutex<Vec<DnaRule>>,
    /// If set, rules are persisted to this file path on every mutation.
    persistence_path: Option<PathBuf>,
}

impl DnaEngine {
    /// Create a new empty engine (no persistence).
    pub fn new() -> Result<Self> {
        Ok(Self {
            rules: Mutex::new(Vec::new()),
            persistence_path: None,
        })
    }

    /// Create an engine that loads rules from a JSON file and persists on mutation.
    ///
    /// If the file exists, rules are deserialized and loaded into memory.
    /// If the file does not exist or is invalid, the engine starts with an empty rule set.
    ///
    /// The `project_path` is the root directory of the project. Rules are stored at
    /// `<data_dir>/database/<project_id>/dna_rules.json`.
    pub fn new_with_persistence(project_path: &Path) -> Result<Self> {
        let rules_dir = duo_utils::path::project_data_dir(project_path)?;
        let persistence_path = rules_dir.join(DNA_RULES_FILE);

        let rules = if persistence_path.exists() {
            match std::fs::read_to_string(&persistence_path) {
                Ok(content) => match serde_json::from_str::<Vec<DnaRule>>(&content) {
                    Ok(r) => {
                        tracing::info!(
                            path = %persistence_path.display(),
                            count = r.len(),
                            "Loaded DNA rules from file"
                        );
                        r
                    }
                    Err(e) => {
                        tracing::warn!(
                            path = %persistence_path.display(),
                            error = %e,
                            "Failed to parse DNA rules file, starting with empty rule set"
                        );
                        Vec::new()
                    }
                },
                Err(e) => {
                    tracing::warn!(
                        path = %persistence_path.display(),
                        error = %e,
                        "Failed to read DNA rules file, starting with empty rule set"
                    );
                    Vec::new()
                }
            }
        } else {
            tracing::info!(
                path = %persistence_path.display(),
                "No DNA rules file found, starting with empty rule set"
            );
            Vec::new()
        };

        Ok(Self {
            rules: Mutex::new(rules),
            persistence_path: Some(persistence_path),
        })
    }

    /// Add a rule, inserting it in priority-descending order.
    ///
    /// Rules with no `priority` (`None`) are treated as priority 0
    /// and placed after all rules that have an explicit priority.
    ///
    /// If persistence is enabled, the rules are written to disk after insertion.
    pub fn add_rule(&self, rule: DnaRule) -> Result<()> {
        let mut rules = self
            .rules
            .lock()
            .map_err(|e| anyhow::anyhow!("lock poisoned: {e}"))?;
        let priority = rule.priority.unwrap_or(0);
        // Find insertion point: first position where existing priority < new priority
        let pos = rules
            .iter()
            .position(|r| r.priority.unwrap_or(0) < priority)
            .unwrap_or(rules.len());
        rules.insert(pos, rule);
        self.persist_rules(&rules)?;
        Ok(())
    }

    /// Remove a rule by id. Returns `true` if a rule was found and removed.
    ///
    /// If persistence is enabled, the rules are written to disk after removal.
    pub fn remove_rule(&self, id: &str) -> Result<bool> {
        let mut rules = self
            .rules
            .lock()
            .map_err(|e| anyhow::anyhow!("lock poisoned: {e}"))?;
        let len_before = rules.len();
        rules.retain(|r| r.id != id);
        let removed = rules.len() < len_before;
        if removed {
            self.persist_rules(&rules)?;
        }
        Ok(removed)
    }

    /// Return all enabled rules (preserving priority-descending order).
    pub fn list_rules(&self) -> Result<Vec<DnaRule>> {
        let rules = self
            .rules
            .lock()
            .map_err(|e| anyhow::anyhow!("lock poisoned: {e}"))?;
        Ok(rules.iter().filter(|r| r.enabled).cloned().collect())
    }

    /// Return all rules (including disabled), preserving priority-descending order.
    pub fn list_all_rules(&self) -> Result<Vec<DnaRule>> {
        let rules = self
            .rules
            .lock()
            .map_err(|e| anyhow::anyhow!("lock poisoned: {e}"))?;
        Ok(rules.clone())
    }

    /// Persist the current rules to disk if persistence is enabled.
    ///
    /// Creates the project data directory if it does not exist.
    /// Errors are logged but do not fail the calling operation — persistence
    /// is best-effort to avoid blocking rule mutations on I/O failures.
    fn persist_rules(&self, rules: &[DnaRule]) -> Result<()> {
        let Some(ref path) = self.persistence_path else {
            return Ok(());
        };

        // Ensure parent directory exists
        if let Some(parent) = path.parent()
            && !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    anyhow::anyhow!("Failed to create DNA rules directory {}: {e}", parent.display())
                })?;
            }

        let json = serde_json::to_string_pretty(rules)
            .map_err(|e| anyhow::anyhow!("Failed to serialize DNA rules: {e}"))?;

        // Write atomically: write to temp file then rename
        let tmp_path = path.with_extension("json.tmp");
        std::fs::write(&tmp_path, &json)
            .map_err(|e| anyhow::anyhow!("Failed to write DNA rules to {}: {e}", tmp_path.display()))?;
        std::fs::rename(&tmp_path, path)
            .map_err(|e| anyhow::anyhow!("Failed to rename {} to {}: {e}", tmp_path.display(), path.display()))?;

        tracing::debug!(path = %path.display(), count = rules.len(), "Persisted DNA rules");
        Ok(())
    }
}

impl Default for DnaEngine {
    fn default() -> Self {
        Self::new().expect("Failed to initialize dna-engine")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_rule(id: &str, priority: Option<u32>, enabled: bool) -> DnaRule {
        DnaRule {
            id: id.to_string(),
            name: format!("rule_{id}"),
            condition: "test".to_string(),
            action: "act".to_string(),
            enabled,
            priority,
            metadata: None,
        }
    }

    #[test]
    fn test_add_rule_sorted_by_priority() {
        let engine = DnaEngine::new().unwrap();

        engine.add_rule(make_rule("low", Some(1), true)).unwrap();
        engine.add_rule(make_rule("high", Some(10), true)).unwrap();
        engine.add_rule(make_rule("mid", Some(5), true)).unwrap();
        engine.add_rule(make_rule("none", None, true)).unwrap();

        let rules = engine.list_rules().unwrap();
        assert_eq!(rules.len(), 4);
        assert_eq!(rules[0].id, "high");  // priority 10
        assert_eq!(rules[1].id, "mid");   // priority 5
        assert_eq!(rules[2].id, "low");   // priority 1
        assert_eq!(rules[3].id, "none");  // priority None → 0
    }

    #[test]
    fn test_remove_rule() {
        let engine = DnaEngine::new().unwrap();
        engine.add_rule(make_rule("a", Some(1), true)).unwrap();
        engine.add_rule(make_rule("b", Some(2), true)).unwrap();

        assert!(engine.remove_rule("a").unwrap());
        assert!(!engine.remove_rule("nonexistent").unwrap());

        let rules = engine.list_rules().unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].id, "b");
    }

    #[test]
    fn test_list_rules_filters_disabled() {
        let engine = DnaEngine::new().unwrap();
        engine.add_rule(make_rule("on", Some(1), true)).unwrap();
        engine.add_rule(make_rule("off", Some(2), false)).unwrap();
        engine.add_rule(make_rule("also_on", Some(3), true)).unwrap();

        let rules = engine.list_rules().unwrap();
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].id, "also_on");
        assert_eq!(rules[1].id, "on");
    }

    #[test]
    fn test_default_impl() {
        let engine = DnaEngine::default();
        let rules = engine.list_rules().unwrap();
        assert!(rules.is_empty());
    }

    /// Build a project path that is unique to this process/run.
    ///
    /// `new_with_persistence` does **not** store rules under `project_path`: it
    /// resolves `duo_utils::path::project_data_dir(project_path)`, which is a
    /// *global* directory keyed by a hash of the path. A fixed path therefore
    /// resolves to the same global dir on every run, and wiping the local temp
    /// dir does not clear it — rules accumulate across runs forever (this is
    /// exactly why `test_persistence_round_trip` drifted to `left: 15`).
    ///
    /// Using a unique path per run yields a distinct `project_id`, hence a fresh
    /// data dir. `unique_project_path` also returns the resolved data dir so the
    /// test can remove the real storage location afterwards.
    fn unique_project_path(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let unique = format!(
            "dna-engine-test-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        );
        let project = std::env::temp_dir().join(unique);
        let _ = std::fs::remove_dir_all(&project);
        std::fs::create_dir_all(&project).unwrap();
        let data_dir = duo_utils::path::project_data_dir(&project).unwrap();
        // The data dir is global and keyed by path hash; make sure no earlier
        // run left rules behind before the test starts.
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&data_dir).unwrap();
        (project, data_dir)
    }

    #[test]
    fn test_persistence_round_trip() {
        let (tmp, data_dir) = unique_project_path("persist");

        // Create engine with persistence, add rules
        {
            let engine = DnaEngine::new_with_persistence(&tmp).unwrap();
            engine.add_rule(make_rule("r1", Some(5), true)).unwrap();
            engine.add_rule(make_rule("r2", Some(10), true)).unwrap();
        }

        // Create a new engine from the same path — should load persisted rules
        let engine2 = DnaEngine::new_with_persistence(&tmp).unwrap();
        let rules = engine2.list_rules().unwrap();
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].id, "r2"); // priority 10 first
        assert_eq!(rules[1].id, "r1"); // priority 5 second

        // Remove a rule and verify persistence
        engine2.remove_rule("r1").unwrap();
        let engine3 = DnaEngine::new_with_persistence(&tmp).unwrap();
        let rules3 = engine3.list_rules().unwrap();
        assert_eq!(rules3.len(), 1);
        assert_eq!(rules3[0].id, "r2");

        // Cleanup: the temp project dir *and* the global data dir that actually
        // holds the rules file.
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn test_persistence_missing_file_starts_empty() {
        // Same isolation requirement as above: a fixed path would resolve to a
        // shared global data dir and this test would start seeing another run's
        // rules the moment anything persisted there.
        let (tmp, data_dir) = unique_project_path("missing");

        let engine = DnaEngine::new_with_persistence(&tmp).unwrap();
        let rules = engine.list_rules().unwrap();
        assert!(rules.is_empty());

        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn test_list_all_rules_includes_disabled() {
        let engine = DnaEngine::new().unwrap();
        engine.add_rule(make_rule("on", Some(1), true)).unwrap();
        engine.add_rule(make_rule("off", Some(2), false)).unwrap();

        let all = engine.list_all_rules().unwrap();
        assert_eq!(all.len(), 2);
    }
}
