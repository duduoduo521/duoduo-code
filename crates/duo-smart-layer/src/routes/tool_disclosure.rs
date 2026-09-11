//! Progressive tool disclosure for the main run-loop.
//!
//! ## Problem
//! The TS side assembles the full tool list (~15K tokens of JSON schema) and
//! hands it to every LLM round. Most tools are rarely used in a given turn, so
//! the schema is fixed dead weight on every request.
//!
//! ## Solution (progressive disclosure)
//! When enabled (`progressive_tools`), only a small *core* set is sent with full
//! schemas. Everything else goes out as a name + one-line description stub. When
//! the model decides it needs a deferred tool, it calls the synthetic
//! `expand_tools` meta-tool; we answer inline from in-memory state (see
//! `agent.rs` where `is_expand_call` is intercepted before the DB write) with the
//! full schema, and permanently promote that tool to full for the rest of the
//! session.
//!
//! `expand_tools` is **never** sent to the upstream provider as a real tool call —
//! `agent.rs` intercepts it. This module only builds the stub list and produces
//! the answer payload.
//!
//! ## Safety / zero-risk
//! - When disabled (`new(false)`), `apply` is a pass-through: output is byte-for
//!   byte identical to the input. No behaviour change, no token change.
//! - Promotion is monotonic and idempotent: a tool expanded once stays expanded;
//!   calling `expand_tools` twice is harmless.
//! - Stub schemas keep `parameters` as an empty object (valid JSON Schema), so the
//!   provider never sees a malformed tool definition.

use std::collections::HashSet;
use std::sync::Mutex;

use duo_utils::sync::MutexPoisonRecover;

use duo_types::ToolDefinition;

/// Synthetic meta-tool name. Intercepted in `agent.rs` before any dispatch.
pub const EXPAND_TOOL_NAME: &str = "expand_tools";

/// Tools that are almost always needed early in a coding/explore turn. These are
/// sent with full schemas even when progressive disclosure is on, so the model
/// never has to expand the most common tools explicitly.
///
/// Mirrors the `listed_always` / `listed_codegen_explore` sets in
/// `agent-executor/src/tools/dispatch.rs` (read/list are `listed_always`;
/// grep/bash/webfetch/websearch are `listed_codegen_explore`). Keeping them full
/// avoids forcing the model to expand the single most-used tool on turn one.
const CORE_TOOL_NAMES: &[&str] = &[
    // Names below MUST match the tool `id` actually registered on the TS side
    // (see packages/duoduo/src/tool/*.ts `Tool.define("<id>", ...)`). A name that
    // does not exist in the live tool set is a dead entry: it never matches, so
    // the intended tool is silently stubbed instead of sent full-schema.
    //
    // Core policy: high-frequency explore / modify / write tools are sent with
    // full schemas on turn one because they underpin core agent mechanisms
    // (file edits, code search, the shared blackboard). Stubbing them would
    // force an extra expand_tools round and can break first-turn behaviour.
    // --- read / inspect ---
    "read",
    "grep",
    "glob",
    "symbol_search",
    "lsp",
    "graph_query",
    "webfetch",
    // --- modify ---
    "edit",
    "apply_patch",
    "code_comment",
    // --- write ---
    "write",
    "blackboard_read",
    "blackboard_write",
    "blackboard_find",
    "blackboard_submit_draft",
    "blackboard_submit_stable",
    "blackboard_annotate",
    // --- execution / memory / skills ---
    "bash",
    "skill",
    "recall_memory",
];

/// Build the `expand_tools` stub that the model calls to pull deferred schemas.
fn expand_tool_definition() -> ToolDefinition {
    ToolDefinition {
        r#type: "function".into(),
        function: duo_types::FunctionDefinition {
            name: EXPAND_TOOL_NAME.into(),
            description: "按需展开被延迟（精简）下发的工具完整 JSON Schema。\
                系统提示词只携带了非核心工具的 name 与一句话描述（stub）。\
                当你判断某个工具与当前任务相关、但手头只有 stub 时，调用本工具并传入该工具名，\
                即可取回它的完整参数定义（parameters），随后便可正常调用该工具。\
                入参 tool 取 stub 列表中列出的 name；多次展开同一工具不会产生副作用。"
                .into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "tool": {
                        "type": "string",
                        "description": "要展开完整 schema 的工具名称（即 stub 列表中的 name）"
                    }
                },
                "required": ["tool"]
            }),
        },
    }
}

pub struct ToolDisclosure {
    enabled: bool,
    /// Tools already promoted to full schema for the rest of the session.
    promoted: Mutex<HashSet<String>>,
}

