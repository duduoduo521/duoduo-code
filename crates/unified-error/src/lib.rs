//! Unified error handling for DuoDuo smart layer.
//!
//! Provides a unified [`UnifiedError`] enum with retryable classification,
//! specific error variants for common failure modes, and HTTP integration
//! (behind the `http` feature flag).

#[cfg(feature = "http")]
use serde::Serialize;

#[cfg(feature = "http")]
use axum::http::StatusCode;
#[cfg(feature = "http")]
use axum::response::{IntoResponse, Response};
#[cfg(feature = "http")]
use axum::Json;

#[cfg(feature = "tokio-runtime")]
use tokio::task::JoinError;

/// Unified error type for all DuoDuo crates.
///
/// Each variant carries enough context for callers to decide whether to
/// retry, propagate, or present the error to the user.
#[derive(Debug, thiserror::Error)]
pub enum UnifiedError {
    #[error("Internal error: {0}")]
    Internal(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("Service unavailable: {0}")]
    Unavailable(String),

    /// Rate limited or quota exceeded — the caller should retry after a backoff.
    ///
    /// `retry_after_ms` is `Some(duration)` when the server provides a hint
    /// (e.g. `Retry-After` header), `None` when no hint is available.
    #[error("Rate limited: {message}")]
    RateLimited {
        message: String,
        retry_after_ms: Option<u64>,
    },

    /// LLM API returned a transient error (429, 5xx, quota exhaustion).
    ///
    /// These errors should be retried with exponential backoff.
    #[error("LLM API error (retryable={retryable}): {message}")]
    LlmApi {
        message: String,
        status_code: Option<u16>,
        retryable: bool,
    },

    /// Timeout — the operation did not complete within the allotted time.
    #[error("Timeout: {0}")]
    Timeout(String),

    /// Configuration error — missing or invalid config that prevents operation.
    #[error("Configuration error: {0}")]
    Configuration(String),

    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

impl UnifiedError {
    /// Returns `true` if the error is potentially transient and the operation
    /// should be retried with exponential backoff.
    ///
    /// Retryable conditions:
    ///   - [`RateLimited`] — server asked us to slow down
    ///   - [`LlmApi`] with `retryable == true` — 429/5xx/quota errors
    ///   - [`Unavailable`] — service temporarily down
    ///   - [`Timeout`] — operation may succeed on retry
    ///
    /// Non-retryable errors (BadRequest, Conflict, NotFound, Unauthorized, Configuration)
    /// indicate a permanent problem that retrying won't fix.
    ///
    /// [`RateLimited`]: UnifiedError::RateLimited
    /// [`LlmApi`]: UnifiedError::LlmApi
    /// [`Unavailable`]: UnifiedError::Unavailable
    /// [`Timeout`]: UnifiedError::Timeout
    pub fn is_retryable(&self) -> bool {
        match self {
            UnifiedError::RateLimited { .. } => true,
            UnifiedError::LlmApi { retryable, .. } => *retryable,
            UnifiedError::Unavailable(_) => true,
            UnifiedError::Timeout(_) => true,
            UnifiedError::BadRequest(_) => false,
            UnifiedError::Conflict(_) => false,
            UnifiedError::Internal(_) => false,
            UnifiedError::NotFound(_) => false,
            UnifiedError::Unauthorized(_) => false,
            UnifiedError::Configuration(_) => false,
            UnifiedError::Other(_) => false,
        }
    }

    /// Returns the suggested retry delay in milliseconds, if available.
    ///
    /// Only [`RateLimited`] errors carry a server-provided hint.
    /// For other retryable errors, callers should implement exponential
    /// backoff starting from a reasonable initial delay (e.g. 2 seconds).
    pub fn retry_after_ms(&self) -> Option<u64> {
        match self {
            UnifiedError::RateLimited { retry_after_ms, .. } => *retry_after_ms,
            _ => None,
        }
    }

    /// Returns a short, human-readable error code string suitable for
    /// logging, metrics, and UI display.
    pub fn error_code(&self) -> &'static str {
        match self {
            UnifiedError::Internal(_) => "INTERNAL",
            UnifiedError::NotFound(_) => "NOT_FOUND",
            UnifiedError::BadRequest(_) => "BAD_REQUEST",
            UnifiedError::Conflict(_) => "CONFLICT",
            UnifiedError::Unauthorized(_) => "UNAUTHORIZED",
            UnifiedError::Unavailable(_) => "UNAVAILABLE",
            UnifiedError::RateLimited { .. } => "RATE_LIMITED",
            UnifiedError::LlmApi { .. } => "LLM_API",
            UnifiedError::Timeout(_) => "TIMEOUT",
            UnifiedError::Configuration(_) => "CONFIGURATION",
            UnifiedError::Other(_) => "OTHER",
        }
    }
}

