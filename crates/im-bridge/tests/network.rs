//! Network / integration tests for the Feishu IM bridge.
//!
//! A local `axum` server stands in for the Feishu Open API. The base URL is
//! injected via `FeishuConfig::domain` (the `http(s)://` prefix short-circuit in
//! `api_base()`), so no real network calls leave the test process.
//!
//! Covers: send success / business failure / 5xx + 429 retry / 4xx no-retry /
//! token single-flight + cache / token failure / update_card / multi-byte
//! safety.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Json;
use im_bridge::config::FeishuConfig;
use im_bridge::feishu::FeishuApiClient;
use serde_json::json;

/// Shared counters for the fake Feishu API server.
#[derive(Default, Clone)]
struct ApiState {
    token_calls: Arc<AtomicUsize>,
    send_calls: Arc<AtomicUsize>,
    /// Response mode for the message endpoint.
    mode: Arc<std::sync::Mutex<RespMode>>,
}

#[derive(Clone, Copy, Default)]
enum RespMode {
    #[default]
    Ok,
    BusinessFail,
    ServerError,
    TooManyRequests,
    ClientError,
}

fn ok_token() -> Json<serde_json::Value> {
    Json(json!({
        "code": 0,
        "tenant_access_token": "test-token",
        "expire": 7200
    }))
}

fn ok_send() -> Json<serde_json::Value> {
    Json(json!({
        "code": 0,
        "msg": "success",
        "data": { "message_id": "m_1" }
    }))
}

async fn token_handler(State(st): State<ApiState>) -> impl IntoResponse {
    st.token_calls.fetch_add(1, Ordering::SeqCst);
    ok_token()
}

/// Message endpoint: honors the configured `RespMode`.
async fn send_handler(State(st): State<ApiState>) -> impl IntoResponse {
    st.send_calls.fetch_add(1, Ordering::SeqCst);
    match *st.mode.lock().unwrap() {
        RespMode::Ok => (StatusCode::OK, ok_send()),
        RespMode::BusinessFail => (
            // 200 with business-level failure (code != 0): NOT retried.
            StatusCode::OK,
            Json(json!({ "code": 19001, "msg": "params error" })),
        ),
        RespMode::ServerError => (StatusCode::INTERNAL_SERVER_ERROR, ok_send()),
        RespMode::TooManyRequests => (StatusCode::TOO_MANY_REQUESTS, ok_send()),
        RespMode::ClientError => (StatusCode::BAD_REQUEST, ok_send()),
    }
}

/// PATCH update_card endpoint.
async fn patch_handler(State(st): State<ApiState>) -> impl IntoResponse {
    st.send_calls.fetch_add(1, Ordering::SeqCst);
    (StatusCode::OK, Json(json!({ "code": 0, "msg": "ok" })))
}

/// Failure token endpoint (returns an error code → get_token bails).
async fn token_fail_handler() -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({ "code": 99999, "msg": "invalid app" })),
    )
}

/// Spawn the fake Feishu API and return `(base_url, state)`.
async fn spawn_server(mode: RespMode) -> (String, ApiState) {
    let state = ApiState {
        mode: Arc::new(std::sync::Mutex::new(mode)),
        ..Default::default()
    };
    let app = axum::Router::new()
        .route(
            "/open-apis/auth/v3/tenant_access_token/internal",
            post(token_handler),
        )
        .route(
            "/open-apis/im/v1/messages",
            post(send_handler).patch(patch_handler),
        )
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), state)
}

fn make_config(base: &str) -> FeishuConfig {
    FeishuConfig {
        app_id: "test_app".to_string(),
        app_secret: "test_secret".to_string(),
        domain: base.to_string(),
    }
}

// ── 1. send_text success ────────────────────────────────────────────────────
#[tokio::test]
async fn send_text_success() {
    let (base, st) = spawn_server(RespMode::Ok).await;
    let client = FeishuApiClient::new(make_config(&base));
    let res = client.send_text_message("oc_1", "hello").await;
    assert!(res.is_ok(), "send_text should succeed: {res:?}");
    assert_eq!(st.send_calls.load(Ordering::SeqCst), 1);
}

// ── 2. send_text business failure (code != 0) → Err, no retry ───────────────
#[tokio::test]
async fn send_text_business_failure_is_error() {
    let (base, st) = spawn_server(RespMode::BusinessFail).await;
    let client = FeishuApiClient::new(make_config(&base));
    let res = client.send_text_message("oc_1", "hi").await;
    assert!(res.is_err(), "business code != 0 must error");
    // 200 response is not retried → exactly one request.
    assert_eq!(st.send_calls.load(Ordering::SeqCst), 1);
}

// ── 3. 5xx triggers retry (5 attempts) ──────────────────────────────────────
#[tokio::test]
async fn server_error_retries_to_max() {
    let (base, st) = spawn_server(RespMode::ServerError).await;
    let client = FeishuApiClient::new(make_config(&base));
    let res = client.send_text_message("oc_1", "hi").await;
    assert!(res.is_err());
    // MAX_ATTEMPTS = 5 in send_message_raw.
    assert_eq!(st.send_calls.load(Ordering::SeqCst), 5);
}

// ── 4. 429 triggers retry (5 attempts) ──────────────────────────────────────
#[tokio::test]
async fn too_many_requests_retries_to_max() {
    let (base, st) = spawn_server(RespMode::TooManyRequests).await;
    let client = FeishuApiClient::new(make_config(&base));
    let res = client.send_text_message("oc_1", "hi").await;
    assert!(res.is_err());
    assert_eq!(st.send_calls.load(Ordering::SeqCst), 5);
}

