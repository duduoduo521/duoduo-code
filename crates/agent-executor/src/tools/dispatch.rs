//! Single source of truth for tool dispatch.
//!
//! `TOOL_REGISTRY` drives BOTH the sub-agent LLM-facing tool list
//! (`agentic_loop_tools_for`) and the runtime dispatch (`dispatch`). Adding a tool
//! requires a single registry entry instead of editing `execute_tool`'s match arms
//! and `agentic_loop_tools_for`'s push list.
//!
//! ## Scope: this registry does NOT advertise tools to the main loop
//!
//! The main agent loop (`duo-smart-layer::routes::agent::run_loop_handler`) builds
//! the tool list it sends to the LLM **entirely on the TypeScript side**
//! (`session/prompt.ts` → `ToolRegistry.tools()` + MCP). Execution is then
//! Rust-first: `run_loop_handler` calls `execute_tool` (→ this `dispatch`) and only
//! falls back to the TS client when Rust returns an error.
//!
//! Consequence: registering a tool here makes it *executable* by the main loop but
//! **not visible** to the model. A tool intended for the main session must also have
//! a definition in the TS registry (see `packages/duoduo/src/tool/recall_memory.ts`
//! for the canonical example of a Rust-executed, TS-advertised tool).
//!
//! Handlers are plain function pointers returning a pinned, boxed, `Send` future that
//! borrows `exec`/`args` for its lifetime `'a` — the `tower`/`axum` fn-pointer idiom.
//! No per-handler boxing wrapper is needed.

use std::path::Path;
use std::pin::Pin;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use duo_types::timeouts;
use duo_types::MemorySearchRequest;
use duo_types::ToolDefinition;
use memory_system::MemorySystem;
use duo_types::MemoryEntry;
use serde_json::Value;

use crate::agentic_loop::{
    AgenticLoopExecutor, LoopToolSet, apply_patch_tool, glob_tool, proceed_to_execute_tool,
    proceed_to_investigate_tool, proceed_to_plan_tool, proceed_to_verify_tool, task_tool, write_tool,
};
use duo_types::TaskPhase;

/// Handler signature: a function pointer (not a trait object) returning a pinned,
/// boxed, `Send` future bounded by the lifetime `'a` of the borrowed `exec`/`args`.
pub type ToolHandler = for<'a> fn(
    &'a AgenticLoopExecutor,
    &'a Value,
    Arc<Mutex<Vec<String>>>,
    Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>>;

/// One registry entry: names (canonical + aliases), LLM-listing predicate, tool-def
/// factory, and execution handler. This is the only place a tool is declared.
pub struct ToolReg {
    /// Canonical name + aliases — all dispatch to the same handler.
    pub names: &'static [&'static str],
    /// Whether the tool is advertised to the LLM for the given `LoopToolSet`.
    /// Encodes the set membership + env gating that previously lived in
    /// `agentic_loop_tools_for` (L652-685).
    pub listed_when: fn(LoopToolSet) -> bool,
    /// LLM tool-definition factory; `None` => dispatch-only (never advertised),
    /// e.g. glob/write/task which the loop drives without listing them.
    pub meta: Option<fn() -> ToolDefinition>,
    /// Execution handler.
    pub handler: ToolHandler,
}

fn env_eq(v: &str) -> bool {
    std::env::var(v).unwrap_or_default() == "true"
}

fn env_neq(v: &str) -> bool {
    std::env::var(v).unwrap_or_default() != "false"
}

