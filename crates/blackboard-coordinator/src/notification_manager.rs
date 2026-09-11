//! Change notification manager.
//!
//! When a file's stable version changes:
//! 1. Generate structural change list
//! 2. Check dependency graph for affected agents
//! 3. Send precise notifications (only to agents that depend on changed symbols)
//! 4. At-Least-Once delivery with ACK and timeout retry

use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use blackboard_store::BlackboardStore;
use duo_types::*;

/// Notification ACK timeout in seconds.
const ACK_TIMEOUT_SECS: u64 = 60;

/// Maximum number of re-delivery attempts before giving up on a notification.
/// After this many timeouts, the notification is removed from `pending_acks`
/// to prevent unbounded growth in long-running sessions.
const MAX_ACK_RETRIES: u32 = 3;

/// Change notification manager.
pub struct NotificationManager {
    store: Arc<BlackboardStore>,
    /// Track pending ACKs: notification_id -> (agent_id, created_at, retry_count)
    pending_acks: Mutex<HashMap<String, (String, String, u32)>>,
}

impl NotificationManager {
    pub fn new(store: Arc<BlackboardStore>) -> Self {
        Self {
            store,
            pending_acks: Mutex::new(HashMap::new()),
        }
    }

    /// Generate and send change notifications after a file's stable version changes.
    ///
    /// Steps:
    /// 1. Get all files that depend on the changed file
    /// 2. For each dependent file, identify which agents have stable submissions
    /// 3. Create notifications for affected agents
    pub async fn notify_file_change(
        &self,
        file_path: &str,
        from_version: i64,
        to_version: i64,
        changes: &[ChangeLogEntry],
    ) -> Result<Vec<String>> {
        if changes.is_empty() {
            debug!(file = file_path, "No changes to notify about");
            return Ok(vec![]);
        }

        // Get all files that depend on this file
        let dependents = self.store.get_dependents(file_path)?;
        if dependents.is_empty() {
            debug!(file = file_path, "No dependents, no notifications needed");
            return Ok(vec![]);
        }

        let mut notification_ids = Vec::new();

        // For each dependent file, find which agents have stable submissions
        for dep in &dependents {
            // Get the stable submission for this dependent file
            let stable = self.store.get_stable_submission(&dep.source_file)?;
            if let Some(submission) = stable {
                // Create a notification for this agent
                let notification_id = self.store.create_change_notification(
                    file_path,
                    from_version,
                    to_version,
                    changes,
                    &submission.agent_id,
                )?;

                // Track pending ACK
                let mut pending = self.pending_acks.lock().await;
                pending.insert(
                    notification_id.clone(),
                    (submission.agent_id.clone(), chrono::Utc::now().to_rfc3339(), 0),
                );

                notification_ids.push(notification_id.clone());

                info!(
                    file = file_path,
                    dependent = %dep.source_file,
                    agent = %submission.agent_id,
                    notification_id = %notification_id,
                    "Change notification created"
                );
            }
        }

        // Record metric
        self.store.record_metric(
            &MetricName::NotificationAckTimeoutCount,
            0.0, // Will be updated when ACK times out
            None,
            Some(file_path),
            None,
        )?;

        Ok(notification_ids)
    }

    /// Acknowledge a change notification.
    pub async fn acknowledge_notification(
        &self,
        notification_id: &str,
        agent_id: &str,
        action_taken: &str,
    ) -> Result<bool> {
        let acknowledged = self.store.acknowledge_notification(notification_id, action_taken)?;

        if acknowledged {
            // Remove from pending ACKs
            let mut pending = self.pending_acks.lock().await;
            pending.remove(notification_id);

            debug!(
                notification_id = notification_id,
                agent = agent_id,
                action = action_taken,
                "Change notification acknowledged"
            );
        }

        Ok(acknowledged)
    }

