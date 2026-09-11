//! WAL checkpoint background task management.
//!
//! Spawns a background tokio task that periodically runs
//! `PRAGMA wal_checkpoint(TRUNCATE)` on the write pool to keep
//! the WAL file size under control.

use std::sync::Arc;
use std::time::Duration;

use crate::SqlitePool;

/// Default WAL checkpoint interval in seconds.
const CHECKPOINT_INTERVAL_SECS: u64 = 60;

/// Spawn a background WAL checkpoint task that runs every 60 seconds.
///
/// The task acquires a connection from the pool and executes
/// `PRAGMA wal_checkpoint(TRUNCATE)` to truncate the WAL file.
///
/// If no tokio runtime is available (e.g. in unit tests), the task is
/// silently skipped — matching the behavior of session-manager's
/// implementation.
///
/// # Arguments
///
/// * `pool` - The connection pool to checkpoint
/// * `name` - A static label used in tracing logs for identification
pub fn spawn_wal_checkpoint(pool: SqlitePool, name: &'static str) {
    let pool = Arc::new(pool);

    // Try to spawn; if no tokio runtime is available, silently skip.
    // This matches session-manager's defensive approach and ensures
    // unit tests without a runtime don't panic.
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(CHECKPOINT_INTERVAL_SECS));
            loop {
                interval.tick().await;
                let pool = pool.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    if let Ok(conn) = pool.get() {
                        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
                    }
                })
                .await;
                tracing::debug!(pool_name = name, "WAL checkpoint completed");
            }
        });
    }
}
