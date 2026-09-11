//! IM bridge configuration types.
//!
//! Supports Feishu (Lark) credentials loaded via environment variables.

use duo_types::env_keys::im;
use serde::{Deserialize, Serialize};

/// The `str::floor_char_boundary` inherent method (stable since Rust 1.87)
/// is used for all byte-boundary-safe truncation. See `feishu::ws` for usage.
///
/// Top-level IM configuration, embedded in [`SmartLayerConfig`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImConfig {
    /// Global on/off switch. Default `false`.
    #[serde(default)]
    pub enabled: bool,
    /// Feishu (Lark) configuration. `None` = Feishu disabled.
    #[serde(default)]
    pub feishu: Option<FeishuConfig>,
    /// Optional fallback project path for development/debugging.
    #[serde(default)]
    pub default_project_path: Option<String>,
    /// Notify configured Feishu chats when IDE tasks complete.
    #[serde(default)]
    pub notify_on_complete: bool,
}

impl ImConfig {
    /// Load IM configuration from environment variables.
    ///
    /// Env vars:
    /// - `DUO_IM_ENABLED` (bool, default false)
    /// - `DUO_IM_DEFAULT_PROJECT_PATH` (optional debug fallback)
    /// - `DUO_IM_NOTIFY_ON_COMPLETE` (bool, default false)
    /// - `DUO_IM_FEISHU_APP_ID` + `DUO_IM_FEISHU_APP_SECRET` (required for Feishu)
    /// - `DUO_IM_FEISHU_DOMAIN` ("feishu" | "lark", default "feishu")
    pub fn from_env() -> Self {
        let enabled = std::env::var(im::ENABLED)
            .ok()
            .and_then(|v| v.parse::<bool>().ok())
            .unwrap_or(false);

        let default_project_path = std::env::var(im::DEFAULT_PROJECT_PATH).ok();
        let notify_on_complete = std::env::var(im::NOTIFY_ON_COMPLETE)
            .ok()
            .and_then(|v| v.parse::<bool>().ok())
            .unwrap_or(false);

        let feishu = {
            let app_id = std::env::var(im::FEISHU_APP_ID).ok();
            let app_secret = std::env::var(im::FEISHU_APP_SECRET).ok();
            match (app_id, app_secret) {
                (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => {
                    let domain = std::env::var(im::FEISHU_DOMAIN)
                        .ok()
                        .filter(|d| !d.is_empty())
                        .unwrap_or_else(|| "feishu".to_string());
                    Some(FeishuConfig {
                        app_id: id,
                        app_secret: secret,
                        domain,
                    })
                }
                _ => None,
            }
        };

        Self {
            enabled,
            feishu,
            default_project_path,
            notify_on_complete,
        }
    }
}

/// Feishu / Lark credentials.
#[derive(Debug, Clone, Deserialize)]
pub struct FeishuConfig {
    pub app_id: String,
    pub app_secret: String,
    /// `"feishu"` or `"lark"`. Controls API domain.
    pub domain: String,
}

impl Serialize for FeishuConfig {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("FeishuConfig", 3)?;
        state.serialize_field("app_id", &self.app_id)?;
        let masked = if self.app_secret.chars().count() <= 8 {
            "***".to_string()
        } else {
            format!(
                "{}***{}",
                self.app_secret.chars().take(4).collect::<String>(),
                self.app_secret
                    .chars()
                    .rev()
                    .take(4)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            )
        };
        state.serialize_field("app_secret", &masked)?;
        state.serialize_field("domain", &self.domain)?;
        state.end()
    }
}

impl FeishuConfig {
    /// Base URL for Feishu/Lark Open APIs.
    pub fn api_base(&self) -> &str {
        // Allow tests (and self-hosted gateways) to inject an explicit base URL
        // by setting `domain` to a full http(s):// endpoint. Real deployments use
        // the short names "lark" / "feishu", which never start with a scheme.
        if self.domain.starts_with("https://") || self.domain.starts_with("http://") {
            return &self.domain;
        }
        match self.domain.as_str() {
            "lark" => "https://open.larksuite.com",
            _ => "https://open.feishu.cn",
        }
    }

    /// WS config endpoint URL.
    pub fn ws_config_url(&self) -> String {
        format!("{}/callback/ws/endpoint", self.api_base())
    }

    /// Tenant access token endpoint.
    pub fn token_url(&self) -> String {
        format!(
            "{}/open-apis/auth/v3/tenant_access_token/internal",
            self.api_base()
        )
    }

    /// Send message API endpoint.
    pub fn send_message_url(&self) -> String {
        format!("{}/open-apis/im/v1/messages", self.api_base())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_im_config_disabled() {
        let config = ImConfig::default();
        assert!(!config.enabled);
        assert!(config.feishu.is_none());
        assert!(config.default_project_path.is_none());
        assert!(!config.notify_on_complete);
    }

    #[test]
    fn feishu_api_base_feishu() {
        let config = FeishuConfig {
            app_id: "test".into(),
            app_secret: "secret".into(),
            domain: "feishu".into(),
        };
        assert_eq!(config.api_base(), "https://open.feishu.cn");
    }

    #[test]
    fn feishu_api_base_lark() {
        let config = FeishuConfig {
            app_id: "test".into(),
            app_secret: "secret".into(),
            domain: "lark".into(),
        };
        assert_eq!(config.api_base(), "https://open.larksuite.com");
    }
}
