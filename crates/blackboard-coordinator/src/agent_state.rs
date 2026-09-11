//! Agent state management for backoff and coordination.
//!
//! Tracks agent states:
//! - Working: actively writing code
//! - InBackoff: waiting after conflict (no LLM calls)
//! - Faulted: LLM fault detected, needs recovery
//! - Idle: between tasks

use std::collections::HashMap;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use duo_types::*;

/// Agent operational state.
#[derive(Clone, Debug, PartialEq)]
pub enum AgentOperationalState {
    /// Agent is actively working on a task.
    Working,
    /// Agent is in backoff after a conflict. No LLM calls allowed.
    InBackoff {
        /// Which file caused the backoff.
        file: String,
        /// How many retries so far.
        retry_count: u32,
        /// Until when the backoff lasts.
        until: String, // ISO 8601 timestamp
    },
    /// Agent has faulted and needs recovery.
    Faulted {
        fault_type: AgentFaultType,
    },
    /// Agent is idle, waiting for a task.
    Idle,
}

/// Agent state manager.
pub struct AgentStateManager {
    states: Mutex<HashMap<String, AgentOperationalState>>,
}

impl Default for AgentStateManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentStateManager {
    pub fn new() -> Self {
        Self {
            states: Mutex::new(HashMap::new()),
        }
    }

    /// Set an agent's state.
    pub async fn set_state(&self, agent_id: &str, state: AgentOperationalState) {
        let mut states = self.states.lock().await;
        let old = states.get(agent_id).cloned();
        states.insert(agent_id.to_string(), state.clone());

        if old.as_ref() != Some(&state) {
            debug!(agent = agent_id, old_state = ?old, new_state = ?state, "Agent state changed");
        }
    }

    /// Get an agent's state.
    pub async fn get_state(&self, agent_id: &str) -> AgentOperationalState {
        let states = self.states.lock().await;
        states.get(agent_id).cloned().unwrap_or(AgentOperationalState::Idle)
    }

    /// Check if an agent can make LLM calls.
    /// Returns false if the agent is in backoff or faulted.
    pub async fn can_call_llm(&self, agent_id: &str) -> bool {
        let state = self.get_state(agent_id).await;
        match state {
            AgentOperationalState::InBackoff { .. } => {
                // Check if backoff period has expired
                // For simplicity, always return false during backoff
                // The background tick loop will transition the state
                false
            }
            AgentOperationalState::Faulted { .. } => false,
            _ => true,
        }
    }

    /// Check if an agent can accept new intent declarations.
    /// Returns false if the agent is in backoff or faulted.
    pub async fn can_accept_intents(&self, agent_id: &str) -> bool {
        self.can_call_llm(agent_id).await
    }

    /// Set agent to backoff state after a conflict.
    pub async fn enter_backoff(&self, agent_id: &str, file: &str, retry_count: u32, delay_secs: u64) {
        let until = chrono::Utc::now() + chrono::Duration::seconds(delay_secs as i64);
        self.set_state(agent_id, AgentOperationalState::InBackoff {
            file: file.to_string(),
            retry_count,
            until: until.to_rfc3339(),
        }).await;
        info!(agent = agent_id, file = file, retry = retry_count, delay_secs = delay_secs, "Agent entered backoff");
    }

    /// Set agent to faulted state.
    pub async fn mark_faulted(&self, agent_id: &str, fault_type: AgentFaultType) {
        self.set_state(agent_id, AgentOperationalState::Faulted { fault_type: fault_type.clone() }).await;
        warn!(agent = agent_id, fault_type = ?fault_type, "Agent marked as faulted");
    }

    /// Set agent to working state.
    pub async fn mark_working(&self, agent_id: &str) {
        self.set_state(agent_id, AgentOperationalState::Working).await;
    }

    /// Set agent to idle state.
    pub async fn mark_idle(&self, agent_id: &str) {
        self.set_state(agent_id, AgentOperationalState::Idle).await;
    }

