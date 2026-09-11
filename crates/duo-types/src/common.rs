//! Common shared types (intent clarification, health, security, config, feedback, task scheduling, knowledge graph, rule engine, code search).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt::Display;
use std::str::FromStr;

// ─── Intent Types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentClarifyRequest {
    pub user_input: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_context: Option<std::collections::HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClarificationResult {
    pub intent_type: String,
    pub confidence: f64,
    pub entities: Vec<Entity>,
    pub ambiguities: Vec<Ambiguity>,
    pub suggested_mode: SuggestedMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ambiguity {
    pub question: String,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum SuggestedMode {
    Chat,
    Agent,
}

// ─── Health Check ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub uptime_seconds: u64,
    /// Whether the memory database is persisted on disk.
    pub memory_persistent: bool,
}

// ─── Security Types ───

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityPolicy {
    pub allowed_paths: Vec<String>,
    pub blocked_commands: Vec<String>,
    pub max_file_size_bytes: u64,
    pub require_confirmation: bool,
    /// Whether to enable RTK (Runtime Kompressor) prefix for shell commands.
    /// When true and `rtk` binary is available on PATH, shell commands are
    /// automatically prefixed with `rtk` for output compression.
    /// Default: true (use rtk if available).
    #[serde(default = "default_enable_rtk")]
    pub enable_rtk: bool,
}

fn default_enable_rtk() -> bool {
    true
}

// ─── Smart Layer Config ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartLayerConfig {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_hostname")]
    pub hostname: String,
    #[serde(default = "default_log_level")]
    pub log_level: String,
    #[serde(default)]
    pub memory: MemoryConfig,
    #[serde(default)]
    pub security: SecurityConfig,
}

/// Default loopback hostname for smart-layer and sidecar services.
pub const DEFAULT_HOSTNAME: &str = "127.0.0.1";

/// Default log level for smart-layer.
pub const DEFAULT_LOG_LEVEL: &str = "info";

/// Loopback addresses that should never be routed through a proxy.
/// Used to populate `NO_PROXY` / `no_proxy` environment variables.
pub const LOOPBACK_ADDRESSES: &[&str] = &["127.0.0.1", "localhost", "::1"];

fn default_port() -> u16 {
    8080
}

fn default_hostname() -> String {
    DEFAULT_HOSTNAME.to_string()
}

fn default_log_level() -> String {
    DEFAULT_LOG_LEVEL.to_string()
}

/// `DEFAULT_HOSTNAME` is documented as the loopback address that
/// `duo-smart-layer` falls back to, and `main` falls back to
/// `Ipv4Addr::LOCALHOST` (a compile-time constant) rather than re-parsing the
/// string. This test is the invariant that keeps the two from drifting apart.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_hostname_is_loopback_ipv4() {
        assert_eq!(
            DEFAULT_HOSTNAME.parse::<std::net::IpAddr>().unwrap(),
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
        );
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryConfig {
    /// Database file path. `None` means use the default path under the config directory.
    #[serde(default = "default_db_path")]
    pub db_path: Option<String>,
    /// Maximum number of entries stored per memory layer.
    /// Defaults to [`DEFAULT_MAX_ENTRIES_LIMIT`] (5000) so the per-layer
    /// eviction is actually reachable; set `max_entries = 9223372036854775807`
    /// (i64::MAX) in config.toml for "no hard limit". Serialized as `i64::MAX`
    /// for the unlimited case (TOML integers are `i64`).
    #[serde(
        default = "default_max_entries",
        serialize_with = "serialize_max_entries",
        deserialize_with = "deserialize_max_entries"
    )]
    pub max_entries: usize,
    /// Default memory layer depth.
    #[serde(default = "default_default_layer")]
    pub default_layer: u8,
    /// Maximum number of memory layers.
    #[serde(default = "default_max_layers")]
    pub max_layers: u8,
    /// Embedding vector dimension.
    #[serde(default = "default_embedding_dim")]
    pub embedding_dim: usize,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            db_path: default_db_path(),
            max_entries: default_max_entries(),
            default_layer: default_default_layer(),
            max_layers: default_max_layers(),
            embedding_dim: default_embedding_dim(),
        }
    }
}

fn default_db_path() -> Option<String> {
    None
}

/// Per-layer entry cap applied by default so eviction is reachable (P1-13).
pub const DEFAULT_MAX_ENTRIES_LIMIT: usize = 5000;

/// Sentinel meaning "no hard limit" (see `serialize_max_entries`).
pub const UNLIMITED_MAX_ENTRIES: usize = usize::MAX;

fn default_max_entries() -> usize {
    DEFAULT_MAX_ENTRIES_LIMIT
}

