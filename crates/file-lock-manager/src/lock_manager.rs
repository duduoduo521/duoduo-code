//! File lock manager implementation.
//!
//! Core responsibilities:
//! - acquire_locks: Agent submits intent, try to acquire all file locks
//! - release_lock: Agent completes, release specific file lock
//! - force_release: Timeout/fault triggered release
//! - check_and_grant_queued: After release, grant lock to next waiter
//!
//! # Design Decision: Wait Queues Are Ephemeral (R13 Mitigation)
//!
//! The `wait_queues` field is intentionally kept as an in-memory-only
//! data structure without persistence to `BlackboardStore`. Rationale:
//!
//! 1. **File locks themselves are transient** — they exist only within
//!    the lifetime of a single process. When the process crashes or
//!    restarts, all file locks are released automatically (the lock
//!    table in `BlackboardStore` is cleared by `recover_from_crash`).
//! 2. **Wait queues are meaningless without active locks** — if there
//!    are no locks held, there is nothing to wait for. All queued
//!    agents would immediately be granted their locks anyway.
//! 3. **Persisting queues introduces consistency risk** — if we persist
//!    queue entries but not the lock state atomically, we risk granting
//!    locks to agents that no longer exist or have already retried.
//!
//! Therefore, on startup we explicitly clear all wait queues (via
//! `Self::new` calling `clear_wait_queues`), which is the correct
//! semantic: a fresh process starts with no locks and no waiters.

use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use blackboard_store::BlackboardStore;
use duo_types::*;

/// Configuration for file lock behavior.
#[derive(Clone, Debug)]
pub struct FileLockConfig {
    /// Lock timeout in seconds. Default: 300 (5 minutes).
    pub lock_timeout_secs: u64,
    /// Whether to enforce atomic lock acquisition (all-or-nothing).
    pub atomic_acquire: bool,
}

impl Default for FileLockConfig {
    fn default() -> Self {
        Self {
            lock_timeout_secs: 300,
            atomic_acquire: true,
        }
    }
}

/// Wait queue entry for a file.
///
/// **Note**: This is an in-memory-only structure. It is NOT persisted to
/// `BlackboardStore`. See module-level documentation for the design rationale.
#[derive(Clone, Debug)]
pub struct WaitQueueEntry {
    pub agent_id: String,
    pub requested_at: String,
}

/// File lock manager. Coordinates file-level write access between agents.
///
/// Wait queues (`wait_queues`) are intentionally ephemeral — they are cleared
/// on startup because file locks are also transient. See the module-level
/// documentation for the full rationale.
pub struct FileLockManager {
    store: Arc<BlackboardStore>,
    config: FileLockConfig,
    /// In-memory wait queues: file_path -> Vec<WaitQueueEntry>
    ///
    /// **NOT persisted**. On process restart, all locks are released and all
    /// wait queues are cleared. This is by design — see module-level docs.
    wait_queues: Mutex<HashMap<String, Vec<WaitQueueEntry>>>,
}

impl FileLockManager {
    pub fn new(store: Arc<BlackboardStore>, config: FileLockConfig) -> Self {
        // Clear any stale wait queues from a previous process instance.
        // This is safe because: (a) the lock table is also reset on crash
        // recovery, and (b) queued agents from a previous process lifecycle
        // no longer exist and would need to re-request locks anyway.
        info!("FileLockManager: initializing with empty wait queues (stale queues from previous process are discarded by design)");

        Self {
            store,
            config,
            wait_queues: Mutex::new(HashMap::new()),
        }
    }

    /// Explicitly clear all wait queues.
    ///
    /// Called on startup to ensure no stale entries remain. Idempotent.
    pub async fn clear_wait_queues(&self) {
        let mut queues = self.wait_queues.lock().await;
        let count: usize = queues.values().map(|q| q.len()).sum();
        if count > 0 {
            info!(discarded_entries = count, "Cleared stale wait queue entries on startup");
        }
        queues.clear();
    }

