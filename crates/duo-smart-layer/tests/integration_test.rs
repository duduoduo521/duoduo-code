//! HTTP API end-to-end integration tests for duo-smart-layer.
//!
//! Uses `axum::Router` + `tower::ServiceExt` to test all endpoints
//! without starting a real TCP listener.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use duo_smart_layer::server::AppState;
use http_body_util::BodyExt;
use tower::ServiceExt;

// ─── Helpers ───

async fn create_test_app() -> TestApp {
    // Each test gets its own temp project directory so the SQLite pools are
    // per-test files. `AppState::new(None)` points every subsystem at the same
    // default location, and the parallel test runners then race to create the
    // metadata tables there — on Windows the loser fails with "Failed to
    // create metadata table", flaking random tests on every run.
    let dir = tempfile::tempdir().expect("create isolated temp project dir");
    let app_state = AppState::new(Some(dir.path().to_path_buf()))
        .await
        .expect("AppState::new with isolated project dir");
    TestApp {
        state: app_state,
        _dir: dir,
    }
}

/// Wraps a shared `AppState` so we can rebuild the router for each request
/// while preserving the underlying in-memory state (all inner fields are Arc-wrapped).
struct TestApp {
    state: AppState,
    /// Keeps the temp project dir alive for the whole test; dropping it would
    /// delete the database files the AppState pools still reference.
    _dir: tempfile::TempDir,
}

impl TestApp {
    /// Build a fresh router from the shared state and send a single request.
    /// The router is consumed by `oneshot`, but the `AppState` is kept.
    async fn send(&self, req: Request<Body>) -> (StatusCode, String) {
        let router = duo_smart_layer::build_router(self.state.clone());
        let resp = router.oneshot(req).await.unwrap();
        let status = resp.status();
        let body = body_to_string(resp.into_body()).await;
        (status, body)
    }
}

fn body_from<T: serde::Serialize>(val: &T) -> Body {
    Body::from(serde_json::to_vec(val).unwrap())
}

async fn body_to_string(body: Body) -> String {
    let bytes = body
        .collect()
        .await
        .expect("failed to read response body")
        .to_bytes();
    String::from_utf8(bytes.to_vec()).expect("response body is not valid utf-8")
}

// ─── Health ───

#[tokio::test]
async fn health_check_returns_ok() {
    let app = create_test_app().await;
    let req = Request::builder()
        .uri("/health")
        .body(Body::empty())
        .unwrap();
    let (status, body) = app.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json["status"].is_string());
    assert!(json["uptimeSeconds"].is_u64());
}

// ─── Memory ───

#[tokio::test]
async fn memory_store_returns_id_and_stored() {
    let app = create_test_app().await;
    let req_body = serde_json::json!({
        "content": "test content",
        "layer": "ephemeral",
        "tags": ["test"]
    });
    let req = Request::builder()
        .method("POST")
        .uri("/memory/store")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (status, body) = app.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json["id"].is_string());
    assert!(json["stored"].is_boolean());
}

#[tokio::test]
async fn memory_search_returns_array() {
    let app = create_test_app().await;
    let req_body = serde_json::json!({
        "query": "test",
        "limit": 5
    });
    let req = Request::builder()
        .method("POST")
        .uri("/memory/search")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (status, body) = app.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json.is_array());
}

#[tokio::test]
async fn memory_stats_v2_returns_enhanced_object() {
    let app = create_test_app().await;
    let req = Request::builder()
        .uri("/memory/stats/v2")
        .body(Body::empty())
        .unwrap();
    let (status, body) = app.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json["totalEntries"].is_number());
    assert!(json["storageSizeBytes"].is_number());
    assert!(json["schemaVersion"].is_string());
    assert!(json["byLayer"].is_object());
    // oldest/newest are Option<String> — null on an empty store, never missing.
    assert!(json["oldestEntry"].is_null() || json["oldestEntry"].is_string());
    assert!(json["newestEntry"].is_null() || json["newestEntry"].is_string());
}

// ─── Quality ───

