use std::sync::Arc;

use async_trait::async_trait;
use axum::{Json, Router, extract::State};
use duo_types::{QualityReport, QualityValidateRequest};
use quality_pipeline::{LlmJudge, QualityPipeline};
use unified_error::Result;

/// Wrapper so `duo-smart-layer` can plug its `AgentExecutor` into the
/// `LlmJudge` trait without violating the orphan rule (`AgentExecutor` lives in
/// `agent-executor`). Only constructed when an LLM is configured, so its absence
/// in `QualityPipeline` ⇒ silent regex degradation (问题1).
struct SmartLayerLlmJudge(Arc<agent_executor::AgentExecutor>);

#[async_trait]
impl LlmJudge for SmartLayerLlmJudge {
    async fn judge(&self, prompt: &str) -> anyhow::Result<String> {
        let req = duo_types::LlmExecuteRequest {
            prompt: prompt.to_string(),
            model_id: None,
            max_tokens: Some(1024),
            temperature: Some(0.0),
            project_path: None,
        };
        let resp = self
            .0
            .execute_prompt(&req, tokio_util::sync::CancellationToken::new())
            .await
            .map_err(|e| anyhow::anyhow!("LLM judge call failed: {e}"))?;
        Ok(resp.content)
    }
}

pub fn router() -> Router<crate::server::AppState> {
    Router::new().route("/quality/validate", axum::routing::post(validate))
}

async fn validate(
    state: State<crate::server::AppState>,
    Json(req): Json<QualityValidateRequest>,
) -> Result<Json<QualityReport>> {
    // Attach the user's current LLM executor so content-correctness checks work.
    // Only when an LLM is actually configured (gated by `with_llm()`) — otherwise
    // the pipeline degrades to pure regex (问题1 / 离线无LLM).
    let quality = if state.executor.with_llm() {
        QualityPipeline::new()?.with_llm_judge(Arc::new(SmartLayerLlmJudge(state.executor.clone())))
    } else {
        QualityPipeline::new()?
    };
    let result = quality.validate(&req).await?;
    Ok(Json(result))
}
