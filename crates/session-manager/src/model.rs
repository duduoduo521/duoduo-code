//! Session model types.
//!
//! Extends `duo_types::SessionInfo` with additional fields needed by
//! the session-manager crate. TS schema fields (18 columns) are persisted
//! to the `session` table; Rust-only fields are kept in-memory only.

use chrono::Utc;
pub use duo_types::SessionState;
use duo_types::{SessionCreateRequest, SessionInfo};
use serde::{Deserialize, Serialize};

/// Extended session information with additional tracking fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtendedSessionInfo {
    // TS schema fields (19 columns in session table)
    pub id: String,
    pub project_id: String,
    pub workspace_id: Option<String>,
    pub parent_id: Option<String>,
    pub slug: String,
    pub directory: String,
    pub title: String,
    pub version: String,
    pub summary_additions: Option<i64>,
    pub summary_deletions: Option<i64>,
    pub summary_files: Option<i64>,
    pub summary_diffs: Option<String>,
    pub revert: Option<String>,
    pub permission: Option<String>,
    pub time_created: i64,
    pub time_updated: i64,
    pub time_compacting: Option<i64>,
    pub time_archived: Option<i64>,
    // Rust-only fields (in-memory only, not in DB)
    pub state: SessionState,
    pub message_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipeline_id: Option<String>,
}

impl ExtendedSessionInfo {
    /// Create a new `ExtendedSessionInfo` from a `SessionCreateRequest`.
    ///
    /// The session starts in `SessionState::Active` with `message_count = 0`.
    /// Timestamps are millisecond-precision i64 from `Utc::now()`.
    pub fn from_request(req: &SessionCreateRequest) -> Self {
        let now = Utc::now().timestamp_millis();
        let id = req
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        Self {
            id: id.clone(),
            project_id: req.project_id.clone(),
            workspace_id: None,
            parent_id: req.parent_id.clone(),
            slug: id.clone(),
            directory: req.project_id.clone(),
            title: format!("Session {}", &id[..8]),
            version: "1".to_string(),
            summary_additions: None,
            summary_deletions: None,
            summary_files: None,
            summary_diffs: None,
            revert: None,
            permission: None,
            time_created: now,
            time_updated: now,
            time_compacting: None,
            time_archived: None,
            state: SessionState::Active,
            message_count: 0,
            metadata: req.metadata.clone(),
            pipeline_id: None,
        }
    }

    /// Convert to the base `SessionInfo` defined in `duo_types`.
    pub fn to_session_info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            project_id: self.project_id.clone(),
            state: self.state.clone(),
            time_created: self.time_created,
            metadata: self.metadata.clone(),
        }
    }

    /// Touch the `time_updated` timestamp to the current time.
    pub fn touch_updated_at(&mut self) {
        self.time_updated = Utc::now().timestamp_millis();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_request_sets_active_state() {
        let req = SessionCreateRequest {
            id: None,
            project_id: "/tmp/test".to_string(),
            parent_id: None,
            metadata: None,
        };
        let info = ExtendedSessionInfo::from_request(&req);
        assert_eq!(info.state, SessionState::Active);
        assert_eq!(info.message_count, 0);
        assert_eq!(info.project_id, "/tmp/test");
        assert!(!info.id.is_empty());
        assert_eq!(info.time_created, info.time_updated);
    }

    #[test]
    fn from_request_with_metadata() {
        let meta = serde_json::json!({ "key": "value" });
        let req = SessionCreateRequest {
            id: None,
            project_id: "/tmp/test".to_string(),
            parent_id: None,
            metadata: Some(meta.clone()),
        };
        let info = ExtendedSessionInfo::from_request(&req);
        assert_eq!(info.metadata, Some(meta));
    }

    #[test]
    fn from_request_with_explicit_id() {
        let req = SessionCreateRequest {
            id: Some("ses_custom_123".to_string()),
            project_id: "/tmp/test".to_string(),
            parent_id: None,
            metadata: None,
        };
        let info = ExtendedSessionInfo::from_request(&req);
        assert_eq!(info.id, "ses_custom_123");
        assert_eq!(info.slug, "ses_custom_123");
    }

    #[test]
    fn to_session_info_roundtrip() {
        let req = SessionCreateRequest {
            id: None,
            project_id: "/tmp/test".to_string(),
            parent_id: None,
            metadata: None,
        };
        let ext = ExtendedSessionInfo::from_request(&req);
        let base = ext.to_session_info();
        assert_eq!(base.id, ext.id);
        assert_eq!(base.project_id, ext.project_id);
        assert_eq!(base.state, ext.state);
        assert_eq!(base.time_created, ext.time_created);
        assert_eq!(base.metadata, ext.metadata);
    }

    #[test]
    fn touch_updated_at_changes_timestamp() {
        let req = SessionCreateRequest {
            id: None,
            project_id: "/tmp/test".to_string(),
            parent_id: None,
            metadata: None,
        };
        let mut info = ExtendedSessionInfo::from_request(&req);
        let original = info.time_updated;
        // Small sleep to ensure timestamp differs
        std::thread::sleep(std::time::Duration::from_millis(10));
        info.touch_updated_at();
        assert_ne!(info.time_updated, original);
    }
}
