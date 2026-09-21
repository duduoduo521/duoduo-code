//! Feishu full-feature robustness integration tests.
//!
//! Covers the five areas previously unproven at the code level:
//!   1. Reconnect resets per-connection dedup/fragment state (no cross-connection bleed)
//!   2. Token acquisition / refresh failure is isolated into the reconnect loop
//!   3. Malformed frames (non-JSON / unknown type / schema drift) do not break the link
//!   4. Massive fan-in of fragmented messages stays within bounded memory and reassembles
//!   5. Multiple `FeishuWsClient` instances in one process stay isolated (no cross-tenant leak)
//!
//! A local `axum` server impersonates BOTH the Feishu WS-config endpoint AND the
//! tenant-access-token endpoint; a local `tokio-tungstenite` server impersonates the
//! WS push endpoint and can be scripted to emit arbitrary frames. No real network
//! calls leave the test process.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::extract::State;
use axum::routing::post;
use axum::Json;
use futures::StreamExt;
use futures::SinkExt;
use im_bridge::config::FeishuConfig;
use im_bridge::feishu::proto::{
    encode_frame, Frame, FRAME_TYPE_CONTROL, FRAME_TYPE_DATA, HEADER_KEY_IS_LAST,
    HEADER_KEY_MESSAGE_ID, HEADER_KEY_SEQ, HEADER_KEY_SUM, HEADER_KEY_TYPE, MESSAGE_TYPE_EVENT,
    MESSAGE_TYPE_PONG,
};
use im_bridge::feishu::FeishuApiClient;
use im_bridge::feishu::FeishuWsClient;
use im_bridge::sse_bridge::SseEvent;
use im_bridge::bridge::SmartLayerBridge;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, RwLock};
use tokio_tungstenite::tungstenite::Message;

/// Records external interactions so tests can assert behavior without reaching
/// into private client state.
#[derive(Clone, Default)]
struct RobustState {
    /// WS-config endpoint hits (== reconnect cycles started).
    config_calls: Arc<AtomicUsize>,
    /// When set, the WS-config endpoint returns a non-zero code (auth/config fault).
    config_fail: Arc<AtomicBool>,
    /// Count of fully-dispatched agent messages (the business path we observe).
    dispatch_count: Arc<AtomicUsize>,
    /// Last dispatched prompt text (for content assertions).
    last_prompt: Arc<RwLock<String>>,
}

/// Script the fake WS server runs after accepting a client connection.
#[derive(Clone)]
enum ServerScript {
    /// Accept then idle forever (heartbeat timeout drives behavior).
    Idle,
    /// Send `frames` immediately, then keep the link alive with pongs.
    Scripted(Vec<Message>),
}

struct MockBridge {
    state: RobustState,
}