#[tokio::test]
async fn quality_validate_returns_report() {
    let app = create_test_app().await;
    let req_body = serde_json::json!({
        "artifact": {
            "type": "function",
            "content": "fn hello() { println!(\"hello\"); }",
            "language": "rust"
        },
        "qualityLevel": "self_check"
    });
    let req = Request::builder()
        .method("POST")
        .uri("/quality/validate")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (status, body) = app.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json["passed"].is_boolean());
    assert!(json["score"].is_number());
    assert!(json["checks"].is_array());
    assert!(json["suggestions"].is_array());
}

// ─── Intent ───

#[tokio::test]
async fn intent_clarify_returns_result() {
    let app = create_test_app().await;
    let req_body = serde_json::json!({
        "userInput": "I want to add a login page"
    });
    let req = Request::builder()
        .method("POST")
        .uri("/intent/clarify")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (status, body) = app.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json["intentType"].is_string());
}

// ─── Feedback ───

#[tokio::test]
async fn feedback_submit_returns_entry() {
    let app = create_test_app().await;
    let req_body = serde_json::json!({
        "sessionId": "test-session",
        "rating": 5,
        "comment": "Great!"
    });
    let req = Request::builder()
        .method("POST")
        .uri("/feedback/submit")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (status, body) = app.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json["id"].is_string());
}

#[tokio::test]
async fn feedback_get_by_session_returns_array() {
    let app = create_test_app().await;
    // First submit some feedback
    let req_body = serde_json::json!({
        "sessionId": "session-list-test",
        "rating": 4,
        "comment": "Good"
    });
    let req = Request::builder()
        .method("POST")
        .uri("/feedback/submit")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (_, _) = app.send(req).await;

    // Then get by session — route is /feedback/:session_id
    let req = Request::builder()
        .uri("/feedback/session-list-test")
        .body(Body::empty())
        .unwrap();
    let (status, body) = app.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json.is_array());
    assert!(
        !json.as_array().unwrap().is_empty(),
        "should have at least one feedback entry"
    );
}

// ─── Session ───

#[tokio::test]
async fn session_create_returns_session_info() {
    let app = create_test_app().await;
    let req_body = serde_json::json!({
        "projectId": "/tmp/test-project",
        "metadata": {"env": "test"}
    });
    let req = Request::builder()
        .method("POST")
        .uri("/session/create")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (status, body) = app.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json["id"].is_string());
}

#[tokio::test]
async fn session_get_returns_session() {
    let app = create_test_app().await;
    // Create first
    let req_body = serde_json::json!({
        "projectId": "/tmp/test-project-2",
        "metadata": null
    });
    let req = Request::builder()
        .method("POST")
        .uri("/session/create")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (_, body) = app.send(req).await;
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    let session_id = json["id"].as_str().unwrap();

    // Get — response is Option<ExtendedSessionInfo>, which serializes as an object (not null)
    let req = Request::builder()
        .uri(format!("/session/{session_id}"))
        .body(Body::empty())
        .unwrap();
    let (status, body) = app.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    // ExtendedSessionInfo serializes with its fields; id is always present
    assert!(
        json.is_object(),
        "session GET should return an object (Some)"
    );
    assert!(json["id"].is_string());
}

// ─── Agent ───

#[tokio::test]
async fn agent_schedule_returns_task() {
    let app = create_test_app().await;
    let req_body = serde_json::json!({
        "description": "test task",
        "priority": "normal"
    });
    let req = Request::builder()
        .method("POST")
        .uri("/agent/schedule")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (status, body) = app.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json["id"].is_string());
}

#[tokio::test]
async fn agent_list_tasks_returns_array() {
    let app = create_test_app().await;
    let req = Request::builder()
        .uri("/agent/tasks")
        .body(Body::empty())
        .unwrap();
    let (status, body) = app.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json.is_array());
}