// ── `listed_when` predicates (named fns => unambiguous fn pointers in the static) ──
fn listed_always(_s: LoopToolSet) -> bool {
    true
}
fn listed_never(_s: LoopToolSet) -> bool {
    false
}
fn listed_codegen_explore(s: LoopToolSet) -> bool {
    matches!(s, LoopToolSet::Codegen | LoopToolSet::Explore)
}
fn listed_codegen(s: LoopToolSet) -> bool {
    matches!(s, LoopToolSet::Codegen)
}
fn listed_webfetch(s: LoopToolSet) -> bool {
    matches!(s, LoopToolSet::Explore) && env_eq("DUODUO_ENABLE_WEBFETCH_TOOL")
}
fn listed_clone_repo(s: LoopToolSet) -> bool {
    matches!(s, LoopToolSet::Explore) && env_eq("DUODUO_ENABLE_CLONE_REPO_TOOL")
}
fn listed_graph(_s: LoopToolSet) -> bool {
    env_neq("DUO_FF_GRAPH_QUERY_TOOL")
}
fn listed_symbol(_s: LoopToolSet) -> bool {
    env_neq("DUO_FF_SYMBOL_SEARCH_TOOL")
}

/// Tool definition for `load_skill` — progressive disclosure (Agent Skills style).
/// The system prompt only carries the lightweight skill catalog (name + description);
/// the model expands a full skill body on demand by calling this tool.
fn load_skill_tool() -> ToolDefinition {
    ToolDefinition {
        r#type: "function".into(),
        function: duo_types::FunctionDefinition {
            name: "load_skill".into(),
            description: "渐进式加载一个已安装的技能(Agent Skills 风格)。\
                系统提示词中只包含一个技能目录(name + 描述)。当你判断某个技能与当前任务相关时，\
                调用本工具获取它的完整指令正文(SKILL.md 内容)，随后按技能定义的工作流行动。\
                入参 name 取技能目录(Available Skills)中列出的名字,大小写不敏感。"
                .into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "要展开加载的技能名称(即 Available Skills 目录中列出的 name)"
                    }
                },
                "required": ["name"]
            }),
        },
    }
}

/// Handler: find the installed skill by name and return its full instructions so the
/// model can follow the skill's workflow. Reads the gears dir directly (self-contained,
/// no dependency on GearHost runtime state).
pub fn handle_load_skill<'a>(
    exec: &'a AgenticLoopExecutor,
    args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move {
        let name = args
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("load_skill: missing 'name'"))?;

        let dir = std::env::var("DUODUO_GEARS_DIR")
            .map_err(|_| anyhow::anyhow!("DUODUO_GEARS_DIR is not set"))?;

        let target = name.to_lowercase();
        let mut matched: Option<(String, String)> = None;

        let entries = std::fs::read_dir(&dir)
            .map_err(|e| anyhow::anyhow!("cannot read gears dir {}: {}", dir, e))?;

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let manifest_path = path.join("manifest.toml");
            if !manifest_path.exists() {
                continue;
            }
            let text = match std::fs::read_to_string(&manifest_path) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let manifest = match crate::intel_gear::manifest::GearManifest::from_toml(&text) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let meta_name = manifest.meta.name.to_lowercase();
            let dir_name = entry.file_name().to_string_lossy().to_lowercase();
            if meta_name != target && dir_name != target {
                continue;
            }
            let instructions =
                std::fs::read_to_string(path.join("instructions.md")).unwrap_or_default();
            let body = crate::intel_gear::skill::split_frontmatter(&instructions)
                .1
                .trim()
                .to_string();
            let content = if body.is_empty() {
                instructions.trim().to_string()
            } else {
                body
            };
            matched = Some((manifest.meta.name.clone(), content));
            break;
        }

        match matched {
            Some((mname, content)) => {
                // ── Module 2: agent self-evolution attribution ──
                // Record a gear_apply signal exactly at the point a skill is
                // successfully loaded. Uses the SAME FeedbackLoop Arc instance
                // the loop-termination outcome write uses (injected via
                // run_loop_handler's `.with_feedback(...)`), so both rows land
                // in the same DB/connection — zero cross-process race. Only
                // fires on SUCCESS (matched Some); a failed lookup falls through
                // to the Err arm and records nothing. `intent_type` is sourced
                // from the same `intent_type_spawn` dimension as task_outcomes.
                if let (Some(fb), Some(intent)) = (&exec.feedback, &exec.intent_type) {
                    let fb = fb.clone();
                    let mname = mname.clone();
                    let intent = intent.clone();
                    let session_id = exec
                        .session_id
                        .clone()
                        .unwrap_or_else(|| "unknown".to_string());
                    let _ = tokio::task::spawn_blocking(move || {
                        let _ = fb.record_gear_apply(&session_id, &mname, &intent);
                    })
                    .await;
                }
                Ok(format!(
                    "Skill '{}' loaded. Follow these instructions:\n\n{}",
                    mname, content
                ))
            }
            None => Err(anyhow::anyhow!(
                "skill not installed: {}. Install it from the 智械市场, or check the 'Available Skills' catalog for the exact name.",
                name
            )),
        }
    })
}