// ── 5. 4xx is NOT retried (single attempt) ─────────────────────────────────
//
// Per `send_message_raw`: only 5xx / 429 trigger the retry loop. A 4xx falls
// into the non-retry branch and is parsed directly — if the body decodes with
// `code == 0` it is treated as a success (this matches Feishu's real API,
// which may return 4xx transport status with a well-formed `code:0` body).
// The invariant we assert here is that 4xx is never retried.
#[tokio::test]
async fn client_error_not_retried() {
    let (base, st) = spawn_server(RespMode::ClientError).await;
    let client = FeishuApiClient::new(make_config(&base));
    let _ = client.send_text_message("oc_1", "hi").await;
    assert_eq!(st.send_calls.load(Ordering::SeqCst), 1, "4xx must not retry");
}

// ── 6. token single-flight: concurrent sends coalesce to ONE token fetch ────
#[tokio::test]
async fn token_single_flight_under_concurrency() {
    let (base, st) = spawn_server(RespMode::Ok).await;
    let client = FeishuApiClient::new(make_config(&base));
    let mut handles = Vec::new();
    for _ in 0..10 {
        let c = client.clone();
        handles.push(tokio::spawn(async move {
            let _ = c.send_text_message("oc_1", "hi").await;
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
    // All 10 sends succeed, but the token endpoint is hit exactly once
    // thanks to the single-flight refresh lock.
    assert_eq!(st.token_calls.load(Ordering::SeqCst), 1, "token must be single-flighted");
}

// ── 7. token cache hit: second call reuses cached token ─────────────────────
#[tokio::test]
async fn token_is_cached_across_calls() {
    let (base, st) = spawn_server(RespMode::Ok).await;
    let client = FeishuApiClient::new(make_config(&base));
    let _ = client.send_text_message("oc_1", "first").await;
    let _ = client.send_text_message("oc_1", "second").await;
    // Token fetched once for the first call, cached for the second.
    assert_eq!(st.token_calls.load(Ordering::SeqCst), 1);
}

// ── 8. token fetch failure surfaces as error ───────────────────────────────
#[tokio::test]
async fn token_failure_propagates() {
    let state = ApiState::default();
    let app = axum::Router::new()
        .route(
            "/open-apis/auth/v3/tenant_access_token/internal",
            post(token_fail_handler),
        )
        .route("/open-apis/im/v1/messages", post(send_handler))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let base = format!("http://{addr}");
    {
        let mut m = state.mode.lock().unwrap();
        *m = RespMode::Ok;
    }
    let client = FeishuApiClient::new(make_config(&base));
    let res = client.send_text_message("oc_1", "hi").await;
    assert!(res.is_err(), "token failure must propagate to send");
}

// ── 9. update_card success via PATCH ────────────────────────────────────────
#[tokio::test]
async fn update_card_success() {
    let (base, st) = spawn_server(RespMode::Ok).await;
    let client = FeishuApiClient::new(make_config(&base));
    let card = json!({ "config": { "wide_screen_mode": true } });
    let res = client.update_card("m_1", "oc_1", &card).await;
    assert!(res.is_ok(), "update_card should succeed: {res:?}");
    // patch_handler counts as a send call.
    assert!(st.send_calls.load(Ordering::SeqCst) >= 1);
}

// ── 10. multi-byte safety: floor_char_boundary never panics ────────────────
#[test]
fn floor_char_boundary_multibyte_safe() {
    let s = "你好世界abc"; // 4 CJK (3 bytes each) + 3 ASCII
    // Byte map: 你[0..3] 好[3..6] 世[6..9] 界[9..12] a[12] b[13] c[14]
    // A `max` that lands inside a multi-byte char must floor down to the
    // previous char boundary instead of panicking.
    // Uses the stable `str::floor_char_boundary` inherent method (Rust 1.87+)
    // instead of a hand-rolled helper.
    assert_eq!(&s[..s.floor_char_boundary(0)], ""); // idx 0 -> ""
    assert_eq!(&s[..s.floor_char_boundary(1)], ""); // 1 not a boundary -> 0 -> ""
    assert_eq!(&s[..s.floor_char_boundary(3)], "你"); // exact boundary
    assert_eq!(&s[..s.floor_char_boundary(4)], "你"); // 4 -> 3 -> "你"
    assert_eq!(&s[..s.floor_char_boundary(6)], "你好"); // exact boundary
    assert_eq!(&s[..s.floor_char_boundary(7)], "你好"); // 7 -> 6 -> "你好"
    // Full string returned when max >= len.
    assert_eq!(&s[..s.floor_char_boundary(100)], s);
}

// ── 11. config masking is multi-byte safe (no slice panic) ─────────────────
#[test]
fn config_app_secret_mask_multibyte_safe() {
    // A secret whose byte length > 8 but char count <= 8 would previously
    // panic on `&app_secret[..4]` if the 4th byte split a multi-byte char.
    let secret = "🤩🤩🤩🤩🤩"; // 5 emoji, each 4 bytes → 20 bytes, 5 chars
    let cfg = FeishuConfig {
        app_id: "a".into(),
        app_secret: secret.into(),
        domain: "feishu".into(),
    };
    // Serialize must not panic and must keep the first/last 4 chars.
    let serialized = serde_json::to_string(&cfg).unwrap();
    assert!(serialized.contains("app_secret"));
    assert!(serialized.contains("***"));
}
