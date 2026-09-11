//! Feishu WebSocket lifecycle integration tests.
//!
//! Covers the three previously unproven areas:
//!   1. Half-open connection detection (TCP alive but no frames → forced reconnect)
//!   2. Reconnect does not open two simultaneous live connections (no double dispatch)
//!   3. Shutdown signal terminates the run loop promptly (no infinite block)
//!
//! A local `axum` server impersonates the Feishu WS-config endpoint and a local
//! `tokio-tungstenite` server impersonates the WS push endpoint. No real network
//! calls leave the test process.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use axum::extract::State;
use axum::routing::post;
use axum::Json;
use im_bridge::config::FeishuConfig;
use im_bridge::feishu::FeishuApiClient;
use im_bridge::feishu::FeishuWsClient;
use im_bridge::sse_bridge::SseEvent;
use im_bridge::bridge::SmartLayerBridge;
use duo_types::ClarificationResult;
use futures::StreamExt;
use serde_json::json;
use tokio::sync::{broadcast, RwLock};

/// Minimal bridge: returns inert defaults. These tests never reach the
/// business dispatch path because the fake WS server sends no frames.
struct MockBridge;

#[async_trait]
impl SmartLayerBridge for MockBridge {
    fn clarify_intent_result(&self, _text: &str) -> anyhow::Result<ClarificationResult> {
        Ok(ClarificationResult {
            intent_type: String::new(),
            confidence: 0.0,
            entities: vec![],
            ambiguities: vec![],
            suggested_mode: duo_types::SuggestedMode::Chat,
        })
    }
    async fn execute_agent(&self, _prompt: &str) -> anyhow::Result<String> {
        Ok(String::new())
    }
    fn set_llm_config(&self, _key: &str, _value: &str) {}
    fn is_llm_configured(&self) -> bool {
        true
    }
    fn subscribe_events(&self) -> broadcast::Receiver<SseEvent> {
        broadcast::channel(1).1
    }
}

/// Tracks how many times the fake Feishu WS-config endpoint was hit (i.e. how
/// many reconnect cycles started) and how many concurrent WS connections exist.
#[derive(Default, Clone)]
struct LifecycleState {
    config_calls: Arc<AtomicUsize>,
    live_ws_conns: Arc<AtomicUsize>,
    max_concurrent: Arc<AtomicUsize>,
}

fn make_config(base: &str) -> FeishuConfig {
    FeishuConfig {
        app_id: "app".to_string(),
        app_secret: "secret".to_string(),
        domain: base.to_string(),
    }
}

/// Spawn the fake Feishu WS-config HTTP endpoint + a dummy WS push endpoint
/// that accepts connections but never sends a single frame (half-open target).
async fn spawn_feishu_fakes(state: LifecycleState) -> (String, u16) {
    // --- Dummy WS push server (accepts, then idles forever) ---
    let ws_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ws_addr = ws_listener.local_addr().unwrap();
    let ws_state = state.clone();
    tokio::spawn(async move {
        loop {
            let (stream, _) = ws_listener.accept().await.unwrap();
            let st = ws_state.clone();
            tokio::spawn(async move {
                // Accept, then read until the client closes (server sends nothing).
                // Counting on the read-return (not a fixed idle) is what makes the
                // live-connection counter track the *client's* view accurately.
                if let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await {
                    let prev = st.live_ws_conns.fetch_add(1, Ordering::SeqCst);
                    // Record the new count atomically (no lock needed).
                    st.max_concurrent.fetch_max(prev + 1, Ordering::SeqCst);
                    // Half-open target: never send a frame. Loop until the
                    // client drops the TCP socket (heartbeat timeout → break).
                    while ws.next().await.is_some() {}
                    st.live_ws_conns.fetch_sub(1, Ordering::SeqCst);
                }
            });
        }
    });

    // --- Fake WS-config HTTP endpoint ---
    let http_state = state.clone();
    let app = axum::Router::new()
        .route(
            "/callback/ws/endpoint",
            post(move |State(st): State<LifecycleState>| async move {
                st.config_calls.fetch_add(1, Ordering::SeqCst);
                // NOTE: tokio-tungstenite's `accept_async` rejects WS URLs that
                // carry a query string (a known limitation), so the fake server
                // returns a query-less URL. `connect_url` tolerates the missing
                // device_id/service_id (falls back to None) without affecting
                // connection establishment or the half-open detection logic.
                let url = format!("ws://127.0.0.1:{}", ws_addr.port());
                Json(json!({
                    "code": 0,
                    "msg": "ok",
                    "data": {
                        "URL": url,
                        "ClientConfig": {
                            "PingInterval": 20,
                            "ReconnectCount": 3,
                            "ReconnectInterval": 2,
                            "ReconnectNonce": 0
                        }
                    }
                }))
            }),
        )
        .with_state(http_state);
    let http_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http_addr = http_listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(http_listener, app).await.unwrap();
    });

    (
        format!("http://{http_addr}"),
        ws_addr.port(),
    )
}

