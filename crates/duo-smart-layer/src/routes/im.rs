//! IM bridge configuration and notification endpoints.

use std::collections::HashMap;

use crate::project_tasks::ProjectTaskState;
use axum::{Json, Router, extract::State};
use serde::Deserialize;
use serde_json::{Value, json};

pub fn router() -> Router<crate::server::AppState> {
    Router::new()
        .route("/im/config", axum::routing::get(get_im_config))
        .route("/im/config", axum::routing::post(set_im_config))
        .route("/im/notify", axum::routing::post(notify_feishu))
        .route("/task/acquire", axum::routing::post(acquire_project_task))
        .route("/task/release", axum::routing::post(release_project_task))
        .route("/task/status", axum::routing::get(project_task_status))
}

/// GET /im/config — returns the current IM configuration.
async fn get_im_config(State(_state): State<crate::server::AppState>) -> Json<Value> {
    let config = match config_manager::load_config() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Failed to load config for /im/config: {e}");
            config_manager::SmartLayerConfig::default()
        }
    };

    let mut im_json = serde_json::to_value(&config.im).unwrap_or_else(|_| json!({}));
    // Never expose the raw app_secret over HTTP. Replace a non-empty secret with
    // a mask placeholder; the frontend treats the mask as "configured, unchanged"
    // and skips it on save so the stored value is preserved.
    if let Some(secret) = im_json
        .get_mut("feishu")
        .and_then(|f| f.get_mut("app_secret"))
        && secret.as_str().is_some_and(|s| !s.is_empty()) {
            *secret = Value::String("\u{2022}\u{2022}\u{2022}\u{2022}".to_string());
        }
    Json(im_json)
}

