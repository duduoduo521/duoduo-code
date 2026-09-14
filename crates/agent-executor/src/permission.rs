//! Permission checking for tool execution in agentic_loop.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use anyhow::anyhow;
use permission_eval::{self as pe, Rule, RuleAction};

/// Result of a permission check.
#[derive(Debug, Clone, PartialEq)]
pub enum PermissionResult {
    Allow,
    Deny,
    Ask,
}

/// A permission rule (mirrors TS Permission.Ruleset).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum PermissionRule {
    Allow {
        permission: String,
        pattern: String,
    },
    Deny {
        permission: String,
        pattern: String,
    },
    Ask {
        permission: String,
        pattern: String,
        /// TS-side `Permission.Rule` only carries `{permission, pattern, action}`
        /// on the wire (the `always` list lives on the ask *Request*, not the
        /// rule), so this field MUST tolerate absence — a strict field made
        /// every ruleset containing an ask rule fail deserialization as a
        /// whole, which callers papered over with an empty-ruleset fallback,
        /// silently flipping every tool to fail-closed Ask.
        #[serde(default)]
        always: Vec<String>,
    },
}

/// Adapt agent-executor's `PermissionRule` (the wire/config format
/// deserialized from TS) into `permission-eval`'s `Rule`s so the single
/// unified evaluation core can be used.
///
/// Historically `check_permission` matched the tool name against **either** the
/// rule's `permission` field **or** its `pattern` field (OR). The unified
/// `evaluate` core matches its two dimensions with AND, so each rule is
/// registered twice — once per field as the tool-name dimension — leaving the
/// argument (`pattern`) dimension unconstrained (`"*"`). `always` is dropped
/// (the unified evaluator does not consume it).
fn to_eval_rules(rules: &[PermissionRule]) -> Vec<Rule> {
    let mut out = Vec::with_capacity(rules.len() * 2);
    for r in rules {
        let action = match r {
            PermissionRule::Allow { .. } => RuleAction::Allow,
            PermissionRule::Deny { .. } => RuleAction::Deny,
            PermissionRule::Ask { .. } => RuleAction::Ask,
        };
        let (permission, pattern) = match r {
            PermissionRule::Allow { permission, pattern }
            | PermissionRule::Deny { permission, pattern }
            | PermissionRule::Ask { permission, pattern, .. } => (permission, pattern),
        };
        out.push(Rule {
            permission: permission.clone(),
            pattern: "*".to_string(),
            action: action.clone(),
        });
        out.push(Rule {
            permission: pattern.clone(),
            pattern: "*".to_string(),
            action,
        });
    }
    out
}

/// Check if a tool execution is allowed by the given ruleset.
///
/// Delegates to the unified `permission-eval` core (`evaluate`), which:
/// - uses TS-compatible wildcard matching (`*`/`?`, metachar escaping),
/// - applies **findLast** precedence (last matching rule wins),
/// - returns **Ask** by default when nothing matches (fail-closed).
///
/// The tool name is matched against both the rule's `permission` and `pattern`
/// fields (preserving historical OR semantics); the argument (`pattern`)
/// dimension is unconstrained (`"*"`) because agent-executor gates only on the
/// tool name.
///
/// # Argument-dimension boundary (Rust vs TS `evaluate`)
/// `permission-eval::evaluate(permission, pattern, …)` is a *two-dimensional*
/// AND match: a rule's `permission` matches the tool name **and** its `pattern`
/// matches the tool *arguments*. `agent-executor` gates only on the tool name,
/// so `check_permission` always passes `"*"` for the argument dimension. As a
/// result a rule's `pattern` field is used purely as an *alternative tool-name*
/// matcher (via `to_eval_rules`) — **not** as an argument/command matcher.
///
/// Therefore TS rulesets that rely on `pattern` matching the actual arguments
/// (e.g. `Deny bash "rm *"`) behave differently on the Rust path: Rust would
/// treat `pattern: "rm *"` as an alternate *tool-name* pattern (matching a tool
/// literally named `rm *`), not as a guard against `bash rm …` commands. This
/// is a known, intentional boundary between the two evaluators, not a bug; if
/// argument-level gating is required on the Rust path the ruleset must be
/// aligned accordingly (or `to_eval_rules` extended to forward the argument
/// dimension — a larger change left as a decision for the product/owner).
pub fn check_permission(
    tool_name: &str,
    _args: &Value,
    rules: &[PermissionRule],
) -> PermissionResult {
    let eval_rules = to_eval_rules(rules);
    let result = pe::evaluate(tool_name, "*", &eval_rules);
    match result.action {
        RuleAction::Allow => PermissionResult::Allow,
        RuleAction::Deny => PermissionResult::Deny,
        RuleAction::Ask => PermissionResult::Ask,
    }
}

