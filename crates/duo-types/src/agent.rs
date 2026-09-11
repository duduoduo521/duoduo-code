//! Agent related types (agentic loop, tool calling).

use serde::{Deserialize, Serialize};

// ─── Tool Calling Types (Agentic Loop) ───

/// Tool definition for LLM function calling (OpenAI format).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    #[serde(rename = "type")]
    pub r#type: String, // "function"
    pub function: FunctionDefinition,
}

/// Function definition within a tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value, // JSON Schema
}

/// Tool choice configuration.
///
/// OpenAI API accepts either a plain string (`"auto"`, `"none"`, `"required"`)
/// or an object (`{"type": "function", "function": {"name": "..."}}`).
/// The `untagged` attribute allows both forms to be serialized/deserialized correctly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolChoice {
    /// String variant: "auto", "none", or "required".
    AutoStr(String),
    /// Explicit tool selection by function name.
    Function {
        #[serde(rename = "type")]
        r#type: String,
        function: NamedToolFunction,
    },
}

impl ToolChoice {
    /// The LLM decides whether to call a tool.
    pub fn auto() -> Self {
        ToolChoice::AutoStr("auto".to_string())
    }

    /// The LLM will not call any tool.
    pub fn none() -> Self {
        ToolChoice::AutoStr("none".to_string())
    }

    /// The LLM must call a tool.
    pub fn required() -> Self {
        ToolChoice::AutoStr("required".to_string())
    }

    /// Force a specific function by name.
    pub fn function(name: impl Into<String>) -> Self {
        ToolChoice::Function {
            r#type: "function".to_string(),
            function: NamedToolFunction { name: name.into() },
        }
    }
}

/// Function name within a [`ToolChoice::Function`] variant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamedToolFunction {
    pub name: String,
}

/// Tool call from LLM response (OpenAI format).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub function: FunctionCall,
}

/// Function call within a tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String, // JSON string
}

// ─── Agentic Loop Types ───

/// Agentic Loop 执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgenticLoopOutput {
    /// 生成的文件路径
    pub file_path: String,
    /// 生成的代码内容
    pub content: String,
    /// 使用的 tool calling 轮数
    pub rounds_used: usize,
    /// 读取的文件列表
    pub files_read: Vec<String>,
    /// 接口一致性验证警告
    pub validation_warnings: Vec<String>,
}

/// A single tool call entry (tool name + arguments).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallEntry {
    pub tool_name: String,
    pub arguments: serde_json::Value,
}

/// Agentic Loop 单轮执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LoopRoundResult {
    /// subagent 请求调用单个 tool（向后兼容）
    ToolCall {
        tool_name: String,
        arguments: serde_json::Value,
    },
    /// subagent 请求调用多个 tool（并行 tool calling）
    ToolCalls { calls: Vec<ToolCallEntry> },
    /// subagent 提交了代码
    CodeSubmitted { content: String },
    /// 达到最大轮数，强制终止
    MaxRoundsExceeded { partial_output: String },
    /// Output was truncated — LLM hit max_tokens limit.
    /// `finish_reason == "length"` or `"max_tokens"`.
    OutputTruncated { content: String },
}

/// Agentic Loop 安全策略
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgenticLoopSecurity {
    /// 项目路径（限定读取范围）
    pub project_path: String,
    /// 单次读取上限 (bytes)，默认 102400 (100KB)
    #[serde(default = "default_max_read_bytes")]
    pub max_read_bytes: usize,
    /// 最多读取文件数，默认 10
    #[serde(default = "default_max_file_reads")]
    pub max_file_reads: usize,
    /// 是否启用路径穿越检查
    #[serde(default = "default_true")]
    pub check_path_traversal: bool,
}

fn default_max_read_bytes() -> usize {
    102_400
}
fn default_max_file_reads() -> usize {
    10
}
fn default_true() -> bool {
    true
}

impl Default for AgenticLoopSecurity {
    fn default() -> Self {
        Self {
            project_path: String::new(),
            max_read_bytes: default_max_read_bytes(),
            max_file_reads: default_max_file_reads(),
            check_path_traversal: true,
        }
    }
}
