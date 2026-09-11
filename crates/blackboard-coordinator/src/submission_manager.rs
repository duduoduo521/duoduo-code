//! Submission manager.
//!
//! Manages draft/stable submission lifecycle:
//! - Draft: only visible to creating agent, no side effects
//! - Stable: visible to all, triggers version increment + change notification
//! - tree-sitter self-review before stable promotion (syntax check)

use anyhow::Result;
use std::sync::Arc;
use tracing::{debug, info, warn};

use blackboard_store::BlackboardStore;
use duo_types::*;

use crate::coordinator::StableSubmission;
use crate::optimistic_lock::{CommitOutcome, OptimisticLockManager};
use crate::treesitter_integration::TreeSitterIntegration;

/// Submission manager.
pub struct SubmissionManager {
    store: Arc<BlackboardStore>,
    treesitter: Arc<TreeSitterIntegration>,
}

impl SubmissionManager {
    pub fn new(store: Arc<BlackboardStore>, treesitter: Arc<TreeSitterIntegration>) -> Self {
        Self { store, treesitter }
    }

    /// Submit a draft. Drafts are only visible to the creating agent.
    /// Replaces any existing draft by the same agent for the same file.
    pub fn submit_draft(
        &self,
        agent_id: &str,
        file_path: &str,
        content: &str,
        base_version: i64,
        base_ast_hash: &str,
    ) -> Result<i64> {
        let id = self.store.submit_file(
            agent_id,
            file_path,
            content,
            &FileSubmissionStatus::Draft,
            base_version,
            base_ast_hash,
        )?;

        debug!(id = id, agent = agent_id, file = file_path, "Draft submitted");
        Ok(id)
    }

    /// Submit a stable. This triggers:
    /// 1. Syntax validation (basic check - full tree-sitter validation in Phase 2)
    /// 2. Optimistic lock validation
    /// 3. Version increment
    /// 4. Change notification to dependent agents
    ///
    /// Returns the new version number on success.
    pub fn submit_stable(
        &self,
        StableSubmission {
            agent_id,
            file_path,
            content,
            base_version,
            base_ast_hash,
            new_ast_hash,
            skip_syntax_check,
        }: StableSubmission<'_>,
    ) -> Result<SubmitStableResult> {
        // Step 1: Tree-sitter syntax validation
        let language = Self::detect_language_from_path(file_path);
        if let Some(error) = self.treesitter.validate_syntax(content, &language, skip_syntax_check) {
            warn!(file = file_path, agent = agent_id, error = %error, "Syntax check failed, rejecting stable submission");
            return Ok(SubmitStableResult::SyntaxError { error });
        }

        // Step 2: Optimistic lock validation
        let write_request = WriteRequest {
            agent_id: agent_id.to_string(),
            file_path: file_path.to_string(),
            content: content.to_string(),
            base_version,
            base_ast_hash: base_ast_hash.to_string(),
            submission_status: FileSubmissionStatus::Stable,
        };

        let optimistic = OptimisticLockManager::new(self.store.clone());
        match optimistic.validate_write(&write_request)? {
            OptimisticLockResult::Success { .. } => {
                // Step 3: Commit the write (CAS: re-checks base_version inside
                // one transaction so a concurrent commit between validate and
                // here surfaces as Conflict instead of a lost update).
                let new_version = match optimistic.commit_write(
                    agent_id,
                    file_path,
                    content,
                    new_ast_hash,
                    base_version,
                )? {
                    CommitOutcome::Committed { new_version } => new_version,
                    CommitOutcome::Conflict { actual_version } => {
                        let actual_version = actual_version.unwrap_or(0);
                        warn!(
                            file = file_path,
                            agent = agent_id,
                            expected = base_version,
                            actual = actual_version,
                            "Commit-time version conflict during stable submission"
                        );
                        return Ok(SubmitStableResult::Conflict {
                            expected_version: base_version,
                            actual_version,
                            conflicts: vec![StructuralConflict {
                                conflict_type: "version_mismatch".to_string(),
                                symbol: String::new(),
                                detail: format!(
                                    "Commit-time CAS failed: expected version {base_version}, actual version {actual_version}"
                                ),
                            }],
                        });
                    }
                };

                // Step 4: Store the stable submission
                self.store.submit_file(
                    agent_id,
                    file_path,
                    content,
                    &FileSubmissionStatus::Stable,
                    base_version,
                    base_ast_hash,
                )?;

                info!(
                    file = file_path,
                    new_version = new_version,
                    agent = agent_id,
                    "Stable submitted successfully"
                );

                Ok(SubmitStableResult::Success { new_version })
            }
            OptimisticLockResult::Conflict {
                expected_version,
                actual_version,
                conflicts,
            } => {
                warn!(
                    file = file_path,
                    agent = agent_id,
                    expected = expected_version,
                    actual = actual_version,
                    "Optimistic lock conflict during stable submission"
                );
                Ok(SubmitStableResult::Conflict {
                    expected_version,
                    actual_version,
                    conflicts,
                })
            }
        }
    }

    /// Get the visible content for an agent reading a file.
    /// - If the agent has a draft, return the draft
    /// - Otherwise, return the latest stable version
    pub fn get_readable_content(&self, agent_id: &str, file_path: &str) -> Result<Option<String>> {
        // Check for own draft first
        let draft = self.store.get_latest_submission(agent_id, file_path)?;
        if let Some(submission) = draft
            && matches!(submission.status, FileSubmissionStatus::Draft) {
                return Ok(Some(submission.content));
            }

        // Fall back to latest stable
        let stable = self.store.get_stable_submission(file_path)?;
        Ok(stable.map(|s| s.content))
    }

    /// Detect language from file path extension.
    fn detect_language_from_path(file_path: &str) -> String {
        ast_engine::detect_language(file_path).unwrap_or_else(|| "unknown".to_string())
    }
}

/// Result of a stable submission attempt.
#[derive(Clone, Debug)]
pub enum SubmitStableResult {
    Success { new_version: i64 },
    Conflict {
        expected_version: i64,
        actual_version: i64,
        conflicts: Vec<StructuralConflict>,
    },
    SyntaxError { error: String },
}

/// Result of a draft-to-stable promotion attempt.
#[derive(Clone, Debug)]
pub enum PromoteResult {
    Success { new_version: i64 },
    Conflict {
        expected_version: i64,
        actual_version: i64,
        conflicts: Vec<StructuralConflict>,
    },
    SyntaxError { error: String },
    NoDraft { reason: String },
}
