use serde::{Deserialize, Serialize};
use std::collections::HashMap;

fn default_retry_count() -> u32 {
    2
}

// ─── Output Format ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum OutputFormat {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "json_schema")]
    JsonSchema {
        schema: serde_json::Value,
        #[serde(rename = "retryCount", default = "default_retry_count")]
        retry_count: u32,
    },
}

// ─── MessageInfo ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMessageTime {
    pub created: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMessageSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub diffs: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMessageModel {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(rename = "modelID")]
    pub model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMessageInfo {
    pub id: String,
    #[serde(rename = "sessionID")]
    pub session_id: String,
    pub time: UserMessageTime,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<OutputFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<UserMessageSummary>,
    pub agent: String,
    pub model: UserMessageModel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<HashMap<String, bool>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantMessageTime {
    pub created: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantMessagePath {
    pub cwd: String,
    pub root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenCacheInfo {
    pub read: f64,
    pub write: f64,
}

/// Token breakdown by category for context display.
/// Populated by Rust run_loop_handler after LlmRequest assembly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenBreakdown {
    /// Message history (user + assistant + tool result)
    pub messages: f64,
    /// System prompt
    #[serde(rename = "systemPrompt")]
    pub system_prompt: f64,
    /// Tool definitions (tools JSON schema)
    pub tools: f64,
    /// Skills (subset of system prompt)
    pub skills: f64,
    /// Other (formatting overhead, uncategorised)
    pub other: f64,
    /// Whether `messages`/`system_prompt`/`tools`/`skills` are heuristic estimates
    /// (true) or exact (false). Currently always `Some(true)` because the
    /// per-category counts are produced by `estimate_tokens`, only `other` is
    /// calibrated against the real `prompt_tokens`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<f64>,
    pub input: f64,
    pub output: f64,
    pub reasoning: f64,
    pub cache: TokenCacheInfo,
    /// Token breakdown by category (backward compatible, old messages have None)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub breakdown: Option<TokenBreakdown>,
    /// Cache hit rate 0.0~100.0 (backward compatible, old messages have None)
    #[serde(rename = "cacheHitRate", default, skip_serializing_if = "Option::is_none")]
    pub cache_hit_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantMessageInfo {
    pub id: String,
    #[serde(rename = "sessionID")]
    pub session_id: String,
    pub time: AssistantMessageTime,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,
    #[serde(rename = "parentID")]
    pub parent_id: String,
    #[serde(rename = "modelID")]
    pub model_id: String,
    #[serde(rename = "providerID")]
    pub provider_id: String,
    pub mode: String,
    pub agent: String,
    pub path: AssistantMessagePath,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<bool>,

    pub tokens: TokenInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role")]
pub enum MessageInfo {
    #[serde(rename = "user")]
    User(UserMessageInfo),
    #[serde(rename = "assistant")]
    Assistant(AssistantMessageInfo),
}

// ─── Part Base ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartBase {
    pub id: String,
    #[serde(rename = "sessionID")]
    pub session_id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartTime {
    pub start: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatedTime {
    pub created: f64,
}

// ─── Part Data ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextPartData {
    #[serde(flatten)]
    pub base: PartBase,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synthetic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignored: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<PartTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReasoningPartData {
    #[serde(flatten)]
    pub base: PartBase,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, serde_json::Value>>,
    pub time: PartTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilePartSourceText {
    pub value: String,
    pub start: i64,
    pub end: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSourceData {
    pub path: String,
    pub text: FilePartSourceText,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolSourceData {
    pub path: String,
    pub range: serde_json::Value,
    pub name: String,
    pub kind: i64,
    pub text: FilePartSourceText,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceSourceData {
    #[serde(rename = "clientName")]
    pub client_name: String,
    pub uri: String,
    pub text: FilePartSourceText,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum FilePartSource {
    #[serde(rename = "file")]
    File(FileSourceData),
    #[serde(rename = "symbol")]
    Symbol(SymbolSourceData),
    #[serde(rename = "resource")]
    Resource(ResourceSourceData),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilePartData {
    #[serde(flatten)]
    pub base: PartBase,
    pub mime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<FilePartSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPartSource {
    pub value: String,
    pub start: i64,
    pub end: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPartData {
    #[serde(flatten)]
    pub base: PartBase,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<AgentPartSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtaskPartModel {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(rename = "modelID")]
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtaskPartData {
    #[serde(flatten)]
    pub base: PartBase,
    pub prompt: String,
    pub description: String,
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<SubtaskPartModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotPartData {
    #[serde(flatten)]
    pub base: PartBase,
    pub snapshot: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchPartData {
    #[serde(flatten)]
    pub base: PartBase,
    pub hash: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepStartPartData {
    #[serde(flatten)]
    pub base: PartBase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepFinishPartData {
    #[serde(flatten)]
    pub base: PartBase,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<String>,

    pub tokens: TokenInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryPartData {
    #[serde(flatten)]
    pub base: PartBase,
    pub attempt: f64,
    pub error: serde_json::Value,
    pub time: CreatedTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactionPartData {
    #[serde(flatten)]
    pub base: PartBase,
    pub auto: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overflow: Option<bool>,
    #[serde(
        rename = "tail_start_id",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub tail_start_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedComment {
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub line: f64,
    pub comment: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
    #[serde(rename = "originalLine")]
    pub original_line: f64,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewPartData {
    #[serde(flatten)]
    pub base: PartBase,
    pub comments: Vec<ResolvedComment>,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

// ─── Tool State ───────────────────────────────────────────────────────────

pub type ToolInput = HashMap<String, serde_json::Value>;
pub type ToolMetadata = HashMap<String, serde_json::Value>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolTimeStart {
    pub start: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolTimeCompleted {
    pub start: f64,
    pub end: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compacted: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status")]
pub enum ToolState {
    #[serde(rename = "pending")]
    Pending { input: ToolInput, raw: String },
    #[serde(rename = "running")]
    Running {
        input: ToolInput,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metadata: Option<ToolMetadata>,
        time: ToolTimeStart,
    },
    #[serde(rename = "completed")]
    Completed {
        input: ToolInput,
        output: String,
        title: String,
        metadata: ToolMetadata,
        time: ToolTimeCompleted,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attachments: Option<Vec<FilePartData>>,
    },
    #[serde(rename = "error")]
    Error {
        input: ToolInput,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metadata: Option<ToolMetadata>,
        time: ToolTimeCompleted,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolPartData {
    #[serde(flatten)]
    pub base: PartBase,
    #[serde(rename = "callID")]
    pub call_id: String,
    pub tool: String,
    pub state: ToolState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ToolMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PartData {
    #[serde(rename = "text")]
    Text(TextPartData),
    #[serde(rename = "subtask")]
    Subtask(SubtaskPartData),
    #[serde(rename = "reasoning")]
    Reasoning(ReasoningPartData),
    #[serde(rename = "file")]
    File(FilePartData),
    #[serde(rename = "tool")]
    Tool(ToolPartData),
    #[serde(rename = "step-start")]
    StepStart(StepStartPartData),
    #[serde(rename = "step-finish")]
    StepFinish(StepFinishPartData),
    #[serde(rename = "snapshot")]
    Snapshot(SnapshotPartData),
    #[serde(rename = "patch")]
    Patch(PatchPartData),
    #[serde(rename = "agent")]
    Agent(AgentPartData),
    #[serde(rename = "retry")]
    Retry(RetryPartData),
    #[serde(rename = "compaction")]
    Compaction(CompactionPartData),
    #[serde(rename = "review")]
    Review(ReviewPartData),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> PartBase {
        PartBase {
            id: "part-1".into(),
            session_id: "sess-1".into(),
            message_id: "msg-1".into(),
        }
    }

    fn tokens() -> TokenInfo {
        TokenInfo {
            total: Some(3.0),
            input: 1.0,
            output: 1.0,
            reasoning: 0.0,
            cache: TokenCacheInfo {
                read: 0.0,
                write: 0.0,
            },
            breakdown: None,
            cache_hit_rate: None,
        }
    }

    #[test]
    fn user_message_info_roundtrip() {
        let msg = MessageInfo::User(UserMessageInfo {
            id: "msg-1".into(),
            session_id: "sess-1".into(),
            time: UserMessageTime { created: 1.0 },
            format: Some(OutputFormat::Text),
            summary: Some(UserMessageSummary {
                title: None,
                body: None,
                diffs: vec![],
            }),
            agent: "build".into(),
            model: UserMessageModel {
                provider_id: "p".into(),
                model_id: "m".into(),
                variant: None,
            },
            system: None,
            locale: None,
            tools: Some(HashMap::from([("bash".into(), true)])),
        });
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["role"], "user");
        assert_eq!(json["sessionID"], "sess-1");
        let _: MessageInfo = serde_json::from_value(json).unwrap();
    }

    #[test]
    fn assistant_message_info_roundtrip() {
        let msg = MessageInfo::Assistant(AssistantMessageInfo {
            id: "msg-2".into(),
            session_id: "sess-1".into(),
            time: AssistantMessageTime {
                created: 1.0,
                completed: Some(2.0),
            },
            error: None,
            parent_id: "msg-1".into(),
            model_id: "m".into(),
            provider_id: "p".into(),
            mode: "build".into(),
            agent: "build".into(),
            path: AssistantMessagePath {
                cwd: "/tmp".into(),
                root: "/tmp".into(),
            },
            summary: Some(false),
            tokens: tokens(),
            structured: Some(json!({"ok": true})),
            variant: None,
            finish: Some("stop".into()),
        });
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["role"], "assistant");
        assert_eq!(json["parentID"], "msg-1");
        let _: MessageInfo = serde_json::from_value(json).unwrap();
    }

    #[test]
    fn all_part_variants_roundtrip() {
        let mut input = HashMap::new();
        input.insert("path".into(), json!("Cargo.toml"));
        let parts = vec![
            PartData::Text(TextPartData {
                base: base(),
                text: "hi".into(),
                synthetic: Some(true),
                ignored: None,
                time: Some(PartTime {
                    start: 1.0,
                    end: None,
                }),
                metadata: None,
            }),
            PartData::Subtask(SubtaskPartData {
                base: base(),
                prompt: "p".into(),
                description: "d".into(),
                agent: "a".into(),
                model: Some(SubtaskPartModel {
                    provider_id: "p".into(),
                    model_id: "m".into(),
                }),
                command: None,
            }),
            PartData::Reasoning(ReasoningPartData {
                base: base(),
                text: "r".into(),
                metadata: None,
                time: PartTime {
                    start: 1.0,
                    end: Some(2.0),
                },
            }),
            PartData::File(FilePartData {
                base: base(),
                mime: "text/plain".into(),
                filename: Some("a.txt".into()),
                url: "file://a".into(),
                source: None,
            }),
            PartData::Tool(ToolPartData {
                base: base(),
                call_id: "call-1".into(),
                tool: "bash".into(),
                state: ToolState::Pending {
                    input: input.clone(),
                    raw: "{}".into(),
                },
                metadata: None,
            }),
            PartData::StepStart(StepStartPartData {
                base: base(),
                snapshot: Some("s".into()),
            }),
            PartData::StepFinish(StepFinishPartData {
                base: base(),
                reason: "stop".into(),
                snapshot: None,
                tokens: tokens(),
            }),
            PartData::Snapshot(SnapshotPartData {
                base: base(),
                snapshot: "snap".into(),
            }),
            PartData::Patch(PatchPartData {
                base: base(),
                hash: "h".into(),
                files: vec!["a.rs".into()],
            }),
            PartData::Agent(AgentPartData {
                base: base(),
                name: "agent".into(),
                source: Some(AgentPartSource {
                    value: "x".into(),
                    start: 0,
                    end: 1,
                }),
            }),
            PartData::Retry(RetryPartData {
                base: base(),
                attempt: 1.0,
                error: json!({"message":"e"}),
                time: CreatedTime { created: 1.0 },
            }),
            PartData::Compaction(CompactionPartData {
                base: base(),
                auto: true,
                overflow: Some(false),
                tail_start_id: Some("msg-x".into()),
            }),
            PartData::Review(ReviewPartData {
                base: base(),
                comments: vec![ResolvedComment {
                    file_path: "a.rs".into(),
                    line: 1.0,
                    comment: "c".into(),
                    suggestion: None,
                    original_line: 1.0,
                    confidence: 0.9,
                }],
                summary: "s".into(),
                plan: None,
            }),
        ];
        let expected = [
            "text",
            "subtask",
            "reasoning",
            "file",
            "tool",
            "step-start",
            "step-finish",
            "snapshot",
            "patch",
            "agent",
            "retry",
            "compaction",
            "review",
        ];
        for (part, ty) in parts.into_iter().zip(expected) {
            let json = serde_json::to_value(&part).unwrap();
            assert_eq!(json["type"], ty);
            assert_eq!(json["sessionID"], "sess-1");
            assert_eq!(json["messageID"], "msg-1");
            let _: PartData = serde_json::from_value(json).unwrap();
        }
    }

    #[test]
    fn tool_state_variants_roundtrip() {
        let mut input = HashMap::new();
        input.insert("cmd".into(), json!("ls"));
        let states = vec![
            ToolState::Pending {
                input: input.clone(),
                raw: "{}".into(),
            },
            ToolState::Running {
                input: input.clone(),
                title: Some("Run".into()),
                metadata: None,
                time: ToolTimeStart { start: 1.0 },
            },
            ToolState::Completed {
                input: input.clone(),
                output: "ok".into(),
                title: "Done".into(),
                metadata: HashMap::new(),
                time: ToolTimeCompleted {
                    start: 1.0,
                    end: 2.0,
                    compacted: None,
                },
                attachments: None,
            },
            ToolState::Error {
                input,
                error: "bad".into(),
                metadata: None,
                time: ToolTimeCompleted {
                    start: 1.0,
                    end: 2.0,
                    compacted: None,
                },
            },
        ];
        for state in states {
            let json = serde_json::to_value(&state).unwrap();
            assert!(json.get("status").is_some());
            let _: ToolState = serde_json::from_value(json).unwrap();
        }
    }

    #[test]
    fn unknown_fields_ignored() {
        let json = json!({
            "type": "text",
            "id": "part-1",
            "sessionID": "sess-1",
            "messageID": "msg-1",
            "text": "hello",
            "unknownField": true
        });
        let part: PartData = serde_json::from_value(json).unwrap();
        match part {
            PartData::Text(t) => assert_eq!(t.text, "hello"),
            _ => panic!("expected text"),
        }
    }
}
