use axum::{Json, Router, extract::State};
use duo_types::{ClarificationResult, IntentClarifyRequest, PatternUpdateRequest};
use unified_error::Result;

pub fn router() -> Router<crate::server::AppState> {
    Router::new().route("/intent/clarify", axum::routing::post(clarify))
}

async fn clarify(
    state: State<crate::server::AppState>,
    Json(req): Json<IntentClarifyRequest>,
) -> Result<Json<ClarificationResult>> {
    let intent = state.intent.get()?;
    let memory = state.memory.clone();
    let user_id = req.user_id.clone();
    let input_preview: String = req.user_input.chars().take(50).collect();
    let result = tokio::task::spawn_blocking(move || intent.clarify(&req)).await??;

    // Write L5 command_pref pattern recording the AI's suggested mode.
    // The user's eventual choice will be written separately
    // when the pipeline executes successfully.
    if let Some(uid) = user_id {
        let mode_str = format!("{:?}", result.suggested_mode);
        let mem = memory.clone();
        let pattern_key = format!("intent:{}", input_preview);
        let _ = tokio::task::spawn_blocking(move || {
            let pat_req = PatternUpdateRequest {
                user_id: uid,
                pattern_type: "command_pref".to_string(),
                pattern_key,
                preferred_value: mode_str,
                execution_result: "success".to_string(),
                project_id: None,
            };
            match mem.update_pattern(&pat_req) {
                Ok(entry) => tracing::debug!(pattern_id = entry.id, "AI suggestion written to L5"),
                Err(e) => tracing::warn!("Failed to write AI suggestion to L5: {e}"),
            }
        })
        .await;
    }

    Ok(Json(result))
}