    /// Check for unacknowledged notifications that have timed out and re-deliver.
    ///
    /// Re-delivery is bounded by `MAX_ACK_RETRIES`. After that many attempts,
    /// the notification is removed from `pending_acks` to prevent unbounded
    /// memory growth in long-running sessions.
    pub async fn check_ack_timeouts(&self) -> Result<Vec<String>> {
        let mut pending = self.pending_acks.lock().await;
        let now = chrono::Utc::now();
        let mut re_delivered = Vec::new();
        let mut to_remove = Vec::new();

        // Collect re-delivery info before mutating pending_acks
        // (old_notification_id -> (new_id, agent_id, retry_count))
        let mut re_delivery_map: Vec<(String, String, String, u32)> = Vec::new();

        for (notification_id, (agent_id, created_at, retry_count)) in pending.iter() {
            if let Ok(created_time) = chrono::DateTime::parse_from_rfc3339(created_at) {
                let elapsed = now.signed_duration_since(created_time.with_timezone(&chrono::Utc));
                if elapsed.num_seconds() > ACK_TIMEOUT_SECS as i64 {
                    // Exceeded max retries — remove to prevent unbounded growth
                    if *retry_count >= MAX_ACK_RETRIES {
                        warn!(
                            original_id = notification_id,
                            agent = agent_id,
                            retries = retry_count,
                            "Notification exceeded max ACK retries, giving up"
                        );
                        to_remove.push(notification_id.clone());
                        continue;
                    }

                    // Re-deliver: get the notification and re-create it
                    let notifications = self.store.get_unacknowledged_notifications(agent_id)?;
                    for notification in notifications {
                        if &notification.id == notification_id {
                            // Re-create the notification (At-Least-Once semantics)
                            let new_id = self.store.create_change_notification(
                                &notification.file,
                                notification.from_version,
                                notification.to_version,
                                &notification.changes,
                                agent_id,
                            )?;

                            warn!(
                                original_id = notification_id,
                                new_id = %new_id,
                                agent = agent_id,
                                retries = retry_count,
                                "Notification ACK timeout, re-delivering"
                            );

                            // Record metric
                            self.store.record_metric(
                                &MetricName::NotificationAckTimeoutCount,
                                1.0,
                                Some(agent_id),
                                Some(&notification.file),
                                None,
                            )?;

                            re_delivered.push(new_id.clone());
                            // Track mapping: old_id -> (new_id, agent_id, retry_count+1)
                            re_delivery_map.push((
                                notification_id.clone(),
                                new_id,
                                agent_id.clone(),
                                *retry_count + 1,
                            ));
                        }
                    }
                }
            }
        }

        // Remove timed-out original entries
        for id in &to_remove {
            pending.remove(id);
        }
        // For re-delivered notifications: remove the old entry and insert the new one
        // with incremented retry_count, so the new notification_id is tracked for future ACKs.
        for (old_id, new_id, agent_id, new_retry_count) in re_delivery_map {
            pending.remove(&old_id);
            pending.insert(
                new_id,
                (agent_id, chrono::Utc::now().to_rfc3339(), new_retry_count),
            );
        }

        Ok(re_delivered)
    }

    /// Get unacknowledged notifications for an agent.
    pub fn get_pending_notifications(&self, agent_id: &str) -> Result<Vec<ChangeNotification>> {
        self.store.get_unacknowledged_notifications(agent_id)
    }

    /// Recover pending ACKs from SQLite after a crash.
    /// Reconstructs the in-memory `pending_acks` HashMap from persisted notifications.
    pub async fn recover_from_crash(&self) -> Result<usize> {
        let notifications = self.store.get_all_unacknowledged_notifications()?;
        let mut pending = self.pending_acks.lock().await;
        pending.clear();

        for notification in &notifications {
            pending.insert(
                notification.id.clone(),
                (notification.target_agent_id.clone(), notification.created_at.clone(), 0),
            );
        }

        let count = pending.len();
        if count > 0 {
            tracing::info!(count = count, "Crash recovery: pending ACKs reconstructed");
        }
        Ok(count)
    }
}
