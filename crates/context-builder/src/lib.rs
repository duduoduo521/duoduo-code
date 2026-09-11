//! Context-builder crate for DuoDuo smart layer.
//!
//! Provides `ContextBuilder` which assembles context from the memory system
//! by searching layers from high (5) to low (0) and filling within a token
//! budget.

pub mod assembler;
pub mod graph;
pub mod normalizer;
pub mod renderer;
pub mod structured_assembler;

pub use assembler::ContextBuilder;
pub use normalizer::normalize_code_blocks;
pub use structured_assembler::StructuredAssembler;

use std::sync::Arc;

/// Outcome of the structured-context pipeline (see [`render_structured_context`]).
pub enum StructuredContextOutcome {
    /// Non-empty rendered Markdown, ready to inject.
    Rendered(String),
    /// Assembly succeeded but rendered nothing (e.g. no elements passed the
    /// budget) — callers that have a lighter fallback may choose to use it.
    Empty,
    /// Assembly failed or the blocking task panicked.
    Failed,
}

/// Single entry point for the structured-context pipeline:
/// `StructuredAssembler::assemble` → deterministic id sort → rhetoric graph →
/// `renderer::render`.
///
/// Three inline copies of this pipeline existed (routes/agent.rs,
/// agentic_loop.rs, routes/context.rs) and had already drifted — the sort
/// comment, the budget constant and the spawn_blocking wiring were duplicated
/// by hand. This is now the only production entry point (routes/context.rs
/// keeps its own expansion solely because the debug endpoint must return the
/// intermediate elements/edges/blueprint).
pub async fn render_structured_context(
    assembler: Arc<StructuredAssembler>,
    session_id: String,
    user_message: Option<String>,
    token_budget: usize,
    project_path: String,
    kg_enabled: bool,
    phase: duo_types::renderer::TaskPhase,
) -> StructuredContextOutcome {
    let assemble_phase = phase.clone();
    let result = tokio::task::spawn_blocking(move || {
        assembler.assemble(
            &session_id,
            user_message.as_deref(),
            token_budget,
            &project_path,
            kg_enabled,
            assemble_phase,
        )
    })
    .await;
    match result {
        Ok(Ok(elements)) => {
            // Sort by id: `into_values()` drains the HashMap in a randomised
            // order and the edge detectors are order-sensitive, so an
            // unsorted drain yields a different prompt for identical input.
            let mut element_vec: Vec<_> = elements.into_values().collect();
            element_vec.sort_by(|a, b| a.id.cmp(&b.id));
            let rhetoric_graph = graph::build_rhetoric_graph_from_elements(&element_vec);
            let rendered = renderer::render(&rhetoric_graph, phase, None, token_budget);
            if rendered.is_empty() {
                StructuredContextOutcome::Empty
            } else {
                StructuredContextOutcome::Rendered(rendered)
            }
        }
        Ok(Err(e)) => {
            tracing::debug!("structured context assembly failed: {e}");
            StructuredContextOutcome::Failed
        }
        Err(e) => {
            tracing::debug!("structured context task panicked: {e}");
            StructuredContextOutcome::Failed
        }
    }
}
