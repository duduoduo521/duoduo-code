//! Memory related types.

use serde::{Deserialize, Serialize};

// ─── Memory System Types ───

/// Map a string layer name to its integer representation stored in SQLite.
///
/// Six-layer architecture (L0–L5):
/// - `"ephemeral"` / `"context"`   → 0  (L0: context assembly, never persisted)
/// - `"episode"` / `"short_term"`  → 1  (L1: episode / short-term memory)
/// - `"semantic"`                  → 2  (L2: semantic memory, importance ≥ 0.4)
/// - `"long_term"` / `"permanent"` → 3  (L3: permanent memory, importance ≥ 0.8 or pinned)
/// - `"profile"`                   → 4  (L4: user profile, stored in `core_memories` table)
/// - `"progressive"`               → 5  (L5: progressive memory, stored in `user_patterns` table)
/// - Numeric strings are parsed as integers.
/// - Unknown names default to 0.
///
/// Backward compatibility: `"short_term"` → 1 (was 2), `"ephemeral"` → 0 (was 1).
/// Old data must be migrated via `UPDATE memories SET layer = layer - 1 WHERE layer IN (1, 2)`.
pub fn layer_name_to_int(layer: &str) -> i32 {
    match layer {
        // L0 - 上下文组装（纯动态，不落盘）
        "ephemeral" | "context" => 0,
        // L1 - Episode/短期记忆
        "episode" | "short_term" => 1,
        // L2 - 语义记忆
        "semantic" => 2,
        // L3 - 永久记忆
        "long_term" | "permanent" => 3,
        // L4 - 用户档案（core_memories 表）
        "profile" => 4,
        // L5 - 渐进记忆（user_patterns 表）
        "progressive" => 5,
        // 数字字符串 fallback
        s => s.parse::<i32>().unwrap_or(0),
    }
}