/// Gate a tool call inside `AgenticLoopExecutor::execute_tool` against the
/// executor's permission ruleset. Pure decision, no side effects — extracted
/// from `execute_tool` so the (sub-agent vs interactive) gating policy can be
/// unit-tested without invoking async tool execution.
///
/// Reuses the unified `permission-eval` core via `check_permission` (findLast
/// precedence, default Ask / fail-closed) and additionally encodes the
/// (sub-agent vs interactive) + auto-accept policy:
/// - `Ask` while `interactive == true` (main agent, TS-bridged) is allowed
///   through; the upstream `run_loop_handler` surfaces the confirmation prompt.
/// - `Ask` while `interactive == false` (autonomous sub-agent, no UI to prompt
///   mid-loop) is **denied by default** — the fail-closed behavior the sub-agent
///   path relies on, so a sub-agent can never block waiting on a human.
/// - `Ask` while `interactive == false` **but `auto_accept == true`** (the user's
///   "auto-accept permissions" switch) is allowed through — honoring the switch
///   so night-time autonomous work is not interrupted by confirmation prompts.
pub fn gate_permission(
    tool_name: &str,
    args: &serde_json::Value,
    rules: &[PermissionRule],
    interactive: bool,
    auto_accept: bool,
) -> anyhow::Result<()> {
    match check_permission(tool_name, args, rules) {
        PermissionResult::Deny => Err(anyhow!(
            "Permission denied for tool '{}' by executor permission rules",
            tool_name
        )),
        PermissionResult::Ask => {
            if interactive || auto_accept {
                // Interactive main agents let the upstream layer handle the
                // prompt; sub-agents with auto-accept on treat Ask as Allow.
                Ok(())
            } else {
                Err(anyhow!(
                    "Permission required (ask) for tool '{}', but this autonomous sub-agent cannot prompt for confirmation",
                    tool_name
                ))
            }
        }
        PermissionResult::Allow => Ok(()),
    }
}

/// Truncate tool output to fit within the byte limit.
pub fn truncate_output(output: &str, max_bytes: usize) -> String {
    if output.len() <= max_bytes {
        return output.to_string();
    }
    // Truncate on a char boundary (`str::floor_char_boundary`, Rust 1.87+)
    // so multi-byte characters are never split.
    let end = output.floor_char_boundary(max_bytes);
    format!(
        "{}...[truncated {} bytes]",
        &output[..end],
        output.len() - end
    )
}

/// Error types for tool execution middleware chain.
#[derive(Debug)]
pub enum ToolExecutionError {
    Validation(String),
    PermissionDenied(String),
    PermissionAsk(String),
    SandboxViolation(String),
}