impl ToolDisclosure {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            promoted: Mutex::new(HashSet::new()),
        }
    }

    /// Whether `name` is the synthetic expand call.
    pub fn is_expand_call(&self, name: &str) -> bool {
        name == EXPAND_TOOL_NAME
    }

    /// Extract a one-line purpose summary from a tool's full description.
///
/// Used to populate the stub `description` for deferred (non-core) tools. We
/// keep the first non-empty line of the real description and truncate it to a
/// fixed budget so the model still receives the "when to use" trigger signal,
/// while the multi-paragraph body (examples, schema details) is deferred until
/// the tool is explicitly expanded via `expand_tools`.
///
/// The summary is derived from the tool's own description, so it can never
/// drift out of sync with the actual schema the way a hand-maintained table
/// would.
fn summarize(desc: &str) -> String {
    const MAX: usize = 100;

    let first_line = desc
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("Tool available")
        .trim_end_matches(['.', ':'])
        .trim();

    if first_line.chars().count() <= MAX {
        first_line.to_string()
    } else {
        let truncated: String = first_line.chars().take(MAX).collect();
        format!("{truncated}…")
    }
}

    /// Reduce `tools` to core-full + non-core-stub, and append `expand_tools`.
    /// When disabled, returns the input unchanged (pass-through, zero token diff).
    pub fn apply(&self, tools: Option<&[ToolDefinition]>) -> Option<Vec<ToolDefinition>> {
        let tools = tools?;
        if !self.enabled {
            return Some(tools.to_vec());
        }

        let core: HashSet<&str> = CORE_TOOL_NAMES.iter().copied().collect();
        let promoted = self.promoted.lock_recover().clone();

        let mut out: Vec<ToolDefinition> = Vec::with_capacity(tools.len() + 1);
        for t in tools {
            let name = &t.function.name;
            if core.contains(name.as_str()) || promoted.contains(name.as_str()) {
                out.push(t.clone());
            } else {
                // Stub: replace the heavy description + parameters with a
                // name + one-line-purpose entry. Per the design intent
                // ("name-only stubs"), the model pulls the full schema on
                // demand via expand_tools. Keeping the full description here
                // would defeat the purpose — descriptions are the dominant
                // cost (the original 19 KB of 23 tool descriptions).
                //
                // Accuracy safeguard: instead of a generic "tool available"
                // placeholder, we keep the FIRST SENTENCE of the real
                // description as a one-line purpose summary. This preserves
                // the "when to use" trigger signal so the model still knows
                // what the tool is for and can decide to expand it — without
                // paying for the full multi-paragraph description up front.
                // The summary is derived from the tool's own description, so
                // it can never drift from the real schema.
                out.push(ToolDefinition {
                    r#type: "function".into(),
                    function: duo_types::FunctionDefinition {
                        name: name.clone(),
                        description: format!(
                            "{} — Call expand_tools with [\"{}\"] to load its full description and parameter schema before using it.",
                            Self::summarize(&t.function.description),
                            name
                        ),
                        parameters: serde_json::json!({ "type": "object", "properties": {} }),
                    },
                });
            }
        }

        out.push(expand_tool_definition());
        Some(out)
    }

    /// Produce the answer payload for an `expand_tools` call.
    /// Returns a JSON text containing the full schema(s) of the requested tool.
    /// The tool is permanently promoted so subsequent rounds carry its full schema.
    pub fn handle_expand(
        &self,
        args: &serde_json::Value,
        tools: Option<&[ToolDefinition]>,
    ) -> String {
        let requested = args
            .get("tool")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let tools = match tools {
            Some(t) => t,
            None => {
                return serde_json::json!({
                    "ok": false,
                    "error": "no tool definitions available in this session"
                })
                .to_string()
            }
        };

        // Promote the requested tool (and any alias sharing the name).
        {
            let mut promoted = self.promoted.lock_recover();
            promoted.insert(requested.clone());
        }

        let matched: Vec<&ToolDefinition> = tools
            .iter()
            .filter(|t| t.function.name == requested)
            .collect();

        if matched.is_empty() {
            return serde_json::json!({
                "ok": false,
                "error": format!("unknown tool: {requested}"),
                "available": tools.iter().map(|t| t.function.name.clone()).collect::<Vec<_>>()
            })
            .to_string();
        }

        serde_json::json!({
            "ok": true,
            "tool": requested,
            "schemas": matched.iter().map(|t| {
                serde_json::json!({
                    "type": t.r#type,
                    "function": {
                        "name": t.function.name,
                        "description": t.function.description,
                        "parameters": t.function.parameters
                    }
                })
            }).collect::<Vec<_>>()
        })
        .to_string()
    }
}
