//! Dependency change adapter.
//!
//! Implements the three adaptation scenarios from 09-依赖变更适配.md:
//! - Scenario 1: Agent writing draft, discovers dependency version changed
//! - Scenario 2: Agent pre-submitting stable, checks dependency versions
//! - Scenario 3: Agent already submitted stable, dependency changed (forced adaptation)

use anyhow::Result;
use std::sync::Arc;
use tracing::{debug, info, warn};

use blackboard_store::BlackboardStore;
use duo_types::*;

/// Result of checking a dependency version.
#[derive(Clone, Debug)]
pub struct DependencyChangeCheckResult {
    pub file: String,
    pub known_version: i64,
    pub current_version: i64,
    pub must_adapt: bool,
}

/// Result of processing a forced adaptation.
#[derive(Clone, Debug)]
pub struct ForcedAdaptationResult {
    pub must_adapt: bool,
    pub affected_files: Vec<String>,
    pub changes: Vec<ChangeLogEntry>,
}

pub struct DependencyAdapter {
    store: Arc<BlackboardStore>,
}

impl DependencyAdapter {
    pub fn new(store: Arc<BlackboardStore>) -> Self {
        Self { store }
    }

    /// Scenario 1: Agent is writing a draft and discovers a dependency's version has changed.
    ///
    /// The agent should call this when reading a dependency file during draft writing.
    /// Returns the dependency change check result if the version has changed, or None if up-to-date.
    pub fn check_dependency_version(
        &self,
        agent_id: &str,
        source_file: &str,
        dependency_file: &str,
        known_version: i64,
    ) -> Result<Option<DependencyChangeCheckResult>> {
        let current = self.store.get_file_version(dependency_file)?;
        match current {
            Some(version) => {
                if version.version == known_version {
                    debug!(
                        agent = agent_id,
                        dependency = dependency_file,
                        version = version.version,
                        "Dependency version up-to-date"
                    );
                    Ok(None)
                } else {
                    // Version has changed - get change logs for this dependency since the known version
                    let relevant_changes = self.store.get_change_logs_since(dependency_file, known_version)?;

                    info!(
                        agent = agent_id,
                        source = source_file,
                        dependency = dependency_file,
                        known_version = known_version,
                        current_version = version.version,
                        relevant_changes = relevant_changes.len(),
                        "Dependency version changed during draft writing"
                    );

                    Ok(Some(DependencyChangeCheckResult {
                        file: dependency_file.to_string(),
                        known_version,
                        current_version: version.version,
                        must_adapt: !relevant_changes.is_empty(),
                    }))
                }
            }
            None => {
                // Dependency file not tracked yet
                debug!(dependency = dependency_file, "Dependency file not tracked");
                Ok(None)
            }
        }
    }

    /// Scenario 2: Agent is about to submit stable, checks all dependencies.
    ///
    /// Returns a list of dependencies that have changed since the agent last read them.
    /// The agent must adapt to these changes before submitting stable.
    pub fn check_all_dependencies_before_stable(
        &self,
        agent_id: &str,
        source_file: &str,
    ) -> Result<Vec<DependencyChangeCheckResult>> {
        let dependencies = self.store.get_dependencies(source_file)?;
        let mut results = Vec::new();

        for dep in &dependencies {
            // Get the agent's latest submission for the source file
            let submission = self.store.get_latest_submission(agent_id, source_file)?;
            let base_version = submission.as_ref().map(|s| s.base_version).unwrap_or(0);

            let check = self.check_dependency_version(
                agent_id,
                source_file,
                &dep.target_file,
                base_version,
            )?;

            if let Some(result) = check {
                results.push(result);
            }
        }

        if !results.is_empty() {
            warn!(
                agent = agent_id,
                source = source_file,
                changed_dependencies = results.len(),
                "Dependencies changed before stable submission"
            );
        }

        Ok(results)
    }