/// Execute a Rust-native tool by name.
/// Only high-frequency tools are handled here; others return an error indicating
/// they should be delegated to TS.
fn execute_rust_tool(
    tool_name: &str,
    args: &serde_json::Value,
    project_path: &str,
) -> Result<String, ToolExecutionError> {
    match tool_name {
        "read" | "read_file" => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ToolExecutionError::Validation("missing 'path' arg".into()))?;
            let full_path = if std::path::Path::new(path).is_absolute() {
                path.to_string()
            } else {
                std::path::PathBuf::from(project_path)
                    .join(path)
                    .to_string_lossy()
                    .to_string()
            };
            std::fs::read_to_string(&full_path)
                .map_err(|e| ToolExecutionError::Validation(format!("read failed: {}", e)))
        }
        "glob" => {
            let pattern = args
                .get("pattern")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ToolExecutionError::Validation("missing 'pattern' arg".into()))?;
            let project_path = args
                .get("projectPath")
                .and_then(|v| v.as_str())
                .unwrap_or(".");
            let max = args
                .get("maxResults")
                .and_then(|v| v.as_u64())
                .unwrap_or(100) as usize;
            crate::tools::glob::glob_search(pattern, std::path::Path::new(project_path), max)
                .map(|files| serde_json::to_string(&files).unwrap_or_default())
                .map_err(|e| ToolExecutionError::Validation(format!("glob failed: {}", e)))
        }
        "graph_query" => {
            // Feature Flag guard: default enabled (opt-out via DUO_FF_GRAPH_QUERY_TOOL=false)
            if std::env::var("DUO_FF_GRAPH_QUERY_TOOL").unwrap_or_default() == "false" {
                return Err(ToolExecutionError::Validation(
                    "graph_query tool is disabled. Use grep for text-based search instead."
                        .to_string(),
                ));
            }

            // Knowledge graph query tool
            let query_type = args
                .get("query_type")
                .and_then(|v| v.as_str())
                .unwrap_or("search");
            let target = args.get("target").and_then(|v| v.as_str()).unwrap_or("");
            let _hops = args
                .get("hops")
                .and_then(|v| v.as_u64())
                .unwrap_or(1)
                .min(3) as usize;
            let _limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(20) as usize;

            // Note: KG execution requires KnowledgeGraphStore reference which is not
            // available in execute_rust_tool's current signature. This tool will be
            // delegated to TS for now, with Rust-side execution added when the
            // signature is extended to accept AppState references.
            Err(ToolExecutionError::Validation(format!(
                "graph_query: delegated to TS — target={}, query_type={}",
                target, query_type
            )))
        }
        "symbol_search" => {
            // Feature Flag guard: default enabled (opt-out via DUO_FF_SYMBOL_SEARCH_TOOL=false)
            if std::env::var("DUO_FF_SYMBOL_SEARCH_TOOL").unwrap_or_default() == "false" {
                return Err(ToolExecutionError::Validation(
                    "symbol_search tool is disabled. Use grep for text-based search instead."
                        .to_string(),
                ));
            }

            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("all");
            let _limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(20) as usize;

            // Note: CodeSearch execution requires CodeSearch reference which is not
            // available in execute_rust_tool's current signature. This tool will be
            // delegated to TS for now.
            Err(ToolExecutionError::Validation(format!(
                "symbol_search: delegated to TS — query={}, kind={}",
                query, kind
            )))
        }
        // Note: "todo_write" / "todo" / "todowrite" are NOT handled here.
        // The TS tool name is "todowrite" (no underscore), which falls through to
        // the _ branch below and is delegated to TS for full persistence
        // (Todo.Service.update → DB write + Bus event + frontend sync).
        // The old "todo_write" match arm was dead code — LLM never sends that name.
        _ => {
            // Tool not implemented in Rust — should be delegated to TS
            Err(ToolExecutionError::Validation(format!(
                "tool '{}' not implemented in Rust — delegate to TS",
                tool_name
            )))
        }
    }
}

