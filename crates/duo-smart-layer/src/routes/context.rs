use axum::extract::State;
use axum::Json;
use axum::Router;
use duo_types::renderer::TaskPhase;
use unified_error::Result;

pub fn router() -> Router<crate::server::AppState> {
    Router::new()
        .route("/context/structured", axum::routing::post(context_structured_handler))
}

// ── POST /context/structured ──
// Full structured context pipeline: StructuredAssembler → GraphBuilder → Renderer.
// Replaces 4 TS→smart-layer HTTP calls with in-process crate calls (zero round-trip).
// Called by TS `structuredContext()` when cache misses.

#[derive(serde::Deserialize)]
struct ContextStructuredRequest {
    session_id: String,
    user_message: Option<String>,
    #[serde(default = "default_token_budget")]
    token_budget: usize,
    project_path: String,
    #[serde(default = "default_phase")]
    phase: TaskPhase,
    #[serde(default)]
    kg_enabled: bool,
    /// When true, returns intermediate data (elements/edges/blueprint) for A/B validation.
    #[serde(default)]
    debug: bool,
}

fn default_token_budget() -> usize {
    2000
}

fn default_phase() -> TaskPhase {
    TaskPhase::Execute
}

async fn context_structured_handler(
    State(state): State<crate::server::AppState>,
    Json(req): Json<ContextStructuredRequest>,
) -> Result<Json<serde_json::Value>> {
    let memory = state.memory.clone();
    let graph = state.graph.clone();
    let debug = req.debug;

    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        // 1. StructuredAssembler: 4-Phase file scan → HashMap<String, NarrativeElement>
        let assembler = context_builder::StructuredAssembler::new(memory, Some(graph));
        let elements = assembler.assemble(
            &req.session_id,
            req.user_message.as_deref(),
            req.token_budget,
            &req.project_path,
            req.kg_enabled,
            req.phase.clone(),
        )?;

        // 2. GraphBuilder: build rhetoric graph from elements.
        // Sort by id first — `into_values()` drains the HashMap in a randomised
        // order and the edge detectors are order-sensitive, so an unsorted
        // drain produces a different graph for identical input.
        let mut element_vec: Vec<_> = elements.into_values().collect();
        element_vec.sort_by(|a, b| a.id.cmp(&b.id));
        let graph = context_builder::graph::build_rhetoric_graph_from_elements(&element_vec);

        // 3. Renderer: render to 5-layer Chinese Markdown.
        // Budget is used as-is: the agent paths (`routes/agent.rs`,
        // `agentic_loop.rs`) both pass 2000, and the historical `* 2` here made
        // the same session inject twice the context depending on which path
        // produced it (P1-23).
        let total_budget = req.token_budget;
        let tt = context_builder::renderer::phase_to_task_type(&req.phase);
        let budget = context_builder::renderer::calc_structured_budget(total_budget as f64, &tt);
        // Truncate BEFORE building the blueprint: the blueprint enumerates the
        // element ids the model is instructed to work through, so deriving it
        // from the untruncated set would emit a plan referencing elements that
        // truncation removes from the rendered prompt. Mirrors `renderer::render`.
        let truncated = context_builder::renderer::truncate_by_priority(&graph.nodes, &budget);
        let blueprint = context_builder::renderer::generate_blueprint(&truncated, &graph, tt);
        let rendered = context_builder::renderer::render_output(&truncated, &blueprint, &graph, &req.phase);

        if debug {
            Ok(serde_json::json!({
                "rendered": rendered,
                "element_count": element_vec.len(),
                "edge_count": graph.edges.len(),
                "blueprint_steps": blueprint.steps.len(),
                "constraints": blueprint.constraints,
                "cautions": blueprint.cautions,
                "budget": budget,
            }))
        } else {
            Ok(serde_json::json!({ "rendered": rendered }))
        }
    })
    .await??;

    Ok(Json(result))
}