fn serialize_max_entries<S: serde::Serializer>(val: &usize, s: S) -> Result<S::Ok, S::Error> {
    // usize::MAX overflows i64; serialize as i64::MAX instead (semantically
    // equivalent — both mean "no hard limit").
    if *val == usize::MAX {
        s.serialize_i64(i64::MAX)
    } else {
        s.serialize_u64(*val as u64)
    }
}

fn deserialize_max_entries<'de, D: serde::Deserializer<'de>>(d: D) -> Result<usize, D::Error> {
    let val = i64::deserialize(d)?;
    if val == i64::MAX {
        Ok(usize::MAX)
    } else {
        Ok(val as usize)
    }
}

fn default_default_layer() -> u8 {
    3
}

fn default_max_layers() -> u8 {
    5
}

fn default_embedding_dim() -> usize {
    1536
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityConfig {
    #[serde(default)]
    pub policy: SecurityPolicy,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            policy: SecurityPolicy {
                allowed_paths: vec![".".to_string()],
                blocked_commands: vec!["rm -rf /".to_string(), "format".to_string()],
                max_file_size_bytes: 10 * 1024 * 1024,
                require_confirmation: true,
                enable_rtk: true,
            },
        }
    }
}

impl Default for SmartLayerConfig {
    fn default() -> Self {
        Self {
            port: default_port(),
            hostname: default_hostname(),
            log_level: default_log_level(),
            memory: MemoryConfig::default(),
            security: SecurityConfig::default(),
        }
    }
}

// ─── Feedback Types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSubmitRequest {
    pub session_id: String,
    pub rating: u8,
    pub comment: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// Whether this feedback was auto-generated (not from user).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackEntry {
    pub id: String,
    pub session_id: String,
    pub rating: u8,
    pub comment: String,
    pub timestamp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// Whether this feedback was auto-generated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto: Option<bool>,
}

// ─── Task Schedule Types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskScheduleRequest {
    pub description: String,
    pub priority: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assigned_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    pub description: String,
    pub priority: TaskPriority,
    pub status: TaskStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assigned_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    pub created_at: String,
    /// ISO-8601 / RFC-3339 timestamp when the task started running.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}

/// Priority level for a scheduled task.
///
/// `Normal` is the canonical medium-priority variant. It deserializes
/// from both `"normal"` and `"medium"` (backward-compat alias).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum TaskPriority {
    Low = 0,
    #[serde(alias = "medium")]
    Normal = 1,
    High = 2,
    Critical = 3,
}

impl TaskPriority {
    /// Returns the numeric value used for priority ordering.
    pub fn value(&self) -> u8 {
        match self {
            TaskPriority::Low => 0,
            TaskPriority::Normal => 1,
            TaskPriority::High => 2,
            TaskPriority::Critical => 3,
        }
    }

    /// Parse a priority string (case-insensitive) into [`TaskPriority`].
    ///
    /// Accepts: `"low"`, `"normal"` (or `"medium"`), `"high"`, `"critical"`.
    /// Returns `None` for unrecognized strings.
    pub fn from_str_loose(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "low" => Some(TaskPriority::Low),
            "normal" | "medium" => Some(TaskPriority::Normal),
            "high" => Some(TaskPriority::High),
            "critical" => Some(TaskPriority::Critical),
            _ => None,
        }
    }
}

/// Lifecycle status of a scheduled task.
///
/// Tasks transition through the following states:
/// `Queued` → `Running` → `Completed` | `Failed`
///
/// Any non-terminal task can be moved to `Cancelled`.
///
/// `Queued` is the canonical name for the "in-queue" state.
/// It deserializes from both `"queued"` and `"scheduled"`
/// (backward-compat alias for callers that used the old name).
/// `Pending` is the initial status before entering the queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    #[serde(alias = "scheduled")]
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl TaskStatus {
    /// Returns `true` if the status represents a terminal state
    /// (completed, failed, or cancelled).
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
        )
    }
}

// ─── Knowledge Graph Types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KGNode {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<HashMap<String, serde_json::Value>>,
    /// Project ID for isolation. Different projects have separate graph spaces.
    /// Empty string means global (shared across all projects).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KGEdge {
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    pub relation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<HashMap<String, serde_json::Value>>,
    /// Project ID for isolation. Different projects have separate graph spaces.
    /// Empty string means global (shared across all projects).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project_id: String,
}

/// 知识图谱边关系类型枚举
/// 保持 relation: String 不变，此枚举仅用于类型安全创建
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum KGRelationType {
    Contains,
    DependsOn,
    Calls,
    Implements,
    Inherits,
    Method,
    Reads,
    Writes,
    HasType,
    Decorates,
}

