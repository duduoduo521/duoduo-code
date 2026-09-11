use axum::{Json, Router, routing::post};
use serde::{Deserialize, Serialize};
use unified_error::Result;

pub fn router() -> Router<crate::server::AppState> {
    Router::new().route("/permission/evaluate", post(evaluate_handler))
}

#[derive(Deserialize)]
struct EvaluateRequest {
    rules: Vec<permission_eval::Rule>,
    permission: String,
    pattern: String,
}

#[derive(Serialize)]
struct EvaluateResponse {
    result: permission_eval::EvaluateResult,
}

async fn evaluate_handler(Json(req): Json<EvaluateRequest>) -> Result<Json<EvaluateResponse>> {
    let result = permission_eval::evaluate(&req.permission, &req.pattern, &req.rules);
    Ok(Json(EvaluateResponse { result }))
}
