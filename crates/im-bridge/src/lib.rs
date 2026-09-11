//! IM bridge for Feishu WebSocket long-connection integration.

pub mod bridge;
pub mod config;
pub mod feishu;
pub mod sse_bridge;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use bridge::SmartLayerBridge;
use config::ImConfig;
use feishu::FeishuWsClient;
use feishu::ws::truncate_im_response;
use feishu::api::{
    FeishuApiClient, PendingAckMap, ACK_MAX_ATTEMPTS, ACK_SCAN_INTERVAL_SECS, ACK_TIMEOUT_SECS,
};

/// Collect due pending-ACK cards for re-delivery (pure core of the timer).
///
/// - Entries at the attempt cap are dropped (not returned).
/// - Due entries (`now >= deadline`) are returned as
///   `(message_id, chat_id, card)`, their attempt count incremented and
///   deadline pushed out by `ACK_TIMEOUT_SECS`.
/// - Not-yet-due entries are kept untouched.
pub(crate) fn collect_due_acks(
    map: &mut PendingAckMap,
    now: Instant,
) -> Vec<(String, String, Value)> {
    let mut out = Vec::new();
    map.retain(|mid, e| {
        if e.attempts >= ACK_MAX_ATTEMPTS {
            return false;
        }
        if now >= e.deadline {
            out.push((mid.clone(), e.chat_id.clone(), e.card.clone()));
            e.attempts += 1;
            e.deadline = now + Duration::from_secs(ACK_TIMEOUT_SECS);
        }
        true
    });
    out
}

/// Top-level IM bridge orchestrator.
pub struct ImBridge {
    config: ImConfig,
    bridge: Arc<dyn SmartLayerBridge>,
    shutdown: Arc<tokio::sync::RwLock<bool>>,
    /// Shared map of pending outbound critical cards (ACK re-delivery).
    pending_ack: Arc<Mutex<PendingAckMap>>,
}