/// Check tool execution permission without actually executing the tool.
///
/// Performs the first 3 layers of the middleware chain:
/// 1. Validation — check tool name is non-empty
/// 2. Permission — check against ruleset (Allow/Deny/Ask)
/// 3. Sandbox — path security check for file tools
///
/// Returns `Ok(())` if the tool is allowed to execute, or the appropriate
/// error if permission is denied, needs user confirmation, or sandbox
/// violation is detected.
///
/// This is used by `run_loop_handler` to gate tool execution before calling
/// `AgenticLoopExecutor::execute_tool` for the actual execution.
pub fn check_tool_permission(
    tool_name: &str,
    args: &serde_json::Value,
    rules: &[PermissionRule],
    security_policy: &security_design::SecurityPolicy,
    auto_accept: bool,
) -> Result<(), ToolExecutionError> {
    // Layer 1: Validation
    if tool_name.is_empty() {
        return Err(ToolExecutionError::Validation(
            "empty tool name".to_string(),
        ));
    }

    // Layer 2: Permission
    match check_permission(tool_name, args, rules) {
        PermissionResult::Deny => {
            return Err(ToolExecutionError::PermissionDenied(tool_name.to_string()));
        }
        PermissionResult::Ask => {
            // P2-23: honour the user's "auto-accept permissions" switch here too.
            // `gate_permission` (the sub-agent gate) already did, so the same
            // switch behaved oppositely on the two paths: with auto-accept on, a
            // sub-agent ran the tool while the main loop still stopped to ask.
            if auto_accept {
                return Ok(());
            }
            return Err(ToolExecutionError::PermissionAsk(tool_name.to_string()));
        }
        PermissionResult::Allow => {}
    }

    // Layer 3: Sandbox (path check for file tools)
    // Support both Rust-style (path, projectPath) and TS-style (filePath)
    // parameter names so the sandbox check works regardless of which
    // naming convention the LLM used.
    if let Some(path) = args
        .get("path")
        .or_else(|| args.get("filePath"))
        .or_else(|| args.get("projectPath"))
        .and_then(|v| v.as_str())
        && security_policy.check_path_access(path).is_err() {
            return Err(ToolExecutionError::SandboxViolation(path.to_string()));
        }

    Ok(())
}

