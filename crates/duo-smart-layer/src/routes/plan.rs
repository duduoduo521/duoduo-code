//! Plan routes — pre-generated modification plan storage, retrieval, matching,
//! and feedback counting.
//!
//! Plans are stored as L3 pinned memories (`layer=3, memory_type='modification_plan',
//! pin=true, tags=["plan"]`). Per-file AST/KG snapshots are persisted in the
//! `plan_file_fingerprints` auxiliary table for drift detection.

use std::sync::Arc;

use axum::{Json, Router, extract::State};
use duo_types::{MemoryEntry, MemorySearchRequest, MemoryStoreRequest};
use serde::{Deserialize, Serialize};
use unified_error::Result;

use crate::error::{bad_request, not_found};

pub fn router() -> Router<crate::server::AppState> {
    Router::new()
        .route("/plan/save", axum::routing::post(save))
        .route("/plan/search", axum::routing::post(search))
        .route("/plan/match", axum::routing::post(r#match))
        .route("/plan/update", axum::routing::post(update))
}

// ─── Request / Response types ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanSaveRequest {
    intent: String,
    #[serde(default)]
    intent_tokens: Vec<String>,
    #[serde(default)]
    intent_kg_entities: Vec<String>,
    reasoning_summary: String,
    ast_operations: serde_json::Value,
    affected_kg_subgraph: serde_json::Value,
    #[serde(default)]
    risks: Vec<String>,
    project_path: String,
    #[serde(default)]
    file_fingerprints: Vec<FileFingerprint>,
    originating_session: String,
    originating_prompt: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileFingerprint {
    file_path: String,
    base_ast_hash: String,
    base_kg_subgraph: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanSaveResponse {
    plan_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanSearchRequest {
    query: String,
    project_path: String,
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanSearchResponse {
    candidates: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanMatchRequest {
    plan_id: String,
    current_files: Vec<FileHash>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileHash {
    path: String,
    ast_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanMatchResponse {
    match_level: String,
    adjusted_plan: Option<serde_json::Value>,
    mismatch_details: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanUpdateRequest {
    plan_id: String,
    /// One of "success_count" | "failed_count" | "rejected_count"
    field: String,
    increment: i32,
}

// ─── Handlers ──────────────────────────────────────────────────────────────

/// POST /plan/save
///
/// Stores a modification plan as a pinned L3 memory and persists per-file
/// fingerprints (AST hash + KG subgraph) to `plan_file_fingerprints`.
async fn save(
    State(state): State<crate::server::AppState>,
    Json(req): Json<PlanSaveRequest>,
) -> Result<Json<PlanSaveResponse>> {
    let memory = Arc::clone(&state.memory);

    // Build plan content JSON (with date for FTS5/semantic search)
    let content = serde_json::json!({
        "date": chrono::Utc::now().format("%Y-%m-%d").to_string(),
        "intent": req.intent,
        "intent_tokens": req.intent_tokens,
        "intent_kg_entities": req.intent_kg_entities,
        "reasoning_summary": req.reasoning_summary,
        "ast_operations": req.ast_operations,
        "affected_kg_subgraph": req.affected_kg_subgraph,
        "risks": req.risks,
        "originating_session": req.originating_session,
        "originating_prompt": req.originating_prompt,
    });
    let content_str = serde_json::to_string(&content)
        .map_err(|e| bad_request(anyhow::anyhow!("Failed to serialize plan content: {e}")))?;

    // Prepare fingerprint tuples for the auxiliary table
    let fingerprints: Vec<(String, String, String)> = req
        .file_fingerprints
        .iter()
        .map(|fp| {
            let kg_json =
                serde_json::to_string(&fp.base_kg_subgraph).unwrap_or_else(|_| "{}".into());
            (fp.file_path.clone(), fp.base_ast_hash.clone(), kg_json)
        })
        .collect();

    // Store the plan as a memory entry
    let store_req = MemoryStoreRequest {
        id: None,
        content: content_str,
        summary: None,
        layer: "3".to_string(),
        importance: Some(0.9),
        pin: Some(true),
        session_id: Some(req.originating_session.clone()),
        memory_type: Some("modification_plan".to_string()),
        metadata: Some(serde_json::json!({
            "success_count": 0,
            "failed_count": 0,
            "rejected_count": 0,
        })),
        tags: Some(vec!["plan".to_string()]),
        project_path: Some(req.project_path.clone()),
        user_id: None,
    };

    let plan_id = tokio::task::spawn_blocking(move || {
        let resp = memory.store(&store_req)?;
        if !resp.stored {
            anyhow::bail!("Failed to store plan: memory not persisted");
        }
        // Save file fingerprints
        if !fingerprints.is_empty() {
            memory.insert_plan_fingerprints(&resp.id, &fingerprints)?;
        }
        Ok::<String, anyhow::Error>(resp.id)
    })
    .await
    .map_err(|e| bad_request(anyhow::anyhow!("Task join error: {e}")))??;

    Ok(Json(PlanSaveResponse { plan_id }))
}

/// POST /plan/search
///
/// FTS5 search for modification plans. Filters by `tags=["plan"]` and
/// `layer=3` (permanent), scoped to the given project_path.
async fn search(
    State(state): State<crate::server::AppState>,
    Json(req): Json<PlanSearchRequest>,
) -> Result<Json<PlanSearchResponse>> {
    let memory = Arc::clone(&state.memory);
    let limit = req.limit.unwrap_or(10);

    let search_req = MemorySearchRequest {
        query: req.query.clone(),
        limit,
        layers: Some(vec!["permanent".to_string()]),
        tags: Some(vec!["plan".to_string()]),
        project_path: if req.project_path.is_empty() {
            None
        } else {
            Some(req.project_path.clone())
        },
    };

    let entries: Vec<MemoryEntry> =
        tokio::task::spawn_blocking(move || memory.search(&search_req)).await??;

    let candidates = entries
        .into_iter()
        .map(|entry| {
            serde_json::json!({
                "plan_id": entry.id,
                "content": entry.content,
                "score": entry.score,
                "created_at": entry.created_at,
                "tags": entry.tags,
                "metadata": entry.metadata,
                "project_path": entry.project_path,
                "memory_type": entry.memory_type,
                "importance": entry.importance,
            })
        })
        .collect();

    Ok(Json(PlanSearchResponse { candidates }))
}

/// POST /plan/match
///
/// Compares the current file AST hashes against the plan's stored fingerprints
/// and produces a match-level verdict:
///
/// - **L0**: Exact match — all file hashes are identical to the plan baseline.
/// - **L1**: Minor drift — some files changed but the plan's affected files
///   are still intact. Plan can be applied as-is.
/// - **L2**: Partial mismatch — one or more affected files have drifted.
///   Plan needs adjustment.
/// - **L3**: Severe mismatch — the base state has fundamentally changed.
///   Plan should be rejected or regenerated.
async fn r#match(
    State(state): State<crate::server::AppState>,
    Json(req): Json<PlanMatchRequest>,
) -> Result<Json<PlanMatchResponse>> {
    let memory = Arc::clone(&state.memory);
    let plan_id = req.plan_id.clone();
    let current_files = req.current_files.clone();

    let (match_level, mismatch_details) = tokio::task::spawn_blocking(move || {
        // Retrieve the plan's stored fingerprints
        let fingerprints = memory.get_plan_fingerprints(&plan_id)?;

        if fingerprints.is_empty() {
            // No fingerprints stored — cannot verify, return L3
            return Ok::<_, anyhow::Error>((
                "L3".to_string(),
                vec!["No file fingerprints found for this plan".to_string()],
            ));
        }

        // Build a lookup of current file hashes
        let current_map: std::collections::HashMap<&str, &str> = current_files
            .iter()
            .map(|fh| (fh.path.as_str(), fh.ast_hash.as_str()))
            .collect();

        let mut mismatch_details: Vec<String> = Vec::new();
        let mut exact_match_count = 0;
        let mut total_fingerprints = 0;

        for (file_path, base_ast_hash, _base_kg_subgraph) in &fingerprints {
            total_fingerprints += 1;
            match current_map.get(file_path.as_str()) {
                Some(current_hash) => {
                    if *current_hash == base_ast_hash.as_str() {
                        exact_match_count += 1;
                    } else {
                        mismatch_details.push(format!(
                            "AST hash mismatch for {file_path}: expected {base_ast_hash}, got {current_hash}"
                        ));
                    }
                }
                None => {
                    mismatch_details.push(format!(
                        "File not found in current workspace: {file_path}"
                    ));
                }
            }
        }

        // Also check if current_files contains files NOT in the plan fingerprints
        let plan_file_set: std::collections::HashSet<&str> = fingerprints
            .iter()
            .map(|(fp, _, _)| fp.as_str())
            .collect();
        for fh in &current_files {
            if !plan_file_set.contains(fh.path.as_str()) {
                // Extra file — not necessarily a problem, but note it
                tracing::debug!(
                    "File {} present in workspace but not in plan fingerprints",
                    fh.path
                );
            }
        }

        let match_level = if mismatch_details.is_empty() {
            // All files match exactly
            "L0".to_string()
        } else if exact_match_count == total_fingerprints {
            // All fingerprinted files match, but some had mismatches
            // This shouldn't happen (contradiction), but handle gracefully
            "L0".to_string()
        } else {
            let mismatch_ratio = mismatch_details.len() as f64 / total_fingerprints as f64;
            if mismatch_ratio <= 0.3 {
                "L1".to_string()
            } else if mismatch_ratio <= 0.6 {
                "L2".to_string()
            } else {
                "L3".to_string()
            }
        };

        Ok((match_level, mismatch_details))
    })
    .await
    .map_err(|e| bad_request(anyhow::anyhow!("Task join error: {e}")))??;

    // For L2/L3, include the plan content as a basis for adjustment
    let adjusted_plan = if match_level == "L2" || match_level == "L3" {
        let memory2 = Arc::clone(&state.memory);
        let plan_id2 = req.plan_id.clone();
        let plan_entry = tokio::task::spawn_blocking(move || memory2.get(&plan_id2)).await??;
        match plan_entry {
            Some(entry) => {
                let content: serde_json::Value = serde_json::from_str(&entry.content)
                    .unwrap_or(serde_json::json!({"raw": entry.content}));
                Some(serde_json::json!({
                    "plan_id": req.plan_id,
                    "content": content,
                    "mismatches": mismatch_details,
                    "original_metadata": entry.metadata,
                }))
            }
            None => {
                return Err(not_found(anyhow::anyhow!("Plan {} not found", req.plan_id)));
            }
        }
    } else {
        None
    };

    Ok(Json(PlanMatchResponse {
        match_level,
        adjusted_plan,
        mismatch_details,
    }))
}

/// POST /plan/update
///
/// Increments a success/failure/rejection counter on a plan's metadata.
/// `field` must be one of `"success_count"`, `"failed_count"`,
/// `"rejected_count"`.
async fn update(
    State(state): State<crate::server::AppState>,
    Json(req): Json<PlanUpdateRequest>,
) -> Result<Json<serde_json::Value>> {
    // Validate field name early
    match req.field.as_str() {
        "success_count" | "failed_count" | "rejected_count" => {}
        other => {
            return Err(bad_request(anyhow::anyhow!(
                "Invalid field '{other}'. Must be one of: success_count, failed_count, rejected_count"
            )));
        }
    }

    let memory = Arc::clone(&state.memory);
    let plan_id = req.plan_id.clone();
    let field = req.field.clone();
    let increment = req.increment;

    tokio::task::spawn_blocking(move || memory.update_plan_counter(&plan_id, &field, increment))
        .await
        .map_err(|e| bad_request(anyhow::anyhow!("Task join error: {e}")))??;

    Ok(Json(serde_json::json!({
        "plan_id": req.plan_id,
        "field": req.field,
        "increment": req.increment,
        "updated": true,
    })))
}
