use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
};
use duo_types::{
    CoreMemoryEntry, CoreMemoryStoreRequest, CoreMemoryUpdateRequest, MemoryDeleteResponse,
    MemoryEntry, MemorySearchRequest, MemoryStatsV2, MemoryStoreRequest, MemoryStoreResponse,
    PatternQueryRequest, PatternQueryResult,
};
use serde::Deserialize;
use unified_error::Result;

pub fn router() -> Router<crate::server::AppState> {
    Router::new()
        // Existing endpoints
        .route("/memory/search", axum::routing::post(search))
        .route("/memory/store", axum::routing::post(store))
        .route("/memory/clear", axum::routing::delete(clear_all))
        .route(
            "/memory/layer/:layer",
            axum::routing::delete(delete_by_layer),
        )
        // Modified: DELETE + GET + PUT on /memory/:id
        .route("/memory/:id", axum::routing::get(get_memory))
        .route("/memory/:id", axum::routing::put(update_memory))
        .route("/memory/:id", axum::routing::delete(delete_by_id))
        // New: L4 Profile endpoints
        .route("/memory/profile", axum::routing::get(get_profile))
        .route("/memory/profile", axum::routing::post(store_profile))
        .route("/memory/profile/:id", axum::routing::put(update_profile))
        .route("/memory/profile/:id", axum::routing::delete(delete_profile))
        .route("/memory/stats/v2", axum::routing::get(stats_v2))
        // L5 Progressive tab. The UI (`memory-panel.tsx`) has always called
        // this endpoint; it was dropped during the P3-06 dead-code sweep, so
        // the tab 404'd and stayed permanently empty (P2-08).
        .route(
            "/memory/patterns/query",
            axum::routing::post(query_patterns),
        )
        // Storage management endpoints
        .route(
            "/memory/count-before/:days",
            axum::routing::get(count_before_days),
        )
        .route(
            "/memory/before/:days",
            axum::routing::delete(delete_before_days),
        )
}

// ─── Query parameter structs ───