// Declaration order strictly mirrors the original `agentic_loop_tools_for` push order
// (read_file, list_dir, grep, bash, submit_code, edit_file, code_comment, graph_query,
// symbol_search, load_skill). With `load_skill` advertised via `listed_always`, Codegen
// yields 10 tools and Explore (no web env vars) yields 7 — the assertions in both
// `agentic_loop::tests` (`test_tools_definition`) and this module's tests must
// stay in lock-step with this order.
pub static TOOL_REGISTRY: &[ToolReg] = &[
    ToolReg {
        names: &["read_file", "read"],
        listed_when: listed_always,
        meta: Some(crate::agentic_loop::read_file_tool),
        handler: read_file_handler,
    },
    ToolReg {
        names: &["list_dir"],
        listed_when: listed_always,
        meta: Some(crate::agentic_loop::list_dir_tool),
        handler: list_dir_handler,
    },
    ToolReg {
        names: &["grep"],
        listed_when: listed_codegen_explore,
        meta: Some(crate::agentic_loop::grep_tool),
        handler: grep_handler,
    },
    ToolReg {
        names: &["bash"],
        listed_when: listed_codegen_explore,
        meta: Some(crate::agentic_loop::bash_tool),
        handler: bash_handler,
    },
    ToolReg {
        names: &["webfetch"],
        listed_when: listed_webfetch,
        meta: Some(crate::agentic_loop::webfetch_tool),
        handler: webfetch_handler,
    },
    ToolReg {
        names: &["clone_repo"],
        listed_when: listed_clone_repo,
        meta: Some(crate::agentic_loop::clone_repo_tool),
        handler: clone_repo_handler,
    },
    ToolReg {
        names: &["submit_code"],
        listed_when: listed_codegen,
        meta: Some(crate::agentic_loop::submit_code_tool),
        handler: submit_code_handler,
    },
    ToolReg {
        names: &["edit_file", "edit"],
        listed_when: listed_codegen,
        meta: Some(crate::agentic_loop::edit_file_tool),
        handler: edit_file_handler,
    },
    ToolReg {
        names: &["code_comment"],
        listed_when: listed_codegen,
        meta: Some(crate::agentic_loop::code_comment_tool),
        handler: code_comment_handler,
    },
    ToolReg {
        names: &["graph_query"],
        listed_when: listed_graph,
        meta: Some(crate::agentic_loop::graph_query_tool),
        handler: graph_query_handler,
    },
    ToolReg {
        names: &["symbol_search"],
        listed_when: listed_symbol,
        meta: Some(crate::agentic_loop::symbol_search_tool),
        handler: symbol_search_handler,
    },
    ToolReg {
        names: &["recall_memory"],
        listed_when: listed_always,
        meta: Some(crate::agentic_loop::recall_memory_tool),
        handler: recall_memory_handler,
    },
    // Dispatch-only: advertised by the loop via other means (or never), but still
    // routable here so the loop's `execute_tool` paths keep working.
    ToolReg {
        names: &["glob"],
        listed_when: listed_never,
        meta: Some(glob_tool),
        handler: glob_handler,
    },
    ToolReg {
        names: &["write", "write_file"],
        listed_when: listed_never,
        meta: Some(write_tool),
        handler: write_handler,
    },
    ToolReg {
        names: &["task"],
        listed_when: listed_never,
        meta: Some(task_tool),
        handler: task_handler,
    },
    ToolReg {
        names: &["load_skill"],
        listed_when: listed_always,
        meta: Some(load_skill_tool),
        handler: handle_load_skill,
    },
    // ── Phase-machine hard-signal tools (§3.3, plan A) ───────────────────────
    // The LLM asserts a legal state transition by calling one of these. The tool
    // NAME is the deterministic hard signal (no text parsing of model output), so
    // it is 100% parse-safe. Advertised to the model via TS `prompt.ts` so they
    // are not double counted in the Rust built-in list. The executor validates
    // the edge (legal-edge table + oscillation / revisit guards) on each call.
    ToolReg {
        names: &["proceed_to_investigate"],
        listed_when: listed_never,
        meta: Some(proceed_to_investigate_tool),
        handler: proceed_to_investigate_handler,
    },
    ToolReg {
        names: &["proceed_to_plan"],
        listed_when: listed_never,
        meta: Some(proceed_to_plan_tool),
        handler: proceed_to_plan_handler,
    },
    ToolReg {
        names: &["proceed_to_execute"],
        listed_when: listed_never,
        meta: Some(proceed_to_execute_tool),
        handler: proceed_to_execute_handler,
    },
    ToolReg {
        names: &["proceed_to_verify"],
        listed_when: listed_never,
        meta: Some(proceed_to_verify_tool),
        handler: proceed_to_verify_handler,
    },
    ToolReg {
        names: &["apply_patch"],
        listed_when: listed_never,
        meta: Some(apply_patch_tool),
        handler: apply_patch_handler,
    },
];

