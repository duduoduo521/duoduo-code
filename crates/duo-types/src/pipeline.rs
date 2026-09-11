//! Pipeline related types.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ─── Subagent Types ───

/// Role of a subagent within a pipeline stage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentRole {
    /// Read-only exploration (search, read files, grep).
    Explore,
    /// General-purpose agent that can read and write code.
    General,
    /// Code generation / modification agent.
    Codegen,
}

/// A subagent task dispatched within a pipeline stage.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentTask {
    /// Unique identifier for this subagent task.
    /// Auto-generated if not provided by the LLM.
    #[serde(default)]
    pub id: String,
    /// Human-readable description (3-5 words).
    pub description: String,
    /// The prompt/instruction for the subagent.
    pub prompt: String,
    /// Role determining the agent's capabilities.
    pub role: SubagentRole,
    /// Target file path for codegen subagents (relative to project output dir).
    /// When set, the subagent's output is written directly to this file
    /// instead of parsing `// filepath:` markers from the output.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub target_file: Option<String>,
    /// Current status of the subagent task.
    /// Defaults to `Pending` if not provided.
    #[serde(default)]
    pub status: SubagentTaskStatus,
    /// Output text from the subagent (set when completed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// Error message if the subagent failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Interface contract for this subagent's target file.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub interface: Option<InterfaceContract>,
    /// Files this subagent depends on.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
}

/// Status of a subagent task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SubagentTaskStatus {
    #[default]
    Pending,
    Running,
    Completed,
    Failed,
}

// ─── Architecture Contract Types (Agentic Loop) ───

/// 接口契约：定义文件生成前必须满足的接口规范。
/// 由架构部在 file_plan 中输出，注入到 subagent prompt。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceContract {
    /// 父类/继承关系
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extends: Option<String>,
    /// 属性定义：属性名 → 类型
    #[serde(default)]
    pub properties: HashMap<String, String>,
    /// 方法定义：方法名 → 方法契约
    #[serde(default)]
    pub methods: HashMap<String, MethodContract>,
}

/// 方法契约
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodContract {
    /// 参数列表
    #[serde(default)]
    pub params: Vec<String>,
    /// 返回类型
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_type: Option<String>,
    /// 方法描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 副作用说明
    #[serde(default)]
    pub side_effects: Vec<String>,
}

/// 共享类型定义（枚举、DTO、常量）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedTypeDefinition {
    /// 类型名称
    pub name: String,
    /// 类型种类：enum / dto / constant
    pub kind: String,
    /// 枚举值（kind=enum 时）
    #[serde(default)]
    pub values: Vec<String>,
    /// DTO 字段（kind=dto 时）
    #[serde(default)]
    pub fields: HashMap<String, String>,
    /// 常量值（kind=constant 时）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    /// 所在文件路径
    pub file: String,
}

/// 文件计划条目（架构部输出）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePlanEntry {
    /// 文件路径
    pub path: String,
    /// 文件描述
    pub description: String,
    /// 接口契约（第1层约束）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface: Option<InterfaceContract>,
    /// 依赖的文件路径列表
    #[serde(default)]
    pub depends_on: Vec<String>,
}

/// 架构契约：架构部的完整输出
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchitectureContract {
    /// 架构规格文档（markdown）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_document: Option<String>,
    /// 共享类型定义（第2层约束）
    #[serde(default)]
    pub shared_types: Vec<SharedTypeDefinition>,
    /// 全局常量
    #[serde(default)]
    pub constants: HashMap<String, serde_json::Value>,
    /// 编码规范摘要（第3层约束）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coding_standards: Option<String>,
    /// 文件计划列表
    #[serde(default)]
    pub file_plan: Vec<FilePlanEntry>,
}

/// 分层文件计划（拓扑排序后的层）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLayer {
    /// 层级索引（0 = 无依赖的基础层）
    pub layer_index: usize,
    /// 本层包含的文件计划条目
    pub entries: Vec<FilePlanEntry>,
}

// ─── Quality Types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeArtifact {
    #[serde(rename = "type")]
    pub artifact_type: String,
    pub content: String,
    pub language: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityValidateRequest {
    pub artifact: CodeArtifact,
    pub quality_level: QualityLevel,
    /// 接口契约（InterfaceConsistency 级别必需）
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub interface_contract: Option<InterfaceContract>,
    /// 共享类型定义（InterfaceConsistency 级别使用）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shared_types: Vec<SharedTypeDefinition>,
    /// 是否启用 LLM 内容正确性判定（由设置开关控制）。
    /// 当为 true 且 QualityPipeline 持有可用 LLM 配置时，会用用户当前 LLM
    /// 判定"修改代码块是否正确"；否则静默降级为纯正则检查。
    #[serde(default)]
    pub enable_llm_check: bool,
    /// 修改前/后的 diff 文本，供 LLM 内容判定上下文使用。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub diff: Option<String>,
    /// 关联依赖（从知识图谱获取），作为 LLM 判定的上下文。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kg_related: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QualityLevel {
    SelfCheck,
    CrossReview,
    Standard,
    Full,
    InterfaceConsistency,
}

/// LLM 对"修改代码块是否正确"的内容判定结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmVerdict {
    /// 是否判定为正确
    pub passed: bool,
    /// 判定理由 / 错误说明（判错时作为回退修改的指引）
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityReport {
    pub passed: bool,
    pub score: f64,
    pub checks: Vec<QualityCheck>,
    pub suggestions: Vec<String>,
    /// LLM 内容判定结果（仅当启用 LLM 检查且 LLM 可用时有值）。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub llm_verdict: Option<LlmVerdict>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityCheck {
    pub name: String,
    pub passed: bool,
    pub score: f64,
}
