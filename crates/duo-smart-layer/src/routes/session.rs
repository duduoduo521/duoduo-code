use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, State},
};
use duo_types::SessionCreateRequest;
use session_manager::ExtendedSessionInfo;
use unified_error::Result;

pub fn router() -> Router<crate::server::AppState> {
    Router::new()
        .route("/session/create", axum::routing::post(create))
        .route("/session/:id", axum::routing::get(get))
}

async fn create(
    State(state): State<crate::server::AppState>,
    Json(req): Json<SessionCreateRequest>,
) -> Result<Json<ExtendedSessionInfo>> {
    let session = Arc::clone(&state.session);
    let project_id = req.project_id;
    let id = req.id;
    let parent_id = req.parent_id;
    let metadata = req.metadata;
    let result = tokio::task::spawn_blocking(move || {
        session.create_session_with_id(&project_id, id, parent_id, metadata)
    })
    .await??;
    Ok(Json(result))
}

async fn get(
    State(state): State<crate::server::AppState>,
    Path(id): Path<String>,
) -> Result<Json<Option<ExtendedSessionInfo>>> {
    let session = Arc::clone(&state.session);
    let result = tokio::task::spawn_blocking(move || session.get_session(&id)).await??;
    Ok(Json(result))
}