/// Runtime overlay for tools discovered after compile time (Skills / MCP servers /
/// user-installed gears). Consulted *after* `TOOL_REGISTRY` by both `dispatch` and
/// `agentic_loop_tools_for`. Built-ins stay frozen in the static source of truth;
/// this layer adds capabilities without disturbing them.
static DYNAMIC_REGISTRY: Mutex<Vec<ToolReg>> = Mutex::new(Vec::new());

/// Register a runtime tool. P4 adapters (`SkillAdapter` / `McpAdapter` /
/// `BuiltinToolAdapter`) call this. Safe to call repeatedly; pair with
/// [`clear_dynamic_tools`] between independent runs.
///
/// Also mirrors the tool into `GearToolRegistry` so the unified dispatch
/// path can handle it without the legacy DYNAMIC_REGISTRY fallback.
pub fn register_tool(reg: ToolReg) {
    // Mirror into GearToolRegistry for unified dispatch
    let gear_reg = crate::intel_gear::registry::global();
    let definition = reg.meta.map(|m| m());
    for name in reg.names.iter() {
        let tool = std::sync::Arc::new(crate::intel_gear::model::NormalizedTool {
            name: name.to_string(),
            definition: definition.clone().unwrap_or_else(|| duo_types::ToolDefinition {
                r#type: "function".into(),
                function: duo_types::FunctionDefinition {
                    name: name.to_string(),
                    description: String::new(),
                    parameters: serde_json::json!({"type":"object","properties":{}}),
                },
            }),
            source: crate::intel_gear::model::CapabilitySource::Builtin,
            executor: crate::intel_gear::model::ToolExecutor::Builtin { handler: reg.handler },
        });
        gear_reg.register(tool);
    }

    if let Ok(mut r) = DYNAMIC_REGISTRY.lock() {
        r.push(reg);
    } else {
        tracing::warn!("DYNAMIC_REGISTRY poisoned; runtime tool registration skipped");
    }
}

