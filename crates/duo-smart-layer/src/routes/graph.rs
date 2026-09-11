//! Graph routes — query + write + project indexing endpoints.

use std::sync::Arc;

use axum::{Json, Router, extract::State};
use duo_types::{GraphIndexRequest, GraphIndexResponse, GraphQueryRequest, GraphQueryResponse};
use knowledge_graph_store::{IndexStatus, project_key};
use unified_error::UnifiedError;

use crate::error::{Result, bad_request};

/// Derive the graph's project identity from a project directory.
///
/// This is the ONLY place the HTTP layer turns a path into a project key.
/// Every endpoint takes a *directory* and calls this, so the key used to
/// index can never disagree with the key used to query, retry or clear —
/// which is exactly how the graph used to silently return zero nodes.
fn kg_key(project_path: &str) -> String {
    project_key(std::path::Path::new(project_path))
}

/// `project_path` is mandatory for graph writes: without it the file's
/// entities would be filed under a key no query could ever reproduce.
fn required_project_path(project_path: Option<&str>) -> Result<String> {
    match project_path.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => Ok(p.to_string()),
        None => Err(bad_request(anyhow::anyhow!(
            "missing required field: projectPath"
        ))),
    }
}

pub fn router() -> Router<crate::server::AppState> {
    Router::new()
        // Query endpoints (existing)
        .route("/graph/query", axum::routing::post(query))
        // Project indexing endpoints (new: passive mechanism — auto-build graph from source)
        .route(
            "/graph/index-project-async",
            axum::routing::post(index_project_async),
        )
        .route("/graph/index-status", axum::routing::get(index_status))
        .route("/graph/force-reindex", axum::routing::post(force_reindex))
        .route(
            "/graph/force-reindex-async",
            axum::routing::post(force_reindex_async),
        )
        .route("/graph/update-file", axum::routing::post(update_file))
        .route("/graph/remove-file", axum::routing::post(remove_file))
        // Stats endpoint
        .route(
            "/graph/stats-detail",
            axum::routing::get(graph_stats_detail),
        )
        .route("/graph/recent-files", axum::routing::get(get_recent_files))
        // Neighbors with edges (returns both nodes and edges as JSON)
        .route(
            "/graph/neighbors-with-edges",
            axum::routing::post(neighbors_with_edges),
        )
        // Cancel in-progress background indexing
        .route("/graph/cancel-index", axum::routing::post(cancel_index))
        // Delete project cache (in-memory graph data)
        .route(
            "/graph/project-cache",
            axum::routing::delete(delete_project_cache),
        )
        // Clear in-memory graph data only (preserve bincode cache on disk)
        .route(
            "/graph/clear-memory",
            axum::routing::post(clear_project_memory),
        )
        .route("/graph/failed-files", axum::routing::get(get_failed_files))
        .route("/graph/retry-file", axum::routing::post(retry_file))
        // Per-project status (required `?project_id`)
        .route(
            "/graph/index-status-all",
            axum::routing::get(index_status_all),
        )
        // Close a project: clear=true wipes its index, false marks it closed
        // (retention sweep removes it later).
        .route(
            "/graph/close-project-index",
            axum::routing::post(close_project_index),
        )
        // Settings: list of all indexed projects + retention days.
        .route(
            "/graph/index-registry",
            axum::routing::get(index_registry),
        )
        // Settings: set retention window (days).
        .route(
            "/graph/index-retention",
            axum::routing::put(set_retention),
        )
        // Settings: clear every project's index.
        .route(
            "/graph/clear-all-indexes",
            axum::routing::post(clear_all_indexes),
        )
}

// ─── Query endpoints ──────────────────────────────────────────────────────

