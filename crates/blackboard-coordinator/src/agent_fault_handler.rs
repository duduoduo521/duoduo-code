//! Agent fault handler.
//!
//! Detects and handles LLM call failures:
//! - LLM timeout (60s no response)
//! - LLM degraded (single token > 5s)
//! - LLM unqualified (tree-sitter rejects 3x)
//! - LLM empty/truncated response
//!
//! Fault handling: release locks + evaluate output + reassign task.

use anyhow::Result;
use std::sync::Arc;
use tracing::{info, warn};

use blackboard_store::BlackboardStore;
use file_lock_manager::FileLockManager;
use duo_types::*;

/// Agent fault handler.
pub struct AgentFaultHandler {
    store: Arc<BlackboardStore>,
    lock_manager: Arc<FileLockManager>,
    config: AgentFaultConfig,
}

impl AgentFaultHandler {
    pub fn new(
        store: Arc<BlackboardStore>,
        lock_manager: Arc<FileLockManager>,
        config: AgentFaultConfig,
    ) -> Self {
        Self {
            store,
            lock_manager,
            config,
        }
    }

    /// Get the fault configuration.
    pub fn config(&self) -> &AgentFaultConfig {
        &self.config
    }

    /// Handle an agent fault.
    ///
    /// Steps:
    /// 1. Record the fault
    /// 2. Release all file locks held by the agent
    /// 3. Evaluate output: keep stable, discard draft
    /// 4. Return fault handling result for task reassignment
    pub async fn handle_fault(
        &self,
        agent_id: &str,
        fault_type: AgentFaultType,
        detail: &str,
    ) -> Result<FaultHandlingResult> {
        warn!(
            agent = agent_id,
            fault_type = ?fault_type,
            detail = detail,
            "Handling agent fault"
        );

        // Step 1: Record the fault
        let fault_id = self.store.record_agent_fault(agent_id, &fault_type, detail)?;

        // Record metric
        self.store.record_metric(
            &MetricName::LlmFaultCount,
            1.0,
            Some(agent_id),
            None,
            Some(&serde_json::json!({"fault_type": format!("{:?}", fault_type)}).to_string()),
        )?;

        // Step 2: Release all file locks
        let released_files = self.lock_manager.release_all_agent_locks(agent_id).await?;

        // Step 3: Evaluate output
        // Keep stable submissions, discard drafts
        let discarded_drafts = self.store.delete_agent_drafts(agent_id)?;

        // Step 3b (R2 — fault reassignment): revert the agent's *assigned* intent
        // declarations back to `pending` instead of deleting them. This keeps the
        // intent history and coordination visibility (other agents see the file is
        // still intended), enabling the main loop's existing re-plan to
        // deterministically re-acquire these files on the next round, and supports
        // future backoff based on retry count. No separate scheduler is introduced.
        // (Deletion is no longer used now that `agent_intents` carries a `status`
        // column — `delete_agent_intents` remains available only as a last resort.)
        let reverted_intents = self.store.revert_agent_intents(agent_id)?;

        // Mark fault as handled
        self.store.mark_fault_handled(fault_id)?;

        info!(
            agent = agent_id,
            released_files = released_files.len(),
            discarded_drafts = discarded_drafts,
            reverted_intents = reverted_intents,
            "Agent fault handled"
        );

        Ok(FaultHandlingResult {
            agent_id: agent_id.to_string(),
            fault_type,
            released_files,
            discarded_drafts,
        })
    }

    /// Check if an agent should be marked as unqualified
    /// (tree-sitter has rejected 3 consecutive submissions).
    pub fn check_unqualified(&self, agent_id: &str) -> Result<bool> {
        let faults = self.store.get_unhandled_faults(agent_id)?;
        let reject_count = faults
            .iter()
            .filter(|f| matches!(f.fault_type, AgentFaultType::LlmUnqualified))
            .count();

        Ok(reject_count >= self.config.quality_check_max_rejects as usize)
    }

    /// Get the LLM request timeout in milliseconds.
    pub fn llm_request_timeout_ms(&self) -> u64 {
        self.config.llm_request_timeout_ms
    }

    /// Get the single token timeout in milliseconds.
    pub fn llm_token_timeout_ms(&self) -> u64 {
        self.config.llm_token_timeout_ms
    }

    /// Reassign tasks from a failed agent to other available agents.
    ///
    /// Strategy:
    /// 1. Get the failed agent's scope (allowed files)
    /// 2. Find other agents that have overlapping or compatible scopes
    /// 3. Reassign tasks to the best available agent
    /// 4. If no agent is available, mark task as unreassignable
    pub async fn reassign_tasks(
        &self,
        failed_agent_id: &str,
        available_agents: &[String],
    ) -> Result<TaskReassignmentResult> {
        let scope = self.store.get_agent_scope(failed_agent_id)?;
        let failed_files = scope.map(|s| s.allowed_files).unwrap_or_default();

        if failed_files.is_empty() {
            return Ok(TaskReassignmentResult {
                failed_agent_id: failed_agent_id.to_string(),
                reassigned_tasks: vec![],
                unreassignable_tasks: vec![],
            });
        }

        let mut reassigned = Vec::new();
        let mut unreassignable = Vec::new();

        for file in &failed_files {
            // Find an available agent whose scope includes this file, or the most suitable one
            let mut best_agent: Option<String> = None;
            let mut best_overlap = 0usize;

            for agent_id in available_agents {
                if agent_id == failed_agent_id {
                    continue;
                }
                let agent_scope = self.store.get_agent_scope(agent_id)?;
                if let Some(scope) = agent_scope {
                    let overlap = scope.allowed_files.iter().filter(|f| *f == file).count();
                    if overlap > best_overlap {
                        best_overlap = overlap;
                        best_agent = Some(agent_id.clone());
                    }
                }
            }

            match best_agent {
                Some(new_agent_id) => {
                    // Expand the new agent's scope to include this file
                    self.store.expand_agent_scope(&new_agent_id, file)?;

                    reassigned.push(ReassignedTask {
                        task_description: format!(
                            "Take over {} from failed agent {}",
                            file, failed_agent_id
                        ),
                        original_agent_id: failed_agent_id.to_string(),
                        new_agent_id,
                        target_files: vec![file.clone()],
                    });
                }
                None => {
                    unreassignable.push(file.clone());
                }
            }
        }

        info!(
            failed_agent = failed_agent_id,
            reassigned = reassigned.len(),
            unreassignable = unreassignable.len(),
            "Task reassignment complete"
        );

        Ok(TaskReassignmentResult {
            failed_agent_id: failed_agent_id.to_string(),
            reassigned_tasks: reassigned,
            unreassignable_tasks: unreassignable,
        })
    }
}

/// Result of fault handling.
#[derive(Clone, Debug)]
pub struct FaultHandlingResult {
    pub agent_id: String,
    pub fault_type: AgentFaultType,
    pub released_files: Vec<String>,
    pub discarded_drafts: usize,
}

/// Result of task reassignment.
#[derive(Clone, Debug)]
pub struct TaskReassignmentResult {
    pub failed_agent_id: String,
    pub reassigned_tasks: Vec<ReassignedTask>,
    pub unreassignable_tasks: Vec<String>,
}

/// A single reassigned task.
#[derive(Clone, Debug)]
pub struct ReassignedTask {
    pub task_description: String,
    pub original_agent_id: String,
    pub new_agent_id: String,
    pub target_files: Vec<String>,
}
