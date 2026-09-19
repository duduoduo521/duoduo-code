//! Tool result registry for P2-01 (Rust runLoop suspend/resume).
//!
//! Bridges the gap between a suspended agent runLoop waiting for a tool
//! result and the external caller (typically the TS side) that submits it.
//! Keyed by `(session_id, call_id)` so multiple concurrent tool calls
//! within the same session are tracked independently.
//!
//! The wait has a **10-minute timeout** — tool execution can take long
//! (e.g. a bash compile), but not indefinitely. If the timeout fires,
//! the pending entry is cleaned up and an error is returned.
//! Cancellation via CancellationToken (user abort / client disconnect)
//! is also handled by the caller's `tokio::select!`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use tokio::sync::{Mutex, oneshot};
use tracing::{debug, warn};

/// How long a pending entry may sit untouched before it is considered stale:
/// 2× the 10-minute wait timeout. A live waiter always removes its own entry
/// (submit / timeout / sender-dropped) well inside that window, so purging an
/// entry older than TTL can never kill a live wait.
const ENTRY_TTL: Duration = Duration::from_secs(1200);

/// Registry that pairs suspended agent loops with oneshot channels,
/// allowing an external producer to submit tool results that the loop
/// is awaiting.
/// Map of `(session_id, tool_call_id)` → channel awaiting that tool's result.
type PendingToolResults = Arc<Mutex<HashMap<(String, String), PendingEntry>>>;

struct PendingEntry {
    tx: oneshot::Sender<String>,
    inserted_at: Instant,
}

impl std::fmt::Debug for PendingEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingEntry")
            .field("age_secs", &self.inserted_at.elapsed().as_secs())
            .finish()
    }
}

#[derive(Debug)]
pub struct ToolResultRegistry {
    pending: PendingToolResults,
}

impl ToolResultRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 2-6: drop entries that nobody picked up within [`ENTRY_TTL`]. Without
    /// this, a cancelled waiter (whose caller drops the future, so neither the
    /// submit nor the timeout arm ever runs for it) leaks its entry until the
    /// same key re-registers or a late submit arrives. Purging drops the
    /// oneshot sender, which correctly errors the (long-gone) waiter.
    async fn purge_expired(&self) {
        let mut map = self.pending.lock().await;
        let before = map.len();
        map.retain(|_, entry| entry.inserted_at.elapsed() < ENTRY_TTL);
        let removed = before - map.len();
        if removed > 0 {
            warn!(removed, "purged expired pending tool-result entries");
        }
    }

    /// Register a oneshot channel for `(session_id, call_id)` and wait for
    /// the result to be submitted via [`Self::submit_tool_result`].
    ///
    /// Waits up to 10 minutes. If the TS side crashes or becomes
    /// unresponsive, the timeout fires, the pending entry is cleaned up,
    /// and an error is returned — preventing the Rust side from hanging
    /// indefinitely.
    ///
    /// Cancellation via CancellationToken (user abort / client disconnect)
    /// is also handled by the caller's `tokio::select!`.
    ///
    /// If a duplicate key already exists the previous sender is dropped
    /// (cancelling the old waiter) and replaced — this should not happen
    /// in normal operation and is logged as a warning.
    pub async fn wait_for_tool_result(&self, session_id: &str, call_id: &str) -> Result<String> {
        let (tx, rx) = oneshot::channel();
        let key = (session_id.to_owned(), call_id.to_owned());

        self.purge_expired().await;
        {
            let mut map = self.pending.lock().await;
            if let Some(old) = map.insert(
                key.clone(),
                PendingEntry {
                    tx,
                    inserted_at: Instant::now(),
                },
            ) {
                warn!(
                    session_id = %key.0,
                    call_id = %key.1,
                    "duplicate pending entry — dropping previous sender"
                );
                drop(old.tx);
            }
        }

        debug!(
            session_id = %key.0,
            call_id = %key.1,
            "registered oneshot channel, awaiting tool result"
        );

        let timeout_duration = Duration::from_secs(600); // 10 minutes
        let result = tokio::select! {
            result = rx => result,
            _ = tokio::time::sleep(timeout_duration) => {
                // Clean up pending entry
                let mut map = self.pending.lock().await;
                map.remove(&key);
                bail!(
                    "tool result timeout (10min) for session_id={}, call_id={}",
                    key.0,
                    key.1
                )
            }
        };

        match result {
            Ok(result) => {
                debug!(
                    session_id = %key.0,
                    call_id = %key.1,
                    result_len = result.len(),
                    "received tool result"
                );
                Ok(result)
            }
            Err(_) => {
                warn!(
                    session_id = %key.0,
                    call_id = %key.1,
                    "sender dropped before result was submitted"
                );
                // Clean up pending entry
                let mut map = self.pending.lock().await;
                map.remove(&key);
                bail!(
                    "tool result sender dropped for session_id={}, call_id={}",
                    key.0,
                    key.1
                )
            }
        }
    }

    /// Submit a tool result for the given `(session_id, call_id)`.
    ///
    /// Removes the pending entry and sends the result through the oneshot
    /// channel, unblocking the corresponding `wait_for_tool_result` call.
    ///
    /// Returns an error if no pending entry exists (i.e. nobody is waiting).
    pub async fn submit_tool_result(
        &self,
        session_id: &str,
        call_id: &str,
        result: String,
    ) -> Result<()> {
        let key = (session_id.to_owned(), call_id.to_owned());

        self.purge_expired().await;
        let tx = {
            let mut map = self.pending.lock().await;
            match map.remove(&key) {
                Some(entry) => entry.tx,
                None => {
                    warn!(
                        session_id = %key.0,
                        call_id = %key.1,
                        "no pending entry found for tool result submission"
                    );
                    bail!(
                        "no pending tool result entry for session_id={}, call_id={}",
                        key.0,
                        key.1
                    );
                }
            }
        };

        debug!(
            session_id = %key.0,
            call_id = %key.1,
            result_len = result.len(),
            "submitting tool result"
        );

        tx.send(result).map_err(|_| {
            anyhow::anyhow!(
                "receiver already dropped for session_id={}, call_id={}",
                key.0,
                key.1
            )
        })
    }
}

impl Default for ToolResultRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_submit_resolves_wait() {
        let registry = Arc::new(ToolResultRegistry::new());

        let wait_handle = {
            let r = registry.clone();
            tokio::spawn(async move { r.wait_for_tool_result("s1", "c1").await })
        };

        // Small delay to ensure the waiter has registered.
        tokio::task::yield_now().await;

        registry
            .submit_tool_result("s1", "c1", "hello".to_owned())
            .await
            .unwrap();

        let result = wait_handle.await.unwrap().unwrap();
        assert_eq!(result, "hello");
    }

    #[tokio::test]
    async fn test_submit_without_waiter_fails() {
        let registry = ToolResultRegistry::new();
        let err = registry
            .submit_tool_result("s1", "c1", "oops".to_owned())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("no pending"));
    }

    #[tokio::test]
    async fn test_waiter_dropped_sender() {
        // When the ToolResultRegistry is dropped while a waiter is active,
        // the receiver gets a RecvError — covered by the `Err(_)` arm in
        // wait_for_tool_result.
    }
}