async fn query(
    State(state): State<crate::server::AppState>,
    Json(req): Json<GraphQueryRequest>,
) -> Result<Json<GraphQueryResponse>> {
    let graph = Arc::clone(&state.graph);
    // Resolve the project filter once, from the path, before moving into the
    // blocking closure.
    let project_id = req.project_path.as_deref().map(kg_key);
    let result =
        tokio::task::spawn_blocking(move || match req.query_type.as_str() {
            "shortest_path" => {
                let from_id = req.from_id.as_deref().ok_or_else(|| {
                    bad_request(anyhow::anyhow!("missing required field: from_id"))
                })?;
                let to_id = req
                    .to_id
                    .as_deref()
                    .ok_or_else(|| bad_request(anyhow::anyhow!("missing required field: to_id")))?;
                knowledge_graph_store::query::shortest_path_project(
                    &graph,
                    from_id,
                    to_id,
                    project_id.as_deref(),
                )
                .map(GraphQueryResponse::Path)
                .map_err(UnifiedError::from)
            }
            "subgraph" => {
                let center_id = req.center_id.as_deref().ok_or_else(|| {
                    bad_request(anyhow::anyhow!("missing required field: center_id"))
                })?;
                let hops = req.hops.unwrap_or(1);
                knowledge_graph_store::query::subgraph_project(
                    &graph,
                    center_id,
                    hops,
                    project_id.as_deref(),
                )
                .map(GraphQueryResponse::Nodes)
                .map_err(UnifiedError::from)
            }
            "neighbors" => {
                let node_id = req.node_id.as_deref().ok_or_else(|| {
                    bad_request(anyhow::anyhow!("missing required field: node_id"))
                })?;
                graph
                    .get_neighbors_project(node_id, project_id.as_deref())
                    .map(|pairs| {
                        GraphQueryResponse::Nodes(pairs.into_iter().map(|(n, _e)| n).collect())
                    })
                    .map_err(UnifiedError::from)
            }
            "nodes_by_type" => {
                let node_type = req.node_type.as_deref().ok_or_else(|| {
                    bad_request(anyhow::anyhow!("missing required field: node_type"))
                })?;
                graph
                    .find_nodes_by_type_project(node_type, project_id.as_deref())
                    .map(GraphQueryResponse::Nodes)
                    .map_err(UnifiedError::from)
            }
            "search" => {
                let search_query = req.search_query.as_deref().ok_or_else(|| {
                    bad_request(anyhow::anyhow!("missing required field: searchQuery"))
                })?;
                let limit = req.limit.unwrap_or(20);
                graph
                    .search_nodes(
                        search_query,
                        req.node_type.as_deref(),
                        project_id.as_deref(),
                        limit,
                    )
                    .map(GraphQueryResponse::Nodes)
                    .map_err(UnifiedError::from)
            }
            other => Err(bad_request(anyhow::anyhow!("unknown query_type: {other}"))),
        })
        .await??;
    Ok(Json(result))
}

// ─── Write endpoints ──────────────────────────────────────────────────────