/// Map an integer layer value from SQLite to a human-readable string name.
///
/// - 0 → `"ephemeral"`   (L0: context assembly)
/// - 1 → `"episode"`     (L1: short-term / episode memory)
/// - 2 → `"semantic"`    (L2: semantic memory)
/// - 3 → `"permanent"`   (L3: permanent memory)
/// - 4 → `"profile"`     (L4: user profile)
/// - 5 → `"progressive"` (L5: progressive memory)
/// - Other values are formatted as `"custom_N"`.
pub fn layer_int_to_name(layer: i32) -> String {
    match layer {
        0 => "ephemeral".to_string(),
        1 => "episode".to_string(),
        2 => "semantic".to_string(),
        3 => "permanent".to_string(),
        4 => "profile".to_string(),
        5 => "progressive".to_string(),
        n => format!("custom_{}", n),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub content: String,
    /// Short summary for ContextBuilder token budget control.
    /// When empty, falls back to `content`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub layer: String,
    pub score: f64,
    pub created_at: i64,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    // ─── New fields (v2 schema) ───
    /// Importance score (0.0–1.0). Drives layer auto-classification.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub importance: Option<f64>,
    /// Whether this entry is pinned (protected from eviction & deletion without force).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pin: Option<bool>,
    /// Whether this entry has been compressed/consolidated (legacy field, always false
    /// since consolidation was removed — retained for DB schema compatibility).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compressed: Option<bool>,
    /// Session ID this memory belongs to (for L1 grouping).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Memory type classification: conversation | decision | bug | config | api_usage | code_pattern | knowledge
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_type: Option<String>,
    /// Last update timestamp (Unix epoch seconds).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchRequest {
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layers: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
}

fn default_limit() -> usize {
    10
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStoreRequest {
    /// Explicit entry id. When set (e.g. `PUT /memory/:id`), the store
    /// upserts under this id instead of minting a fresh UUID (P0-03).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub content: String,
    /// Optional short summary. When provided, `content` stores the full text
    /// and `summary` stores the abbreviated version for token-efficient retrieval.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub layer: String,
    /// Importance score (0.0–1.0). When None, auto-computed by `auto_importance()`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub importance: Option<f64>,
    /// Whether to pin this entry (prevents eviction & deletion without force).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pin: Option<bool>,
    /// Session ID for L1 episode grouping.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Memory type: conversation | decision | bug | config | api_usage | code_pattern | knowledge
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStoreResponse {
    pub id: String,
    pub stored: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssembledContext {
    pub assembled_context: String,
    pub token_count: usize,
    pub sources: Vec<ContextSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSource {
    pub layer: String,
    pub count: usize,
}

/// 增强的 MemoryStats（v2）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatsV2 {
    pub total_entries: usize,
    pub by_layer: std::collections::HashMap<String, LayerStats>,
    pub storage_size_bytes: u64,
    pub schema_version: String,
    pub oldest_entry: Option<String>,
    pub newest_entry: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerStats {
    pub count: usize,
    pub avg_importance: f64,
    pub pinned_count: usize,
    /// Legacy field — always 0 since consolidation was removed.
    /// Retained for API compatibility.
    pub compressed_count: usize,
}

/// 实体关联
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityLink {
    pub memory_id: String,
    pub entity_id: String,
    pub project_id: String,
    pub link_type: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDeleteResponse {
    pub deleted: usize,
    pub vacuumed: bool,
}

// ─── L4 Core Memory Types ───

/// A single entry in the `core_memories` table (L4 user profile).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreMemoryEntry {
    pub id: String,
    pub user_id: String,
    pub project_id: String,
    pub content: String,
    /// Category: profile | preference | declaration
    pub category: String,
    pub metadata: serde_json::Value,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
}

/// Request body for creating / updating a core memory entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreMemoryStoreRequest {
    pub content: String,
    /// Category: profile | preference | declaration. Defaults to "profile".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Request body for updating an existing core memory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreMemoryUpdateRequest {
    pub id: String,
    pub content: String,
    /// Category: profile | preference | declaration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

// ─── L5 Pattern Types ───

/// A single entry in the `user_patterns` table (L5 progressive memory).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternEntry {
    pub id: i64,
    pub user_id: String,
    pub project_id: String,
    /// Pattern type: deixis | command_pref | sequence
    pub pattern_type: String,
    pub pattern_key: String,
    pub preferred_value: String,
    /// Confidence score (0.0–1.0). Increases with successful usage.
    pub confidence: f64,
    /// Number of times this pattern has been observed.
    pub sample_count: i64,
    pub last_used: i64,
    pub created_at: i64,
}

/// Request body for updating / creating a user pattern (L5).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternUpdateRequest {
    pub user_id: String,
    /// Pattern type: deixis | command_pref | sequence
    pub pattern_type: String,
    pub pattern_key: String,
    pub preferred_value: String,
    /// Execution result: "success" increments sample_count & confidence; "logic_error" skips update.
    #[serde(default = "default_execution_result")]
    pub execution_result: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

fn default_execution_result() -> String {
    "success".to_string()
}

/// Request body for querying user patterns (L5).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternQueryRequest {
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default = "default_pattern_limit")]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
}

fn default_pattern_limit() -> usize {
    50
}

/// Result of a pattern query, including total count for pagination.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternQueryResult {
    pub patterns: Vec<PatternEntry>,
    pub total: usize,
}

/// Request body for querying a single preference by intent and deixis type.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceQueryRequest {
    pub user_id: String,
    pub intent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deixis_type: Option<String>,
}

/// Standardized memory tags for structured retrieval.
///
/// Three dimensions:
/// - Category: what kind of memory (process record, summary, decision)
/// - Source: where the memory came from
/// - Status: current state of the task/record
pub mod memory_tags {
    // Dimension 1: Category
    pub const CATEGORY_PROCESS: &str = "cat:process";
    pub const CATEGORY_SUMMARY: &str = "cat:summary";
    pub const CATEGORY_DECISION: &str = "cat:decision";

    // Dimension 2: Source
    pub const SOURCE_PIPELINE_STAGE: &str = "src:pipeline-stage";
    pub const SOURCE_PIPELINE_RESULT: &str = "src:pipeline-result";
    pub const SOURCE_AGENT_EXECUTE: &str = "src:agent-execute";
    pub const SOURCE_AGENT_LOOP: &str = "src:agent-loop";
    pub const SOURCE_SCHEDULED: &str = "src:scheduled";

    // Dimension 3: Status
    pub const STATUS_COMPLETED: &str = "status:completed";
    pub const STATUS_FAILED: &str = "status:failed";
    pub const STATUS_IN_PROGRESS: &str = "status:in-progress";
}