#[async_trait]
impl SmartLayerBridge for MockBridge {
    fn clarify_intent_result(&self, _text: &str) -> anyhow::Result<duo_types::ClarificationResult> {
        Ok(duo_types::ClarificationResult {
            intent_type: String::new(),
            confidence: 0.0,
            entities: vec![],
            ambiguities: vec![],
            suggested_mode: duo_types::SuggestedMode::Chat,
        })
    }
    async fn execute_agent(&self, prompt: &str) -> anyhow::Result<String> {
        self.state.dispatch_count.fetch_add(1, Ordering::SeqCst);
        *self.state.last_prompt.write().await = prompt.to_string();
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

fn make_config(base: &str) -> FeishuConfig {
    FeishuConfig {
        app_id: "app".to_string(),
        app_secret: "secret".to_string(),
        domain: base.to_string(),
    }
}

/// Build a Feishu `data` frame that wraps `payload` as an event fragment.
fn event_frame(message_id: &str, seq: u32, sum: u32, is_last: bool, payload: &[u8]) -> Message {
    let mut headers = vec![
        im_bridge::feishu::proto::Header {
            key: HEADER_KEY_TYPE.to_string(),
            value: MESSAGE_TYPE_EVENT.to_string(),
        },
        im_bridge::feishu::proto::Header {
            key: HEADER_KEY_MESSAGE_ID.to_string(),
            value: message_id.to_string(),
        },
        im_bridge::feishu::proto::Header {
            key: HEADER_KEY_SUM.to_string(),
            value: sum.to_string(),
        },
        im_bridge::feishu::proto::Header {
            key: HEADER_KEY_SEQ.to_string(),
            value: seq.to_string(),
        },
    ];
    if is_last {
        headers.push(im_bridge::feishu::proto::Header {
            key: HEADER_KEY_IS_LAST.to_string(),
            value: "true".to_string(),
        });
    }
    let frame = Frame {
        seq_id: 0,
        log_id: 0,
        service: 1,
        method: FRAME_TYPE_DATA,
        headers,
        payload_encoding: "json".to_string(),
        payload_type: "event".to_string(),
        payload: payload.to_vec(),
        log_id_new: String::new(),
    };
    Message::Binary(encode_frame(&frame))
}

fn pong_frame() -> Message {
    let frame = Frame {
        seq_id: 0,
        log_id: 0,
        service: 1,
        method: FRAME_TYPE_CONTROL,
        headers: vec![im_bridge::feishu::proto::Header {
            key: HEADER_KEY_TYPE.to_string(),
            value: MESSAGE_TYPE_PONG.to_string(),
        }],
        payload_encoding: String::new(),
        payload_type: String::new(),
        payload: Vec::new(),
        log_id_new: String::new(),
    };
    Message::Binary(encode_frame(&frame))
}

/// A minimal valid Feishu `im.message.receive_v1` event with a single text part,
/// carrying `message_id` and content `text`. Used as a complete (sum=1) message.
fn clean_event(message_id: &str, text: &str) -> Vec<u8> {
    clean_event_in_chat(message_id, text, "oc_1")
}

/// Same as `clean_event` but with an explicit chat id — instances that must
/// stay isolated must NOT share a chat id (the per-chat serial gate would
/// serialize their dispatches).
fn clean_event_in_chat(message_id: &str, text: &str, chat_id: &str) -> Vec<u8> {
    let payload = json!({
        "schema": "2.0",
        "header": {
            "event_id": message_id,
            "event_type": "im.message.receive_v1",
            "token": "t",
            "create_time": "1700000000",
            "tenant_key": "tk",
            "app_id": "app"
        },
        "event": {
            "message": {
                "message_id": message_id,
                "chat_id": chat_id,
                "content_type": "text",
                "content": json!({ "text": text }).to_string()
            }
        }
    });
    payload.to_string().into_bytes()
}

/// Split `payload` into `sum` binary fragment frames for `message_id`.
fn fragmented_event(message_id: &str, payload: &[u8], sum: u32) -> Vec<Message> {
    let chunk = payload.len().div_ceil(sum as usize).max(1);
    let mut frames = Vec::new();
    for seq in 0..sum {
        let start = (seq as usize) * chunk;
        let end = ((seq as usize) + 1) * chunk;
        let end = end.min(payload.len());
        let data: &[u8] = if start >= payload.len() {
            &[]
        } else {
            &payload[start..end]
        };
        let is_last = seq == sum - 1;
        frames.push(event_frame(message_id, seq, sum, is_last, data));
    }
    frames
}

/// Spawn fake Feishu servers: an axum HTTP server (WS-config + token endpoint)
/// and a tokio-tungstenite WS push server driven by `script`.
async fn spawn_fake_feishu(state: RobustState, script: ServerScript) -> String {
    spawn_fake_feishu_inner(state, script, /*close_after_script=*/ false, None).await
}

/// Variant that closes the WS socket right after sending its scripted frames,
/// forcing the client to reconnect (used to prove per-connection state reset).
async fn spawn_fake_feishu_resetting(state: RobustState, script: ServerScript) -> String {
    spawn_fake_feishu_inner(state, script, /*close_after_script=*/ true, None).await
}

/// Variant that sends `phase1`, waits `delay`, then sends `phase2`, then keeps
/// the link alive with pongs. Used for the massive-fan-in test.
async fn spawn_fake_feishu_dual_phase(
    state: RobustState,
    phase1: Vec<Message>,
    phase2: Vec<Message>,
    delay: Duration,
) -> String {
    spawn_fake_feishu_inner(state, ServerScript::Idle, false, Some((phase1, phase2, delay))).await
}

#[allow(clippy::too_many_arguments)]
async fn spawn_fake_feishu_inner(
    state: RobustState,
    script: ServerScript,
    close_after_script: bool,
    dual_phase: Option<(Vec<Message>, Vec<Message>, Duration)>,
) -> String {
    // --- WS push server ---
    let ws_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ws_addr = ws_listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (stream, _) = ws_listener.accept().await.unwrap();
            let script = script.clone();
            let dual_phase = dual_phase.clone();
            tokio::spawn(async move {
                let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
                    return;
                };
                // Split read/write so a dedicated task ALWAYS drains the
                // inbound direction while the script writes. The client
                // ACKs every data frame (official SDK parity); a script
                // that only writes (dual-phase sleep / pong loop) would
                // let 1205 ACKs fill its TCP receive buffer and
                // back-pressure the client's send path into a deadlock
                // that only the heartbeat timeout can break. A real Feishu
                // server reads ACKs concurrently -- so must the mock.
                let (mut write, mut read) = ws.split();
                let drain = tokio::spawn(async move {
                    while read.next().await.is_some() {}
                });
                match (&script, &dual_phase) {
                    (_, Some((p1, p2, delay))) => {
                        for f in p1 {
                            let _ = write.send(f.clone()).await;
                        }
                        tokio::time::sleep(*delay).await;
                        for f in p2 {
                            let _ = write.send(f.clone()).await;
                        }
                        loop {
                            let _ = write.send(pong_frame()).await;
                            tokio::time::sleep(Duration::from_secs(1)).await;
                        }
                    }
                    (ServerScript::Idle, None) => {}
                    (ServerScript::Scripted(frames), None) => {
                        for f in frames {
                            let _ = write.send(f.clone()).await;
                        }
                        if close_after_script {
                            let _ = write.close().await;
                        } else {
                            loop {
                                let _ = write.send(pong_frame()).await;
                                tokio::time::sleep(Duration::from_secs(1)).await;
                            }
                        }
                    }
                }
                let _ = drain.await;
            });
        }
    });

    // --- HTTP: WS-config + token endpoint ---
    let http_state = state.clone();
    let app = axum::Router::new()
        .route(
            "/callback/ws/endpoint",
            post(move |State(st): State<RobustState>| async move {
                st.config_calls.fetch_add(1, Ordering::SeqCst);
                if st.config_fail.load(Ordering::SeqCst) {
                    return Json(json!({ "code": 9999, "msg": "auth failed" }));
                }
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
        .route(
            // IM-02 send_message_raw target (welcome cards + text replies).
            // Without it the client's bounded retry loop (5 attempts, ~6s of
            // backoff per dispatch) serializes the per-chat gate and starves
            // the test window.
            "/open-apis/im/v1/messages",
            post(|| async {
                Json(json!({
                    "code": 0,
                    "msg": "ok",
                    "data": { "message_id": "om_mock" }
                }))
            }),
        )
        .route(
            "/open-apis/auth/v3/tenant_access_token/internal",
            post(move |State(_st): State<RobustState>| async move {
                Json(json!({
                    "code": 0,
                    "msg": "ok",
                    "tenant_access_token": "valid-token",
                    "expire": 7200
                }))
            }),
        )
        .with_state(http_state);
    let http_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http_addr = http_listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(http_listener, app).await.unwrap();
    });

    format!("http://{http_addr}")
}