///
/// Returns immediately with a `task_id` and the current `IndexStatus`.
/// Clients should poll `/graph/index-status` to track progress.
async fn index_project_async(
    State(state): State<crate::server::AppState>,
    Json(req): Json<GraphIndexRequest>,
) -> Result<Json<serde_json::Value>> {
    let indexer = state.indexer.get()?;
    let path = req.project_path.clone();
    let project_id = kg_key(&path);
    tracing::info!("[kg-diag] index_project_async ENTER: project_path={path}, project_id={project_id}");

    // A delete (close_project_index with clear=true) leaves a tombstone, which
    // both blocks snapshot saves and cancels any run still in flight. Reaching
    // this point means the user re-opened the project and genuinely wants a new
    // index, so the tombstone must be lifted.
    //
    // Order matters: cancel first, then lift. A pre-delete indexing pass may
    // still be unwinding, and lifting the tombstone while it runs would hand it
    // back a green light to finish and save the very snapshot the delete
    // removed. `cancel_index` sets the per-project cancel flag (which outlives
    // the tombstone) so that run is guaranteed to bail, and the fresh index
    // started below resets the flag for itself.
    if indexer.is_tombstoned(&project_id) {
        tracing::info!("[kg-diag] index_project_async: tombstone FOUND, clearing it");
        indexer.cancel_index(&project_id);
        indexer.clear_tombstone(&project_id);
    }

    if req.root_filter.is_some() {
        let result = indexer
            .index_project_filtered(&path, &project_id, req.root_filter.as_deref())
            .await
            .map_err(UnifiedError::from)?;
        return Ok(Json(serde_json::json!({
            "task_id": "filtered",
            "status": IndexStatus::Ready,
            "result": {
                "files_indexed": result.0,
                "entities_created": result.1,
                "edges_created": result.2,
            }
        })));
    }

    // Mirror `index_project`: run the (potentially heavy) snapshot load on a
    // blocking thread so it doesn't occupy an async worker and starve the
    // runtime — that previously froze the whole app during large-project
    // loads (e.g. 1700+ source files traversed + hashed + graph rebuilt
    // synchronously inside the request handler).
    let indexer_for_load = Arc::clone(&indexer);
    let project_id_for_load = project_id.clone();
    let path_for_load = path.clone();
    let loaded = tokio::task::spawn_blocking(move || {
        indexer_for_load
            .load_fresh_bincode_snapshot(&path_for_load, &project_id_for_load)
            .map_err(UnifiedError::from)
    })
    .await??;

    // Non-blocking: if no snapshot was loaded, kick off background indexing and
    // return immediately so the HTTP handler never blocks on a full index.
    //
    // Use the status returned by `start_background_index` verbatim. Re-reading
    // it from the indexer state was the root cause of projects silently not
    // re-indexing: a stale `Ready` left over from before the index was cleared
    // (deleting an index does not necessarily clear its in-memory state, and a
    // just-spawned task may not have written its own status yet) made callers
    // believe indexing was already done, so they never tracked progress.
    let status = if loaded {
        // A fresh snapshot was loaded; `load_fresh_bincode_snapshot` set the
        // terminal status itself, so reading it back is authoritative.
        let s = indexer.get_index_status(&project_id);
        tracing::info!(project_id = %project_id, loaded = true, status = ?s, "[kg-diag] index_project_async: snapshot loaded -> returning (likely Ready)");
        s
    } else {
        tracing::info!(project_id = %project_id, loaded = false, "[kg-diag] index_project_async: no snapshot -> start_background_index (Indexing)");
        Arc::clone(&indexer).start_background_index(path, project_id.clone())
    };

    Ok(Json(serde_json::json!({
        "task_id": "default",
        "status": status,
    })))
}

/// Query the current background indexing status for a given project.
async fn index_status(
    State(state): State<crate::server::AppState>,
    axum::extract::Query(params): axum::extract::Query<ProjectPathParam>,
) -> Result<Json<IndexStatus>> {
    let indexer = state.indexer.get()?;
    let status = indexer.get_index_status(&kg_key(&params.project_path));
    Ok(Json(status))
}

/// Query the indexing status of every known project (settings tab / debugging).
async fn index_status_all(
    State(state): State<crate::server::AppState>,
) -> Result<Json<serde_json::Value>> {
    let indexer = state.indexer.get()?;
    Ok(Json(indexer.get_all_statuses()))
}

async fn force_reindex(
    State(state): State<crate::server::AppState>,
    Json(req): Json<GraphIndexRequest>,
) -> Result<Json<GraphIndexResponse>> {
    let indexer = state.indexer.get()?;
    let path = req.project_path.clone();
    let project_id = kg_key(&path);

    // Non-blocking: kick off a background force-reindex and return immediately.
    let _status: IndexStatus = indexer.start_background_force_reindex(path, project_id);

    Ok(Json(GraphIndexResponse {
        project_path: req.project_path,
        files_indexed: 0,
        entities_created: 0,
        edges_created: 0,
    }))
}

/// Start a background force-reindex.
///
/// Returns immediately with the current `IndexStatus`.
/// Clients should poll `/graph/index-status` to track progress.
async fn force_reindex_async(
    State(state): State<crate::server::AppState>,
    Json(req): Json<GraphIndexRequest>,
) -> Result<Json<serde_json::Value>> {
    let indexer = state.indexer.get()?;
    let path = req.project_path.clone();
    let project_id = kg_key(&path);

    let status: IndexStatus = indexer.start_background_force_reindex(path, project_id);

    Ok(Json(serde_json::json!({
        "task_id": "force-reindex",
        "status": status,
    })))
}