/// Convert a `JoinError` (from `spawn_blocking`) into `UnifiedError::Internal`.
#[cfg(feature = "tokio-runtime")]
impl From<JoinError> for UnifiedError {
    fn from(err: JoinError) -> Self {
        UnifiedError::Internal(format!("blocking task failed: {err}"))
    }
}

/// Convert a [`std::io::Error`] into `UnifiedError::Internal`.
impl From<std::io::Error> for UnifiedError {
    fn from(err: std::io::Error) -> Self {
        UnifiedError::Internal(format!("IO error: {err}"))
    }
}

#[cfg(feature = "http")]
#[derive(Serialize)]
struct ErrorResponse {
    error: String,
    code: u16,
    /// Machine-readable error code for programmatic handling.
    error_type: String,
    /// Whether the client should retry the request.
    retryable: bool,
    /// Suggested retry delay in milliseconds, if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<u64>,
}

#[cfg(feature = "http")]
impl IntoResponse for UnifiedError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            UnifiedError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.clone()),
            UnifiedError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            UnifiedError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            UnifiedError::Conflict(msg) => (StatusCode::CONFLICT, msg.clone()),
            UnifiedError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg.clone()),
            UnifiedError::Unavailable(msg) => (StatusCode::SERVICE_UNAVAILABLE, msg.clone()),
            UnifiedError::RateLimited { message, .. } => (StatusCode::TOO_MANY_REQUESTS, message.clone()),
            UnifiedError::LlmApi { message, status_code, .. } => {
                let code = status_code.unwrap_or(500);
                let s = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                (s, message.clone())
            }
            UnifiedError::Timeout(msg) => (StatusCode::REQUEST_TIMEOUT, msg.clone()),
            UnifiedError::Configuration(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.clone()),
            UnifiedError::Other(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
        };

        let retryable = self.is_retryable();
        let retry_after_ms = self.retry_after_ms();
        let error_type = self.error_code().to_string();

        let body = ErrorResponse {
            error: message,
            code: status.as_u16(),
            error_type,
            retryable,
            retry_after_ms,
        };

        // Add Retry-After header for rate-limited responses
        let response = (status, Json(body)).into_response();
        if let Some(delay) = retry_after_ms {
            let mut response = response;
            let headers = response.headers_mut();
            headers.insert(
                axum::http::header::RETRY_AFTER,
                axum::http::HeaderValue::from_str(&format!("{}", delay / 1000)).unwrap_or_else(|_| axum::http::HeaderValue::from_static("2")),
            );
            return response;
        }

        response
    }
}

/// Convenience type alias for Results using UnifiedError.
pub type Result<T> = std::result::Result<T, UnifiedError>;

// ---------------------------------------------------------------------------
// Convenience constructors
// ---------------------------------------------------------------------------

impl UnifiedError {
    /// Create an [`Internal`] error.
    ///
    /// [`Internal`]: UnifiedError::Internal
    pub fn internal(msg: impl Into<String>) -> Self {
        UnifiedError::Internal(msg.into())
    }

    /// Create a [`NotFound`] error.
    ///
    /// [`NotFound`]: UnifiedError::NotFound
    pub fn not_found(msg: impl Into<String>) -> Self {
        UnifiedError::NotFound(msg.into())
    }

    /// Create a [`BadRequest`] error.
    ///
    /// [`BadRequest`]: UnifiedError::BadRequest
    pub fn bad_request(msg: impl Into<String>) -> Self {
        UnifiedError::BadRequest(msg.into())
    }

    /// Create a [`Conflict`] error (HTTP 409).
    ///
    /// Use this for optimistic-lock violations, duplicate resource creation,
    /// file-lock contention, and any scenario where the request conflicts
    /// with the current state of the target resource.
    ///
    /// [`Conflict`]: UnifiedError::Conflict
    pub fn conflict(msg: impl Into<String>) -> Self {
        UnifiedError::Conflict(msg.into())
    }

    /// Create an [`Unauthorized`] error.
    ///
    /// [`Unauthorized`]: UnifiedError::Unauthorized
    pub fn unauthorized(msg: impl Into<String>) -> Self {
        UnifiedError::Unauthorized(msg.into())
    }