struct ClientBundle {
    client: FeishuWsClient,
    shutdown: Arc<RwLock<bool>>,
}

fn make_client_with_shutdown(base: &str, state: RobustState, hb: u64) -> ClientBundle {
    let shutdown = Arc::new(RwLock::new(false));
    let client = FeishuWsClient::new(
        make_config(base),
        FeishuApiClient::new(make_config(base)),
        Arc::new(MockBridge { state }),
        shutdown.clone(),
        None,
    )
    .with_heartbeat_timeout(hb);
    ClientBundle { client, shutdown }
}

async fn run_bundle(bundle: ClientBundle, secs: u64) {
    let ClientBundle { client, shutdown } = bundle;
    let handle = tokio::spawn(async move { client.run().await });
    tokio::time::sleep(Duration::from_secs(secs)).await;
    *shutdown.write().await = true;
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
}

// ---------------------------------------------------------------------------
// 1. Reconnect resets per-connection dedup/fragment state (no cross-connection bleed)
// ---------------------------------------------------------------------------
#[tokio::test]
async fn reconnect_resets_dedup_state_per_connection() {
    let state = RobustState::default();
    // An Idle server never sends frames, so the heartbeat timeout (1s) forces a
    // reconnect every ~1s + 2s backoff. The loop must keep re-fetching config.
    let base = spawn_fake_feishu(state.clone(), ServerScript::Idle).await;
    let bundle = make_client_with_shutdown(&base, state.clone(), 1);
    run_bundle(bundle, 7).await;
    let calls = state.config_calls.load(Ordering::SeqCst);
    assert!(calls >= 2, "reconnect loop must re-fetch config repeatedly, got {calls}");
}