/// 1. Half-open detection: with a server that never sends frames, the client
///    must break the connection after `heartbeat_timeout` and re-fetch config
///    (i.e. it does NOT block forever on a dead link).
#[tokio::test]
async fn half_open_connection_forces_reconnect() {
    let state = LifecycleState::default();
    let (base, _ws_port) = spawn_feishu_fakes(state.clone()).await;

    let shutdown = Arc::new(RwLock::new(false));
    let client = FeishuWsClient::new(
        make_config(&base),
        FeishuApiClient::new(make_config(&base)),
        Arc::new(MockBridge),
        shutdown.clone(),
        None,
    )
    .with_heartbeat_timeout(2);

    // Run for a bounded window; the half-open link (2s timeout) + 2s backoff
    // means the config endpoint is hit at least twice within 8s.
    let run_handle = tokio::spawn(async move {
        client.run().await;
    });
    tokio::time::sleep(std::time::Duration::from_secs(8)).await;
    *shutdown.write().await = true;
    // run() observes shutdown within 250ms poll → returns promptly.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), run_handle).await;

    let calls = state.config_calls.load(Ordering::SeqCst);
    assert!(
        calls >= 2,
        "half-open link must trigger reconnect (config re-fetched >=2 times), got {calls}"
    );
}

/// 2. Reconnect safety: at no point should two live connections to the push
///    endpoint coexist (otherwise Feishu would double-deliver and we'd double
///    dispatch). The sequential `run` loop guarantees the old connection's
///    `connect_and_serve` fully returns before the next connect begins.
#[tokio::test]
async fn reconnect_never_double_opens_connection() {
    let state = LifecycleState::default();
    let (base, _ws_port) = spawn_feishu_fakes(state.clone()).await;

    let shutdown = Arc::new(RwLock::new(false));
    let client = FeishuWsClient::new(
        make_config(&base),
        FeishuApiClient::new(make_config(&base)),
        Arc::new(MockBridge),
        shutdown.clone(),
        None,
    )
    .with_heartbeat_timeout(2);

    let run_handle = tokio::spawn(async move {
        client.run().await;
    });
    tokio::time::sleep(std::time::Duration::from_secs(8)).await;
    *shutdown.write().await = true;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), run_handle).await;

    let max_concurrent = state.max_concurrent.load(Ordering::SeqCst);
    assert_eq!(
        max_concurrent, 1,
        "reconnect must not open two simultaneous live connections (max seen: {max_concurrent})"
    );
}

/// 3. Shutdown crosses the reconnect loop: requesting shutdown while the loop
///    is mid-sleep/connecting must terminate `run` within a bounded time.
#[tokio::test]
async fn shutdown_terminates_run_loop_promptly() {
    let state = LifecycleState::default();
    let (base, _ws_port) = spawn_feishu_fakes(state.clone()).await;

    let shutdown = Arc::new(RwLock::new(false));
    let client = FeishuWsClient::new(
        make_config(&base),
        FeishuApiClient::new(make_config(&base)),
        Arc::new(MockBridge),
        shutdown.clone(),
        None,
    )
    .with_heartbeat_timeout(2);

    let run_handle = tokio::spawn(async move {
        client.run().await;
    });
    // Let it connect once, then request shutdown.
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    *shutdown.write().await = true;

    // run() must exit well within the 2s heartbeat + 2s backoff windows.
    let finished = tokio::time::timeout(std::time::Duration::from_secs(5), run_handle).await;
    assert!(
        finished.is_ok(),
        "run() must terminate after shutdown signal, not block forever"
    );
}