async fn update_file(
    State(state): State<crate::server::AppState>,
    Json(req): Json<duo_types::IndexFileRequest>,
) -> Result<Json<duo_types::IndexFileResponse>> {
    let indexer = state.indexer.get()?;
    let path_for_closure = req.path.clone();
    let path_for_response = req.path.clone();
    let content = req.content.clone();
    let project_path = required_project_path(req.project_path.as_deref())?;
    let project_id = kg_key(&project_path);

    tokio::task::spawn_blocking(move || {
        indexer
            .update_file_with_snapshot(
                &path_for_closure,
                &content,
                &project_id,
                Some(project_path.as_str()),
            )
            .map_err(UnifiedError::from)
    })
    .await??;

    Ok(Json(duo_types::IndexFileResponse {
        indexed: true,
        path: path_for_response,
    }))
}

async fn remove_file(
    State(state): State<crate::server::AppState>,
    Json(req): Json<duo_types::IndexFileRequest>,
) -> Result<Json<duo_types::IndexFileResponse>> {
    let indexer = state.indexer.get()?;
    let path_for_closure = req.path.clone();
    let path_for_response = req.path.clone();
    let project_path = required_project_path(req.project_path.as_deref())?;
    let project_id = kg_key(&project_path);

    tokio::task::spawn_blocking(move || {
        indexer
            .remove_file_with_snapshot(
                &path_for_closure,
                &project_id,
                Some(project_path.as_str()),
            )
            .map_err(UnifiedError::from)
    })
    .await??;

    Ok(Json(duo_types::IndexFileResponse {
        indexed: false,
        path: path_for_response,
    }))
}

// ─── Neighbors with edges ────────────────────────────────────────────────

/// Return both neighbor nodes and the connecting edges as a JSON object.
///
/// Unlike the `neighbors` query_type (which returns only nodes), this handler
/// returns `{ "nodes": [...], "edges": [...] }` so the caller can reconstruct
/// the subgraph without a separate edges query.
async fn neighbors_with_edges(
    State(state): State<crate::server::AppState>,
    Json(req): Json<GraphQueryRequest>,
) -> Result<Json<serde_json::Value>> {
    let node_id = req
        .node_id
        .as_deref()
        .ok_or_else(|| bad_request(anyhow::anyhow!("missing required field: node_id")))?
        .to_string();
    let graph = Arc::clone(&state.graph);
    let project_id = req.project_path.as_deref().map(kg_key);

    let result = tokio::task::spawn_blocking(move || {
        graph
            .get_neighbors_project(&node_id, project_id.as_deref())
            .map(|pairs| {
                let nodes: Vec<serde_json::Value> = pairs
                    .iter()
                    .map(|(n, _)| {
                        serde_json::json!({
                            "id": n.id,
                            "type": n.node_type,
                            "label": n.label,
                            // Include node properties: the TS consumer
                            // (`smart-layer/contract.ts`) reads
                            // `n.properties?.["file"]` to map related symbols
                            // to files. Omitting it made cross-file related
                            // detection silently return nothing.
                            "properties": n.properties,
                        })
                    })
                    .collect();
                let edges: Vec<serde_json::Value> = pairs
                    .iter()
                    .map(|(_, e)| {
                        serde_json::json!({
                            "id": e.id,
                            "source": e.source_id,
                            "target": e.target_id,
                            "relation": e.relation,
                        })
                    })
                    .collect();
                serde_json::json!({ "nodes": nodes, "edges": edges })
            })
            .map_err(UnifiedError::from)
    })
    .await??;

    Ok(Json(result))
}

// ─── Cancel index ────────────────────────────────────────────────────────

/// Cancel any in-progress background indexing job for a given project.
async fn cancel_index(
    State(state): State<crate::server::AppState>,
    Json(params): Json<ProjectPathParam>,
) -> Result<Json<serde_json::Value>> {
    state.indexer.get()?.cancel_index(&kg_key(&params.project_path));
    Ok(Json(serde_json::json!({ "cancelled": true })))
}

// ─── Delete project cache ───────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct ProjectCacheParams {
    project_path: String,
}