#[derive(Debug, Deserialize)]
struct DeleteParams {
    #[serde(default)]
    force: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ProfileQueryParams {
    #[serde(default = "default_user_id")]
    user_id: String,
    project_id: Option<String>,
}

fn default_user_id() -> String {
    "default".to_string()
}

// ─── Existing handlers ───

async fn search(
    State(state): State<crate::server::AppState>,
    Json(req): Json<MemorySearchRequest>,
) -> Result<Json<Vec<MemoryEntry>>> {
    let memory = Arc::clone(&state.memory);
    let result = tokio::task::spawn_blocking(move || memory.search(&req)).await??;
    Ok(Json(result))
}

async fn store(
    State(state): State<crate::server::AppState>,
    Json(req): Json<MemoryStoreRequest>,
) -> Result<Json<MemoryStoreResponse>> {
    let memory = Arc::clone(&state.memory);
    let result = tokio::task::spawn_blocking(move || memory.store(&req)).await??;
    Ok(Json(result))
}

// ─── New: GET /memory/:id ───

async fn get_memory(
    State(state): State<crate::server::AppState>,
    Path(id): Path<String>,
) -> Result<Json<Option<MemoryEntry>>> {
    let memory = Arc::clone(&state.memory);
    let result = tokio::task::spawn_blocking(move || memory.get(&id)).await??;
    Ok(Json(result))
}

// ─── New: PUT /memory/:id ───

async fn update_memory(
    State(state): State<crate::server::AppState>,
    Path(id): Path<String>,
    Json(mut req): Json<MemoryStoreRequest>,
) -> Result<Json<MemoryStoreResponse>> {
    // Update the addressed entry. `store()` merges onto the existing row, so
    // unspecified fields, the original `created_at`, and the layer are
    // preserved; previously it minted a fresh UUID and appended a duplicate
    // (P0-03).
    let memory = Arc::clone(&state.memory);
    let result = tokio::task::spawn_blocking(move || {
        req.id = Some(id);
        memory.store(&req)
    })
    .await??;
    Ok(Json(result))
}

// ─── Modified: DELETE /memory/:id (now with ?force=true) ───

async fn delete_by_id(
    State(state): State<crate::server::AppState>,
    Path(id): Path<String>,
    Query(params): Query<DeleteParams>,
) -> Result<Json<MemoryDeleteResponse>> {
    let memory = Arc::clone(&state.memory);
    let force = params.force.unwrap_or(false);
    let found = tokio::task::spawn_blocking(move || memory.delete(&id, force)).await??;
    Ok(Json(MemoryDeleteResponse {
        deleted: if found { 1 } else { 0 },
        vacuumed: false,
    }))
}

// ─── Delete by layer / clear all (unchanged) ───

async fn delete_by_layer(
    State(state): State<crate::server::AppState>,
    Path(layer): Path<String>,
) -> Result<Json<MemoryDeleteResponse>> {
    let memory = Arc::clone(&state.memory);
    let affected = tokio::task::spawn_blocking(move || memory.delete_by_layer(&layer)).await??;
    Ok(Json(MemoryDeleteResponse {
        deleted: affected,
        vacuumed: false,
    }))
}

async fn clear_all(
    State(state): State<crate::server::AppState>,
) -> Result<Json<MemoryDeleteResponse>> {
    let memory = Arc::clone(&state.memory);
    let affected = tokio::task::spawn_blocking(move || {
        let count = memory.delete_all()?;
        memory.vacuum()?;
        Ok::<usize, anyhow::Error>(count)
    })
    .await??;
    Ok(Json(MemoryDeleteResponse {
        deleted: affected,
        vacuumed: true,
    }))
}

// ─── L5 Pattern endpoint ───

/// POST /memory/patterns/query — query user patterns (L5 progressive memory).
/// Body is the camelCase `PatternQueryRequest` (`userId` required); the result
/// is `{ patterns, total }`, matching what the panel renders.
async fn query_patterns(
    State(state): State<crate::server::AppState>,
    Json(req): Json<PatternQueryRequest>,
) -> Result<Json<PatternQueryResult>> {
    let memory = Arc::clone(&state.memory);
    let result = tokio::task::spawn_blocking(move || memory.query_patterns(&req)).await??;
    Ok(Json(result))
}

// ─── L4 Profile endpoints ───

/// GET /memory/profile?user_id=default&project_id=...
async fn get_profile(
    State(state): State<crate::server::AppState>,
    Query(params): Query<ProfileQueryParams>,
) -> Result<Json<Vec<CoreMemoryEntry>>> {
    let memory = Arc::clone(&state.memory);
    let user_id = params.user_id;
    let project_id = params.project_id;
    let result = tokio::task::spawn_blocking(move || {
        memory.get_core_memories(&user_id, project_id.as_deref())
    })
    .await??;
    Ok(Json(result))
}

/// POST /memory/profile
async fn store_profile(
    State(state): State<crate::server::AppState>,
    Json(req): Json<CoreMemoryStoreRequest>,
) -> Result<Json<CoreMemoryEntry>> {
    let memory = Arc::clone(&state.memory);
    let result = tokio::task::spawn_blocking(move || memory.store_core_memory(&req)).await??;
    Ok(Json(result))
}

/// PUT /memory/profile/:id — the path id is authoritative: it overrides any
/// `id` in the body so the URL always identifies the resource being updated.
/// Previously the path id was discarded (`Path(_id)`), letting the body target
/// an arbitrary entry.
async fn update_profile(
    State(state): State<crate::server::AppState>,
    Path(id): Path<String>,
    Json(mut req): Json<CoreMemoryUpdateRequest>,
) -> Result<Json<CoreMemoryEntry>> {
    req.id = id;
    let memory = Arc::clone(&state.memory);
    let result = tokio::task::spawn_blocking(move || memory.update_core_memory(&req)).await??;
    Ok(Json(result))
}

/// DELETE /memory/profile/:id?force=true
async fn delete_profile(
    State(state): State<crate::server::AppState>,
    Path(id): Path<String>,
    Query(params): Query<DeleteParams>,
) -> Result<Json<MemoryDeleteResponse>> {
    let memory = Arc::clone(&state.memory);
    let force = params.force.unwrap_or(false);
    let found =
        tokio::task::spawn_blocking(move || memory.delete_core_memory(&id, force)).await??;
    Ok(Json(MemoryDeleteResponse {
        deleted: if found { 1 } else { 0 },
        vacuumed: false,
    }))
}

// ─── C7: Advanced memory system endpoints ───

/// GET /memory/stats/v2 — Enhanced memory statistics
async fn stats_v2(State(state): State<crate::server::AppState>) -> Result<Json<MemoryStatsV2>> {
    let memory = Arc::clone(&state.memory);
    let result = tokio::task::spawn_blocking(move || memory.stats_v2()).await??;
    Ok(Json(result))
}

// ─── Storage management endpoints ─────────────────────────────────────

/// GET /memory/count-before/:days — Count non-pinned memories older than N days
async fn count_before_days(
    State(state): State<crate::server::AppState>,
    Path(days): Path<u32>,
) -> Result<Json<serde_json::Value>> {
    let memory = Arc::clone(&state.memory);
    let count = tokio::task::spawn_blocking(move || memory.count_before_days(days)).await??;
    Ok(Json(serde_json::json!({ "count": count, "days": days })))
}

/// DELETE /memory/before/:days — Delete non-pinned memories older than N days
async fn delete_before_days(
    State(state): State<crate::server::AppState>,
    Path(days): Path<u32>,
) -> Result<Json<MemoryDeleteResponse>> {
    let memory = Arc::clone(&state.memory);
    let affected = tokio::task::spawn_blocking(move || {
        let count = memory.delete_before_days(days)?;
        memory.vacuum()?;
        Ok::<usize, anyhow::Error>(count)
    })
    .await??;
    Ok(Json(MemoryDeleteResponse {
        deleted: affected,
        vacuumed: true,
    }))
}
