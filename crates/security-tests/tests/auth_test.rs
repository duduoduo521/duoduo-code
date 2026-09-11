//! Auth-token validation — `security_design::AuthToken::validate_token`.
//!
//! Security path: sidecar auth token. Validation must accept the exact stored
//! token and reject any other value (wrong, empty, or differing length). The
//! comparison is constant-time over a fixed buffer.

use proptest::prelude::*;
use security_design::AuthToken;

#[test]
fn correct_token_validates() {
    let auth = AuthToken::generate_token();
    assert!(auth.validate_token(&auth.token));
}

#[test]
fn wrong_or_empty_token_rejected() {
    let auth = AuthToken::generate_token();
    assert!(!auth.validate_token("sec-wrong"));
    assert!(!auth.validate_token(""));
    assert!(!auth.validate_token(&auth.token.to_uppercase()));
}

#[test]
fn token_has_prefix() {
    let auth = AuthToken::generate_token();
    assert!(auth.token.starts_with("sec-"));
}

#[test]
fn constructed_token_reflexive_and_length_sensitive() {
    // Build a token with known content to test length/value sensitivity
    // directly (generate_token is random).
    let auth = AuthToken {
        token: "sec-fixedtoken0000000000000000000000".to_string(),
        created_at: String::new(),
    };
    assert!(auth.validate_token("sec-fixedtoken0000000000000000000000"));
    assert!(!auth.validate_token("sec-fixedtoken0000000000000000000001")); // last char
    assert!(!auth.validate_token("sec-fixedtoken000000000000000000000")); // one char short
    assert!(!auth.validate_token("sec-fixedtoken00000000000000000000000")); // one char long
    assert!(!auth.validate_token(""));
}

proptest! {
    /// Validation must never panic, for any provided token string.
    #[test]
    fn validate_never_panics(s in ".*") {
        let auth = AuthToken {
            token: "sec-fixedtoken0000000000000000000000".to_string(),
            created_at: String::new(),
        };
        let _ = auth.validate_token(&s);
    }
}