/// Shared `{ project_path }` payload, used by status / cancel / failed-files
/// routes (both as query params and JSON bodies). The project key is derived
/// from the path, never supplied by the caller.
#[derive(serde::Deserialize)]
struct ProjectPathParam {
    project_path: String,
}

/// Clear in-memory graph data and bincode cache for a project.
///
/// Removes all nodes and edges matching `project_id` from the in-memory graph.
/// Global entities (project_id = "") are not removed.
async fn delete_project_cache(
    State(state): State<crate::server::AppState>,
    axum::extract::Query(params): axum::extract::Query<ProjectCacheParams>,
) -> Result<Json<serde_json::Value>> {
    let project_id = kg_key(&params.project_path);
    let graph = Arc::clone(&state.graph);
    let indexer = state.indexer.get()?;

    let moved_id = project_id.clone();
    tokio::task::spawn_blocking(move || {
        graph
            .clear_project_memory(&moved_id)
            .map_err(UnifiedError::from)?;
        indexer
            .delete_project_index(&moved_id)
            .map_err(UnifiedError::from)
    })
    .await??;

    Ok(Json(serde_json::json!({
        "deleted": true,
        "project_id": project_id,
    })))
}

/// Clear in-memory graph data only (preserve bincode cache on disk).
///
/// Used when a project is closed/switched to free memory while keeping
/// the bincode snapshot available for fast incremental reload on next open.
async fn clear_project_memory(
    State(state): State<crate::server::AppState>,
    Json(params): Json<ProjectCacheParams>,
) -> Result<Json<serde_json::Value>> {
    let project_id = kg_key(&params.project_path);
    let graph = Arc::clone(&state.graph);

    let moved_id = project_id.clone();
    tokio::task::spawn_blocking(move || {
        graph
            .clear_project_memory(&moved_id)
            .map_err(UnifiedError::from)
    })
    .await??;

    Ok(Json(serde_json::json!({
        "cleared": true,
        "project_id": project_id,
    })))
}

// ─── Stats endpoint ───────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct StatsQueryParams {
    project_path: Option<String>,
}

// ─── Detail stats endpoint ──────────────────────────────────────────────────

async fn graph_stats_detail(
    State(state): State<crate::server::AppState>,
    axum::extract::Query(params): axum::extract::Query<StatsQueryParams>,
) -> Result<Json<serde_json::Value>> {
    let graph = Arc::clone(&state.graph);
    let persistence = Arc::clone(&state.graph_persistence);
    let project_id = params.project_path.as_deref().map(kg_key);

    let stats = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let node_count = graph.node_count_project(project_id.as_deref())?;
        let edge_count = graph.edge_count_project(project_id.as_deref())?;
        let file_count = graph.file_count_project(project_id.as_deref())?;
        let node_type_dist = graph.node_type_distribution(project_id.as_deref())?;
        let relation_type_dist = graph.relation_type_distribution(project_id.as_deref())?;
        Ok(serde_json::json!({
            "nodeCount": node_count,
            "edgeCount": edge_count,
            "indexedFileCount": file_count,
            "persistent": persistence.is_persistent(),
            "nodeTypeDistribution": node_type_dist,
            "relationTypeDistribution": relation_type_dist,
        }))
    })
    .await?
    .map_err(crate::error::bad_request)?;

    Ok(Json(stats))
}

// ─── Recent files endpoint ─────────────────────────────────────────────────

async fn get_recent_files(
    State(state): State<crate::server::AppState>,
    axum::extract::Query(params): axum::extract::Query<StatsQueryParams>,
) -> Result<Json<serde_json::Value>> {
    let graph = Arc::clone(&state.graph);
    let project_id = params.project_path.as_deref().map(kg_key);

    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let files = graph.recent_files(project_id.as_deref(), 20)?;
        let file_entries: Vec<serde_json::Value> = files
            .iter()
            .map(|node| {
                let path = node.label.clone();
                // Count neighbor entities (non-File nodes connected to this file)
                let entity_count = graph
                    .get_neighbors_project(&node.id, project_id.as_deref())
                    .map(|pairs| pairs.iter().filter(|(n, _)| n.node_type != "File").count())
                    .unwrap_or(0);
                let indexed_at = node
                    .properties
                    .as_ref()
                    .and_then(|p| p.get("indexed_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                serde_json::json!({
                    "path": path,
                    "entityCount": entity_count,
                    "indexedAt": indexed_at,
                })
            })
            .collect();
        Ok(serde_json::json!({ "files": file_entries }))
    })
    .await?
    .map_err(crate::error::bad_request)?;

    Ok(Json(result))
}

