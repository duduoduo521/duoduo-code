//! Unified error handling for duo-smart-layer route handlers.
//!
//! All handlers return `unified_error::Result<T>` so that errors propagate
//! via `?` and are automatically converted into proper HTTP responses
//! (JSON `{"error": "...", "code": ...}`) by `UnifiedError::into_response`.

use unified_error::UnifiedError;

// `From<JoinError> for UnifiedError` is implemented in the `unified-error` crate,
// allowing `?` to be used on `spawn_blocking` results directly.

/// Helper: map an `anyhow::Error` to `UnifiedError::BadRequest`.
///
/// Use this when the error originates from invalid user input rather than
/// an internal failure (e.g. missing required fields in a request).
pub fn bad_request(err: anyhow::Error) -> UnifiedError {
    UnifiedError::BadRequest(err.to_string())
}

/// Helper: map an `anyhow::Error` to `UnifiedError::NotFound`.
///
/// Use this when the requested resource does not exist.
pub fn not_found(err: anyhow::Error) -> UnifiedError {
    UnifiedError::NotFound(err.to_string())
}

/// Helper: map an `anyhow::Error` to `UnifiedError::Unavailable`.
///
/// Use this when a dependent service is unreachable.
pub fn unavailable(err: anyhow::Error) -> UnifiedError {
    UnifiedError::Unavailable(err.to_string())
}

/// Log an error and return it, so callers can write:
/// `Err(log_internal(err))?` or `.map_err(log_internal)?`
pub fn log_internal(err: anyhow::Error) -> UnifiedError {
    tracing::error!("Request failed: {err:?}");
    UnifiedError::Other(err)
}

/// Log a `UnifiedError` and return it.
pub fn log_unified(err: UnifiedError) -> UnifiedError {
    tracing::error!("Request failed: {err:?}");
    err
}

/// Re-export for convenience.
pub use unified_error::Result;