    /// Create an [`Unavailable`] error.
    ///
    /// [`Unavailable`]: UnifiedError::Unavailable
    pub fn unavailable(msg: impl Into<String>) -> Self {
        UnifiedError::Unavailable(msg.into())
    }

    /// Create a [`Timeout`] error.
    ///
    /// [`Timeout`]: UnifiedError::Timeout
    pub fn timeout(msg: impl Into<String>) -> Self {
        UnifiedError::Timeout(msg.into())
    }

    /// Create a [`Configuration`] error.
    ///
    /// [`Configuration`]: UnifiedError::Configuration
    pub fn configuration(msg: impl Into<String>) -> Self {
        UnifiedError::Configuration(msg.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The retry matrix is the contract every caller depends on: retrying a
    /// permanent error wastes budget, and giving up on a transient one fails
    /// requests that would have succeeded. Every variant is pinned here so the
    /// table in `is_retryable`'s docs cannot drift from the implementation.
    #[test]
    fn is_retryable_matches_documented_matrix() {
        let cases: Vec<(UnifiedError, bool)> = vec![
            (UnifiedError::Internal("x".into()), false),
            (UnifiedError::NotFound("x".into()), false),
            (UnifiedError::BadRequest("x".into()), false),
            (UnifiedError::Conflict("x".into()), false),
            (UnifiedError::Unauthorized("x".into()), false),
            (UnifiedError::Configuration("x".into()), false),
            (UnifiedError::Other(anyhow::anyhow!("x")), false),
            (UnifiedError::Unavailable("x".into()), true),
            (UnifiedError::Timeout("x".into()), true),
            (
                UnifiedError::RateLimited {
                    message: "x".into(),
                    retry_after_ms: None,
                },
                true,
            ),
            // `LlmApi` defers entirely to its own flag.
            (
                UnifiedError::LlmApi {
                    message: "x".into(),
                    status_code: Some(429),
                    retryable: true,
                },
                true,
            ),
            (
                UnifiedError::LlmApi {
                    message: "x".into(),
                    status_code: Some(400),
                    retryable: false,
                },
                false,
            ),
        ];

        for (err, expected) in cases {
            assert_eq!(
                err.is_retryable(),
                expected,
                "is_retryable mismatch for {} ({err})",
                err.error_code()
            );
        }
    }

    /// Only `RateLimited` carries a server-provided delay; callers must fall
    /// back to their own backoff for every other retryable error.
    #[test]
    fn retry_after_ms_only_comes_from_rate_limited() {
        assert_eq!(
            UnifiedError::RateLimited {
                message: "x".into(),
                retry_after_ms: Some(1500),
            }
            .retry_after_ms(),
            Some(1500)
        );
        assert_eq!(
            UnifiedError::RateLimited {
                message: "x".into(),
                retry_after_ms: None,
            }
            .retry_after_ms(),
            None
        );
        assert_eq!(UnifiedError::Timeout("x".into()).retry_after_ms(), None);
        assert_eq!(UnifiedError::Unavailable("x".into()).retry_after_ms(), None);
    }

    #[test]
    fn error_code_is_stable_per_variant() {
        let cases: Vec<(UnifiedError, &str)> = vec![
            (UnifiedError::internal("x"), "INTERNAL"),
            (UnifiedError::not_found("x"), "NOT_FOUND"),
            (UnifiedError::bad_request("x"), "BAD_REQUEST"),
            (UnifiedError::conflict("x"), "CONFLICT"),
            (UnifiedError::unauthorized("x"), "UNAUTHORIZED"),
            (UnifiedError::unavailable("x"), "UNAVAILABLE"),
            (UnifiedError::timeout("x"), "TIMEOUT"),
            (UnifiedError::configuration("x"), "CONFIGURATION"),
            (
                UnifiedError::RateLimited {
                    message: "x".into(),
                    retry_after_ms: None,
                },
                "RATE_LIMITED",
            ),
            (
                UnifiedError::LlmApi {
                    message: "x".into(),
                    status_code: None,
                    retryable: false,
                },
                "LLM_API",
            ),
            (UnifiedError::Other(anyhow::anyhow!("x")), "OTHER"),
        ];

        for (err, expected) in cases {
            assert_eq!(err.error_code(), expected);
        }
    }

    #[test]
    fn io_error_becomes_internal() {
        let err: UnifiedError =
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied").into();
        assert!(matches!(err, UnifiedError::Internal(_)));
        assert_eq!(err.error_code(), "INTERNAL");
        // An IO failure is not transient on its own — the caller decides.
        assert!(!err.is_retryable());
    }

    #[test]
    fn anyhow_error_becomes_other() {
        let err: UnifiedError = anyhow::anyhow!("wrapped").into();
        assert!(matches!(err, UnifiedError::Other(_)));
        assert_eq!(err.error_code(), "OTHER");
    }

    /// `thiserror` derives `Display` from the variant; callers surface this
    /// string in logs and API bodies, so it must never lose the message.
    #[test]
    fn display_contains_the_message() {
        let needle = "session 42 is gone";
        assert!(UnifiedError::not_found(needle).to_string().contains(needle));
        assert!(UnifiedError::internal(needle).to_string().contains(needle));

        let llm = UnifiedError::LlmApi {
            message: needle.into(),
            status_code: Some(503),
            retryable: true,
        };
        let rendered = llm.to_string();
        assert!(rendered.contains(needle), "{rendered}");
        assert!(rendered.contains("retryable=true"), "{rendered}");
    }

    #[cfg(feature = "http")]
    mod http {
        use super::*;
        use axum::http::StatusCode;
        use axum::response::IntoResponse;

        fn status_of(err: UnifiedError) -> StatusCode {
            err.into_response().status()
        }

        /// The status mapping is what clients branch on; a wrong code silently
        /// breaks every consumer's error handling.
        #[test]
        fn maps_each_variant_to_its_status() {
            assert_eq!(status_of(UnifiedError::internal("x")), StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(status_of(UnifiedError::not_found("x")), StatusCode::NOT_FOUND);
            assert_eq!(status_of(UnifiedError::bad_request("x")), StatusCode::BAD_REQUEST);
            assert_eq!(status_of(UnifiedError::conflict("x")), StatusCode::CONFLICT);
            assert_eq!(status_of(UnifiedError::unauthorized("x")), StatusCode::UNAUTHORIZED);
            assert_eq!(status_of(UnifiedError::unavailable("x")), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(status_of(UnifiedError::timeout("x")), StatusCode::REQUEST_TIMEOUT);
            assert_eq!(status_of(UnifiedError::configuration("x")), StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(
                status_of(UnifiedError::Other(anyhow::anyhow!("x"))),
                StatusCode::INTERNAL_SERVER_ERROR
            );
            assert_eq!(
                status_of(UnifiedError::RateLimited {
                    message: "x".into(),
                    retry_after_ms: None,
                }),
                StatusCode::TOO_MANY_REQUESTS
            );
        }

        #[test]
        fn llm_api_propagates_status_code() {
            let err = UnifiedError::LlmApi {
                message: "x".into(),
                status_code: Some(429),
                retryable: true,
            };
            assert_eq!(status_of(err), StatusCode::TOO_MANY_REQUESTS);

            // Missing or unrepresentable codes degrade to 500 rather than
            // panicking — a bad upstream status must not take down the server.
            let missing = UnifiedError::LlmApi {
                message: "x".into(),
                status_code: None,
                retryable: true,
            };
            assert_eq!(status_of(missing), StatusCode::INTERNAL_SERVER_ERROR);

            let out_of_range = UnifiedError::LlmApi {
                message: "x".into(),
                status_code: Some(1000),
                retryable: false,
            };
            assert_eq!(status_of(out_of_range), StatusCode::INTERNAL_SERVER_ERROR);
        }

        #[test]
        fn retry_after_header_only_when_a_delay_is_known() {
            let response = UnifiedError::RateLimited {
                message: "x".into(),
                retry_after_ms: Some(2500),
            }
            .into_response();
            assert_eq!(
                response.headers().get(axum::http::header::RETRY_AFTER),
                // The delay is converted to whole seconds.
                Some(&axum::http::HeaderValue::from_static("2"))
            );

            let response = UnifiedError::RateLimited {
                message: "x".into(),
                retry_after_ms: None,
            }
            .into_response();
            assert!(response.headers().get(axum::http::header::RETRY_AFTER).is_none());

            let response = UnifiedError::Timeout("x".into()).into_response();
            assert!(response.headers().get(axum::http::header::RETRY_AFTER).is_none());
        }
    }

    #[cfg(feature = "tokio-runtime")]
    #[tokio::test]
    async fn join_error_becomes_internal() {
        let handle = tokio::spawn(async { panic!("blocking task failed on purpose") });
        let join_error = handle.await.expect_err("the task panicked, so join returns Err");

        let err: UnifiedError = join_error.into();
        assert!(matches!(err, UnifiedError::Internal(_)));
        assert_eq!(err.error_code(), "INTERNAL");
        assert!(!err.is_retryable());
    }
}