/// POST /im/config — validates Feishu credentials, then saves IM configuration.
///
/// Validation happens BEFORE persisting: a config that cannot pass Feishu
/// auth + long-connection probe is rejected and nothing is written to disk.
async fn set_im_config(
    State(state): State<crate::server::AppState>,
    Json(env_vars): Json<HashMap<String, String>>,
) -> Json<Value> {
    use duo_types::env_keys::im as im_keys;

    // Resolve effective Feishu credentials: payload wins; omitted/empty fields
    // inherit currently-stored values (the frontend omits the masked secret).
    let existing = config_manager::load_config()
        .ok()
        .and_then(|c| c.im.feishu);
    let pick = |key: &str| {
        env_vars
            .get(key)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let app_id = pick(im_keys::FEISHU_APP_ID)
        .or_else(|| existing.as_ref().map(|f| f.app_id.clone()))
        .unwrap_or_default();
    // `GET /im/config` hands out a mask; the UI echoes it back when the field
    // was left untouched. Taking it literally would fail validation (or store
    // "••••" as the real secret) on every unrelated save.
    let app_secret = pick(im_keys::FEISHU_APP_SECRET)
        .filter(|s| s.as_str() != config_manager::SECRET_MASK)
        .or_else(|| existing.as_ref().map(|f| f.app_secret.clone()))
        .unwrap_or_default();
    let domain = pick(im_keys::FEISHU_DOMAIN)
        .or_else(|| existing.as_ref().map(|f| f.domain.clone()))
        .unwrap_or_else(|| "feishu".to_string());

    // Validated Feishu config, kept for the post-save welcome broadcast.
    let mut validated_feishu: Option<im_bridge::config::FeishuConfig> = None;

    match (app_id.is_empty(), app_secret.is_empty()) {
        // Both present: validate against Feishu before saving.
        (false, false) => {
            let candidate = im_bridge::config::FeishuConfig {
                app_id,
                app_secret,
                domain,
            };
            if let Err(e) = im_bridge::feishu::validate_credentials(&candidate).await {
                tracing::warn!("Feishu credential validation failed: {e}");
                return Json(json!({ "success": false, "error": e.to_string() }));
            }
            validated_feishu = Some(candidate);
        }
        // Neither present: no Feishu involved (e.g. notify toggle only) — allow.
        (true, true) => {}
        // One of the two missing: incomplete credentials.
        _ => {
            return Json(json!({
                "success": false,
                "error": "App ID 与 App Secret 必须同时填写"
            }));
        }
    }

    match config_manager::save_im_config(&env_vars) {
        Ok(()) => {
            let config = config_manager::load_config()
                .map(|cfg| cfg.im)
                .unwrap_or_else(|_| im_bridge::config::ImConfig::from_env());
            let restart_result = crate::im_runtime::start_or_restart(config, state).await;
            match restart_result {
                Ok(()) => {
                    // Onboarding: after a successful save + bridge restart,
                    // proactively broadcast the welcome card (usage guide +
                    // operation buttons) to every chat the bot has interacted
                    // with so far. This product is driven from 1-on-1 (P2P)
                    // chats with the bot, and Feishu's chat-listing API cannot
                    // enumerate P2P chats (and needs the `im:chat` permission
                    // for groups), so we rely on the chat registry that is
                    // populated the moment a user opens/sends a message to the
                    // bot. Fire-and-forget: onboarding must never fail the save.
                    if let Some(feishu_cfg) = validated_feishu {
                        tokio::spawn(async move {
                            let api = im_bridge::feishu::FeishuApiClient::new(feishu_cfg);
                            let targets = im_bridge::feishu::known_chat_ids();
                            if targets.is_empty() {
                                tracing::info!(
                                    "Feishu welcome broadcast skipped: bot has not yet been \
                                     contacted in any chat. Open the bot or send a message \
                                     first, then save again to onboard."
                                );
                                return;
                            }
                            let total = targets.len();
                            let mut sent = 0usize;
                            for chat_id in targets {
                                match api.send_welcome_card(&chat_id).await {
                                    Ok(()) => sent += 1,
                                    Err(e) => tracing::warn!(
                                        chat_id = %chat_id,
                                        error = %e,
                                        "Failed to send welcome card"
                                    ),
                                }
                            }
                            tracing::info!(sent, total, "Feishu welcome broadcast done");
                        });
                    }
                    Json(json!({
                        "success": true,
                        "message": "IM config saved and Feishu bridge restarted."
                    }))
                }
                Err(e) => Json(json!({
                    "success": false,
                    "error": format!("IM config saved but restart failed: {}", e)
                })),
            }
        }
        Err(e) => {
            tracing::error!("Failed to save IM config: {e}");
            Json(json!({
                "success": false,
                "error": e.to_string()
            }))
        }
    }
}

#[derive(Debug, Deserialize)]
struct ImNotifyDiff {
    file: String,
    additions: i64,
    deletions: i64,
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImNotifyRequest {
    project_path: Option<String>,
    chat_id: Option<String>,
    session_id: String,
    summary: String,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    diffs: Vec<ImNotifyDiff>,
}

/// POST /im/notify — push a task completion notification to a bound Feishu chat.
async fn notify_feishu(
    State(state): State<crate::server::AppState>,
    Json(req): Json<ImNotifyRequest>,
) -> Json<Value> {
    let chat_id = if let Some(chat_id) = req.chat_id.clone() {
        Some(chat_id)
    } else if let Some(project_path) = req.project_path.as_ref() {
        state
            .im_project_chats
            .lock()
            .await
            .get(project_path)
            .cloned()
    } else {
        None
    };

    let Some(chat_id) = chat_id else {
        return Json(json!({
            "success": false,
            "notified": false,
            "reason": "no bound Feishu chat for project"
        }));
    };

    let files = if req.files.is_empty() && !req.diffs.is_empty() {
        format_diff_files(&req.diffs)
    } else {
        req.files
    };

    let _ = state
        .sse_event_tx
        .send(im_bridge::sse_bridge::SseEvent::AgentTaskCompleted {
            session_id: req.session_id,
            chat_id: Some(chat_id),
            files,
            summary: req.summary,
        });

    Json(json!({ "success": true, "notified": true }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectTaskReleaseRequest {
    project_path: String,
    task_id: String,
    state: Option<ProjectTaskState>,
}

async fn acquire_project_task(
    State(state): State<crate::server::AppState>,
    Json(task): Json<crate::project_tasks::ProjectTask>,
) -> Json<Value> {
    match state.project_tasks.acquire(task).await {
        Ok(()) => Json(json!({ "success": true })),
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

async fn release_project_task(
    State(state): State<crate::server::AppState>,
    Json(req): Json<ProjectTaskReleaseRequest>,
) -> Json<Value> {
    let released = state
        .project_tasks
        .release_with_state(
            &req.project_path,
            &req.task_id,
            req.state.unwrap_or(ProjectTaskState::Completed),
        )
        .await;
    Json(json!({ "success": true, "released": released }))
}

async fn project_task_status(State(state): State<crate::server::AppState>) -> Json<Value> {
    Json(serde_json::to_value(state.project_tasks.status().await).unwrap_or_else(|_| json!({})))
}

/// Format git-style diffs into human-readable file change lines.
/// Extracted from `notify_feishu` so the formatting is independently testable.
fn format_diff_files(diffs: &[ImNotifyDiff]) -> Vec<String> {
    diffs
        .iter()
        .map(|d| {
            format!(
                "{} (+{} -{}{})",
                d.file,
                d.additions,
                d.deletions,
                d.status
                    .as_ref()
                    .map(|s| format!(", {}", s))
                    .unwrap_or_default()
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn im_notify_diff_deserializes_camel_case_files() {
        // `ImNotifyRequest.files` is Vec<String>; verify round-trip of that shape.
        let json = r#"{"sessionId":"s1","summary":"done","files":["src/main.rs","README.md"],"chatId":"oc_1","diffs":[]}"#;
        let req: ImNotifyRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.files, vec!["src/main.rs".to_string(), "README.md".to_string()]);
        assert_eq!(req.chat_id.as_deref(), Some("oc_1"));
    }

    #[test]
    fn im_notify_diff_deserializes_camel_case_with_optional_status() {
        let json = r#"{"file":"a.rs","additions":5,"deletions":2,"status":"modified"}"#;
        let d: ImNotifyDiff = serde_json::from_str(json).unwrap();
        assert_eq!(d.file, "a.rs");
        assert_eq!(d.additions, 5);
        assert_eq!(d.status.as_deref(), Some("modified"));

        // status optional
        let json2 = r#"{"file":"b.rs","additions":0,"deletions":0}"#;
        let d2: ImNotifyDiff = serde_json::from_str(json2).unwrap();
        assert!(d2.status.is_none());
    }

    #[test]
    fn im_notify_request_prefers_explicit_chat_id() {
        let json = r#"{"chatId":"oc_abc","projectPath":"/p","sessionId":"s1","summary":"done"}"#;
        let req: ImNotifyRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.chat_id.as_deref(), Some("oc_abc"));
        assert_eq!(req.project_path.as_deref(), Some("/p"));
        assert_eq!(req.session_id, "s1");
    }

    #[test]
    fn format_diff_files_includes_status_suffix_when_present() {
        let diffs = vec![
            ImNotifyDiff {
                file: "src/main.rs".to_string(),
                additions: 10,
                deletions: 4,
                status: Some("modified".to_string()),
            },
            ImNotifyDiff {
                file: "README.md".to_string(),
                additions: 1,
                deletions: 0,
                status: None,
            },
        ];
        let files = format_diff_files(&diffs);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0], "src/main.rs (+10 -4, modified)");
        assert_eq!(files[1], "README.md (+1 -0)");
    }

    #[test]
    fn format_diff_files_empty_on_empty_input() {
        assert!(format_diff_files(&[]).is_empty());
    }

    #[test]
    fn router_constructs_without_panic() {
        // Builds the public Router (handler wiring + method/path registration).
        // A panic here (e.g. a renamed endpoint or mismatched handler arity)
        // would surface as a compile/construct failure, catching regressions in
        // the IM route table without requiring a live AppState.
        let _r = router();
    }
}
