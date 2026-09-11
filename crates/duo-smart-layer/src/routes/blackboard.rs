//! Blackboard routes — multi-agent file coordination endpoints.
//!
//! Provides per-prompt isolated blackboard sessions for agent coordination,
//! including file read/write, draft/stable submission, promotion, and
//! shared context (KV store) operations.

use std::sync::Arc;

use axum::{Json, Router, extract::State};
use blackboard_coordinator::coordinator::{StableSubmission, StableSubmitResult};
use duo_types::AgentScope;
use serde::{Deserialize, Serialize};

use crate::error::{Result, bad_request};
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/blackboard/init", axum::routing::post(init))
        .route("/blackboard/read", axum::routing::post(read))
        .route("/blackboard/write", axum::routing::post(write))
        .route("/blackboard/submit", axum::routing::post(submit))
        .route("/blackboard/promote", axum::routing::post(promote))
        .route("/blackboard/annotate", axum::routing::post(annotate))
        .route("/blackboard/destroy", axum::routing::post(destroy))
        .route("/blackboard/state", axum::routing::get(state))
        .route("/blackboard/version", axum::routing::post(file_version))
}

// ─── Request / Response types ────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct InitRequest {
    pub session_id: String,
    pub prompt_id: String,
    /// Agent scopes to register during initialization.
    /// If empty, the blackboard is created with no agents.
    #[serde(default)]
    pub agent_scopes: Vec<AgentScope>,
    /// Initial files to seed into the blackboard.
    #[serde(default)]
    pub initial_files: Vec<InitialFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InitialFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct InitResponse {
    pub prompt_id: String,
    pub initialized: bool,
}

