//! File scope enforcer.
//!
//! Enforces that agents only write to files within their assigned scope.
//! Three-level protection:
//! 1. Scheduler assigns file scope at planning time
//! 2. Blackboard validates writes against scope
//! 3. Out-of-scope writes are rejected; scope expansion can be requested

use anyhow::Result;
use std::sync::Arc;
use tracing::{debug, warn};

use blackboard_store::BlackboardStore;

/// File scope enforcer.
pub struct ScopeEnforcer {
    store: Arc<BlackboardStore>,
}

impl ScopeEnforcer {
    pub fn new(store: Arc<BlackboardStore>) -> Self {
        Self { store }
    }

    /// Register an agent's allowed file scope.
    pub fn register_scope(&self, agent_id: &str, allowed_files: &[String]) -> Result<()> {
        self.store.register_agent_scope(agent_id, allowed_files)
    }

    /// Validate that a write is within the agent's scope.
    /// Returns Ok(InScope) if in scope, Ok(OutOfScope) if out of scope.
    pub fn validate_write_scope(
        &self,
        agent_id: &str,
        file_path: &str,
    ) -> Result<ScopeValidationResult> {
        let scope = self.store.get_agent_scope(agent_id)?;

        match scope {
            Some(scope) => {
                if scope.allowed_files.iter().any(|f| {
                    f == "*"
                        || (f.ends_with('/') && file_path.starts_with(f.as_str()))
                        || f == file_path
                }) {
                    debug!(agent = agent_id, file = file_path, "Write within scope");
                    Ok(ScopeValidationResult::InScope)
                } else {
                    warn!(
                        agent = agent_id,
                        file = file_path,
                        allowed = ?scope.allowed_files,
                        "Write out of scope"
                    );
                    Ok(ScopeValidationResult::OutOfScope {
                        allowed_files: scope.allowed_files,
                    })
                }
            }
            None => {
                // No scope registered - reject by default
                warn!(
                    agent = agent_id,
                    file = file_path,
                    "No scope registered for agent"
                );
                Ok(ScopeValidationResult::NoScope)
            }
        }
    }

    /// Check if any agent has a registered scope (used for backward compatibility)
    pub fn has_any_registered_scope(&self) -> Result<bool> {
        self.store.has_any_agent_scope()
    }

}

/// Result of scope validation.
#[derive(Clone, Debug)]
pub enum ScopeValidationResult {
    InScope,
    OutOfScope { allowed_files: Vec<String> },
    NoScope,
}