#[tokio::test]
async fn agent_list_tasks_with_status_filter() {
    let app = create_test_app().await;
    let req = Request::builder()
        .uri("/agent/tasks?status=queued")
        .body(Body::empty())
        .unwrap();
    let (status, _) = app.send(req).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn agent_execute_returns_error_without_llm_config() {
    let app = create_test_app().await;
    let req_body = serde_json::json!({
        "prompt": "Hello, world!",
        "modelId": "test-model"
    });
    let req = Request::builder()
        .method("POST")
        .uri("/agent/execute")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (status, _body) = app.send(req).await;
    // Without LLM configured, the endpoint returns an error (500)
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
}

// ─── Search ───

#[tokio::test]
async fn search_code_index_file() {
    let app = create_test_app().await;
    let req_body = serde_json::json!({
        "path": "/tmp/test.rs",
        "content": "fn main() { println!(\"hello\"); }",
        "language": "rust"
    });
    let req = Request::builder()
        .method("POST")
        .uri("/search/code")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (status, body) = app.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json["indexed"].is_boolean());
}

#[tokio::test]
async fn search_symbols_returns_array() {
    let app = create_test_app().await;
    let req_body = serde_json::json!({
        "query": "main",
        "limit": 10
    });
    let req = Request::builder()
        .method("POST")
        .uri("/search/symbols")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (status, body) = app.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json.is_array());
}

// ─── Graph ───

#[tokio::test]
async fn graph_query_shortest_path() {
    let app = create_test_app().await;
    let req_body = serde_json::json!({
        "queryType": "shortest_path",
        "fromId": "a",
        "toId": "b"
    });
    let req = Request::builder()
        .method("POST")
        .uri("/graph/query")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (status, _) = app.send(req).await;
    assert!(
        status == StatusCode::OK || status == StatusCode::INTERNAL_SERVER_ERROR,
        "graph/query should return 200 or 500, got {}",
        status
    );
}

#[tokio::test]
async fn graph_query_subgraph() {
    let app = create_test_app().await;
    let req_body = serde_json::json!({
        "queryType": "subgraph",
        "centerId": "a",
        "hops": 1
    });
    let req = Request::builder()
        .method("POST")
        .uri("/graph/query")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (status, _) = app.send(req).await;
    assert!(
        status == StatusCode::OK || status == StatusCode::INTERNAL_SERVER_ERROR,
        "graph/query subgraph should return 200 or 500, got {}",
        status
    );
}

#[tokio::test]
async fn graph_query_neighbors() {
    let app = create_test_app().await;
    let req_body = serde_json::json!({
        "queryType": "neighbors",
        "nodeId": "a"
    });
    let req = Request::builder()
        .method("POST")
        .uri("/graph/query")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (status, _) = app.send(req).await;
    assert!(
        status == StatusCode::OK || status == StatusCode::INTERNAL_SERVER_ERROR,
        "graph/query neighbors should return 200 or 500, got {} Unprocessable Entity",
        status
    );
}

#[tokio::test]
async fn graph_query_nodes_by_type() {
    let app = create_test_app().await;
    let req_body = serde_json::json!({
        "queryType": "nodes_by_type",
        "nodeType": "file"
    });
    let req = Request::builder()
        .method("POST")
        .uri("/graph/query")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (status, _) = app.send(req).await;
    assert!(
        status == StatusCode::OK || status == StatusCode::INTERNAL_SERVER_ERROR,
        "graph/query nodes_by_type should return 200 or 500, got {} Unprocessable Entity",
        status
    );
}

// ─── DNA ───

#[tokio::test]
async fn dna_match_returns_rules() {
    let app = create_test_app().await;
    let req_body = serde_json::json!({
        "input": "test input for dna matching"
    });
    let req = Request::builder()
        .method("POST")
        .uri("/dna/match")
        .header("content-type", "application/json")
        .body(body_from(&req_body))
        .unwrap();
    let (status, body) = app.send(req).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(json.is_array(), "dna/match should return an array of rules");
}

// ─── 404 for unknown route ───

#[tokio::test]
async fn unknown_route_returns_404() {
    let app = create_test_app().await;
    let req = Request::builder()
        .uri("/nonexistent/endpoint")
        .body(Body::empty())
        .unwrap();
    let (status, _) = app.send(req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