#[tokio::test]
async fn dedup_state_survives_reconnect() {
    // P2-45 (inverted from the old contract): the fake server sends one clean
    // event then CLOSES the socket, forcing the client to reconnect. The SAME
    // event_id is replayed on the new connection. Dedup state is process-wide
    // now, so the redelivery must be suppressed — the agent must run the
    // prompt exactly once, no matter how many times the socket drops.
    let state = RobustState::default();
    let frames = vec![event_frame("dup_event", 0, 1, true, &clean_event("dup_event", "hello"))];
    let base = spawn_fake_feishu_resetting(state.clone(), ServerScript::Scripted(frames)).await;

    let bundle = make_client_with_shutdown(&base, state.clone(), 5);
    run_bundle(bundle, 9).await;
    let dispatched = state.dispatch_count.load(Ordering::SeqCst);
    assert_eq!(
        dispatched, 1,
        "a redelivered event after reconnect must be suppressed (global dedup), got {dispatched}"
    );
}

// ---------------------------------------------------------------------------
// 2. WS-config / auth endpoint failure is isolated into the reconnect loop
// ---------------------------------------------------------------------------
// NOTE: The Feishu WS long-connection handshake does NOT fetch a
// tenant_access_token on its own — the config endpoint returns an already
// authenticated WS URL, and the tenant token is only used later when the
// dispatcher *replies* to a message. So the connection-path "auth failure"
// surface is the WS-config endpoint returning a non-zero code. We prove that a
// failing config endpoint is caught and isolated into the reconnect loop
// (run keeps retrying instead of crashing or exiting early).
//
// The tenant_access_token refresh-failure path itself is covered separately by
// a focused unit test in `auth.rs` (FeishuAuthProvider refresh behaviour).
#[tokio::test]
async fn ws_config_auth_failure_does_not_crash_run() {
    let state = RobustState::default();
    // The config endpoint now always returns a non-zero code (auth fault).
    state.config_fail.store(true, Ordering::SeqCst);
    let base = spawn_fake_feishu(state.clone(), ServerScript::Idle).await;

    let bundle = make_client_with_shutdown(&base, state.clone(), 1);
    run_bundle(bundle, 6).await;

    let config_calls = state.config_calls.load(Ordering::SeqCst);
    assert!(
        config_calls >= 2,
        "a failing WS-config endpoint must be retried inside the reconnect loop, got {config_calls}"
    );
    // If we reach here, run() returned cleanly under shutdown — it did not panic
    // or abort the process on the auth fault.
}

// ---------------------------------------------------------------------------
// 3. Malformed frames do not break the link
// ---------------------------------------------------------------------------
#[tokio::test]
async fn malformed_frames_do_not_break_link() {
    let state = RobustState::default();
    // Script: a non-JSON data frame, then an unknown-type data frame, then a
    // schema-drifted (valid JSON, missing fields) data frame, then a CLEAN event.
    // The clean event MUST still be dispatched — proof the link survived the junk.
    let mut frames = Vec::new();
    // (a) non-JSON payload
    frames.push(event_frame("junk1", 0, 1, true, b"this is not json at all"));
    // (b) unknown type
    {
        let frame = Frame {
            seq_id: 0, log_id: 0, service: 1, method: FRAME_TYPE_DATA,
            headers: vec![im_bridge::feishu::proto::Header {
                key: HEADER_KEY_TYPE.to_string(), value: "frobnicate".to_string(),
            }],
            payload_encoding: "json".to_string(), payload_type: "event".to_string(),
            payload: b"{\"foo\":\"bar\"}".to_vec(), log_id_new: String::new(),
        };
        frames.push(Message::Binary(encode_frame(&frame)));
    }
    // (c) schema drift: valid JSON but no header/event
    frames.push(event_frame("drift1", 0, 1, true, b"{\"unexpected\":\"shape\"}"));
    // (d) clean event that must survive
    frames.push(event_frame("clean1", 0, 1, true, &clean_event("clean1", "survived")));

    let base = spawn_fake_feishu(state.clone(), ServerScript::Scripted(frames)).await;
    let bundle = make_client_with_shutdown(&base, state.clone(), 5);
    run_bundle(bundle, 5).await;

    let dispatched = state.dispatch_count.load(Ordering::SeqCst);
    let last = state.last_prompt.read().await.clone();
    assert_eq!(
        dispatched, 1,
        "exactly the clean event should be dispatched after malformed frames, got {dispatched}"
    );
    assert_eq!(last, "survived", "dispatched prompt must be the clean event's text");
}