    /// Agent submits intent declaration, attempting to acquire locks on all target files.
    ///
    /// Returns a vector of LockAcquireResult for each file.
    /// If atomic_acquire is true and any file cannot be locked, all acquired locks are released
    /// and the agent is queued for all files.
    pub async fn acquire_locks(&self, declaration: &IntentDeclaration) -> Result<Vec<LockAcquireResult>> {
        let mut results = Vec::new();
        let mut acquired_files = Vec::new();

        info!(
            agent = %declaration.agent_id,
            files = ?declaration.files,
            intent = ?declaration.intent,
            "Agent requesting file locks"
        );

        // Only implement write locks for now
        if declaration.intent != IntentKind::Write {
            for file in &declaration.files {
                results.push(LockAcquireResult::Granted { file: file.clone() });
            }
            return Ok(results);
        }

        // Try to acquire each file lock
        for file in &declaration.files {
            let acquired = self.store.acquire_file_lock(file, &declaration.agent_id, "write")?;
            if acquired {
                results.push(LockAcquireResult::Granted { file: file.clone() });
                acquired_files.push(file.clone());
            } else {
                // File is locked by another agent, add to wait queue
                let position = self.enqueue_wait(file, &declaration.agent_id).await?;
                results.push(LockAcquireResult::Queued { file: file.clone(), position });
            }
        }

        // Atomic mode: if any file is queued, release all acquired locks and queue for everything
        if self.config.atomic_acquire {
            let has_queued = results.iter().any(|r| matches!(r, LockAcquireResult::Queued { .. }));
            if has_queued {
                // Release all acquired locks
                for file in &acquired_files {
                    self.store.release_file_lock(file, &declaration.agent_id)?;
                }

                // Queue for all files that were granted (replace Granted with Queued)
                let mut final_results = Vec::new();
                for result in &results {
                    match result {
                        LockAcquireResult::Granted { file } => {
                            let position = self.enqueue_wait(file, &declaration.agent_id).await?;
                            final_results.push(LockAcquireResult::Queued { file: file.clone(), position });
                        }
                        LockAcquireResult::Queued { file, position } => {
                            final_results.push(LockAcquireResult::Queued {
                                file: file.clone(),
                                position: *position,
                            });
                        }
                        LockAcquireResult::Denied { file, reason } => {
                            final_results.push(LockAcquireResult::Denied {
                                file: file.clone(),
                                reason: reason.clone(),
                            });
                        }
                    }
                }

                info!(
                    agent = %declaration.agent_id,
                    "Atomic lock acquisition: some files queued, releasing all acquired locks"
                );

                return Ok(final_results);
            }
        }

        info!(
            agent = %declaration.agent_id,
            granted = acquired_files.len(),
            total = declaration.files.len(),
            "Lock acquisition complete"
        );

        Ok(results)
    }

    /// Agent releases a specific file lock after completing work.
    /// Triggers granting the lock to the next agent in the wait queue.
    pub async fn release_lock(&self, agent_id: &str, file_path: &str) -> Result<()> {
        info!(agent = agent_id, file = file_path, "Agent releasing file lock");

        let released = self.store.release_file_lock(file_path, agent_id)?;
        if released {
            // Try to grant lock to next agent in queue
            self.grant_to_next_in_queue(file_path).await?;
        }

        Ok(())
    }

    /// Release all locks held by an agent (used in fault handling).
    pub async fn release_all_agent_locks(&self, agent_id: &str) -> Result<Vec<String>> {
        let files = self.store.release_all_locks_for_agent(agent_id)?;

        // For each released file, try to grant to next in queue
        for file in &files {
            self.grant_to_next_in_queue(file).await?;
        }

        // Also remove agent from all wait queues
        self.remove_from_all_queues(agent_id).await;

        Ok(files)
    }

    /// Force release a file lock (timeout or fault handling).
    pub async fn force_release(&self, file_path: &str, reason: &str) -> Result<Option<String>> {
        warn!(file = file_path, reason = reason, "Force releasing file lock");

        let prev_owner = self.store.force_release_file_lock(file_path)?;

        // Grant to next in queue
        self.grant_to_next_in_queue(file_path).await?;

        Ok(prev_owner)
    }

    /// Get current lock state for a file.
    pub fn get_lock_state(&self, file_path: &str) -> Result<FileLockState> {
        self.store.get_file_lock_state(file_path)
    }

    /// Get the wait queue for a file.
    pub async fn get_wait_queue(&self, file_path: &str) -> Vec<WaitQueueEntry> {
        let queues = self.wait_queues.lock().await;
        queues.get(file_path).cloned().unwrap_or_default()
    }

    /// Recover from a crash: release all locks and clear wait queues.
    /// Returns the list of (agent_id, file_path) pairs that had locks.
    pub async fn recover_from_crash(&self) -> Result<Vec<(String, String)>> {
        let locks = self.store.get_all_locks()?;
        let mut released = Vec::new();

        for (file_path, agent_id, _) in &locks {
            self.store.force_release_file_lock(file_path)?;
            released.push((agent_id.clone(), file_path.clone()));
        }

        // Clear all wait queues — they are meaningless without active locks
        self.clear_wait_queues().await;

        if !released.is_empty() {
            info!(released_count = released.len(), "Crash recovery: all locks released, wait queues cleared");
        }

        Ok(released)
    }

