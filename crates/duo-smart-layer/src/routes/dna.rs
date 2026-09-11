use axum::{
    Json, Router,
    extract::{Path, State},
};
use duo_types::{DnaMatchRequest, DnaRule};
use unified_error::{Result, UnifiedError};

pub fn router() -> Router<crate::server::AppState> {
    Router::new()
        .route("/dna/match", axum::routing::post(match_rules_handler))
        .route("/dna/rules", axum::routing::post(add_rule_handler))
        .route(
            "/dna/rules/{id}",
            axum::routing::delete(remove_rule_handler),
        )
}

async fn match_rules_handler(
    State(state): State<crate::server::AppState>,
    Json(req): Json<DnaMatchRequest>,
) -> Result<Json<Vec<DnaRule>>> {
    let engine = state.dna.get()?;
    let input = req.input;
    let rules =
        tokio::task::spawn_blocking(move || dna_engine::match_rules(&engine, &input)).await?;
    Ok(Json(rules))
}

async fn add_rule_handler(
    State(state): State<crate::server::AppState>,
    Json(rule): Json<DnaRule>,
) -> Result<Json<serde_json::Value>> {
    let engine = state.dna.get()?;
    let rule_id = rule.id.clone();
    tokio::task::spawn_blocking(move || {
        engine
            .add_rule(rule)
            .map_err(|e| UnifiedError::Internal(format!("Failed to add DNA rule: {e}")))
    })
    .await??;

    Ok(Json(serde_json::json!({
        "ok": true,
        "id": rule_id
    })))
}

async fn remove_rule_handler(
    State(state): State<crate::server::AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let engine = state.dna.get()?;
    let id_for_closure = id.clone();
    let removed = tokio::task::spawn_blocking(move || {
        engine
            .remove_rule(&id_for_closure)
            .map_err(|e| UnifiedError::Internal(format!("Failed to remove DNA rule: {e}")))
    })
    .await??;

    if removed {
        Ok(Json(serde_json::json!({
            "ok": true,
            "id": id
        })))
    } else {
        Err(UnifiedError::NotFound(format!("DNA rule '{id}' not found")))
    }
}
