//! SmartLayerBridge trait definition.
//!
//! This trait abstracts the capabilities needed by the Feishu IM adapter
//! without depending on duo-smart-layer directly.

use async_trait::async_trait;
use duo_types::ClarificationResult;

use crate::sse_bridge::SseEvent;

/// Contract marker: when a bridge reply contains this substring, the WS
/// dispatcher (`feishu::ws`) sends a project selection card to the chat.
/// duo-smart-layer must embed this exact string in "no project bound"
/// replies — reference this constant instead of a string literal.
pub const NEEDS_PROJECT_MARKER: &str = "请先选择项目";

/// Contract marker: when a bridge reply contains this substring, the WS
/// dispatcher (`feishu::ws`) sends a model selection card to the chat.
/// Mirrors `NEEDS_PROJECT_MARKER`; duo-smart-layer embeds this exact
/// string in "no model selected" replies.
pub const NEEDS_MODEL_MARKER: &str = "请先选择模型";

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectInfo {
    pub token: String,
    pub name: String,
}

/// A selectable model exposed to Feishu cards. `display_name` is the human
/// readable button label (`provider/model`), the two ids are what the
/// `prompt_async` body needs.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelInfo {
    pub provider_id: String,
    pub model_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone)]
pub struct FeishuCardAction {
    pub chat_id: String,
    pub action: String,
    pub project_token: Option<String>,
    /// Selected model provider id (from a `select_model` card action).
    pub model_provider: Option<String>,
    /// Selected model id (from a `select_model` card action).
    pub model_id: Option<String>,
    /// User input from card form (input/textarea). Parsed from action.form_value.
    pub prompt: Option<String>,
    /// Message ID of the last card sent to this chat (for PATCH updates).
    pub message_id: Option<String>,
}

/// Bridge trait for IM adapters to call smart-layer core methods.
#[async_trait]
pub trait SmartLayerBridge: Send + Sync + 'static {
    /// Legacy structured intent result. Kept for existing non-IM callers/tests;
    /// Feishu IM natural language must not use this for routing.
    fn clarify_intent_result(&self, text: &str) -> anyhow::Result<ClarificationResult>;

    /// Handle natural language text from Feishu.
    async fn handle_feishu_text(&self, chat_id: &str, text: &str) -> anyhow::Result<String> {
        self.execute_agent_with_chat(text, chat_id).await
    }

    /// Show or bind a project for the Feishu chat.
    async fn handle_feishu_project(
        &self,
        _chat_id: &str,
        path: Option<&str>,
    ) -> anyhow::Result<String> {
        if let Some(path) = path {
            self.set_llm_config("project_path", path);
            Ok(format!("✅ 已绑定项目: {}", path))
        } else {
            Ok("请在项目选择卡片中选择项目".to_string())
        }
    }

    /// Handle Feishu interactive card actions.
    async fn handle_feishu_card_action(&self, action: FeishuCardAction) -> anyhow::Result<String> {
        match action.action.as_str() {
            "select_project" => {
                Ok("项目选择能力正在初始化，请稍后重试或重新选择项目。".to_string())
            }
            _ => Ok(String::new()),
        }
    }

    /// Abort current Feishu task.
    async fn abort_feishu_task(&self, _chat_id: &str) -> anyhow::Result<String> {
        Ok("当前没有可中止的飞书任务".to_string())
    }

    /// Current Feishu task status.
    async fn get_feishu_status(&self, _chat_id: &str) -> anyhow::Result<String> {
        Ok("当前没有运行中的飞书任务".to_string())
    }

    /// List selectable IDE projects for Feishu cards.
    async fn list_ide_projects(&self, _chat_id: &str) -> anyhow::Result<Vec<ProjectInfo>> {
        Ok(vec![])
    }

    /// List selectable models for Feishu model-selection cards.
    /// Defaults to empty; duo-smart-layer implements this from the Node
    /// `/provider` endpoint so the card reflects the actually available models.
    async fn list_models(&self, _chat_id: &str) -> anyhow::Result<Vec<ModelInfo>> {
        Ok(vec![])
    }

    /// Execute an AI agent prompt asynchronously.
    async fn execute_agent(&self, prompt: &str) -> anyhow::Result<String>;



    /// Execute a lightweight direct Agent prompt. This is retained for explicit
    /// `/agent` compatibility and delegates to the Feishu text flow by default.
    async fn execute_agent_with_chat(
        &self,
        prompt: &str,
        _chat_id: &str,
    ) -> anyhow::Result<String> {
        self.execute_agent(prompt).await
    }

    /// Set the LLM configuration.
    fn set_llm_config(&self, key: &str, value: &str);

    /// Check if LLM is configured.
    fn is_llm_configured(&self) -> bool;



    /// Subscribe to IM notification events.
    fn subscribe_events(&self) -> tokio::sync::broadcast::Receiver<SseEvent>;
}
