//! Global circuit breaker.
//!
//! Monitors system-wide conflict rate and agent health.
//! Triggers熔断 when:
//! - Global conflict rate > threshold (default 50%)
//! - Agent failure ratio > threshold (default 50%)
//! - Blackboard crash count > threshold (default 3)
//!
//! When tripped: all parallel work pauses, switch to serial mode.

use anyhow::Result;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, warn};

use blackboard_store::BlackboardStore;
use duo_types::*;

/// Combined mutable counters protected by a single RwLock to prevent deadlocks.
/// Previously, `failed_agents`, `total_agents`, `crash_count`, `consecutive_serial_successes`
/// were separate RwLocks, and methods like `record_agent_failure` acquired multiple locks
/// in nested fashion (failed_agents → total_agents → config → state), which could deadlock
/// if another method acquired them in a different order.
#[derive(Debug, Default)]
struct CircuitBreakerCounters {
    failed_agents: usize,
    total_agents: usize,
    crash_count: u32,
    consecutive_serial_successes: u32,
}

/// Global circuit breaker.
pub struct CircuitBreaker {
    store: Arc<BlackboardStore>,
    config: Arc<RwLock<CircuitBreakerConfig>>,
    state: RwLock<CircuitBreakerState>,
    /// All mutable counters behind a single RwLock.
    counters: RwLock<CircuitBreakerCounters>,
}

impl CircuitBreaker {
    pub fn new(store: Arc<BlackboardStore>, config: CircuitBreakerConfig) -> Self {
        Self {
            store,
            config: Arc::new(RwLock::new(config)),
            state: RwLock::new(CircuitBreakerState::Normal),
            counters: RwLock::new(CircuitBreakerCounters::default()),
        }
    }

    /// Get current circuit breaker state.
    pub async fn state(&self) -> CircuitBreakerState {
        self.state.read().await.clone()
    }

    /// Check if circuit breaker is tripped.
    pub async fn is_tripped(&self) -> bool {
        matches!(*self.state.read().await, CircuitBreakerState::Broken)
    }

    /// Set total agent count.
    pub async fn set_total_agents(&self, count: usize) {
        self.counters.write().await.total_agents = count;
    }

    /// Record an agent failure.
    pub async fn record_agent_failure(&self) -> Result<()> {
        let mut counters = self.counters.write().await;
        counters.failed_agents += 1;

        if counters.total_agents > 0 {
            let ratio = counters.failed_agents as f64 / counters.total_agents as f64;
            let config = self.config.read().await;
            if ratio > config.agent_failure_ratio_threshold {
                warn!(
                    failed_agents = counters.failed_agents,
                    total_agents = counters.total_agents,
                    ratio = ratio,
                    threshold = config.agent_failure_ratio_threshold,
                    "Agent failure ratio exceeded threshold, triggering circuit breaker"
                );
                drop(config);
                drop(counters); // Release counters lock before acquiring state write lock
                self.trigger("agent_failure_ratio_exceeded").await?;
            }
        }

        Ok(())
    }

    /// Record an agent recovery (decrement failed count).
    /// Call this when an agent successfully completes an operation after a prior failure.
    pub async fn record_agent_recovery(&self) {
        let mut counters = self.counters.write().await;
        let prev = counters.failed_agents;
        counters.failed_agents = counters.failed_agents.saturating_sub(1);
        if prev != counters.failed_agents {
            info!(
                failed_agents = counters.failed_agents,
                "Agent recovered, decremented failed_agents counter"
            );
        }
    }

    /// Record a blackboard crash.
    pub async fn record_crash(&self) -> Result<()> {
        let mut counters = self.counters.write().await;
        counters.crash_count += 1;

        let config = self.config.read().await;
        if counters.crash_count > config.blackboard_crash_threshold {
            warn!(
                crash_count = counters.crash_count,
                threshold = config.blackboard_crash_threshold,
                "Blackboard crash count exceeded threshold, triggering circuit breaker"
            );
            drop(config);
            drop(counters); // Release counters lock before acquiring state write lock
            self.trigger("blackboard_crash_exceeded").await?;
        }

        Ok(())
    }

