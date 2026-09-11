//! Conflict degradation mechanism.
//!
//! When optimistic lock conflicts occur repeatedly:
//! 1st conflict → ImmediateRetry
//! 2nd conflict → DelayedRetry(30s)
//! 3rd conflict → SerialMode
//!
//! Pure deterministic rules, no LLM judgment needed.

use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};

use blackboard_store::BlackboardStore;
use duo_types::*;

/// Delay in seconds for 2nd retry.
const RETRY_DELAY_SECS: u64 = 30;

/// Conflict degradation manager.
pub struct ConflictDegradation {
    store: Arc<BlackboardStore>,
    /// Track conflict retry counts: (agent_id, file_path) -> retry_count
    retry_counters: Mutex<HashMap<(String, String), u32>>,
    /// Files currently in serial mode
    serial_mode_files: Mutex<HashMap<String, bool>>,
}

impl ConflictDegradation {
    pub fn new(store: Arc<BlackboardStore>) -> Self {
        Self {
            store,
            retry_counters: Mutex::new(HashMap::new()),
            serial_mode_files: Mutex::new(HashMap::new()),
        }
    }

    /// Record a conflict and determine the resolution strategy.
    pub async fn record_conflict(
        &self,
        agent_id: &str,
        file_path: &str,
    ) -> Result<ConflictResolution> {
        let key = (agent_id.to_string(), file_path.to_string());
        let mut counters = self.retry_counters.lock().await;
        let count = counters.entry(key.clone()).or_insert(0);
        *count += 1;

        let resolution = match *count {
            1 => {
                info!(
                    agent = agent_id,
                    file = file_path,
                    retry = 1,
                    "Conflict: immediate retry"
                );
                ConflictResolution::ImmediateRetry
            }
            2 => {
                info!(
                    agent = agent_id,
                    file = file_path,
                    retry = 2,
                    delay_secs = RETRY_DELAY_SECS,
                    "Conflict: delayed retry"
                );
                ConflictResolution::DelayedRetry {
                    delay_secs: RETRY_DELAY_SECS,
                }
            }
            _ => {
                warn!(
                    agent = agent_id,
                    file = file_path,
                    retry = *count,
                    "Conflict: degrading to serial mode"
                );
                // Mark file as serial mode
                let mut serial_files = self.serial_mode_files.lock().await;
                serial_files.insert(file_path.to_string(), true);

                // Record metric
                self.store.record_metric(
                    &MetricName::DegradationTriggerCount,
                    1.0,
                    Some(agent_id),
                    Some(file_path),
                    None,
                )?;

                ConflictResolution::SerialMode
            }
        };

        Ok(resolution)
    }

    /// Reset the retry counter for a successful write.
    pub async fn reset_counter(&self, agent_id: &str, file_path: &str) {
        let key = (agent_id.to_string(), file_path.to_string());
        let mut counters = self.retry_counters.lock().await;
        counters.remove(&key);
    }

    /// Check if a file is in serial mode.
    pub async fn is_serial_mode(&self, file_path: &str) -> bool {
        let serial_files = self.serial_mode_files.lock().await;
        serial_files.get(file_path).copied().unwrap_or(false)
    }

    /// Get the current retry count for an agent+file.
    pub async fn get_retry_count(&self, agent_id: &str, file_path: &str) -> u32 {
        let key = (agent_id.to_string(), file_path.to_string());
        let counters = self.retry_counters.lock().await;
        counters.get(&key).copied().unwrap_or(0)
    }

    /// Remove a file from serial mode (for recovery).
    pub async fn remove_serial_mode(&self, file_path: &str) {
        let mut serial_files = self.serial_mode_files.lock().await;
        serial_files.remove(file_path);
        info!(file = file_path, "File removed from serial mode");
    }

    /// Recover degradation state from SQLite after a crash.
    /// Retry counters and serial mode state are in-memory only,
    /// so on crash they reset to defaults (which is safe: no ongoing conflicts).
    pub async fn recover_from_crash(&self) {
        let mut counters = self.retry_counters.lock().await;
        counters.clear();
        let mut serial_files = self.serial_mode_files.lock().await;
        serial_files.clear();
        tracing::info!("Crash recovery: conflict degradation state reset");
    }

}
