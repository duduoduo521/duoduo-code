//! SSE (Server-Sent Events) endpoint for real-time agent quality check updates.

use axum::{
    Router,
    extract::{Path, State},
    response::sse::{Event, KeepAlive, Sse},
};
use std::convert::Infallible;
use std::time::Duration;

pub fn router() -> Router<crate::server::AppState> {
    Router::new().route(
        "/events/agent/:task_id",
        axum::routing::get(sse_agent_events),
    )
}

/// SSE endpoint for agent quality events.
/// Filters `QualityCheckUpdate` events by task_id from the broadcast channel.
async fn sse_agent_events(
    Path(task_id): Path<String>,
    State(state): State<crate::server::AppState>,
) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    let rx = state.sse_event_tx.subscribe();
    let target_pipeline_id = format!("agent-{}", task_id);
    let task_id_for_log = task_id.clone();
    let stream = futures::stream::unfold(rx, move |mut rx| {
        let target_pipeline_id = target_pipeline_id.clone();
        let task_id_for_log = task_id_for_log.clone();
        async move {
            loop {
                match rx.recv().await {
                    Ok(im_bridge::sse_bridge::SseEvent::QualityCheckUpdate {
                        pipeline_id,
                        quality_report,
                        ..
                    }) => {
                        if pipeline_id == target_pipeline_id {
                            return Some((
                                Ok(Event::default()
                                    .event("quality_check_update")
                                    .data(quality_report)),
                                rx,
                            ));
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(
                            "SSE agent channel lagged, skipped {} events for task {}",
                            n,
                            task_id_for_log
                        );
                        continue;
                    }
                    _ => continue,
                }
            }
        }
    });
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    )
}