    /// Check global conflict rate and potentially trigger.
    pub async fn check_conflict_rate(&self) -> Result<bool> {
        let conflict_rate = self.store.compute_conflict_rate(50)?;
        let config = self.config.read().await;
        if conflict_rate > config.conflict_rate_threshold {
            warn!(
                conflict_rate = conflict_rate,
                threshold = config.conflict_rate_threshold,
                "Global conflict rate exceeded threshold, triggering circuit breaker"
            );
            drop(config);
            self.trigger("conflict_rate_exceeded").await?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Record a successful serial task completion (for recovery check).
    pub async fn record_serial_success(&self) -> Result<()> {
        let config = self.config.read().await;
        let mut counters = self.counters.write().await;
        counters.consecutive_serial_successes += 1;

        if counters.consecutive_serial_successes >= config.recovery_success_count {
            info!(
                consecutive_successes = counters.consecutive_serial_successes,
                required = config.recovery_success_count,
                "Recovery threshold reached, checking if safe to recover"
            );
            drop(config);
            drop(counters); // Release all locks before try_recover which acquires state
            self.try_recover().await?;
        }

        Ok(())
    }

    /// Record a serial task failure (resets recovery counter).
    pub async fn record_serial_failure(&self) {
        self.counters.write().await.consecutive_serial_successes = 0;
    }

    /// Get the current configuration.
    pub async fn config(&self) -> CircuitBreakerConfig {
        self.config.read().await.clone()
    }

    /// Update configuration at runtime.
    pub async fn update_config(&self, config: CircuitBreakerConfig) {
        *self.config.write().await = config;
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    /// Trigger the circuit breaker.
    async fn trigger(&self, reason: &str) -> Result<()> {
        let mut state = self.state.write().await;
        if matches!(*state, CircuitBreakerState::Broken) {
            return Ok(()); // Already tripped
        }

        *state = CircuitBreakerState::Broken;
        warn!(reason = reason, "Circuit breaker TRIGGERED - switching to serial mode");

        // Record metric
        self.store.record_metric(
            &MetricName::DegradationTriggerCount,
            1.0,
            None,
            None,
            Some(&serde_json::json!({"reason": reason}).to_string()),
        )?;

        Ok(())
    }

    /// Try to recover from circuit breaker state.
    async fn try_recover(&self) -> Result<()> {
        // Safety check: verify conflict rate has fallen and no new faults
        let conflict_rate = self.store.compute_conflict_rate(50)?;
        let counters = self.counters.read().await;
        let failure_ratio = if counters.total_agents > 0 {
            counters.failed_agents as f64 / counters.total_agents as f64
        } else {
            0.0
        };

        let config = self.config.read().await;
        let safe = conflict_rate <= config.conflict_rate_threshold
            && failure_ratio <= config.agent_failure_ratio_threshold;
        drop(config);
        // Release the read guard before taking the write lock below. tokio's
        // RwLock is write-preferring and not upgradable, so awaiting the write
        // lock while still holding this read guard deadlocks the maintenance
        // task permanently (P0-04) — every later `record_*` caller hangs too.
        drop(counters);

        if safe {
            let mut state = self.state.write().await;
            *state = CircuitBreakerState::Normal;
            drop(state);

            // Reset all counters on full recovery to prevent stale counts
            // from re-triggering the circuit breaker
            let mut counters = self.counters.write().await;
            counters.consecutive_serial_successes = 0;
            counters.failed_agents = 0;
            counters.crash_count = 0;

            info!("Circuit breaker RECOVERED - resuming parallel mode");
        } else {
            warn!(
                conflict_rate = conflict_rate,
                failure_ratio = failure_ratio,
                "Recovery safety check failed, remaining in serial mode"
            );
        }

        Ok(())
    }
}