/// Remove all runtime tools (e.g. between sub-agent runs to avoid cross-contamination).
/// Also clears the corresponding entries from GearToolRegistry.
pub fn clear_dynamic_tools() {
    if let Ok(mut r) = DYNAMIC_REGISTRY.lock() {
        // Remove mirrored tools from GearToolRegistry
        let gear_reg = crate::intel_gear::registry::global();
        for reg in r.iter() {
            for name in reg.names.iter() {
                gear_reg.remove(name);
            }
        }
        r.clear();
    } else {
        tracing::warn!("DYNAMIC_REGISTRY poisoned; runtime tool cleanup skipped");
    }
}

/// LLM-facing tool list — single source: static `TOOL_REGISTRY` plus the runtime
/// `DYNAMIC_REGISTRY` overlay. With no dynamic tools registered, output is identical
/// to the old `agentic_loop_tools_for` push order.
pub fn agentic_loop_tools_for(set: LoopToolSet) -> Vec<ToolDefinition> {
    let mut tools: Vec<ToolDefinition> = TOOL_REGISTRY
        .iter()
        .filter(|t| (t.listed_when)(set))
        .filter_map(|t| t.meta)
        .map(|m| m())
        .collect();
    if let Ok(registry) = DYNAMIC_REGISTRY.lock() {
        for t in registry.iter() {
            if (t.listed_when)(set)
                && let Some(m) = t.meta {
                    tools.push(m());
                }
        }
    }
    tools
}

/// Runtime dispatch. `submit_code` is intercepted here (the loop must handle it), and
/// unknown tools return the same error string as the previous `_ =>` arm.
pub fn dispatch<'a>(
    exec: &'a AgenticLoopExecutor,
    name: &'a str,
    args: &'a Value,
    fr: Arc<Mutex<Vec<String>>>,
    rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    if name == "submit_code" {
        return Box::pin(async {
            Err(anyhow::anyhow!("submit_code should be handled at the loop level"))
        });
    }

    // ── IntelGear unified registry (checked FIRST) ──
    // Builtins are self-registered into the global GearToolRegistry exactly once
    // (idempotent). MCP tools are registered by ensure_gear_mcp, plugin/native tools
    // by the install pipeline. `try_execute_with_ctx` handles ALL executor types
    // (Builtin/MCP/Plugin) uniformly, so the legacy TOOL_REGISTRY / DYNAMIC_REGISTRY
    // fallback scans are removed.
    crate::intel_gear::registry::ensure_builtins_registered();
    {
        let gear_reg = crate::intel_gear::registry::global();
        if gear_reg.get(name).is_some() {
            let name_owned = name.to_string();
            let args_owned = args.clone();
            let fr_clone = fr.clone();
            let rr_clone = rr.clone();
            return Box::pin(async move {
                gear_reg.try_execute_with_ctx(&name_owned, &args_owned, exec, fr_clone, rr_clone)
                    .await
                    .unwrap_or_else(|| Err(anyhow::anyhow!("tool '{}' execution failed", name_owned)))
            });
        }
    }

    // MCP prefix fallback: tools with mcp__ prefix not yet registered in GearToolRegistry.
    if crate::mcp::is_mcp_tool(name) {
        // P3: MCP tools were previously routed straight to call_mcp_tool WITHOUT
        // passing through gate_permission — meaning a third-party server's tool
        // could execute even when the same tool name was filtered out of
        // visibleTools or denied by the ruleset. Now MCP tools honor the same
        // permission gate as builtin tools (Deny/Ask, Ask→Allow under
        // auto_accept). "接管道不关阀门": with no pre-existing MCP servers this
        // is zero-disruption — the gate defaults to Ask and auto_accept (or an
        // explicit allow rule) lets it through exactly as before.
        if let Some(rules) = &exec.permission_rules
            && let Err(e) = crate::permission::gate_permission(name, args, rules, exec.interactive, exec.auto_accept) {
                return Box::pin(async move { Err(e) });
            }
        let name_owned = name.to_string();
        let args_owned = args.clone();
        return Box::pin(async move { crate::mcp::call_mcp_tool(&name_owned, &args_owned).await });
    }
    Box::pin(async move {
        Err(anyhow::anyhow!(
            "tool '{}' is not implemented in the Rust agent executor",
            name
        ))
    })
}