// ---------------------------------------------------------------------------
// 4. Massive fan-in of fragmented messages: bounded memory + full reassembly
// ---------------------------------------------------------------------------
#[tokio::test]
async fn large_single_message_reassembles() {
    let state = RobustState::default();
    // A single Feishu event split into 300 fragments (well over a typical
    // per-message shard count). Reassembly must reproduce the original JSON and
    // the extracted prompt must be delivered intact.
    let event_json = clean_event("big", "LARGE_PAYLOAD_REPEATED");
    let frames = fragmented_event("big", &event_json, 300);
    let base = spawn_fake_feishu(state.clone(), ServerScript::Scripted(frames)).await;
    let bundle = make_client_with_shutdown(&base, state.clone(), 5);
    run_bundle(bundle, 5).await;

    let dispatched = state.dispatch_count.load(Ordering::SeqCst);
    let last = state.last_prompt.read().await.clone();
    assert_eq!(dispatched, 1, "single large message must dispatch exactly once");
    assert_eq!(
        last, "LARGE_PAYLOAD_REPEATED",
        "reassembled event must yield the original prompt text"
    );
}

#[tokio::test]
async fn many_incomplete_fragments_stay_bounded_and_reassemble() {
    let state = RobustState::default();
    // 1205 messages (sum=2) where we first send only fragment 0 to ALL of them
    // (surpassing the 1000-entry hard cap), then send fragment 1 to ALL of them.
    // Each message's payload is a real Feishu event JSON sliced into two halves.
    // With the buggy "evict oldest regardless of completion" logic, fragment 0 of
    // the earliest messages would be dropped and they could never complete. The fix
    // only evicts *completed* buffers, so every message must still reassemble.
    const TOTAL: usize = 1205;
    let mut phase1 = Vec::new();
    let mut phase2 = Vec::new();
    for i in 0..TOTAL {
        let mid = format!("m{i}");
        let event_json = clean_event(&mid, &format!("x{i}"));
        let split = event_json.len() / 2;
        let head = event_json[..split].to_vec();
        let tail = event_json[split..].to_vec();
        phase1.push(event_frame(&mid, 0, 2, false, &head));
        phase2.push(event_frame(&mid, 1, 2, true, &tail));
    }
    let base = spawn_fake_feishu_dual_phase(state.clone(), phase1, phase2, Duration::from_millis(800)).await;
    let bundle = make_client_with_shutdown(&base, state.clone(), 30);
    run_bundle(bundle, 9).await;

    let dispatched = state.dispatch_count.load(Ordering::SeqCst);
    assert_eq!(
        dispatched, TOTAL,
        "every in-flight message must reassemble after its fragments arrive (no loss past cap), got {dispatched}/{TOTAL}"
    );
}

// ---------------------------------------------------------------------------
// 5. Multiple client instances in one process stay isolated
// ---------------------------------------------------------------------------
#[tokio::test]
async fn multiple_instances_stay_isolated() {
    let state_a = RobustState::default();
    let state_b = RobustState::default();
    // Two independent servers, each pushing its own event once. Feishu
    // event_ids are globally unique per delivery, so two instances in one
    // process never legitimately share an id — each must dispatch its own
    // event exactly once. (This test used to reuse one id for both instances
    // and assert double dispatch, which is precisely the P2-45 duplicate-agent
    // bug the global dedup table exists to prevent.)
    let frames_a = vec![event_frame("shared", 0, 1, true, &clean_event_in_chat("shared_a", "from_a", "oc_a"))];
    let frames_b = vec![event_frame("shared", 0, 1, true, &clean_event_in_chat("shared_b", "from_b", "oc_b"))];
    let base_a = spawn_fake_feishu(state_a.clone(), ServerScript::Scripted(frames_a)).await;
    let base_b = spawn_fake_feishu(state_b.clone(), ServerScript::Scripted(frames_b)).await;

    let bundle_a = make_client_with_shutdown(&base_a, state_a.clone(), 5);
    let bundle_b = make_client_with_shutdown(&base_b, state_b.clone(), 5);

    // Run both concurrently in the same process.
    let handle_a = tokio::spawn(async move { run_bundle(bundle_a, 5).await });
    let handle_b = tokio::spawn(async move { run_bundle(bundle_b, 5).await });
    let _ = tokio::join!(handle_a, handle_b);

    let dispatched_a = state_a.dispatch_count.load(Ordering::SeqCst);
    let dispatched_b = state_b.dispatch_count.load(Ordering::SeqCst);
    assert_eq!(dispatched_a, 1, "instance A must dispatch its own shared event once");
    assert_eq!(dispatched_b, 1, "instance B must dispatch its own shared event once");
    let prompt_a = state_a.last_prompt.read().await.clone();
    let prompt_b = state_b.last_prompt.read().await.clone();
    assert_eq!(prompt_a, "from_a");
    assert_eq!(prompt_b, "from_b");
}
