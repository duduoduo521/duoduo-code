//! security-design crate for DuoDuo smart layer.
//!
//! Provides security policy enforcement (path access control, command blocking)
//! and authentication token management.

pub mod auth;
pub mod policy;
pub mod sanitize;

pub use auth::AuthToken;
pub use policy::SecurityPolicy;

use anyhow::Result;

/// Top-level security orchestrator combining policy and auth concerns.
pub struct SecurityDesign {
    policy: SecurityPolicy,
    auth: Option<AuthToken>,
}

impl SecurityDesign {
    /// Create a new instance with default policy and no auth token.
    pub fn new() -> Result<Self> {
        Ok(Self {
            policy: SecurityPolicy::default(),
            auth: None,
        })
    }

    /// Set a custom security policy (builder pattern).
    pub fn with_policy(mut self, policy: SecurityPolicy) -> Self {
        self.policy = policy;
        self
    }

    /// Set an auth token (builder pattern).
    pub fn with_auth_token(mut self, token: AuthToken) -> Self {
        self.auth = Some(token);
        self
    }

    /// Access the current security policy.
    pub fn policy(&self) -> &SecurityPolicy {
        &self.policy
    }

    /// Access the current auth token, if set.
    pub fn auth(&self) -> Option<&AuthToken> {
        self.auth.as_ref()
    }
}

impl Default for SecurityDesign {
    fn default() -> Self {
        Self::new().expect("Failed to initialize security-design")
    }
}
