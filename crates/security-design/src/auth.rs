//! Auth token module — token generation and validation.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Authentication token for sidecar communication.
///
/// Generated at startup with a random UUID v4 token and ISO 8601 timestamp.
/// Used to validate incoming requests against the expected credential.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthToken {
    pub token: String,
    pub created_at: String,
}

impl AuthToken {
    /// Validate a provided token against the stored token.
    ///
    /// Uses a simple string comparison. In a production environment this should
    /// be replaced with a constant-time comparison (e.g. `subtle` crate) to
    /// mitigate timing attacks.
    pub fn validate_token(&self, provided_token: &str) -> bool {
        const FIXED_LEN: usize = 64;
        let a = self.token.as_bytes();
        let b = provided_token.as_bytes();

        let mut buf_a = [0u8; FIXED_LEN];
        let mut buf_b = [0u8; FIXED_LEN];

        // Copy into fixed-size buffers (truncate if too long)
        let len_a = a.len().min(FIXED_LEN);
        let len_b = b.len().min(FIXED_LEN);
        buf_a[..len_a].copy_from_slice(&a[..len_a]);
        buf_b[..len_b].copy_from_slice(&b[..len_b]);

        // Constant-time comparison over fixed buffer size
        let mut result: u8 = 0;
        for i in 0..FIXED_LEN {
            result |= buf_a[i] ^ buf_b[i];
        }
        // Also XOR the length difference into result
        result |= (a.len() ^ b.len()) as u8;

        result == 0
    }

    /// Generate a new auth token with a random UUID v4 and current timestamp.
    pub fn generate_token() -> Self {
        Self {
            token: format!("sec-{}", Uuid::new_v4()),
            created_at: Utc::now().to_rfc3339(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_token_has_prefix_and_timestamp() {
        let auth = AuthToken::generate_token();
        assert!(auth.token.starts_with("sec-"));
        assert!(!auth.created_at.is_empty());
    }

    #[test]
    fn validate_correct_token() {
        let auth = AuthToken::generate_token();
        assert!(auth.validate_token(&auth.token));
    }

    #[test]
    fn reject_wrong_token() {
        let auth = AuthToken::generate_token();
        assert!(!auth.validate_token("sec-wrong-token"));
    }

    #[test]
    fn reject_empty_token() {
        let auth = AuthToken::generate_token();
        assert!(!auth.validate_token(""));
    }
}