// ── Handlers (signatures match the old `execute_tool` match arms, verbatim behaviour) ──

pub fn read_file_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    args: &'a Value,
    fr: Arc<Mutex<Vec<String>>>,
    rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move {
        let path = args
            .get("path")
            .or_else(|| args.get("filePath"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("read_file: missing 'path' argument"))?;
        let offset = args
            .get("offset")
            .and_then(|v| v.as_u64())
            .unwrap_or(1)
            .max(1) as usize;
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(timeouts::DEFAULT_READ_LIMIT as u64)
            .max(1) as usize;
        exec.execute_read_file(path, offset, limit, fr, rr).await
    })
}

pub fn list_dir_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move {
        let path = args
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("list_dir: missing 'path' argument"))?;
        exec.execute_list_dir(path).await
    })
}

pub fn submit_code_handler<'a>(
    _exec: &'a AgenticLoopExecutor,
    _args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async {
        Err(anyhow::anyhow!(
            "submit_code should be handled at the loop level"
        ))
    })
}

pub fn edit_file_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move {
        // If replaceAll is requested, delegate to TS — Rust edit only supports
        // single-occurrence replacement.
        let replace_all = args
            .get("replaceAll")
            .or_else(|| args.get("replace_all"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if replace_all {
            return Err(anyhow::anyhow!(
                "edit_file: replaceAll not supported in Rust, delegate to TS"
            ));
        }
        let path = args
            .get("path")
            .or_else(|| args.get("filePath"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("edit_file: missing 'path' argument"))?;
        let old_text = args
            .get("old_text")
            .or_else(|| args.get("oldString"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("edit_file: missing 'old_text' argument"))?;
        let new_text = args
            .get("new_text")
            .or_else(|| args.get("newString"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("edit_file: missing 'new_text' argument"))?;
        exec.execute_edit_file(path, old_text, new_text).await
    })
}

pub fn write_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move {
        let path = args
            .get("path")
            .or_else(|| args.get("filePath"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("write: missing 'path' argument"))?;
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("write: missing 'content' argument"))?;
        exec.execute_write_file(path, content).await
    })
}

pub fn glob_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move {
        let pattern = args
            .get("pattern")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("glob: missing 'pattern' argument"))?
            .to_string();
        let project_path_for_glob = args
            .get("projectPath")
            .or_else(|| args.get("path"))
            .and_then(|v| v.as_str())
            .unwrap_or(".")
            .to_string();
        let max = args
            .get("maxResults")
            .and_then(|v| v.as_u64())
            .unwrap_or(100) as usize;
        let project = exec.project_path().clone();
        tokio::task::spawn_blocking(move || {
            crate::tools::glob::glob_search(
                &pattern,
                Path::new(if project_path_for_glob == "." {
                    project.to_str().unwrap_or(".")
                } else {
                    &project_path_for_glob
                }),
                max,
            )
            .map(|files| serde_json::to_string(&files).unwrap_or_default())
            .map_err(|e| anyhow::anyhow!("glob failed: {}", e))
        })
        .await?
    })
}

pub fn grep_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move {
        let pattern = args
            .get("pattern")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("grep: missing 'pattern' argument"))?;
        let relative_path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let include_glob = args.get("include").and_then(|v| v.as_str());
        let max_results = args
            .get("max_results")
            .and_then(|v| v.as_u64())
            .unwrap_or(50) as usize;
        exec.execute_grep(pattern, relative_path, include_glob, max_results)
            .await
    })
}

pub fn bash_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move {
        let command = args
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("bash: missing 'command' argument"))?;
        let timeout_secs = args
            .get("timeout_secs")
            .or_else(|| args.get("timeout"))
            .and_then(|v| v.as_u64());
        exec.execute_bash(command, timeout_secs).await
    })
}