    /// Scenario 3: Agent has already submitted stable, and a dependency has changed.
    ///
    /// This is triggered by the change notification system. The agent must adapt.
    /// Returns the notification details and what needs to be adapted.
    pub fn process_forced_adaptation(
        &self,
        agent_id: &str,
        notification: &ChangeNotification,
    ) -> Result<ForcedAdaptationResult> {
        // Check if the agent has a stable submission that depends on the changed file
        let dependencies = self.store.get_dependencies_for_agent(agent_id)?;

        let mut affected_files = Vec::new();
        for dep in &dependencies {
            if dep.target_file == notification.file {
                affected_files.push(dep.source_file.clone());
            }
        }

        if affected_files.is_empty() {
            debug!(
                agent = agent_id,
                notification_id = %notification.id,
                "No affected files, adaptation not needed"
            );
            return Ok(ForcedAdaptationResult {
                must_adapt: false,
                affected_files: vec![],
                changes: notification.changes.clone(),
            });
        }

        info!(
            agent = agent_id,
            notification_id = %notification.id,
            affected_files = affected_files.len(),
            "Forced adaptation required"
        );

        // Record the adaptation metric
        self.store.record_metric(
            &MetricName::DependencyAdaptCount,
            1.0,
            Some(agent_id),
            Some(&notification.file),
            None,
        )?;

        Ok(ForcedAdaptationResult {
            must_adapt: true,
            affected_files,
            changes: notification.changes.clone(),
        })
    }

