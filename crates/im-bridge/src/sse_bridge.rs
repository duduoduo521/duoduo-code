//! IM notification event types bridged from duo-smart-layer to Feishu.

use serde::{Deserialize, Serialize};

/// Event payload pushed from duo-smart-layer to IM adapters.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SseEvent {
    AgentTaskStarted {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        chat_id: Option<String>,
        summary: String,
    },
    AgentTaskQueued {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        chat_id: Option<String>,
        summary: String,
        position: usize,
    },
    AgentTaskCompleted {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        chat_id: Option<String>,
        files: Vec<String>,
        summary: String,
    },
    AgentTaskFailed {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        chat_id: Option<String>,
        error: String,
    },

    /// Subagent task started (Rust-side subagent execution).
    SubagentStarted {
        parent_session_id: String,
        child_session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        chat_id: Option<String>,
        subagent_type: String,
        description: String,
    },
    /// Subagent task completed.
    SubagentDone {
        parent_session_id: String,
        child_session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        chat_id: Option<String>,
    },

    /// Quality check result. Kept for existing smart-layer quality signals.
    QualityCheckUpdate {
        pipeline_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        chat_id: Option<String>,
        current_stage: String,
        status: String,
        quality_report: String,
    },

    /// LLM assistant reply destined for a specific Feishu chat, carrying the
    /// full reply text. Consumed by `im-bridge` to push the actual answer back
    /// to Feishu (the lifecycle cards only carry status/summaries).
    FeishuReply {
        chat_id: String,
        text: String,
    },
}

/// Format an event into a human-readable IM push message.
pub fn format_sse_event(event: &SseEvent) -> String {
    match event {
        SseEvent::AgentTaskStarted { summary, .. } => format!("🔄 任务已开始\n{}", summary),
        SseEvent::AgentTaskQueued {
            summary, position, ..
        } => {
            format!("⏳ 任务已加入队列（第 {} 位）\n{}", position, summary)
        }
        SseEvent::AgentTaskCompleted { files, summary, .. } => {
            let files_text = if files.is_empty() {
                "无文件列表".to_string()
            } else {
                files
                    .iter()
                    .map(|f| format!("- `{}`", f))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            format!("✅ 任务完成\n\n{}\n\n文件:\n{}", summary, files_text)
        }
        SseEvent::AgentTaskFailed { error, .. } => format!("❌ 任务失败\n{}", error),
        SseEvent::SubagentStarted {
            subagent_type,
            description,
            ..
        } => format!(
            "🔍 子Agent已启动\n类型: {}\n描述: {}",
            subagent_type, description
        ),
        SseEvent::SubagentDone { .. } => "✅ 子Agent完成".to_string(),
        SseEvent::QualityCheckUpdate { current_stage, .. } => {
            format!("🔍 QA 检测完成 — `{}`", current_stage)
        }
        SseEvent::FeishuReply { text, .. } => text.clone(),
    }
}

impl SseEvent {
    /// Extract the chat_id from any variant.
    pub fn chat_id(&self) -> Option<&str> {
        match self {
            Self::AgentTaskStarted { chat_id, .. }
            | Self::AgentTaskQueued { chat_id, .. }
            | Self::AgentTaskCompleted { chat_id, .. }
            | Self::AgentTaskFailed { chat_id, .. }
            | Self::QualityCheckUpdate { chat_id, .. }
            | Self::SubagentStarted { chat_id, .. }
            | Self::SubagentDone { chat_id, .. } => chat_id.as_deref(),
            Self::FeishuReply { chat_id, .. } => Some(chat_id.as_str()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn completed(files: Vec<String>, chat_id: Option<String>) -> SseEvent {
        SseEvent::AgentTaskCompleted {
            session_id: "s1".into(),
            chat_id,
            files,
            summary: "已修复登录问题".into(),
        }
    }

    #[test]
    fn format_completed_lists_files_backticked() {
        let msg = format_sse_event(&completed(
            vec!["src/a.rs".into(), "src/b.rs".into()],
            None,
        ));
        assert!(msg.starts_with("✅ 任务完成"));
        assert!(msg.contains("已修复登录问题"));
        assert!(msg.contains("- `src/a.rs`"));
        assert!(msg.contains("- `src/b.rs`"));
    }

    #[test]
    fn format_completed_without_files_shows_placeholder() {
        let msg = format_sse_event(&completed(vec![], None));
        assert!(msg.contains("无文件列表"));
    }

    #[test]
    fn format_covers_all_lifecycle_variants() {
        let started = SseEvent::AgentTaskStarted {
            session_id: "s".into(),
            chat_id: None,
            summary: "任务A".into(),
        };
        assert_eq!(format_sse_event(&started), "🔄 任务已开始\n任务A");

        let queued = SseEvent::AgentTaskQueued {
            session_id: "s".into(),
            chat_id: None,
            summary: "任务B".into(),
            position: 2,
        };
        assert_eq!(format_sse_event(&queued), "⏳ 任务已加入队列（第 2 位）\n任务B");

        let failed = SseEvent::AgentTaskFailed {
            session_id: "s".into(),
            chat_id: None,
            error: "boom".into(),
        };
        assert_eq!(format_sse_event(&failed), "❌ 任务失败\nboom");

        let sub_started = SseEvent::SubagentStarted {
            parent_session_id: "p".into(),
            child_session_id: "c".into(),
            chat_id: None,
            subagent_type: "explorer".into(),
            description: "扫描仓库".into(),
        };
        assert!(format_sse_event(&sub_started).contains("类型: explorer"));

        let sub_done = SseEvent::SubagentDone {
            parent_session_id: "p".into(),
            child_session_id: "c".into(),
            chat_id: None,
        };
        assert_eq!(format_sse_event(&sub_done), "✅ 子Agent完成");

        let qa = SseEvent::QualityCheckUpdate {
            pipeline_id: "pl".into(),
            chat_id: None,
            current_stage: "lint".into(),
            status: "ok".into(),
            quality_report: "r".into(),
        };
        assert_eq!(format_sse_event(&qa), "🔍 QA 检测完成 — `lint`");
    }

    #[test]
    fn chat_id_extraction_across_variants() {
        assert_eq!(
            completed(vec![], Some("oc_1".into())).chat_id(),
            Some("oc_1")
        );
        assert_eq!(completed(vec![], None).chat_id(), None);
        let failed = SseEvent::AgentTaskFailed {
            session_id: "s".into(),
            chat_id: Some("oc_2".into()),
            error: "e".into(),
        };
        assert_eq!(failed.chat_id(), Some("oc_2"));
    }

    #[test]
    fn serde_uses_type_tag_and_omits_none_chat_id() {
        let json = serde_json::to_value(completed(vec!["f".into()], None)).unwrap();
        assert_eq!(json["type"], "AgentTaskCompleted");
        assert!(json.get("chat_id").is_none(), "None chat_id must be omitted");

        // Round-trip with chat_id present.
        let json = serde_json::to_string(&completed(vec![], Some("oc_9".into()))).unwrap();
        let back: SseEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(back.chat_id(), Some("oc_9"));
    }
}