/// Execute a tool with the 7-layer middleware chain:
/// 1. Validation — check tool name and args
/// 2. Permission — check against ruleset
/// 3. Sandbox — path security check
/// 4. Execution — actual tool execution
/// 5. Output truncation — limit output size
/// 6. Audit — log the execution
/// 7. Result — return the output
///
/// Note: For the `run_loop_handler` path, prefer using `check_tool_permission`
/// (layers 1-3) + `AgenticLoopExecutor::execute_tool` (layer 4 with full
/// async support) + `truncate_output` (layer 5) separately. This function
/// is retained for backward compatibility with the old synchronous path.
pub fn execute_tool_with_middleware(
    tool_name: &str,
    args: &serde_json::Value,
    rules: &[PermissionRule],
    security_policy: &security_design::SecurityPolicy,
    _max_output_bytes: usize,
    project_path: &str,
) -> Result<String, ToolExecutionError> {
    // Layer 1: Validation
    if tool_name.is_empty() {
        return Err(ToolExecutionError::Validation(
            "empty tool name".to_string(),
        ));
    }

    // Layer 2: Permission
    match check_permission(tool_name, args, rules) {
        PermissionResult::Deny => {
            return Err(ToolExecutionError::PermissionDenied(tool_name.to_string()));
        }
        PermissionResult::Ask => {
            return Err(ToolExecutionError::PermissionAsk(tool_name.to_string()));
        }
        PermissionResult::Allow => {}
    }

    // Layer 3: Sandbox (path check for file tools)
    // Support both Rust-style (path, projectPath) and TS-style (filePath)
    // parameter names so the sandbox check works regardless of which
    // naming convention the LLM used.
    if let Some(path) = args
        .get("path")
        .or_else(|| args.get("filePath"))
        .or_else(|| args.get("projectPath"))
        .and_then(|v| v.as_str())
        && security_policy.check_path_access(path).is_err() {
            return Err(ToolExecutionError::SandboxViolation(path.to_string()));
        }

    // Layer 4: Execution — execute Rust-native tools directly.
    // High-frequency read-only tools (read, glob) are executed in Rust.
    // All other tools (write, bash, grep, edit, todo_write, MCP, subtask, skill, lsp)
    // are delegated to TS via the ToolResultRegistry — the caller handles those.
    let raw_output = execute_rust_tool(tool_name, args, project_path)?;

    // Layer 5: Output truncation
    let truncated = truncate_output(&raw_output, _max_output_bytes);

    // Layer 6: Audit (log execution)
    tracing::info!(
        tool = tool_name,
        output_len = truncated.len(),
        "tool executed via middleware"
    );

    // Layer 7: Return result
    Ok(truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_permission_default_ask() {
        // Unified core returns Ask (fail-closed) when no rule matches,
        // instead of the historical default Allow.
        assert_eq!(
            check_permission("read_file", &Value::Null, &[]),
            PermissionResult::Ask
        );
    }

    #[test]
    fn test_check_permission_deny() {
        let rules = vec![PermissionRule::Deny {
            permission: "bash".to_string(),
            pattern: "bash".to_string(),
        }];
        assert_eq!(
            check_permission("bash", &Value::Null, &rules),
            PermissionResult::Deny
        );
    }

    #[test]
    fn test_check_permission_allow_rule() {
        let rules = vec![PermissionRule::Allow {
            permission: "read_file".to_string(),
            pattern: "read_file".to_string(),
        }];
        assert_eq!(
            check_permission("read_file", &Value::Null, &rules),
            PermissionResult::Allow
        );
    }

    #[test]
    fn test_check_permission_ask() {
        let rules = vec![PermissionRule::Ask {
            permission: "bash".to_string(),
            pattern: "bash".to_string(),
            always: vec![],
        }];
        assert_eq!(
            check_permission("bash", &Value::Null, &rules),
            PermissionResult::Ask
        );
    }

    #[test]
    fn test_check_permission_glob_star() {
        // "*" on the permission dimension matches every tool name.
        let rules = vec![PermissionRule::Deny {
            permission: "*".to_string(),
            pattern: "*".to_string(),
        }];
        assert_eq!(
            check_permission("bash", &Value::Null, &rules),
            PermissionResult::Deny
        );
    }

    #[test]
    fn test_check_permission_glob_prefix() {
        let rules = vec![PermissionRule::Deny {
            permission: "web".to_string(),
            pattern: "web*".to_string(),
        }];
        assert_eq!(
            check_permission("websearch", &Value::Null, &rules),
            PermissionResult::Deny
        );
        assert_eq!(
            check_permission("webfetch", &Value::Null, &rules),
            PermissionResult::Deny
        );
        // read_file matches neither "web" nor "web*", so it falls through to the
        // unified default → Ask (fail-closed) rather than the old default Allow.
        assert_eq!(
            check_permission("read_file", &Value::Null, &rules),
            PermissionResult::Ask
        );
    }

    // ── Sub-agent / interactive permission gate (gate_permission) ─────────────
    // Closes the "sub-agent path has no unit test" blind spot: the exact
    // decision `AgenticLoopExecutor::execute_tool` makes before any side effect.

    #[test]
    fn test_gate_subagent_default_ask_denied() {
        // Autonomous sub-agent (interactive=false, auto_accept=false) with NO
        // rules → unified default Ask becomes Deny (no UI to prompt mid-loop).
        // This is the fail-closed behavior the sub-agent path relies on.
        let err = gate_permission("read_file", &Value::Null, &[], false, false)
            .expect_err("sub-agent default Ask must be denied");
        assert!(
            err.to_string().contains("cannot prompt for confirmation"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn test_gate_subagent_auto_accept_allows() {
        // Autonomous sub-agent (interactive=false) with auto-accept ON honors the
        // user's "auto-accept permissions" switch: the default Ask is treated as
        // Allow, so night-time autonomous work is not blocked by confirmation
        // prompts. This is option B of the unification refactor.
        assert!(gate_permission("read_file", &Value::Null, &[], false, true).is_ok());
    }

    #[test]
    fn test_gate_subagent_deny_denied() {
        let rules = vec![PermissionRule::Deny {
            permission: "bash".to_string(),
            pattern: "bash".to_string(),
        }];
        assert!(gate_permission("bash", &Value::Null, &rules, false, false).is_err());
    }

    #[test]
    fn test_gate_subagent_allow_ok() {
        let rules = vec![PermissionRule::Allow {
            permission: "bash".to_string(),
            pattern: "*".to_string(),
        }];
        assert!(gate_permission("bash", &Value::Null, &rules, false, false).is_ok());
    }

    #[test]
    fn test_gate_interactive_default_ask_ok() {
        // Interactive main agent: default Ask is allowed through (delegated to TS
        // for confirmation) — must NOT be denied.
        assert!(gate_permission("read_file", &Value::Null, &[], true, false).is_ok());
    }

    #[test]
    fn test_gate_interactive_deny_denied() {
        let rules = vec![PermissionRule::Deny {
            permission: "*".to_string(),
            pattern: "*".to_string(),
        }];
        assert!(gate_permission("read_file", &Value::Null, &rules, true, false).is_err());
    }

    #[test]
    fn test_truncate_output_within_limit() {
        assert_eq!(truncate_output("hello", 100), "hello");
    }

    #[test]
    fn test_truncate_output_exceeds_limit() {
        let long = "x".repeat(200);
        let result = truncate_output(&long, 100);
        assert!(result.contains("...[truncated"));
        assert!(result.len() < 200);
    }

    #[test]
    fn test_truncate_output_multibyte() {
        // Japanese characters — each is 3 bytes in UTF-8
        let input = "あいうえお"; // 15 bytes
        let result = truncate_output(input, 10);
        // Should truncate at a char boundary (after あいう = 9 bytes)
        assert!(result.contains("...[truncated"));
        assert!(!result.is_empty());
    }

    #[test]
    fn test_execute_tool_with_middleware_empty_name() {
        let policy = security_design::SecurityPolicy::default();
        let result = execute_tool_with_middleware("", &Value::Null, &[], &policy, 1024, ".");
        assert!(matches!(result, Err(ToolExecutionError::Validation(_))));
    }

    #[test]
    fn test_execute_tool_with_middleware_deny() {
        let policy = security_design::SecurityPolicy::default();
        let rules = vec![PermissionRule::Deny {
            permission: "bash".to_string(),
            pattern: "bash".to_string(),
        }];
        let result = execute_tool_with_middleware("bash", &Value::Null, &rules, &policy, 1024, ".");
        assert!(matches!(
            result,
            Err(ToolExecutionError::PermissionDenied(_))
        ));
    }

    #[test]
    fn test_execute_tool_with_middleware_ask() {
        let policy = security_design::SecurityPolicy::default();
        let rules = vec![PermissionRule::Ask {
            permission: "bash".to_string(),
            pattern: "bash".to_string(),
            always: vec![],
        }];
        let result = execute_tool_with_middleware("bash", &Value::Null, &rules, &policy, 1024, ".");
        assert!(matches!(result, Err(ToolExecutionError::PermissionAsk(_))));
    }

    #[test]
    fn test_execute_tool_with_middleware_default_ask() {
        let policy = security_design::SecurityPolicy::default();
        // No rules → unified default is Ask (fail-closed), so an unmatched tool
        // is gated with PermissionAsk (delegated to TS for confirmation) instead
        // of silently executing.
        let result =
            execute_tool_with_middleware("unknown_tool", &Value::Null, &[], &policy, 1024, ".");
        assert!(matches!(result, Err(ToolExecutionError::PermissionAsk(_))));
    }

    // ── Regression: TS wire rules must deserialize without an `always` field ──
    //
    // TS `Permission.Rule` only sends `{permission, pattern, action}` (see
    // packages/duoduo/src/permission/index.ts). A strict `always` on the Ask
    // variant made EVERY ruleset containing an ask rule fail serde as a whole,
    // which the run_loop handler papered over with an empty-ruleset fallback —
    // silently flipping all tools (even `*: allow` reads) to fail-closed Ask
    // and delegating them to the TS slow path.

    #[test]
    fn test_deserialize_ts_wire_rules_without_always() {
        let json = r#"[
            {"permission":"*","action":"allow","pattern":"*"},
            {"permission":"doom_loop","action":"ask","pattern":"*"},
            {"permission":"external_directory","action":"ask","pattern":"*"},
            {"permission":"question","action":"deny","pattern":"*"},
            {"permission":"read","action":"allow","pattern":"*"},
            {"permission":"read","action":"ask","pattern":"*.env"}
        ]"#;
        let rules: Vec<PermissionRule> =
            serde_json::from_str(json).expect("TS-shaped rules must parse without `always`");
        assert_eq!(rules.len(), 6);
    }

    #[test]
    fn test_ts_wire_rules_allow_read_only_tools() {
        // The exact production failure: with the rules parsed, `read`/`glob`/
        // `bash` under `*: allow` must be Allow (not fail-closed Ask).
        let json = r#"[
            {"permission":"*","action":"allow","pattern":"*"},
            {"permission":"doom_loop","action":"ask","pattern":"*"},
            {"permission":"external_directory","action":"ask","pattern":"*"},
            {"permission":"read","action":"allow","pattern":"*"},
            {"permission":"read","action":"ask","pattern":"*.env"},
            {"permission":"question","action":"allow","pattern":"*"}
        ]"#;
        let rules: Vec<PermissionRule> = serde_json::from_str(json).expect("parse");
        let policy = security_design::SecurityPolicy::default();
        for tool in ["read", "glob", "bash"] {
            let res = check_tool_permission(tool, &Value::Null, &rules, &policy, false);
            assert!(
                res.is_ok(),
                "tool '{tool}' must be Allow under '*: allow' rules, got {:?}",
                res.err()
            );
        }
    }

    // ── P2-23: `check_tool_permission` must honour the auto-accept switch ──
    //
    // `gate_permission` already did, so the same user setting produced opposite
    // outcomes on the two paths.

    #[test]
    fn check_tool_permission_asks_when_auto_accept_off() {
        let policy = security_design::SecurityPolicy::default();
        let res = check_tool_permission("bash", &Value::Null, &[], &policy, false);
        assert!(
            matches!(res, Err(ToolExecutionError::PermissionAsk(_))),
            "without auto-accept the caller must still be asked, got: {res:?}"
        );
    }

    #[test]
    fn check_tool_permission_allows_when_auto_accept_on() {
        let policy = security_design::SecurityPolicy::default();
        assert!(
            check_tool_permission("bash", &Value::Null, &[], &policy, true).is_ok(),
            "auto-accept must mean 'do not stop to ask' on this path too"
        );
    }

    #[test]
    fn check_tool_permission_still_denies_with_auto_accept_on() {
        let policy = security_design::SecurityPolicy::default();
        let rules = vec![PermissionRule::Deny {
            permission: "bash".to_string(),
            pattern: "*".to_string(),
        }];
        assert!(
            matches!(
                check_tool_permission("bash", &Value::Null, &rules, &policy, true),
                Err(ToolExecutionError::PermissionDenied(_))
            ),
            "auto-accept relaxes Ask, never Deny"
        );
    }

    #[test]
    fn test_execute_tool_with_middleware_glob() {
        let policy = security_design::SecurityPolicy::default();
        // Explicit Allow so the permission layer passes and we can verify the
        // tool actually executes (Layer 4). Default is now Ask (fail-closed).
        let rules = vec![PermissionRule::Allow {
            permission: "glob".to_string(),
            pattern: "*".to_string(),
        }];
        let args = serde_json::json!({"pattern": "*.rs", "projectPath": ".", "maxResults": 5});
        let result = execute_tool_with_middleware("glob", &args, &rules, &policy, 1024, ".");
        assert!(result.is_ok());
    }
}