pub fn webfetch_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move {
        let url = args
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("webfetch: missing 'url'"))?;
        let format = args
            .get("format")
            .and_then(|v| v.as_str())
            .unwrap_or("markdown");
        let timeout = args.get("timeout").and_then(|v| v.as_u64());
        exec.execute_webfetch(url, format, timeout).await
    })
}

pub fn clone_repo_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move {
        let url = args
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("clone_repo: missing 'url'"))?;
        let branch = args.get("branch").and_then(|v| v.as_str());
        exec.execute_clone_repo(url, branch).await
    })
}

pub fn graph_query_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move { exec.execute_graph_query(args).await })
}

pub fn symbol_search_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move { exec.execute_symbol_search(args).await })
}

pub fn recall_memory_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move {
        let mem: &MemorySystem = exec
            .memory()
            .ok_or_else(|| anyhow::anyhow!("recall_memory: memory system not available"))?;
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("recall_memory: missing 'query'"))?
            .to_string();
        let limit = args
            .get("top_k")
            .and_then(|v| v.as_u64())
            .or_else(|| args.get("limit").and_then(|v| v.as_u64()))
            .map(|n| (n as usize).clamp(1, 50))
            .unwrap_or(10);
        // P1-10: the project scope is a server-side fact, not a model choice —
        // force the executor's project path (same pattern as glob_handler).
        // A model-supplied or omitted project_path previously scoped the query
        // to '' (see store.rs `OR project_path = ''`), which returns memories
        // from ALL projects.
        let project_path = Some(exec.project_path().to_string_lossy().to_string());
        let req = MemorySearchRequest {
            query: query.clone(),
            limit,
            layers: None,
            tags: None,
            project_path,
            session_id: None,
        };
        let entries = mem
            .search(&req)
            .map_err(|e| anyhow::anyhow!("recall_memory failed: {e}"))?;
        // ── P2-B 热路径：召回命中则累加 recall_hits(前端 metrics 面板可轮询) ──
        if !entries.is_empty() {
            exec.recall_hits().fetch_add(1, Ordering::Relaxed);
        }
        Ok(format_recall_entries(&query, &entries))
    })
}

/// Render memory entries as compact, token-efficient lines — identical in
/// shape to the TS fallback (`recall_memory.ts::formatEntries`) so the model
/// sees a consistent format regardless of which execution path served it.
fn format_recall_entries(query: &str, entries: &[MemoryEntry]) -> String {
    if entries.is_empty() {
        return format!("No long-term memory found for \"{query}\".");
    }
    let mut lines = vec![format!(
        "Recalled {} memory entr{}:",
        entries.len(),
        if entries.len() == 1 { "y" } else { "ies" }
    )];
    lines.push(String::new());
    for entry in entries {
        let score = if entry.score.is_finite() {
            format!("{:.3}", entry.score)
        } else {
            "n/a".to_string()
        };
        let tags = if entry.tags.is_empty() {
            String::new()
        } else {
            format!(" tags=[{}]", entry.tags.join(", "))
        };
        lines.push(format!("- [{}] (score {}{})", entry.layer, score, tags));
        lines.push(format!("  {}", entry.content.split_whitespace().collect::<Vec<_>>().join(" ")));
    }
    lines.join("\n")
}

pub fn task_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move { exec.execute_task(args).await })
}

/// Phase-machine hard-signal tools (§3.3, plan A): the LLM explicitly asserts a
/// legal state transition by calling `proceed_to_*`. The tool NAME is the
/// deterministic hard signal — no text parsing of the model's free-form output,
/// so it is 100% parse-safe. The executor validates the edge (legal-edge table
/// + oscillation / revisit guards) and returns the resulting phase.
fn proceed_to_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    target: TaskPhase,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move {
        let target_desc = match target {
            TaskPhase::Investigate => "Investigate",
            TaskPhase::Plan => "Plan",
            TaskPhase::Execute => "Execute",
            TaskPhase::Verify => "Verify",
        };
        let (after, changed) = exec.proceed_to(target);
        let desc = match after {
            TaskPhase::Investigate => "Investigate",
            TaskPhase::Plan => "Plan",
            TaskPhase::Execute => "Execute",
            TaskPhase::Verify => "Verify",
        };
        if changed {
            Ok(format!(
                "Phase advanced to {}. Continue with the work appropriate to this phase.",
                desc
            ))
        } else {
            Ok(format!(
                "Phase transition to {} was not applied (illegal edge or guard limit reached). \
                 Current phase remains {}.",
                target_desc, desc
            ))
        }
    })
}

