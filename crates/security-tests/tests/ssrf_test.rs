//! SSRF protection — `agent_executor::agentic_loop::is_url_host_private`.
//!
//! Security path: SSRF guard. A URL that resolves to a private/reserved host
//! (loopback, RFC1918, link-local, CGNAT, metadata endpoints, etc.) must be
//! reported as private so the caller refuses to fetch it. Anything that cannot
//! be parsed is treated as private (fail-closed).

use agent_executor::agentic_loop::is_url_host_private;
use proptest::prelude::*;

#[test]
fn private_ipv4_blocked() {
    let blocked = [
        "http://127.0.0.1/",
        "http://10.0.0.5/",
        "http://172.16.0.1/",
        "http://192.168.1.1/",
        "http://169.254.169.254/latest/meta-data/", // cloud metadata
        "http://0.0.0.0/",
        "http://100.64.0.1/", // CGNAT
        "http://192.0.0.1/",  // IETF protocol assignments
        "http://198.18.0.1/", // benchmarking
        "http://240.0.0.1/",  // reserved
        "http://255.255.255.255/",
    ];
    for u in blocked {
        assert!(is_url_host_private(u), "expected PRIVATE: {u}");
    }
}

#[test]
fn public_ipv4_allowed() {
    let allowed = [
        "http://8.8.8.8/",
        "http://1.1.1.1/",
        "http://93.184.216.34/",
        "https://142.250.72.14/",
    ];
    for u in allowed {
        assert!(!is_url_host_private(u), "expected PUBLIC: {u}");
    }
}

#[test]
fn danger_hostnames_blocked() {
    assert!(is_url_host_private("http://localhost/"));
    assert!(is_url_host_private("http://metadata.google.internal/"));
    assert!(is_url_host_private("http://metadata.azure.com/"));
}

#[test]
fn normal_public_hostname_allowed() {
    assert!(!is_url_host_private("https://example.com/"));
    assert!(!is_url_host_private("https://api.openai.com/v1/"));
    assert!(!is_url_host_private("http://www.example.org/path?q=1"));
}

#[test]
fn malformed_url_treated_private() {
    // Fail-closed: unparseable input is treated as private.
    assert!(is_url_host_private("not a url"));
    assert!(is_url_host_private(""));
    assert!(is_url_host_private("http://"));
}

#[test]
fn ipv6_blocked() {
    assert!(is_url_host_private("http://[::1]/"));
    assert!(is_url_host_private("http://[fe80::1]/"));
    assert!(is_url_host_private("http://[fc00::1]/"));
}

#[test]
fn ipv4_mapped_ipv6_blocked() {
    // ::ffff:127.0.0.1 maps to loopback; ::ffff:10.x maps to RFC1918.
    assert!(is_url_host_private("http://[::ffff:127.0.0.1]/"));
    assert!(is_url_host_private("http://[::ffff:10.0.0.1]/"));
}

#[test]
fn ipv6_public_allowed() {
    assert!(!is_url_host_private("http://[2606:4700:4700::1111]/")); // Cloudflare
    assert!(!is_url_host_private("http://[2001:4860:4860::8888]/")); // Google
}

proptest! {
    /// The guard must never panic and must be deterministic for any input.
    #[test]
    fn never_panics_and_deterministic(s in ".*") {
        let a = is_url_host_private(&s);
        let b = is_url_host_private(&s);
        prop_assert_eq!(a, b, "non-deterministic result for input {:?}", s);
    }
}