    /// Check for expired locks and force release them.
    pub async fn check_expired_locks(&self) -> Result<Vec<String>> {
        let locks = self.store.get_all_locks()?;
        let now = chrono::Utc::now();
        let mut expired = Vec::new();

        for (file_path, agent_id, acquired_at) in locks {
            if let Ok(acquired_time) = chrono::DateTime::parse_from_rfc3339(&acquired_at) {
                let elapsed = now.signed_duration_since(acquired_time.with_timezone(&chrono::Utc));
                if elapsed.num_seconds() > self.config.lock_timeout_secs as i64 {
                    warn!(
                        file = %file_path,
                        agent = %agent_id,
                        elapsed_secs = elapsed.num_seconds(),
                        "Lock expired, force releasing"
                    );
                    self.force_release(&file_path, "lock_timeout").await?;
                    expired.push(file_path);
                }
            }
        }

        if !expired.is_empty() {
            info!(expired_count = expired.len(), "Expired locks released");
        }

        Ok(expired)
    }

    // -------------------------------------------------------------------------
    // Internal methods
    // -------------------------------------------------------------------------

    /// Add an agent to the wait queue for a file.
    async fn enqueue_wait(&self, file_path: &str, agent_id: &str) -> Result<usize> {
        let mut queues = self.wait_queues.lock().await;
        let queue = queues.entry(file_path.to_string()).or_default();

        // Check if agent is already in queue
        if queue.iter().any(|e| e.agent_id == agent_id) {
            let position = queue
                .iter()
                .position(|e| e.agent_id == agent_id)
                .expect("invariant: element presence verified by any() check immediately above");
            return Ok(position + 1); // 1-based position
        }

        let entry = WaitQueueEntry {
            agent_id: agent_id.to_string(),
            requested_at: chrono::Utc::now().to_rfc3339(),
        };
        queue.push(entry);

        let position = queue.len();
        debug!(file = file_path, agent = agent_id, position = position, "Agent queued for file lock");
        Ok(position)
    }

    /// Grant lock to the next agent in the wait queue for a file.
    async fn grant_to_next_in_queue(&self, file_path: &str) -> Result<()> {
        let next_agent = {
            let mut queues = self.wait_queues.lock().await;
            if let Some(queue) = queues.get_mut(file_path) {
                if !queue.is_empty() {
                    let next = queue.remove(0); // FIFO
                    Some(next.agent_id)
                } else {
                    None
                }
            } else {
                None
            }
        };

        if let Some(agent_id) = next_agent {
            let acquired = self.store.acquire_file_lock(file_path, &agent_id, "write")?;
            if acquired {
                info!(file = file_path, agent = %agent_id, "Lock granted to next agent in queue");
            } else {
                // Should not happen since we just released the lock, but handle gracefully
                warn!(file = file_path, agent = %agent_id, "Failed to grant lock to next agent in queue");
                // Re-enqueue at front
                let mut queues = self.wait_queues.lock().await;
                let queue = queues.entry(file_path.to_string()).or_default();
                queue.insert(0, WaitQueueEntry {
                    agent_id,
                    requested_at: chrono::Utc::now().to_rfc3339(),
                });
            }
        }

        Ok(())
    }

    /// Remove an agent from all wait queues.
    async fn remove_from_all_queues(&self, agent_id: &str) {
        let mut queues = self.wait_queues.lock().await;
        for (_, queue) in queues.iter_mut() {
            queue.retain(|entry| entry.agent_id != agent_id);
        }
    }

    /// Remove a single agent from the wait queue of a specific file.
    ///
    /// Must be called by any caller that gives up after receiving
    /// [`LockAcquireResult::Queued`]. A stale entry would otherwise be handed
    /// the lock by [`Self::grant_to_next_in_queue`] once the current holder
    /// releases it; since the abandoning agent never comes back to release it,
    /// the lock would stay held until the timeout reaper reclaims it, blocking
    /// every other agent on that file in the meantime.
    pub async fn remove_from_queue(&self, file_path: &str, agent_id: &str) {
        let mut queues = self.wait_queues.lock().await;
        if let Some(queue) = queues.get_mut(file_path) {
            queue.retain(|entry| entry.agent_id != agent_id);
        }
    }

    /// Roll back a failed intent declaration (B-03 fix).
    ///
    /// Releases any file locks that were granted for `files` and removes the
    /// agent from the corresponding wait queues, so a held lock is never
    /// orphaned without its intent row. Used by the coordinator when intent
    /// registration fails after locks were acquired. Safe to call even when no
    /// lock is held for a given file (the release is a no-op in that case).
    pub async fn rollback_declaration(
        &self,
        agent_id: &str,
        files: &[String],
    ) -> Result<()> {
        for file in files {
            // Release a granted lock if held (no-op otherwise); this also lets
            // the next waiter acquire the file if it was released.
            let _ = self.release_lock(agent_id, file).await;
            // Drop any residual wait-queue entry so the agent is not granted a
            // lock for a declaration that already failed.
            self.remove_from_queue(file, agent_id).await;
        }
        Ok(())
    }
}
