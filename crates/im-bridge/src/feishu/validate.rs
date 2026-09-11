//! Save-time credential validation for Feishu.
//!
//! Called by the settings "save" flow BEFORE persisting the config, so an
//! invalid App ID / App Secret (or an app without long-connection capability)
//! is rejected up front instead of failing silently in the background bridge.

use anyhow::{anyhow, bail};

use crate::config::FeishuConfig;

/// End-to-end validation of Feishu credentials.
///
/// 1. `tenant_access_token/internal` — proves the App ID / App Secret pair is
///    valid on the target domain (feishu / lark).
/// 2. `/callback/ws/endpoint` — proves the app can establish the WebSocket
///    long connection. This requires, in the Feishu developer console:
///    bot capability enabled, event subscription mode set to "long connection"
///    and the `im.message.receive_v1` event subscribed. Without it the bridge
///    never receives any chat message even though credentials are valid.
pub async fn validate_credentials(config: &FeishuConfig) -> anyhow::Result<()> {
    // Shared client (P1-32): same connect/overall timeout ladder as every
    // other Feishu outbound call — this used to build its own client with an
    // overall timeout but NO connect timeout, so a black-holed host stalled
    // the settings save flow for the full overall window.
    let http = super::api::http_client();

    // Step 1: credential check via tenant access token.
    let resp: serde_json::Value = http
        .post(config.token_url())
        .json(&serde_json::json!({
            "app_id": config.app_id,
            "app_secret": config.app_secret,
        }))
        .send()
        .await
        .map_err(|e| anyhow!("无法访问飞书开放平台（网络错误）: {e}"))?
        .json()
        .await
        .map_err(|e| anyhow!("飞书鉴权接口响应解析失败: {e}"))?;
    let code = resp.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 0 {
        let msg = resp.get("msg").and_then(|v| v.as_str()).unwrap_or("unknown");
        bail!("App ID / App Secret 校验失败（code={code}, msg={msg}），请核对飞书开放平台的应用凭证");
    }

    // Step 2: long-connection availability check (same endpoint the WS client
    // uses at startup).
    let resp: serde_json::Value = http
        .post(config.ws_config_url())
        .header("locale", "zh")
        .json(&serde_json::json!({
            "AppID": config.app_id,
            "AppSecret": config.app_secret,
        }))
        .send()
        .await
        .map_err(|e| anyhow!("无法访问飞书长连接分配接口（网络错误）: {e}"))?
        .json()
        .await
        .map_err(|e| anyhow!("飞书长连接接口响应解析失败: {e}"))?;
    let code = resp.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != super::proto::ERROR_CODE_OK {
        let msg = resp.get("msg").and_then(|v| v.as_str()).unwrap_or("unknown");
        bail!(
            "凭证有效，但无法建立长连接（code={code}, msg={msg}）。请在飞书开放平台确认：已开启机器人能力、事件订阅方式为「使用长连接接收事件」、已订阅 im.message.receive_v1（接收消息）事件，并发布应用版本"
        );
    }
    Ok(())
}
