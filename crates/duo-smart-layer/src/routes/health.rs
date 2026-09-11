use axum::{Json, Router, extract::State};
use duo_types::HealthResponse;
use serde_json::{json, Value};

pub fn router() -> Router<crate::server::AppState> {
    Router::new()
        .route("/health", axum::routing::get(health_check))
        .route("/shutdown", axum::routing::post(shutdown))
}

async fn health_check(
    state: State<crate::server::AppState>,
) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_seconds: state.started_at.elapsed().as_secs(),
        memory_persistent: state.memory.is_persistent(),
    })
}

/// Graceful shutdown endpoint.
///
/// Spawns a delayed `std::process::exit(0)` so the HTTP response can be
/// sent back to the caller before the process terminates.
async fn shutdown() -> Json<Value> {
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        tracing::info!("Graceful shutdown triggered via /shutdown endpoint");
        std::process::exit(0);
    });
    Json(json!({ "status": "shutting_down" }))
}
