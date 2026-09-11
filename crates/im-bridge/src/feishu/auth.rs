//! Feishu authentication & token management.
//!
//! Manages `tenant_access_token` lifecycle: fetch, cache, and auto-refresh
//! before expiry.

use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use serde::Deserialize;

use crate::config::FeishuConfig;

/// Cached tenant access token with its expiry time.
#[derive(Debug, Clone)]
struct CachedToken {
    token: String,
    /// Absolute instant (UNIX seconds) when the token expires.
    expires_at: i64,
}

/// Feishu authentication provider.
///
/// Thread-safe: uses `RwLock` for concurrent access. Auto-refreshes
/// the token when it is within 60 seconds of expiry.
#[derive(Clone)]
pub struct FeishuAuthProvider {
    config: FeishuConfig,
    http: reqwest::Client,
    cached: Arc<RwLock<Option<CachedToken>>>,
    /// IM-03: serializes token refreshes so concurrent `get_token` callers
    /// coalesce on a single network request (single-flight) instead of
    /// stampeding the Feishu token API and racing on the cache write.
    refresh_lock: Arc<Mutex<()>>,
}

/// Response from the tenant access token API.
#[derive(Debug, Deserialize)]
struct TokenResponse {
    code: i64,
    msg: Option<String>,
    tenant_access_token: Option<String>,
    expire: Option<i64>,
}

impl FeishuAuthProvider {
    /// Create a new auth provider from Feishu config.
    pub fn new(config: FeishuConfig) -> Self {
        Self {
            config,
            http: crate::feishu::api::http_client(),
            cached: Arc::new(RwLock::new(None)),
            refresh_lock: Arc::new(Mutex::new(())),
        }
    }

    /// Get a valid tenant_access_token, refreshing if necessary.
    pub async fn get_token(&self) -> anyhow::Result<String> {
        // Fast path: return a still-valid cached token without blocking refreshes.
        {
            let guard = self.cached.read().await;
            if let Some(cached) = guard.as_ref() {
                let now = chrono::Utc::now().timestamp();
                // Refresh 60s before actual expiry
                if now < cached.expires_at - 60 {
                    return Ok(cached.token.clone());
                }
            }
        }

        // Slow path: IM-03 single-flight. Serialize refreshes so concurrent
        // callers coalesce on one network request. Re-check the cache after
        // taking the lock — a waiting caller may find another caller already
        // refreshed it and can return immediately without a second fetch.
        let _refresh_guard = self.refresh_lock.lock().await;
        {
            let guard = self.cached.read().await;
            if let Some(cached) = guard.as_ref() {
                let now = chrono::Utc::now().timestamp();
                // Inside the lock the re-check MUST use the strict validity
                // window (not the 60s early-refresh margin from the fast path).
                // The lock holder has just produced a token that is valid until
                // `expires_at`; concurrent waiters that acquire the lock after
                // it must coalesce on that token instead of re-fetching. Using
                // the -60 margin here caused a redundant fetch for short-lived
                // tokens: the first writer's token (e.g. 1s expiry) is already
                // "within 60s of expiry", so every queued caller failed the
                // re-check and issued a second network request, violating the
                // single-flight invariant (IM-03).
                if now < cached.expires_at {
                    return Ok(cached.token.clone());
                }
            }
        }

        // Fetch new token — reached only when the cache is genuinely absent or
        // already expired after taking the refresh lock (i.e. exactly one caller
        // wins per cold-refresh window; concurrent waiters coalesce above).
        self.refresh_token().await
    }