impl ImBridge {
    /// Create a new ImBridge with the given configuration and smart-layer bridge.
    pub fn new(config: ImConfig, bridge: Arc<dyn SmartLayerBridge>) -> Self {
        Self {
            config,
            bridge,
            shutdown: Arc::new(tokio::sync::RwLock::new(false)),
            pending_ack: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Signal all adapter tasks to stop.
    pub async fn stop(&self) {
        let mut guard = self.shutdown.write().await;
        *guard = true;
    }

    /// Start configured Feishu adapter and the IM notification bridge.
    pub async fn start(&self) {
        {
            let mut guard = self.shutdown.write().await;
            *guard = false;
        }

        let pending_ack = self.pending_ack.clone();

        if let Some(feishu_config) = &self.config.feishu {
            tracing::info!(
                app_id = %feishu_config.app_id,
                domain = %feishu_config.domain,
                "Starting Feishu adapter"
            );

            let feishu_config = feishu_config.clone();
            let bridge = self.bridge.clone();
            let shutdown = self.shutdown.clone();
            let ack_ws = pending_ack.clone();

            tokio::spawn(async move {
                let mut retries: u32 = 0;
                let max_retries: u32 = 5;
                // IM-05: reset the retry counter once a session has been alive
                // for >= 60s. This prevents a *permanently* disconnected adapter
                // after a transient outage that spanned the first 5 quick retries:
                // if the connection stabilizes for a minute, the consecutive-failure
                // budget is replenished. Rapid consecutive failures (< 60s) still
                // exhaust the budget and exit as before.
                let session_start = Instant::now();
                loop {
                    if *shutdown.read().await {
                        tracing::info!(adapter = "Feishu", "Adapter stop requested");
                        return;
                    }
                    let api = FeishuApiClient::new(feishu_config.clone())
                        .with_ack_tracker(ack_ws.clone());
                    let ws_client = FeishuWsClient::new(
                        feishu_config.clone(),
                        api,
                        bridge.clone(),
                        shutdown.clone(),
                        Some(ack_ws.clone()),
                    );

                    let handle = tokio::spawn(async move { ws_client.run().await });
                    match handle.await {
                        Ok(()) => {
                            // `run()` returns `()` only on a clean shutdown — on any
                            // normal disconnect it loops internally and retries via
                            // `reconnect_backoff`. Exit immediately on shutdown instead
                            // of waiting a fixed 2s; otherwise treat the clean exit as a
                            // reconnect attempt and apply the shared exponential backoff
                            // (identical to the panic path below, single source of truth).
                            if *shutdown.read().await {
                                tracing::info!(adapter = "Feishu", "Adapter clean exit on shutdown");
                                return;
                            }
                            tracing::warn!(adapter = "Feishu", "Adapter exited, reconnecting...");
                            if session_start.elapsed() >= Duration::from_secs(60) {
                                retries = 0;
                            }
                            retries += 1;
                            if retries > max_retries {
                                tracing::error!(
                                    adapter = "Feishu",
                                    retries,
                                    "Max retries exceeded, giving up"
                                );
                                return;
                            }
                            let backoff = FeishuWsClient::reconnect_backoff(retries);
                            tracing::info!(
                                adapter = "Feishu",
                                retries,
                                backoff_secs = backoff.as_secs(),
                                "Reconnecting after clean exit..."
                            );
                            tokio::time::sleep(backoff).await;
                        }
                        Err(join_err) => {
                            if join_err.is_panic() {
                                tracing::error!(adapter = "Feishu", "Adapter panicked!");
                            } else {
                                tracing::error!(adapter = "Feishu", "Adapter task cancelled");
                            }
                            if session_start.elapsed() >= Duration::from_secs(60) {
                                retries = 0;
                            }
                            retries += 1;
                            if retries > max_retries {
                                tracing::error!(
                                    adapter = "Feishu",
                                    retries,
                                    "Max retries exceeded, giving up"
                                );
                                return;
                            }
                            let backoff = FeishuWsClient::reconnect_backoff(retries);
                            tracing::info!(
                                adapter = "Feishu",
                                retries,
                                backoff_secs = backoff.as_secs(),
                                "Reconnecting after panic..."
                            );
                            tokio::time::sleep(backoff).await;
                        }
                    }
                }
            });
        }

        // SSE/event → Feishu push notification bridge.
        let feishu_api = self
            .config
            .feishu
            .as_ref()
            .map(|cfg| {
                Arc::new(
                    FeishuApiClient::new(cfg.clone())
                        .with_ack_tracker(pending_ack.clone()),
                )
            });

        // Independent ACK re-delivery timer (critical status cards only).
        // Scans the shared PendingAckMap and re-PATCHes (`update_card`) any
        // unconfirmed card until the user confirms via a card action callback
        // or the attempt cap is reached. Runs OFF the SSE broadcast channel.
        if feishu_api.is_some() {
            let timer_map = pending_ack.clone();
            let timer_api = feishu_api.clone();
            let timer_shutdown = self.shutdown.clone();
            tokio::spawn(async move {
                loop {
                    if *timer_shutdown.read().await {
                        return;
                    }
                    tokio::time::sleep(Duration::from_secs(ACK_SCAN_INTERVAL_SECS)).await;
                    let now = Instant::now();
                    let due: Vec<(String, String, Value)> = {
                        let mut map = timer_map
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        collect_due_acks(&mut map, now)
                    };
                    let Some(api) = timer_api.as_ref() else { break };
                    for (mid, chat_id, card) in due {
                        if let Err(e) = api.update_card(&mid, &chat_id, &card).await {
                            tracing::warn!(message_id = %mid, error = %e, "ACK re-delivery failed");
                        } else {
                            tracing::info!(message_id = %mid, "ACK re-delivered via update_card");
                        }
                    }
                }
            });
        }

        {
            let mut rx = self.bridge.subscribe_events();
            let shutdown = self.shutdown.clone();
            // Snapshot of the user's "notify on task completion" preference.
            // The bridge is rebuilt on every config save (im_runtime), so this
            // snapshot always reflects the latest saved value.
            let notify_on_complete = self.config.notify_on_complete;

            tokio::spawn(async move {
                loop {
                    if *shutdown.read().await {
                        tracing::info!("IM event bridge stop requested");
                        return;
                    }
                    match tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await {
                        Ok(Ok(event)) => {
                            let Some(ref api) = feishu_api else { continue };
                            let Some(chat_id) = event.chat_id() else {
                                continue;
                            };
                            let text = sse_bridge::format_sse_event(&event);
                            match &event {
                                sse_bridge::SseEvent::AgentTaskStarted { .. } => {
                                    if let Err(e) = api
                                        .send_task_status_card(chat_id, "🔄 任务已开始", &text)
                                        .await
                                    {
                                        tracing::warn!(error = %e, "Failed to send Feishu started card");
                                    }
                                }
                                sse_bridge::SseEvent::AgentTaskQueued { .. } => {
                                    if let Err(e) = api
                                        .send_task_status_card(chat_id, "⏳ 任务已排队", &text)
                                        .await
                                    {
                                        tracing::warn!(error = %e, "Failed to send Feishu queued card");
                                    }
                                }
                                sse_bridge::SseEvent::AgentTaskCompleted { .. } => {
                                    // Honor the user's notification preference:
                                    // only push completion cards when enabled.
                                    if notify_on_complete
                                        && let Err(e) = api
                                            .send_task_completed_card(chat_id, "✅ 任务完成", &text)
                                            .await
                                    {
                                        tracing::warn!(error = %e, "Failed to send Feishu completed card");
                                    }
                                }
                                sse_bridge::SseEvent::AgentTaskFailed { .. } => {
                                    if let Err(e) = api
                                        .send_task_status_card(chat_id, "❌ 任务失败", &text)
                                        .await
                                    {
                                        tracing::warn!(error = %e, "Failed to send Feishu failed card");
                                    }
                                }
                                sse_bridge::SseEvent::SubagentStarted { .. } => {
                                    if let Err(e) = api
                                        .send_task_status_card(chat_id, "🔍 子Agent已启动", &text)
                                        .await
                                    {
                                        tracing::warn!(error = %e, "Failed to send Feishu subagent started card");
                                    }
                                }
                                sse_bridge::SseEvent::SubagentDone { .. } => {
                                    if let Err(e) = api
                                        .send_task_status_card(chat_id, "✅ 子Agent完成", &text)
                                        .await
                                    {
                                        tracing::warn!(error = %e, "Failed to send Feishu subagent done card");
                                    }
                                }
                                sse_bridge::SseEvent::FeishuReply { text, .. } => {
                                    // Push the actual LLM answer back to the chat.
                                    let truncated = truncate_im_response(text);
                                    if let Err(e) = api.send_text_message(chat_id, &truncated).await {
                                        tracing::warn!(error = %e, "Failed to send Feishu reply");
                                    }
                                }
                                _ => {
                                    if let Err(e) = api.send_text_message(chat_id, &text).await {
                                        tracing::warn!(error = %e, "Failed to send Feishu text message");
                                    }
                                }
                            }
                        }
                        Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => {
                            tracing::warn!(skipped = n, "IM event bridge lagged");
                        }
                        Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                            tracing::info!("IM event bridge closed");
                            return;
                        }
                        Err(_) => continue,
                    }
                }
            });
        }

        if self.config.feishu.is_none() {
            tracing::warn!("IM bridge enabled but Feishu is not configured");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feishu::api::PendingAck;

    fn ack(chat_id: &str, attempts: u32, deadline: Instant) -> PendingAck {
        PendingAck {
            chat_id: chat_id.to_string(),
            card: serde_json::json!({ "elements": [] }),
            attempts,
            deadline,
        }
    }

    #[test]
    fn due_entry_is_returned_and_rescheduled() {
        let now = Instant::now();
        let mut map: PendingAckMap = HashMap::new();
        map.insert("om_1".into(), ack("oc_a", 0, now)); // now >= deadline → due

        let due = collect_due_acks(&mut map, now);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].0, "om_1");
        assert_eq!(due[0].1, "oc_a");

        // Entry stays for the next round, with attempts+1 and pushed deadline.
        let e = map.get("om_1").expect("kept");
        assert_eq!(e.attempts, 1);
        assert_eq!(e.deadline, now + Duration::from_secs(ACK_TIMEOUT_SECS));
    }

    #[test]
    fn not_due_entry_is_kept_untouched() {
        let now = Instant::now();
        let mut map: PendingAckMap = HashMap::new();
        map.insert("om_2".into(), ack("oc_b", 1, now + Duration::from_secs(100)));

        let due = collect_due_acks(&mut map, now);
        assert!(due.is_empty());
        assert_eq!(map.get("om_2").unwrap().attempts, 1);
    }

    #[test]
    fn entry_at_attempt_cap_is_dropped_silently() {
        let now = Instant::now();
        let mut map: PendingAckMap = HashMap::new();
        map.insert("om_3".into(), ack("oc_c", ACK_MAX_ATTEMPTS, now));

        let due = collect_due_acks(&mut map, now);
        assert!(due.is_empty());
        assert!(map.is_empty(), "capped entry must be evicted, not re-sent");
    }

    #[test]
    fn due_entry_exhausts_after_max_attempts() {
        // Simulate the timer firing repeatedly on an unacknowledged card:
        // exactly ACK_MAX_ATTEMPTS re-deliveries, then eviction.
        let mut map: PendingAckMap = HashMap::new();
        let mut now = Instant::now();
        map.insert("om_4".into(), ack("oc_d", 0, now));

        let mut deliveries = 0;
        for _ in 0..(ACK_MAX_ATTEMPTS + 2) {
            deliveries += collect_due_acks(&mut map, now).len();
            now += Duration::from_secs(ACK_TIMEOUT_SECS);
        }
        assert_eq!(deliveries as u32, ACK_MAX_ATTEMPTS);
        assert!(map.is_empty());
    }
}
