//! Optimistic lock manager.
//!
//! Ensures write consistency by checking file version + AST hash
//! at submission time. Works alongside intent locks as a double guarantee.

use anyhow::Result;
use std::sync::Arc;
use tracing::{debug, info, warn};

use blackboard_store::{BlackboardStore, FileVersionCas};
use duo_types::*;

/// Outcome of [`OptimisticLockManager::commit_write`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitOutcome {
    /// The base version still matched; write committed at `new_version`.
    Committed { new_version: i64 },
    /// Another writer bumped the version between validation and commit.
    Conflict { actual_version: Option<i64> },
}

/// Optimistic lock manager.
pub struct OptimisticLockManager {
    store: Arc<BlackboardStore>,
}

impl OptimisticLockManager {
    pub fn new(store: Arc<BlackboardStore>) -> Self {
        Self { store }
    }

    /// Validate a write request against current file version.
    ///
    /// Returns OptimisticLockResult::Success if version+hash match.
    /// Returns OptimisticLockResult::Conflict with structural conflict info if mismatch.
    pub fn validate_write(&self, request: &WriteRequest) -> Result<OptimisticLockResult> {
        let current = self.store.get_file_version(&request.file_path)?;

        match current {
            None => {
                // File not tracked yet - this is fine for new files
                debug!(file = %request.file_path, "File not tracked, allowing write");
                Ok(OptimisticLockResult::Success { new_version: 0 })
            }
            Some(version) => {
                let version_match = version.version == request.base_version;
                let hash_match = version.ast_hash == request.base_ast_hash;

                if version_match && hash_match {
                    debug!(
                        file = %request.file_path,
                        base_version = request.base_version,
                        "Optimistic lock validation passed"
                    );
                    Ok(OptimisticLockResult::Success {
                        new_version: version.version,
                    })
                } else {
                    // Version or hash mismatch - conflict
                    warn!(
                        file = %request.file_path,
                        expected_version = request.base_version,
                        actual_version = version.version,
                        expected_hash = %request.base_ast_hash,
                        actual_hash = %version.ast_hash,
                        "Optimistic lock conflict detected"
                    );

                    // Record conflict metric
                    self.store.record_metric(
                        &MetricName::FileConflictRate,
                        1.0,
                        Some(&request.agent_id),
                        Some(&request.file_path),
                        None,
                    )?;

                    Ok(OptimisticLockResult::Conflict {
                        expected_version: request.base_version,
                        actual_version: version.version,
                        conflicts: vec![StructuralConflict {
                            conflict_type: "version_mismatch".to_string(),
                            symbol: String::new(),
                            detail: format!(
                                "Expected version {} (hash: {}), actual version {} (hash: {})",
                                request.base_version,
                                request.base_ast_hash,
                                version.version,
                                version.ast_hash
                            ),
                        }],
                    })
                }
            }
        }
    }

    /// Commit a write after successful validation.
    ///
    /// Re-checks `expected_version` inside a single IMMEDIATE transaction
    /// (compare-and-swap) so a concurrent writer that bumped the version
    /// between `validate_write` and this call yields `Conflict` instead of a
    /// silent lost update.
    pub fn commit_write(
        &self,
        agent_id: &str,
        file_path: &str,
        content: &str,
        new_ast_hash: &str,
        expected_version: i64,
    ) -> Result<CommitOutcome> {
        let outcome = self.store.commit_file_version_cas(
            file_path,
            content,
            new_ast_hash,
            agent_id,
            expected_version,
        )?;

        match outcome {
            FileVersionCas::Committed { new_version } => {
                info!(
                    file = file_path,
                    new_version = new_version,
                    agent = agent_id,
                    "Write committed, version incremented"
                );
                // Record a success sample (value = 0.0) so
                // `compute_conflict_rate`'s denominator includes successful
                // writes. The metric previously only ever contained 1.0
                // conflict rows, so the rate was 1.0 after the first conflict
                // and the circuit breaker tripped permanently (P0-05).
                self.store.record_metric(
                    &MetricName::FileConflictRate,
                    0.0,
                    Some(agent_id),
                    Some(file_path),
                    None,
                )?;
                Ok(CommitOutcome::Committed { new_version })
            }
            FileVersionCas::Conflict { actual_version } => {
                warn!(
                    file = file_path,
                    agent = agent_id,
                    expected_version = expected_version,
                    actual_version = ?actual_version,
                    "Commit-time version conflict (lost update prevented)"
                );
                // Record conflict metric (same as validate-time conflicts).
                self.store.record_metric(
                    &MetricName::FileConflictRate,
                    1.0,
                    Some(agent_id),
                    Some(file_path),
                    None,
                )?;
                Ok(CommitOutcome::Conflict { actual_version })
            }
        }
    }

}