impl Display for KGRelationType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KGRelationType::Contains => write!(f, "Contains"),
            KGRelationType::DependsOn => write!(f, "DependsOn"),
            KGRelationType::Calls => write!(f, "Calls"),
            KGRelationType::Implements => write!(f, "Implements"),
            KGRelationType::Inherits => write!(f, "Inherits"),
            KGRelationType::Method => write!(f, "Method"),
            KGRelationType::Reads => write!(f, "Reads"),
            KGRelationType::Writes => write!(f, "Writes"),
            KGRelationType::HasType => write!(f, "HasType"),
            KGRelationType::Decorates => write!(f, "Decorates"),
        }
    }
}

impl FromStr for KGRelationType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "Contains" => Ok(KGRelationType::Contains),
            "DependsOn" => Ok(KGRelationType::DependsOn),
            "Calls" => Ok(KGRelationType::Calls),
            "Implements" => Ok(KGRelationType::Implements),
            "Inherits" => Ok(KGRelationType::Inherits),
            "Method" => Ok(KGRelationType::Method),
            "Reads" => Ok(KGRelationType::Reads),
            "Writes" => Ok(KGRelationType::Writes),
            "HasType" => Ok(KGRelationType::HasType),
            "Decorates" => Ok(KGRelationType::Decorates),
            _ => Err(format!("Unknown KGRelationType: {}", s)),
        }
    }
}

/// Request body for the graph query endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphQueryRequest {
    pub query_type: String,
    #[serde(default)]
    pub from_id: Option<String>,
    #[serde(default)]
    pub to_id: Option<String>,
    #[serde(default)]
    pub center_id: Option<String>,
    #[serde(default)]
    pub hops: Option<usize>,
    #[serde(default)]
    pub node_id: Option<String>,
    #[serde(default)]
    pub node_type: Option<String>,
    /// Search query string for the "search" query type.
    /// Performs case-insensitive substring matching on node labels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_query: Option<String>,
    /// Maximum number of results to return for search queries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    /// Project root path used for isolation. The backend derives the graph's
    /// project identity from it, so a query can never filter by a key that
    /// disagrees with the one indexing wrote.
    /// When omitted, no project filter is applied (all loaded projects).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
}

/// Response body for the graph query endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(untagged)]
pub enum GraphQueryResponse {
    Path(Vec<String>),
    Nodes(Vec<KGNode>),
}

// ─── Knowledge Graph Indexing Types ───

/// Request body for the graph project indexing endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphIndexRequest {
    /// Root directory path of the project to index.
    ///
    /// This is the ONLY project input: the graph's project identity is derived
    /// from it by the backend (`knowledge_graph_store::project_key`). Accepting
    /// an id here too would reintroduce a second source of truth that can
    /// disagree with what indexing actually wrote.
    pub project_path: String,
    /// Optional relative sub-directory to index. When omitted, indexes the whole project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_filter: Option<String>,
}

/// Response body for the graph project indexing endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphIndexResponse {
    pub project_path: String,
    pub files_indexed: usize,
    pub entities_created: usize,
    pub edges_created: usize,
}

// ─── Rule Engine Types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnaRule {
    pub id: String,
    pub name: String,
    pub condition: String,
    pub action: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Request body for the DNA match endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnaMatchRequest {
    pub input: String,
}

// ─── Code Search Types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndex {
    pub path: String,
    pub language: String,
    pub last_modified: String,
    pub symbols: Vec<Symbol>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range_start: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range_end: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub documentation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolKind {
    Function,
    Method,
    Struct,
    Enum,
    Trait,
    Module,
    Variable,
    Constant,
    Interface,
    Class,
    Namespace,
}

/// Request body for the code-search file-indexing endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexFileRequest {
    pub path: String,
    pub content: String,
    pub language: String,
    /// Project root path. The graph routes derive the project identity from
    /// this (see `GraphIndexRequest::project_path`); they reject the request
    /// when it is missing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
}

/// Response body for the code-search file-indexing endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexFileResponse {
    pub indexed: bool,
    pub path: String,
}

/// Request body for the code-search symbol-search endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSymbolsRequest {
    pub query: String,
    pub limit: usize,
}

// ─── AST Analysis Types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AstResult {
    pub file_path: String,
    pub language: String,
    pub functions: Vec<FunctionDef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionDef {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_type: Option<String>,
    pub start_line: usize,
    pub end_line: usize,
    #[serde(default)]
    pub parameters: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub documentation: Option<String>,
}

// ─── Vector Search Types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    pub content: String,
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}