pub fn proceed_to_investigate_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    _args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    proceed_to_handler(exec, TaskPhase::Investigate)
}

pub fn proceed_to_plan_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    _args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    proceed_to_handler(exec, TaskPhase::Plan)
}

pub fn proceed_to_execute_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    _args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    proceed_to_handler(exec, TaskPhase::Execute)
}

pub fn proceed_to_verify_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    _args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    proceed_to_handler(exec, TaskPhase::Verify)
}

pub fn code_comment_handler<'a>(
    exec: &'a AgenticLoopExecutor,
    args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move {
        // G5 回流: persist a review comment to the blackboard so the loop's Reflect
        // phase can surface it (mirrors TS code_comment.ts).
        let file_path = args
            .get("file_path")
            .or_else(|| args.get("path"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("code_comment: missing 'file_path' argument"))?;
        let line = args.get("line").and_then(|v| v.as_u64()).map(|v| v as u32);
        let comment = args
            .get("comment")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("code_comment: missing 'comment' argument"))?;
        let author = args
            .get("author")
            .and_then(|v| v.as_str())
            .unwrap_or("rust-agent");
        match exec.blackboard() {
            Some(bb) => {
                let id = crate::tools::code_comment::create_code_comment_and_annotate(
                    bb,
                    file_path,
                    line,
                    comment,
                    author,
                    Some(exec.project_path().as_path()),
                )?;
                Ok(format!("Code comment recorded (annotation id: {}).", id))
            }
            None => Ok(
                "Code comment recorded in-memory only (no blackboard available).".to_string(),
            ),
        }
    })
}

/// `apply_patch` is executed entirely on the TS side (`packages/duoduo/src/tool/apply_patch.ts`).
/// The Rust side holds only the canonical `ToolDefinition` (see `apply_patch_tool` in
/// `agentic_loop.rs`) for the Layer A single-source contract. This handler exists solely so
/// the tool can be registered as a dispatch-only entry (mounting its schema) and returns an
/// explicit pointer to the TS execution path if it is ever reached on the Rust side.
pub fn apply_patch_handler<'a>(
    _exec: &'a AgenticLoopExecutor,
    _args: &'a Value,
    _fr: Arc<Mutex<Vec<String>>>,
    _rr: Arc<AtomicUsize>,
) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
    Box::pin(async move {
        Ok("apply_patch is executed by the TypeScript side of the agent. The Rust side only \
           holds the canonical tool schema for the LLM contract; route this call through the \
           TS session, not the Rust dispatch path."
            .to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic_loop::{LoopToolSet, read_file_tool};

    #[test]
    fn dynamic_overlay_is_consulted_by_tool_list() {
        clear_dynamic_tools();
        let before = agentic_loop_tools_for(LoopToolSet::Codegen).len();
        // Register a runtime tool (mirrors what P4 SkillAdapter/McpAdapter would do).
        register_tool(ToolReg {
            names: &["dyn_probe"],
            listed_when: |_| true,
            meta: Some(read_file_tool),
            handler: read_file_handler,
        });
        let after = agentic_loop_tools_for(LoopToolSet::Codegen).len();
        assert_eq!(after, before + 1, "dynamic tool must extend the tool list");
        clear_dynamic_tools();
        assert_eq!(
            agentic_loop_tools_for(LoopToolSet::Codegen).len(),
            before,
            "clear_dynamic_tools must restore the static-only list"
        );
    }
}