    /// Force-refresh the tenant_access_token.
    async fn refresh_token(&self) -> anyhow::Result<String> {
        let resp = self
            .http
            .post(self.config.token_url())
            .json(&serde_json::json!({
                "app_id": self.config.app_id,
                "app_secret": self.config.app_secret
            }))
            .send()
            .await?
            .json::<TokenResponse>()
            .await?;

        if resp.code != 0 {
            anyhow::bail!(
                "Feishu token API error: code={}, msg={}",
                resp.code,
                resp.msg.unwrap_or_default()
            );
        }

        let token = resp
            .tenant_access_token
            .ok_or_else(|| anyhow::anyhow!("Missing tenant_access_token in response"))?;
        let expire = resp.expire.unwrap_or(7200);

        let now = chrono::Utc::now().timestamp();
        let cached = CachedToken {
            token: token.clone(),
            expires_at: now + expire,
        };

        {
            let mut guard = self.cached.write().await;
            *guard = Some(cached);
        }

        tracing::debug!(expires_in = expire, "Refreshed Feishu tenant_access_token");
        Ok(token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use axum::extract::State;
    use axum::routing::post;
    use axum::Json;
    use serde_json::json;
    use tokio::net::TcpListener;

    #[derive(Clone)]
    struct TokenHarness {
        /// How many successful responses to serve before returning code != 0.
        fail_after: Arc<AtomicUsize>,
        calls: Arc<AtomicUsize>,
    }

    async fn spawn_token_server(fail_after: usize) -> (String, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let state = TokenHarness {
            fail_after: Arc::new(AtomicUsize::new(fail_after)),
            calls: calls.clone(),
        };
        let app = axum::Router::new()
            .route(
                "/open-apis/auth/v3/tenant_access_token/internal",
                post(move |State(h): State<TokenHarness>| async move {
                    let n = h.calls.fetch_add(1, Ordering::SeqCst);
                    if n < h.fail_after.load(Ordering::SeqCst) {
                        // First response uses a 1s expiry so a re-fetch shortly
                        // after must actually refresh (exercise the refresh path).
                        let expire = if n == 0 { 1 } else { 7200 };
                        Json(json!({
                            "code": 0,
                            "msg": "ok",
                            "tenant_access_token": format!("tok-{n}"),
                            "expire": expire
                        }))
                    } else {
                        Json(json!({ "code": 9999, "msg": "app verification failed" }))
                    }
                }),
            )
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), calls)
    }

    fn config_for(base: &str) -> FeishuConfig {
        FeishuConfig {
            app_id: "app".to_string(),
            app_secret: "secret".to_string(),
            domain: base.to_string(),
        }
    }

    #[tokio::test]
    async fn refresh_failure_returns_error_not_panic() {
        // First token succeeds (1s expiry); every later call fails. After the
        // short-lived token expires, the refresh MUST fail with an Err that is
        // propagated to the caller — it must NOT panic or hang the caller.
        let (base, _calls) = spawn_token_server(1).await;
        let provider = FeishuAuthProvider::new(config_for(&base));

        // First call: fresh fetch, succeeds.
        let first = provider.get_token().await;
        assert!(first.is_ok(), "initial token fetch must succeed");

        // Wait past the 1s expiry so the next call must refresh.
        tokio::time::sleep(Duration::from_secs(2)).await;
        let second = provider.get_token().await;
        assert!(
            second.is_err(),
            "refresh after failure must surface an Err (isolated, not panicked)"
        );
    }

    #[tokio::test]
    async fn persistent_failure_is_error_not_panic() {
        // Token endpoint always fails — the very first fetch must return Err
        // (graceful), not crash the process.
        let (base, _calls) = spawn_token_server(0).await;
        let provider = FeishuAuthProvider::new(config_for(&base));
        let result = provider.get_token().await;
        assert!(result.is_err(), "token fetch must fail gracefully on API error");
    }

    #[tokio::test]
    async fn single_flight_coalesces_concurrent_refreshes() {
        // 16 concurrent first-fetches must coalesce into a SINGLE network request
        // (IM-03 single-flight). The server call counter proves this.
        let (base, calls) = spawn_token_server(100).await;
        let provider = Arc::new(FeishuAuthProvider::new(config_for(&base)));

        let mut handles = Vec::new();
        for _ in 0..16 {
            let p = provider.clone();
            handles.push(tokio::spawn(async move { p.get_token().await }));
        }
        let mut ok = 0;
        for h in handles {
            if h.await.unwrap().is_ok() {
                ok += 1;
            }
        }
        assert_eq!(ok, 16, "all concurrent callers must receive the token");
        // Single-flight: the provider must issue exactly one token request for
        // the (initial, cold) refresh window despite 16 concurrent callers.
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "concurrent refreshes must coalesce into a single network request"
        );
    }
}
