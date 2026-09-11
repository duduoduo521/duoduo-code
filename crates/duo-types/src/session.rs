//! Session related types.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreateRequest {
    /// Optional session ID from the TS side. When provided, the session is
    /// registered under this exact ID (upsert). When absent, a UUID is generated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub project_id: String,
    /// Parent session ID for subagent sessions. When set, this session is a
    /// child of the specified parent (used by Rust-side subagent execution).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub project_id: String,
    pub state: SessionState,
    pub time_created: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Active,
    Idle,
    Closed,
}
