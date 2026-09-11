//! Blackboard related types (multi-agent coordination).

use serde::{Deserialize, Serialize};

// ─── 1. Intent Lock Types ───

/// Agent操作意图类型
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum IntentKind {
    Write,
    Read,
}

/// Agent向黑板提交的意图声明
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IntentDeclaration {
    pub agent_id: String,
    pub files: Vec<String>,
    pub intent: IntentKind,
}

/// 文件注解（如审查建议），挂在具体文件上，供循环 Reflect 阶段消费
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileAnnotation {
    pub id: i64,
    pub file_path: String,
    pub author_agent_id: String,
    pub annotation_type: String,
    pub content: String,
    pub created_at: String,
}

/// 文件锁状态
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum FileLockState {
    Unlocked,
    Locked {
        agent_id: String,
        acquired_at: String, // ISO 8601 timestamp
    },
}

/// 锁获取结果
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum LockAcquireResult {
    Granted { file: String },
    Queued { file: String, position: usize },
    Denied { file: String, reason: String },
}

// ─── 2. Symbol Change Types ───

/// 符号变更类型
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum SymbolChangeKind {
    Added,
    Removed,
    Modified,
    Renamed { old_name: String },
}

/// 单个符号的变更记录
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileChangeEntry {
    pub symbol_name: String,
    pub change_kind: SymbolChangeKind,
    pub old_signature: Option<String>,
    pub new_signature: Option<String>,
}

/// 提交后的结构化变更清单
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StructuredChangeList {
    pub file: String,
    pub agent_id: String,
    pub changes: Vec<FileChangeEntry>,
}

// ─── 3. Optimistic Lock Types ───

/// 文件版本记录
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileVersion {
    pub file_path: String,
    pub version: i64,
    pub ast_hash: String,
    pub last_modified_by: String,
    pub updated_at: String,
}

/// AST哈希值（语义节点结构哈希）
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AstHash(pub String);

/// 乐观锁校验结果
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum OptimisticLockResult {
    Success { new_version: i64 },
    Conflict {
        expected_version: i64,
        actual_version: i64,
        conflicts: Vec<StructuralConflict>,
    },
}

/// 结构化冲突信息
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StructuralConflict {
    pub conflict_type: String, // "function_modified", "function_added", "export_removed", etc.
    pub symbol: String,
    pub detail: String,
}

/// 携带基准版本的写入请求
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WriteRequest {
    pub agent_id: String,
    pub file_path: String,
    pub content: String,
    pub base_version: i64,
    pub base_ast_hash: String,
    pub submission_status: FileSubmissionStatus,
}

// ─── 4. File Submission Types ───

/// 文件提交状态
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum FileSubmissionStatus {
    Draft,
    Stable,
}

/// Agent提交记录
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentSubmission {
    pub id: i64,
    pub agent_id: String,
    pub file_path: String,
    pub content: String,
    pub status: FileSubmissionStatus,
    pub base_version: i64,
    pub base_ast_hash: String,
    pub submitted_at: String,
}

// ─── 5. Change Notification Types ───

/// 变更类型枚举
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ChangeType {
    SignatureChanged, // 必须通知
    Removed,          // 必须通知
    Modified,         // 建议通知
    Added,            // 可选通知
}

/// 变更通知优先级
impl ChangeType {
    pub fn is_must_notify(&self) -> bool {
        matches!(self, ChangeType::SignatureChanged | ChangeType::Removed)
    }
}

/// 变更通知
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChangeNotification {
    pub id: String,
    pub file: String,
    pub from_version: i64,
    pub to_version: i64,
    pub changes: Vec<ChangeLogEntry>,
    pub target_agent_id: String,
    pub created_at: String,
    pub acknowledged: bool,
}

/// 变更清单条目
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChangeLogEntry {
    pub change_type: ChangeType,
    pub symbol: String,
    pub detail: String,
    pub old_signature: Option<String>,
    pub new_signature: Option<String>,
}

/// 通知确认
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NotificationACK {
    pub notification_id: String,
    pub agent_id: String,
    pub acknowledged_at: String,
    pub action_taken: String, // "adapted", "no_impact", "failed"
}

// ─── 6. Agent Scope Types ───

/// Agent文件范围
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentScope {
    pub agent_id: String,
    pub allowed_files: Vec<String>,
    pub assigned_at: String,
}

/// 范围扩展申请
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScopeExpansionRequest {
    pub agent_id: String,
    pub target_file: String,
    pub reason: String,
    pub expected_scope: Option<String>, // 函数/类级别范围描述
}

/// 范围扩展审批结果
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ScopeExpansionResult {
    Approved { file: String },
    Rejected { file: String, reason: String },
}

// ─── 7. Conflict Degradation Types ───

/// 冲突解决策略
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ConflictResolution {
    ImmediateRetry,
    DelayedRetry { delay_secs: u64 },
    SerialMode,
}

/// 冲突重试计数器
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConflictRetryCounter {
    pub agent_id: String,
    pub file_path: String,
    pub retry_count: u32,
    pub last_conflict_at: String,
}

/// 串行模式队列
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SerialModeQueue {
    pub entries: Vec<SerialQueueEntry>,
}

/// 串行队列条目
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SerialQueueEntry {
    pub agent_id: String,
    pub file_path: String,
    pub content: String,
    pub base_version: i64,
    pub base_ast_hash: String,
}

// ─── 8. Agent Fault Types ───

/// Agent故障类型
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum AgentFaultType {
    LlmTimeout,       // LLM请求超时60秒
    LlmDegraded,      // 单token生成超5秒
    LlmUnqualified,   // tree-sitter连续拦截3次
    LlmEmptyResponse, // 返回空/截断
}