    /// Check and expire backoff periods for all agents.
    /// Returns list of agents that exited backoff.
    pub async fn expire_backoffs(&self) -> Vec<String> {
        let now = chrono::Utc::now();
        let mut states = self.states.lock().await;
        let mut expired = Vec::new();

        for (agent_id, state) in states.iter_mut() {
            if let AgentOperationalState::InBackoff { until, .. } = state
                && let Ok(until_time) = chrono::DateTime::parse_from_rfc3339(until)
                    && now >= until_time.with_timezone(&chrono::Utc) {
                        *state = AgentOperationalState::Idle;
                        expired.push(agent_id.clone());
                        debug!(agent = agent_id, "Agent backoff expired");
                    }
        }

        expired
    }

    /// Get all agents in a specific state.
    pub async fn get_agents_in_state(&self, target_state: &AgentOperationalState) -> Vec<String> {
        let states = self.states.lock().await;
        states.iter()
            .filter(|(_, state)| std::mem::discriminant(*state) == std::mem::discriminant(target_state))
            .map(|(id, _)| id.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_agent_state_transitions() {
        let mgr = AgentStateManager::new();

        // Default state is Idle
        assert_eq!(mgr.get_state("agent-a").await, AgentOperationalState::Idle);
        assert!(mgr.can_call_llm("agent-a").await);

        // Mark as working
        mgr.mark_working("agent-a").await;
        assert_eq!(mgr.get_state("agent-a").await, AgentOperationalState::Working);
        assert!(mgr.can_call_llm("agent-a").await);

        // Mark as idle
        mgr.mark_idle("agent-a").await;
        assert_eq!(mgr.get_state("agent-a").await, AgentOperationalState::Idle);
    }

    #[tokio::test]
    async fn test_agent_backoff_blocks_llm() {
        let mgr = AgentStateManager::new();

        // Enter backoff with 1-second delay
        mgr.enter_backoff("agent-a", "file.ts", 1, 1).await;
        let state = mgr.get_state("agent-a").await;
        assert!(matches!(state, AgentOperationalState::InBackoff { .. }));
        assert!(!mgr.can_call_llm("agent-a").await);
        assert!(!mgr.can_accept_intents("agent-a").await);

        // Expire backoffs - with 1s delay it should not expire immediately
        let expired = mgr.expire_backoffs().await;
        assert!(expired.is_empty());

        // Wait for backoff to expire
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        let expired = mgr.expire_backoffs().await;
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0], "agent-a");

        // Should be idle now
        assert_eq!(mgr.get_state("agent-a").await, AgentOperationalState::Idle);
        assert!(mgr.can_call_llm("agent-a").await);
    }

    #[tokio::test]
    async fn test_agent_faulted_blocks_llm() {
        let mgr = AgentStateManager::new();

        // Mark as faulted
        mgr.mark_faulted("agent-a", AgentFaultType::LlmTimeout).await;
        let state = mgr.get_state("agent-a").await;
        assert!(matches!(state, AgentOperationalState::Faulted { .. }));
        assert!(!mgr.can_call_llm("agent-a").await);
        assert!(!mgr.can_accept_intents("agent-a").await);
    }

    #[tokio::test]
    async fn test_get_agents_in_state() {
        let mgr = AgentStateManager::new();

        mgr.mark_working("agent-a").await;
        mgr.mark_working("agent-b").await;
        mgr.mark_faulted("agent-c", AgentFaultType::LlmTimeout).await;

        let working = mgr.get_agents_in_state(&AgentOperationalState::Working).await;
        assert_eq!(working.len(), 2);
        assert!(working.contains(&"agent-a".to_string()));
        assert!(working.contains(&"agent-b".to_string()));

        let faulted = mgr.get_agents_in_state(&AgentOperationalState::Faulted {
            fault_type: AgentFaultType::LlmTimeout,
        }).await;
        assert_eq!(faulted.len(), 1);
        assert!(faulted.contains(&"agent-c".to_string()));
    }
}