    /// Register a file dependency (for the dependency graph).
    pub fn register_dependency(
        &self,
        source_file: &str,
        target_file: &str,
        dependency_type: &str,
        symbols_referenced: &[String],
    ) -> Result<()> {
        self.store.register_dependency(source_file, target_file, dependency_type, symbols_referenced)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn make_store() -> Arc<BlackboardStore> {
        Arc::new(BlackboardStore::open_in_memory("dep-test").unwrap())
    }

    #[test]
    fn test_check_dependency_version_up_to_date() {
        let store = make_store();
        let adapter = DependencyAdapter::new(store.clone());

        store.init_file_version("dep.ts", "// v0", "h0").unwrap();

        let result = adapter.check_dependency_version("agent-a", "src.ts", "dep.ts", 0).unwrap();
        assert!(result.is_none(), "Version 0 is up-to-date, should return None");
    }

    #[test]
    fn test_check_dependency_version_changed() {
        let store = make_store();
        let adapter = DependencyAdapter::new(store.clone());

        store.init_file_version("dep.ts", "// v0", "h0").unwrap();
        // Simulate a version change
        store.update_file_version("dep.ts", "// v1", "h1", "agent-b").unwrap();

        let result = adapter.check_dependency_version("agent-a", "src.ts", "dep.ts", 0).unwrap();
        assert!(result.is_some(), "Version changed, should return Some");
        let r = result.unwrap();
        assert_eq!(r.known_version, 0);
        assert_eq!(r.current_version, 1);
        // No change logs recorded, so must_adapt should be false
        assert!(!r.must_adapt);
    }

    #[test]
    fn test_check_dependency_version_changed_with_logs() {
        let store = make_store();
        let adapter = DependencyAdapter::new(store.clone());

        store.init_file_version("dep.ts", "// v0", "h0").unwrap();
        store.update_file_version("dep.ts", "// v1", "h1", "agent-b").unwrap();

        // Record a change log
        let diff = StructuredChangeList {
            file: "dep.ts".to_string(),
            agent_id: "agent-b".to_string(),
            changes: vec![FileChangeEntry {
                symbol_name: "fn_a".to_string(),
                change_kind: SymbolChangeKind::Modified,
                old_signature: None,
                new_signature: None,
            }],
        };
        store.record_change_log("dep.ts", 0, 1, "modified", "agent-b", &diff).unwrap();

        let result = adapter.check_dependency_version("agent-a", "src.ts", "dep.ts", 0).unwrap();
        assert!(result.is_some());
        let r = result.unwrap();
        assert!(r.must_adapt, "With change logs, must_adapt should be true");
    }

    #[test]
    fn test_check_dependency_version_not_tracked() {
        let store = make_store();
        let adapter = DependencyAdapter::new(store.clone());

        let result = adapter.check_dependency_version("agent-a", "src.ts", "unknown.ts", 0).unwrap();
        assert!(result.is_none(), "Untracked file should return None");
    }

    #[test]
    fn test_check_all_dependencies_before_stable_no_changes() {
        let store = make_store();
        let adapter = DependencyAdapter::new(store.clone());

        store.init_file_version("dep.ts", "// v0", "h0").unwrap();
        store.init_file_version("src.ts", "// v0", "h0").unwrap();
        store.register_dependency("src.ts", "dep.ts", "import", &["fn_a".into()]).unwrap();

        let results = adapter.check_all_dependencies_before_stable("agent-a", "src.ts").unwrap();
        assert!(results.is_empty(), "No changes, should return empty");
    }

    #[test]
    fn test_check_all_dependencies_before_stable_with_changes() {
        let store = make_store();
        let adapter = DependencyAdapter::new(store.clone());

        store.init_file_version("dep.ts", "// v0", "h0").unwrap();
        store.init_file_version("src.ts", "// v0", "h0").unwrap();
        store.register_dependency("src.ts", "dep.ts", "import", &["fn_a".into()]).unwrap();

        // Agent has a previous submission with base_version=0
        store.submit_file("agent-a", "src.ts", "// content", &FileSubmissionStatus::Draft, 0, "h0").unwrap();

        // Dependency gets updated
        store.update_file_version("dep.ts", "// v1", "h1", "agent-b").unwrap();

        let results = adapter.check_all_dependencies_before_stable("agent-a", "src.ts").unwrap();
        assert_eq!(results.len(), 1, "Should detect one changed dependency");
        assert_eq!(results[0].file, "dep.ts");
    }

    #[test]
    fn test_process_forced_adaptation_not_affected() {
        let store = make_store();
        let adapter = DependencyAdapter::new(store.clone());

        let notification = ChangeNotification {
            id: "notif-1".to_string(),
            file: "other.ts".to_string(),
            from_version: 0,
            to_version: 1,
            changes: vec![],
            target_agent_id: "agent-a".to_string(),
            created_at: String::new(),
            acknowledged: false,
        };

        let result = adapter.process_forced_adaptation("agent-a", &notification).unwrap();
        assert!(!result.must_adapt, "No dependency on the changed file");
        assert!(result.affected_files.is_empty());
    }

    #[test]
    fn test_process_forced_adaptation_affected() {
        let store = make_store();
        let adapter = DependencyAdapter::new(store.clone());

        store.init_file_version("dep.ts", "// v0", "h0").unwrap();
        store.init_file_version("src.ts", "// v0", "h0").unwrap();
        store.register_dependency("src.ts", "dep.ts", "import", &["fn_a".into()]).unwrap();

        // Agent has a stable submission on src.ts
        store.submit_file("agent-a", "src.ts", "// content", &FileSubmissionStatus::Stable, 0, "h0").unwrap();

        let notification = ChangeNotification {
            id: "notif-1".to_string(),
            file: "dep.ts".to_string(),
            from_version: 0,
            to_version: 1,
            changes: vec![ChangeLogEntry {
                change_type: ChangeType::Modified,
                symbol: "fn_a".to_string(),
                detail: "Signature changed".to_string(),
                old_signature: Some("fn_a(): void".into()),
                new_signature: Some("fn_a(): string".into()),
            }],
            target_agent_id: "agent-a".to_string(),
            created_at: String::new(),
            acknowledged: false,
        };

        let result = adapter.process_forced_adaptation("agent-a", &notification).unwrap();
        assert!(result.must_adapt, "Agent depends on the changed file");
        assert_eq!(result.affected_files, vec!["src.ts"]);
        assert_eq!(result.changes.len(), 1);
    }
}