/// Agent故障记录
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentFault {
    pub id: i64,
    pub agent_id: String,
    pub fault_type: AgentFaultType,
    pub detail: String,
    pub occurred_at: String,
    pub handling_status: String, // "pending", "handled"
}

/// Agent故障处理配置
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentFaultConfig {
    pub llm_request_timeout_ms: u64,   // 默认60000
    pub llm_token_timeout_ms: u64,     // 默认5000
    pub quality_check_max_rejects: u32, // 默认3
    pub max_retries: u32,              // 默认3
    pub retry_initial_delay_ms: u64,   // 默认100
    pub retry_backoff_factor: u64,     // 默认2
    pub retry_max_delay_ms: u64,       // 默认10000
}

impl Default for AgentFaultConfig {
    fn default() -> Self {
        Self {
            llm_request_timeout_ms: 60000,
            llm_token_timeout_ms: 5000,
            quality_check_max_rejects: 3,
            max_retries: 3,
            retry_initial_delay_ms: 100,
            retry_backoff_factor: 2,
            retry_max_delay_ms: 10000,
        }
    }
}

// ─── 9. Blackboard Persistence Types ───

/// 文件依赖关系
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileDependency {
    pub source_file: String,
    pub target_file: String,
    pub dependency_type: String, // "import", "call", "reference"
    pub detected_at: String,
}

/// 变更日志
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChangeLog {
    pub id: i64,
    pub file_path: String,
    pub change_type: String,
    pub agent_id: String,
    pub diff: String,
    pub changed_at: String,
}

// ─── 10. Circuit Breaker Types ───

/// 熔断器状态
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum CircuitBreakerState {
    Normal,
    Broken,
}

/// 熔断器配置
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CircuitBreakerConfig {
    pub conflict_rate_threshold: f64,       // 默认0.5
    pub agent_failure_ratio_threshold: f64, // 默认0.5
    pub blackboard_crash_threshold: u32,    // 默认3
    pub recovery_success_count: u32,        // 默认3
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            conflict_rate_threshold: 0.5,
            agent_failure_ratio_threshold: 0.5,
            blackboard_crash_threshold: 3,
            recovery_success_count: 3,
        }
    }
}

// ─── 11. Metrics Types ───

/// 指标分类
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum MetricCategory {
    Conflict,
    Performance,
    Reliability,
    Resource,
}

/// 指标名称枚举
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum MetricName {
    FileConflictRate,
    AverageRetryCount,
    DependencyAdaptCount,
    AgentAverageWorkDuration,
    DegradationTriggerCount,
    LlmFaultCount,
    TreeSitterInterceptCount,
    StructuredDiffHitRate,
    NotificationAckTimeoutCount,
    DuplicateResourceDetectCount,
    /// Number of stale (assigned but abandoned) agent intents reverted to
    /// `pending` by the intent-TTL sweeper. Pure coordination-metadata cleanup;
    /// does not touch file locks (G13 FIFO/TTL boundary).
    StaleIntentExpireCount,
    /// Number of wait-for cycles (potential deadlocks) detected by the
    /// read-only wait-graph observer (G13 deadlock boundary). Observation only —
    /// cycles are broken passively via lock/intent TTL, never by force.
    DeadlockCycleDetectCount,
}

/// 指标记录
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MetricRecord {
    pub id: i64,
    pub metric_name: MetricName,
    pub metric_value: f64,
    pub timestamp: String,
    pub session_id: String,
    pub agent_id: Option<String>,
    pub file_path: Option<String>,
    pub extra: Option<String>, // JSON扩展字段
}

// ─── 12. Dependency Change Types ───

/// 依赖变更类型
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum DependencyChangeType {
    FunctionSignatureChanged,
    ExportAdded,
    ExportRemoved,
    TypeChanged,
    ImportPathChanged,
}

/// 依赖变更清单条目
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DependencyChangeEntry {
    pub change_type: DependencyChangeType,
    pub name: String,
    pub old_signature: Option<String>,
    pub new_signature: Option<String>,
}

/// 依赖变更清单
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DependencyChangeList {
    pub file_path: String,
    pub old_version: i64,
    pub new_version: i64,
    pub changes: Vec<DependencyChangeEntry>,
}

// ─── 13. Public Resource Types ───

/// 公共资源标记
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PublicResource {
    pub file_path: String,
    pub reference_count: usize,
    pub referencing_modules: Vec<String>,
}

/// Agent工具需求声明
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolNeedDeclaration {
    pub agent_id: String,
    pub function_signature: String,
    pub semantic_description: String,
    pub declared_at: String,
}

// ─── 14. Blackboard Event Types ───

/// 黑板事件类型
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum BlackboardEvent {
    FileLocked { file: String, agent_id: String },
    FileUnlocked { file: String, agent_id: String },
    FileVersionChanged { file: String, old_version: i64, new_version: i64 },
    StableSubmitted { file: String, agent_id: String, version: i64 },
    ChangeNotificationSent { notification_id: String, target_agent: String },
    ChangeNotificationAcknowledged { notification_id: String, agent_id: String },
    ConflictDetected { file: String, agent_id: String, retry_count: u32 },
    DegradedToSerial { file: String },
    AgentFault { agent_id: String, fault_type: AgentFaultType },
    CircuitBreakerTriggered { reason: String },
    CircuitBreakerRecovered,
}

/// 黑板初始化请求
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlackboardInitRequest {
    pub session_id: String,
    pub project_path: String,
    pub agent_scopes: Vec<AgentScope>,
}

/// 黑板状态摘要
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlackboardStatus {
    pub session_id: String,
    pub total_files: usize,
    pub locked_files: usize,
    pub total_agents: usize,
    pub active_agents: usize,
    pub circuit_breaker_state: CircuitBreakerState,
    pub global_conflict_rate: f64,
}
