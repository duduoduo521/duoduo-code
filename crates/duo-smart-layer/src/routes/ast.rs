//! AST routes — syntax validation, structural diff, and AST hash computation.

use axum::{Json, Router};

use crate::error::{Result, bad_request};

pub fn router() -> Router<crate::server::AppState> {
    Router::new()
        .route("/ast/validate-syntax", axum::routing::post(validate_syntax))
        .route("/ast/structural-diff", axum::routing::post(structural_diff))
        .route("/ast/compute-hash", axum::routing::post(compute_hash))
}

// ─── Request / Response types ────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct ValidateSyntaxRequest {
    code: String,
    language: String,
}

#[derive(serde::Serialize)]
struct ValidateSyntaxResponse {
    valid: bool,
    errors: Vec<String>,
    functions: Vec<duo_types::FunctionDef>,
    language: String,
}

#[derive(serde::Deserialize)]
struct StructuralDiffRequest {
    file_path: String,
    old_code: String,
    new_code: String,
    language: String,
    agent_id: String,
}

#[derive(serde::Deserialize)]
struct ComputeHashRequest {
    code: String,
    language: String,
}

#[derive(serde::Serialize)]
struct ComputeHashResponse {
    hash: String,
}

// ─── Fallback helpers ────────────────────────────────────────────────────

/// Fallback content hash when tree-sitter is unavailable for a language.
fn fallback_content_hash(code: &str) -> String {
    use std::hash::{Hash, Hasher};
    let stripped: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    stripped.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Empty change list for when structural diff is unavailable.
fn empty_change_list(file_path: &str, agent_id: &str) -> duo_types::StructuredChangeList {
    duo_types::StructuredChangeList {
        file: file_path.to_string(),
        agent_id: agent_id.to_string(),
        changes: vec![],
    }
}

// ─── Handlers ─────────────────────────────────────────────────────────────

/// Validate code syntax without writing to disk.
async fn validate_syntax(
    Json(req): Json<ValidateSyntaxRequest>,
) -> Result<Json<ValidateSyntaxResponse>> {
    if req.code.is_empty() {
        return Err(bad_request(anyhow::anyhow!("code must not be empty")));
    }

    let result =
        tokio::task::spawn_blocking(move || ast_engine::analyze(&req.code, &req.language)).await?;

    Ok(Json(ValidateSyntaxResponse {
        valid: true,
        errors: result.errors.unwrap_or_default(),
        functions: result.functions,
        language: result.language,
    }))
}

/// Generate a structural diff between two versions of a file.
/// Falls back to an empty change list when tree-sitter is unavailable.
async fn structural_diff(
    Json(req): Json<StructuralDiffRequest>,
) -> Result<Json<duo_types::StructuredChangeList>> {
    let result = tokio::task::spawn_blocking(move || {
        if ast_engine::is_language_enabled(&req.language) {
            ast_engine::generate_structural_diff(
                &req.file_path,
                &req.old_code,
                &req.new_code,
                &req.language,
                &req.agent_id,
            )
            .unwrap_or_else(|_| empty_change_list(&req.file_path, &req.agent_id))
        } else {
            empty_change_list(&req.file_path, &req.agent_id)
        }
    })
    .await?;

    Ok(Json(result))
}

/// Compute a deterministic AST hash for source code.
/// Falls back to a content-based hash when tree-sitter is unavailable.
async fn compute_hash(Json(req): Json<ComputeHashRequest>) -> Result<Json<ComputeHashResponse>> {
    if req.code.is_empty() {
        return Err(bad_request(anyhow::anyhow!("code must not be empty")));
    }

    let hash = tokio::task::spawn_blocking(move || {
        if ast_engine::is_language_enabled(&req.language) {
            ast_engine::compute_ast_hash(&req.code, &req.language)
                .unwrap_or_else(|_| fallback_content_hash(&req.code))
        } else {
            fallback_content_hash(&req.code)
        }
    })
    .await?;

    Ok(Json(ComputeHashResponse { hash }))
}
