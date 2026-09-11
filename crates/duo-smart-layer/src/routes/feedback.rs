use axum::{
    Json, Router,
    extract::{Path, State},
};
use duo_types::{FeedbackEntry, FeedbackSubmitRequest};
use unified_error::Result;

pub fn router() -> Router<crate::server::AppState> {
    Router::new()
        .route("/feedback/submit", axum::routing::post(submit))
        .route("/feedback/:session_id", axum::routing::get(get_by_session))
}

async fn submit(
    State(state): State<crate::server::AppState>,
    Json(req): Json<FeedbackSubmitRequest>,
) -> Result<Json<FeedbackEntry>> {
    let feedback = state.feedback.get()?;
    let result = tokio::task::spawn_blocking(move || feedback.submit(&req)).await??;
    Ok(Json(result))
}

async fn get_by_session(
    State(state): State<crate::server::AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<Vec<FeedbackEntry>>> {
    let feedback = state.feedback.get()?;
    let result =
        tokio::task::spawn_blocking(move || feedback.get_by_session(&session_id)).await??;
    Ok(Json(result))
}