#[derive(Debug, Deserialize)]
pub struct ReadRequest {
    pub prompt_id: String,
    /// Shared context key (mutually exclusive with file_path).
    pub key: Option<String>,
    /// File path to read (mutually exclusive with key).
    pub file_path: Option<String>,
    /// Agent reading the file (required for file reads to determine
    /// draft vs stable visibility).
    #[serde(default)]
    pub agent_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ReadResponse {
    pub prompt_id: String,
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ast_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WriteRequest {
    pub prompt_id: String,
    pub agent_id: String,
    pub key: String,
    pub value: String,
}

/// P1-04: fetch the CURRENT version + ast hash of a file so TS clients can
/// send a truthful `base_version`/`base_ast_hash` on submit (the previous
/// hard-coded `baseVersion: 0` made the optimistic lock reject every SECOND
/// submit to the same file, silently diverging disk from blackboard state).
#[derive(Debug, Deserialize)]
pub struct FileVersionRequest {
    pub prompt_id: String,
    pub file_path: String,
}

#[derive(Debug, Serialize)]
pub struct FileVersionResponse {
    pub prompt_id: String,
    pub file_path: String,
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ast_hash: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WriteResponse {
    pub prompt_id: String,
    pub key: String,
    pub written: bool,
}

#[derive(Debug, Deserialize)]
pub struct SubmitRequest {
    pub prompt_id: String,
    pub agent_id: String,
    pub file_path: String,
    pub content: String,
    pub base_version: i64,
    /// "draft" or "stable"
    pub status: String,
    /// AST hash of the base version (for optimistic lock).
    #[serde(default)]
    pub base_ast_hash: Option<String>,
    /// New AST hash after modifications (required for stable submissions).
    #[serde(default)]
    pub new_ast_hash: Option<String>,
    /// Optional AST plan snapshot ID for tracking.
    #[serde(default)]
    pub plan_id: Option<String>,
    /// When true, skip the tree-sitter syntax gate (expert escape hatch).
    /// Defaults to false (syntax check always runs).
    #[serde(default)]
    pub skip_syntax_check: bool,
}

#[derive(Debug, Serialize)]
pub struct SubmitResponse {
    pub prompt_id: String,
    pub file_path: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submission_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct PromoteRequest {
    pub prompt_id: String,
    pub agent_id: String,
    pub file_path: String,
    pub new_ast_hash: String,
}

#[derive(Debug, Serialize)]
pub struct PromoteResponse {
    pub prompt_id: String,
    pub file_path: String,
    pub promoted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_version: Option<i64>,
}

/// Blackboard annotation request — attach a review comment / note to a file.
#[derive(Debug, Deserialize)]
pub struct AnnotationRequest {
    pub prompt_id: String,
    pub agent_id: String,
    pub file_path: String,
    /// Annotation category, e.g. "review". Defaults to "review" server-side.
    #[serde(default)]
    pub annotation_type: Option<String>,
    pub content: String,
}

/// Blackboard annotation response.
#[derive(Debug, Serialize)]
pub struct AnnotationResponse {
    pub prompt_id: String,
    pub file_path: String,
    pub annotation_id: i64,
    pub written: bool,
}

#[derive(Debug, Deserialize)]
pub struct DestroyRequest {
    pub prompt_id: String,
}

#[derive(Debug, Serialize)]
pub struct DestroyResponse {
    pub prompt_id: String,
    pub destroyed: bool,
}

// ─── Handlers ─────────────────────────────────────────────────────────────

async fn init(
    State(state): State<AppState>,
    Json(req): Json<InitRequest>,
) -> Result<Json<InitResponse>> {
    let factory = Arc::clone(&state.blackboard_factory);
    let prompt_id = req.prompt_id.clone();
    let agent_scopes = req.agent_scopes.clone();
    let initial_files = req.initial_files.clone();

    let prompt_id_for_closure = prompt_id.clone();
    let coordinator = tokio::task::spawn_blocking(move || {
        // P1-03: pass an empty session segment so the per-prompt DB lands at
        // `<base_dir>/<prompt_id>.db` — the SAME path every other endpoint
        // uses (read/write/submit/promote/… all call `create_for_prompt("")`).
        // Previously init alone passed the real session_id, creating the DB
        // under `<base_dir>/<session_id>/` while all subsequent operations
        // opened a DIFFERENT empty database: agent scopes registered during
        // init were effectively void and seeded files invisible.
        // `req.session_id` is kept in the request for API compatibility but
        // is no longer used for path derivation.
        factory.create_for_prompt("", &prompt_id_for_closure)
    })
    .await
    .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

    // Initialize the blackboard with agent scopes.
    // Use the prompt_id as a pseudo project path (blackboard is per-prompt isolated).
    let project_path = format!("prompt://{}", prompt_id);
    coordinator
        .initialize(&project_path, &agent_scopes)
        .await
        .map_err(bad_request)?;

    // Seed initial files into the blackboard store
    if !initial_files.is_empty() {
        let store = Arc::clone(coordinator.store());
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            for file in &initial_files {
                store.init_file_version(&file.path, &file.content, "")?;
            }
            Ok(())
        })
        .await
        .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;
    }

    Ok(Json(InitResponse {
        prompt_id,
        initialized: true,
    }))
}

async fn read(
    State(state): State<AppState>,
    Json(req): Json<ReadRequest>,
) -> Result<Json<ReadResponse>> {
    let factory = Arc::clone(&state.blackboard_factory);
    let prompt_id = req.prompt_id.clone();

    // Re-create the coordinator handle (it opens the existing DB)
    let coordinator = tokio::task::spawn_blocking(move || {
        // create_for_prompt with a known session/prompt reopens the existing DB
        factory.create_for_prompt("", &prompt_id)
    })
    .await
    .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

    // Key-based read: shared_context KV store
    if let Some(key) = &req.key {
        let store = Arc::clone(coordinator.store());
        let key = key.clone();
        let result = tokio::task::spawn_blocking(move || store.get_shared_context(&key))
            .await
            .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

        return Ok(Json(match result {
            Some((value, updated_by, updated_at)) => ReadResponse {
                prompt_id: req.prompt_id,
                found: true,
                content: Some(value),
                version: None,
                ast_hash: None,
                updated_by: Some(updated_by),
                updated_at: Some(updated_at),
            },
            None => ReadResponse {
                prompt_id: req.prompt_id,
                found: false,
                content: None,
                version: None,
                ast_hash: None,
                updated_by: None,
                updated_at: None,
            },
        }));
    }

    // File-based read
    if let Some(file_path) = &req.file_path {
        let agent_id = req
            .agent_id
            .as_deref()
            .ok_or_else(|| bad_request(anyhow::anyhow!("agent_id is required for file reads")))?;
        let file_path = file_path.clone();
        let agent_id = agent_id.to_string();

        let result =
            tokio::task::spawn_blocking(move || coordinator.read_file(&agent_id, &file_path))
                .await
                .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

        return Ok(Json(match result {
            Some((content, version, ast_hash)) => ReadResponse {
                prompt_id: req.prompt_id,
                found: true,
                content: Some(content),
                version: Some(version),
                ast_hash: Some(ast_hash),
                updated_by: None,
                updated_at: None,
            },
            None => ReadResponse {
                prompt_id: req.prompt_id,
                found: false,
                content: None,
                version: None,
                ast_hash: None,
                updated_by: None,
                updated_at: None,
            },
        }));
    }

    Err(bad_request(anyhow::anyhow!(
        "either 'key' or 'file_path' must be provided"
    )))
}

/// P1-04: current version + ast hash of a file, for optimistic-lock base
/// values. `found: false` means the file has no blackboard version yet
/// (base_version 0 / empty ast hash is then truthful).
async fn file_version(
    State(state): State<AppState>,
    Json(req): Json<FileVersionRequest>,
) -> Result<Json<FileVersionResponse>> {
    let factory = Arc::clone(&state.blackboard_factory);
    let prompt_id = req.prompt_id.clone();

    let coordinator =
        tokio::task::spawn_blocking(move || factory.create_for_prompt("", &prompt_id))
            .await
            .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

    let store = Arc::clone(coordinator.store());
    let file_path = req.file_path.clone();
    let result = tokio::task::spawn_blocking(move || store.get_file_version(&file_path))
        .await
        .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

    Ok(Json(match result {
        Some(v) => FileVersionResponse {
            prompt_id: req.prompt_id,
            file_path: req.file_path,
            found: true,
            version: Some(v.version),
            ast_hash: Some(v.ast_hash),
        },
        None => FileVersionResponse {
            prompt_id: req.prompt_id,
            file_path: req.file_path,
            found: false,
            version: None,
            ast_hash: None,
        },
    }))
}

async fn write(
    State(state): State<AppState>,
    Json(req): Json<WriteRequest>,
) -> Result<Json<WriteResponse>> {
    let factory = Arc::clone(&state.blackboard_factory);
    let prompt_id = req.prompt_id.clone();

    let coordinator =
        tokio::task::spawn_blocking(move || factory.create_for_prompt("", &prompt_id))
            .await
            .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

    let store = Arc::clone(coordinator.store());
    let key = req.key.clone();
    let value = req.value.clone();
    let agent_id = req.agent_id.clone();

    tokio::task::spawn_blocking(move || store.set_shared_context(&key, &value, &agent_id))
        .await
        .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

    Ok(Json(WriteResponse {
        prompt_id: req.prompt_id,
        key: req.key,
        written: true,
    }))
}

async fn submit(
    State(state): State<AppState>,
    Json(req): Json<SubmitRequest>,
) -> Result<Json<SubmitResponse>> {
    let factory = Arc::clone(&state.blackboard_factory);
    let prompt_id = req.prompt_id.clone();

    let coordinator =
        tokio::task::spawn_blocking(move || factory.create_for_prompt("", &prompt_id))
            .await
            .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

    let agent_id = req.agent_id.clone();
    let file_path = req.file_path.clone();
    let content = req.content.clone();
    let base_version = req.base_version;
    let base_ast_hash = req.base_ast_hash.clone().unwrap_or_default();
    let new_ast_hash = req.new_ast_hash.clone().unwrap_or_default();
    let status = req.status.clone();

    match status.as_str() {
        "draft" => {
            let coordinator = Arc::clone(&coordinator);
            let submission_id = tokio::task::spawn_blocking(move || {
                coordinator.submit_draft(
                    &agent_id,
                    &file_path,
                    &content,
                    base_version,
                    &base_ast_hash,
                )
            })
            .await
            .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

            Ok(Json(SubmitResponse {
                prompt_id: req.prompt_id,
                file_path: req.file_path,
                success: true,
                new_version: None,
                submission_id: Some(submission_id),
                result_type: Some("draft".to_string()),
                detail: None,
            }))
        }
        "stable" => {
            let result = coordinator
                .submit_stable(StableSubmission {
                    agent_id: &agent_id,
                    file_path: &file_path,
                    content: &content,
                    base_version,
                    base_ast_hash: &base_ast_hash,
                    new_ast_hash: &new_ast_hash,
                    skip_syntax_check: req.skip_syntax_check,
                })
                .await
                .map_err(bad_request)?;

            let (success, new_version, result_type, detail) = match result {
                StableSubmitResult::Success { new_version } => {
                    (true, Some(new_version), Some("success".to_string()), None)
                }
                StableSubmitResult::Conflict {
                    expected_version,
                    actual_version,
                    conflicts,
                    resolution,
                } => (
                    false,
                    None,
                    Some("conflict".to_string()),
                    Some(serde_json::json!({
                        "expected_version": expected_version,
                        "actual_version": actual_version,
                        "conflicts": conflicts.iter().map(|c| serde_json::json!({
                            "conflict_type": c.conflict_type,
                            "symbol": c.symbol,
                            "detail": c.detail,
                        })).collect::<Vec<_>>(),
                        "resolution": format!("{:?}", resolution),
                    })),
                ),
                StableSubmitResult::SyntaxError { error } => (
                    false,
                    None,
                    Some("syntax_error".to_string()),
                    Some(serde_json::json!({ "error": error })),
                ),
                StableSubmitResult::OutOfScope { allowed_files } => (
                    false,
                    None,
                    Some("out_of_scope".to_string()),
                    Some(serde_json::json!({ "allowed_files": allowed_files })),
                ),
                StableSubmitResult::QueuedForSerial => {
                    (false, None, Some("queued_for_serial".to_string()), None)
                }
                StableSubmitResult::DependencyChanged { changes } => (
                    false,
                    None,
                    Some("dependency_changed".to_string()),
                    Some(serde_json::json!({
                        "changes": changes.iter().map(|c| serde_json::json!({
                            "file": c.file,
                            "known_version": c.known_version,
                            "current_version": c.current_version,
                            "must_adapt": c.must_adapt,
                        })).collect::<Vec<_>>(),
                    })),
                ),
            };

            Ok(Json(SubmitResponse {
                prompt_id: req.prompt_id,
                file_path: req.file_path,
                success,
                new_version,
                submission_id: None,
                result_type,
                detail,
            }))
        }
        other => Err(bad_request(anyhow::anyhow!(
            "invalid status '{}': must be 'draft' or 'stable'",
            other
        ))),
    }
}

async fn promote(
    State(state): State<AppState>,
    Json(req): Json<PromoteRequest>,
) -> Result<Json<PromoteResponse>> {
    let factory = Arc::clone(&state.blackboard_factory);
    let prompt_id = req.prompt_id.clone();

    let coordinator =
        tokio::task::spawn_blocking(move || factory.create_for_prompt("", &prompt_id))
            .await
            .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

    let agent_id = req.agent_id.clone();
    let file_path = req.file_path.clone();
    let new_ast_hash = req.new_ast_hash.clone();

    let result = tokio::task::spawn_blocking(move || {
        coordinator.promote_draft(&agent_id, &file_path, &new_ast_hash)
    })
    .await
    .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

    Ok(Json(PromoteResponse {
        prompt_id: req.prompt_id,
        file_path: req.file_path,
        promoted: result.is_some(),
        new_version: result,
    }))
}

async fn annotate(
    State(state): State<AppState>,
    Json(req): Json<AnnotationRequest>,
) -> Result<Json<AnnotationResponse>> {
    let factory = Arc::clone(&state.blackboard_factory);
    let prompt_id = req.prompt_id.clone();

    let coordinator =
        tokio::task::spawn_blocking(move || factory.create_for_prompt("", &prompt_id))
            .await
            .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

    let agent_id = req.agent_id.clone();
    let file_path = req.file_path.clone();
    let annotation_type = req.annotation_type.clone().unwrap_or_else(|| "review".to_string());
    let content = req.content.clone();

    let annotation_id = tokio::task::spawn_blocking(move || {
        coordinator.add_file_annotation(&file_path, &agent_id, &annotation_type, &content)
    })
    .await
    .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

    Ok(Json(AnnotationResponse {
        prompt_id: req.prompt_id,
        file_path: req.file_path,
        annotation_id,
        written: true,
    }))
}

async fn destroy(
    State(state): State<AppState>,
    Json(req): Json<DestroyRequest>,
) -> Result<Json<DestroyResponse>> {
    let factory = Arc::clone(&state.blackboard_factory);
    let prompt_id = req.prompt_id.clone();

    let coordinator =
        tokio::task::spawn_blocking(move || factory.create_for_prompt("", &prompt_id))
            .await
            .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

    coordinator.cleanup().await.map_err(bad_request)?;

    Ok(Json(DestroyResponse {
        prompt_id: req.prompt_id,
        destroyed: true,
    }))
}

async fn state(
    State(state): State<AppState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>> {
    let prompt_id = params
        .get("prompt_id")
        .ok_or_else(|| bad_request(anyhow::anyhow!("missing query parameter: prompt_id")))?;

    let factory = Arc::clone(&state.blackboard_factory);
    let prompt_id = prompt_id.clone();

    let coordinator =
        tokio::task::spawn_blocking(move || factory.create_for_prompt("", &prompt_id))
            .await
            .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

    let status = coordinator.get_status().await.map_err(bad_request)?;

    // Also gather shared context and task findings for a complete state view
    let store = Arc::clone(coordinator.store());
    let shared_context = tokio::task::spawn_blocking(move || store.get_all_shared_context())
        .await
        .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

    let store2 = Arc::clone(coordinator.store());
    let task_findings = tokio::task::spawn_blocking(move || store2.get_task_findings(None))
        .await
        .map_err(|e| bad_request(anyhow::anyhow!("spawn error: {e}")))??;

    Ok(Json(serde_json::json!({
        "status": status,
        "shared_context": shared_context.iter().map(|(k, v, by, at)| {
            serde_json::json!({ "key": k, "value": v, "updated_by": by, "updated_at": at })
        }).collect::<Vec<_>>(),
        "task_findings": task_findings.iter().map(|(id, agent_id, finding_type, content, related, created_at)| {
            serde_json::json!({
                "id": id,
                "agent_id": agent_id,
                "finding_type": finding_type,
                "content": content,
                "related_entities": related,
                "created_at": created_at,
            })
        }).collect::<Vec<_>>(),
    })))
}