// ─── Failed files endpoint ────────────────────────────────────────────────

async fn get_failed_files(
    State(state): State<crate::server::AppState>,
    axum::extract::Query(params): axum::extract::Query<ProjectPathParam>,
) -> Result<Json<serde_json::Value>> {
    let indexer = state.indexer.get()?;
    let files = indexer.get_failed_files(&kg_key(&params.project_path));
    Ok(Json(serde_json::json!({ "files": files })))
}

async fn retry_file(
    State(state): State<crate::server::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    // Owned: the closure below runs on a blocking thread and must not borrow
    // from `req`.
    let path = req
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let project_path = required_project_path(
        req.get("projectPath").and_then(|v| v.as_str()),
    )?;
    let project_id = kg_key(&project_path);

    let indexer = state.indexer.get()?;
    // P2-06: `retry_file` ends in `save_project_snapshot` — the heaviest path
    // in the indexer (full tree walk + hashing). Running it inline blocked the
    // async runtime for the duration; every other file endpoint uses
    // `spawn_blocking`, so this one does too.
    let result = tokio::task::spawn_blocking(move || {
        indexer.retry_file(&project_path, &project_id, &path)
    })
    .await
    .unwrap_or_else(|e| Err(format!("retry_file task failed: {e}")));

    match result {
        Ok(()) => Ok(Json(serde_json::json!({ "ok": true }))),
        Err(e) => Ok(Json(serde_json::json!({ "ok": false, "error": e }))),
    }
}

// ─── Registry / retention / close endpoints ──────────────────────────────────

#[derive(serde::Deserialize)]
struct CloseProjectIndexParams {
    project_path: String,
    /// `true` wipes the index immediately; `false` marks it closed so the
    /// retention sweep removes it after the configured window.
    clear: bool,
}

#[derive(serde::Deserialize)]
struct SetRetentionParams {
    days: u32,
}

/// Close a project: clear its index or mark it closed (retention-managed).
async fn close_project_index(
    State(state): State<crate::server::AppState>,
    Json(params): Json<CloseProjectIndexParams>,
) -> Result<Json<serde_json::Value>> {
    let indexer = state.indexer.get()?;
    let project_id = kg_key(&params.project_path);
    tracing::info!("[kg-diag] close_project_index: project_id={project_id}, clear={}", params.clear);
    indexer
        .close_project_index(&project_id, params.clear)
        .map_err(UnifiedError::from)?;
    Ok(Json(serde_json::json!({ "closed": true, "project_id": project_id })))
}

/// Return the index registry (retention days + per-project metadata).
async fn index_registry(
    State(state): State<crate::server::AppState>,
) -> Result<Json<serde_json::Value>> {
    let indexer = state.indexer.get()?;
    Ok(Json(indexer.registry_info()))
}

/// Set the retention window (days) for closed projects.
async fn set_retention(
    State(state): State<crate::server::AppState>,
    Json(params): Json<SetRetentionParams>,
) -> Result<Json<serde_json::Value>> {
    let indexer = state.indexer.get()?;
    indexer
        .set_retention_days(params.days)
        .map_err(UnifiedError::from)?;
    Ok(Json(serde_json::json!({ "retention_days": params.days })))
}

/// Clear every project's index (settings "clear all").
async fn clear_all_indexes(
    State(state): State<crate::server::AppState>,
) -> Result<Json<serde_json::Value>> {
    let indexer = state.indexer.get()?;
    match indexer.clear_all_indexes() {
        Ok(()) => Ok(Json(serde_json::json!({ "cleared": true }))),
        Err(e) => Ok(Json(serde_json::json!({ "cleared": false, "error": e.to_string() }))),
    }
}
