//! Async runtime helpers for bounded blocking execution.
//!
//! # Why this module exists
//!
//! The codebase calls `tokio::task::spawn_blocking` in ~24 files and
//! `tokio::time::timeout` in ~7 files, with no shared wrapper. That matters
//! because **`spawn_blocking` has no cancellation semantics**: dropping the
//! `JoinHandle` does not stop the closure, it keeps running to completion on
//! a pool thread. A bare `timeout()` therefore only bounds how long the
//! *caller* waits — it never reclaims the work.
//!
//! This module makes that contract explicit and provides an `on_timeout`
//! hook for callers that must reclaim resources (kill a child process,
//! abort an FFI call, close a socket).

use std::time::Duration;

/// Error returned by the bounded blocking helpers.
#[derive(Debug)]
pub enum BlockingError {
    /// The operation did not finish before the deadline.
    ///
    /// The blocking closure is **still running** on a pool thread. Callers
    /// that need to reclaim resources must use
    /// [`blocking_timeout_with_reclaim`] and do it in the hook.
    Timeout(Duration),
    /// The blocking closure panicked.
    Panicked(String),
}

impl std::fmt::Display for BlockingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BlockingError::Timeout(d) => write!(f, "blocking operation timed out after {d:?}"),
            BlockingError::Panicked(msg) => write!(f, "blocking task panicked: {msg}"),
        }
    }
}

impl std::error::Error for BlockingError {}

/// Run `f` on the tokio blocking pool, bounded by `timeout`.
///
/// See the [module docs](self) for the cancellation caveat.
pub async fn blocking_timeout<F, T>(timeout: Duration, f: F) -> Result<T, BlockingError>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    match tokio::time::timeout(timeout, tokio::task::spawn_blocking(f)).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(join_err)) => Err(BlockingError::Panicked(panic_message(join_err))),
        Err(_) => Err(BlockingError::Timeout(timeout)),
    }
}

/// Like [`blocking_timeout`], but calls `on_timeout` when the deadline
/// elapses, so the caller can reclaim resources owned by the blocked work
/// (e.g. `Child::kill`).
///
/// The hook runs on the awaiting task, **not** on the blocked pool thread.
pub async fn blocking_timeout_with_reclaim<F, T, R>(
    timeout: Duration,
    f: F,
    on_timeout: R,
) -> Result<T, BlockingError>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
    R: FnOnce() + Send + 'static,
{
    match tokio::time::timeout(timeout, tokio::task::spawn_blocking(f)).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(join_err)) => Err(BlockingError::Panicked(panic_message(join_err))),
        Err(_) => {
            on_timeout();
            Err(BlockingError::Timeout(timeout))
        }
    }
}

/// Extract a human-readable message from a failed `JoinHandle`.
fn panic_message(join_err: tokio::task::JoinError) -> String {
    match join_err.try_into_panic() {
        Ok(payload) => {
            if let Some(s) = payload.downcast_ref::<&str>() {
                (*s).to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "non-string panic payload".to_string()
            }
        }
        Err(_) => "task cancelled".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_value_when_work_finishes_in_time() {
        let v = blocking_timeout(Duration::from_secs(5), || 41 + 1).await;
        assert!(matches!(v, Ok(42)));
    }

    #[tokio::test]
    async fn timeout_is_reported() {
        let v = blocking_timeout(Duration::from_millis(30), || {
            std::thread::sleep(Duration::from_secs(2));
            1
        })
        .await;
        match v {
            Err(BlockingError::Timeout(d)) => assert_eq!(d, Duration::from_millis(30)),
            other => panic!("expected Timeout, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn reclaim_hook_runs_on_timeout() {
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag_c = flag.clone();
        let v = blocking_timeout_with_reclaim(
            Duration::from_millis(30),
            || {
                std::thread::sleep(Duration::from_secs(2));
                1
            },
            move || flag_c.store(true, std::sync::atomic::Ordering::SeqCst),
        )
        .await;
        assert!(matches!(v, Err(BlockingError::Timeout(_))));
        assert!(
            flag.load(std::sync::atomic::Ordering::SeqCst),
            "reclaim hook must run when the deadline elapses"
        );
    }

    #[tokio::test]
    async fn reclaim_hook_does_not_run_on_success() {
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag_c = flag.clone();
        let v = blocking_timeout_with_reclaim(
            Duration::from_secs(5),
            || 7,
            move || flag_c.store(true, std::sync::atomic::Ordering::SeqCst),
        )
        .await;
        assert!(matches!(v, Ok(7)));
        assert!(!flag.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn panic_is_reported_not_propagated() {
        let v = blocking_timeout(Duration::from_secs(5), || panic!("boom")).await;
        match v {
            Err(BlockingError::Panicked(msg)) => assert!(msg.contains("boom"), "got {msg}"),
            other => panic!("expected Panicked, got {other:?}"),
        }
    }
}
