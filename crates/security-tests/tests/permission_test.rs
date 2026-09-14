//! Tool permission & path sandbox — `check_permission` / `check_tool_permission`.
//!
//! Security paths:
//! - Permission rules: Allow/Deny/Ask with findLast-wins semantics (last
//!   matching rule wins); default Ask (fail-closed) when no rule matches.
//! - Path sandbox (Layer 3): `..` traversal is a hard sandbox rejection; a
//!   plain out-of-project path yields `PermissionAsk` so the main loop
//!   delegates it to TS and the user gets the external-directory prompt
//!   instead of a silent refusal.

use agent_executor::permission::{
    check_permission, check_tool_permission, PermissionResult, PermissionRule, ToolExecutionError,
};
use proptest::prelude::*;
use security_design::SecurityPolicy;
use serde_json::json;

#[test]
fn default_ask_when_no_rule() {
    // Unified core returns Ask when no rule matches (fail-closed).
    let rules: Vec<PermissionRule> = vec![];
    assert_eq!(check_permission("read", &json!({}), &rules), PermissionResult::Ask);
}

#[test]
fn deny_rule_blocks() {
    let rules = vec![PermissionRule::Deny {
        permission: "bash".into(),
        pattern: "*".into(),
    }];
    assert_eq!(check_permission("bash", &json!({}), &rules), PermissionResult::Deny);
}

#[test]
fn last_matching_rule_wins_allow_after_deny() {
    // Unified core uses findLast precedence: the LAST matching rule wins.
    // Allow listed after Deny → Allow.
    let rules = vec![
        PermissionRule::Deny {
            permission: "bash".into(),
            pattern: "*".into(),
        },
        PermissionRule::Allow {
            permission: "bash".into(),
            pattern: "*".into(),
        },
    ];
    assert_eq!(check_permission("bash", &json!({}), &rules), PermissionResult::Allow);
}

#[test]
fn last_matching_rule_wins_deny_after_allow() {
    // findLast: Deny listed after Allow → Deny.
    let rules = vec![
        PermissionRule::Allow {
            permission: "bash".into(),
            pattern: "*".into(),
        },
        PermissionRule::Deny {
            permission: "bash".into(),
            pattern: "*".into(),
        },
    ];
    assert_eq!(check_permission("bash", &json!({}), &rules), PermissionResult::Deny);
}

#[test]
fn ask_rule_asks() {
    let rules = vec![PermissionRule::Ask {
        permission: "bash".into(),
        pattern: "*".into(),
        always: vec![],
    }];
    assert_eq!(check_permission("bash", &json!({}), &rules), PermissionResult::Ask);
}

    #[test]
    fn sandbox_asks_for_out_of_project_path() {
        let policy = SecurityPolicy::with_project_path(std::path::PathBuf::from("/tmp/duoduo_proj_test"));
        // Explicit Allow so the permission layer passes and we exercise Layer 3
        // (sandbox). Default is now Ask (fail-closed), so an unmatched rule
        // would never reach the sandbox check.
        let rules = vec![PermissionRule::Allow {
            permission: "read".into(),
            pattern: "*".into(),
        }];
        let res = check_tool_permission("read", &json!({"path": "/etc/passwd"}), &rules, &policy, false);
        assert!(
            matches!(res, Err(ToolExecutionError::PermissionAsk(_))),
            "a plain out-of-project path must delegate to TS (external-directory prompt), got: {res:?}"
        );
    }

    #[test]
    fn sandbox_allows_in_project() {
        let dir = tempfile::tempdir().unwrap();
        let policy = SecurityPolicy::with_project_path(dir.path().to_path_buf());
        let file = dir.path().join("main.rs");
        std::fs::write(&file, "fn main() {}").unwrap();
        // Explicit Allow so the permission layer passes and we exercise Layer 3.
        let rules = vec![PermissionRule::Allow {
            permission: "read".into(),
            pattern: "*".into(),
        }];
        let res = check_tool_permission(
            "read",
            &json!({ "path": file.to_str().unwrap() }),
            &rules,
            &policy,
            false,
        );
        assert!(res.is_ok(), "in-project read should be allowed, got: {res:?}");
    }

    #[test]
    fn sandbox_blocks_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let policy = SecurityPolicy::with_project_path(dir.path().to_path_buf());
        // Explicit Allow so the permission layer passes and we exercise Layer 3.
        let rules = vec![PermissionRule::Allow {
            permission: "read".into(),
            pattern: "*".into(),
        }];
        let res = check_tool_permission("read", &json!({ "path": "../escape" }), &rules, &policy, false);
        assert!(
            matches!(res, Err(ToolExecutionError::SandboxViolation(_))),
            "path traversal must be sandboxed, got: {res:?}"
        );
    }

#[test]
fn empty_tool_name_rejected() {
    let policy = SecurityPolicy::default();
    let res = check_tool_permission("", &json!({}), &[], &policy, false);
    assert!(matches!(res, Err(ToolExecutionError::Validation(_))));
}

proptest! {
    /// check_permission must never panic with arbitrary rules/tool names.
    #[test]
    fn check_permission_never_panics(
        tool in "[a-zA-Z0-9_]*",
        perm in "[a-zA-Z0-9_]*",
        pat in "[a-zA-Z0-9_*?]*",
    ) {
        let rules = vec![
            PermissionRule::Allow {
                permission: perm.clone(),
                pattern: pat.clone(),
            },
            PermissionRule::Deny {
                permission: perm,
                pattern: pat,
            },
        ];
        let _ = check_permission(&tool, &json!({}), &rules);
    }

    /// Stronger property than `never_panics`: with an empty ruleset EVERY tool
    /// must resolve to the unified default `Ask` (fail-closed), never Allow/Deny.
    #[test]
    fn check_permission_empty_rules_always_ask(tool in "[a-zA-Z0-9_]*") {
        prop_assert_eq!(check_permission(&tool, &json!({}), &[]), PermissionResult::Ask);
    }

    /// A universal Deny rule must deny ANY tool (required invariant).
    #[test]
    fn check_permission_global_deny_always_denies(tool in "[a-zA-Z0-9_]*") {
        let rules = vec![PermissionRule::Deny {
            permission: "*".into(),
            pattern: "*".into(),
        }];
        prop_assert_eq!(check_permission(&tool, &json!({}), &rules), PermissionResult::Deny);
    }

    /// A universal Allow listed AFTER a universal Deny must win (findLast),
    /// so ANY tool is Allowed.
    #[test]
    fn check_permission_global_allow_after_deny_always_allows(tool in "[a-zA-Z0-9_]*") {
        let rules = vec![
            PermissionRule::Deny {
                permission: "*".into(),
                pattern: "*".into(),
            },
            PermissionRule::Allow {
                permission: "*".into(),
                pattern: "*".into(),
            },
        ];
        prop_assert_eq!(check_permission(&tool, &json!({}), &rules), PermissionResult::Allow);
    }
}

// ── 主代理路径行为（对应 routes/agent.rs run_loop_handler 调用链） ──────────
//
// `run_loop_handler` 直接同步调用 `agent_executor::check_tool_permission` 作为权限闸门
// （interactive=true 的主代理路径），随后根据其返回的 `ToolExecutionError` 分支：
//   - `PermissionAsk` → 委托 TS 让用户确认（不执行、不拒绝）
//   - `PermissionDenied` → 直接拒绝
//   - `Ok(())` → 继续实际执行
// 该函数是纯函数，无需启动 axum / HTTP 服务即可测试本路径的新默认行为。
// 下列用例复用与 route 完全相同的 `check_tool_permission` 签名。

#[test]
fn main_agent_path_unmatched_tool_asks() {
    // 主代理路径：无显式规则的常用工具 → 新默认 Ask（fail-closed）
    // → route 据此委托 TS 确认，而非静默执行（旧默认 Allow）。
    let policy = SecurityPolicy::default();
    for tool in ["read_file", "glob", "bash", "edit", "websearch", "grep"] {
        let res = check_tool_permission(tool, &json!({}), &[], &policy, false);
        assert!(
            matches!(res, Err(ToolExecutionError::PermissionAsk(_))),
            "tool '{tool}' with no rules must yield PermissionAsk (delegate to TS), got: {res:?}"
        );
    }
}

#[test]
fn main_agent_path_explicit_allow_executes() {
    // 显式 Allow 后，主代理路径闸门放行（route 继续交给 execute_tool 实际执行）。
    let policy = SecurityPolicy::default();
    let rules = vec![PermissionRule::Allow {
        permission: "read_file".into(),
        pattern: "*".into(),
    }];
    let res = check_tool_permission("read_file", &json!({ "path": "./main.rs" }), &rules, &policy, false);
    assert!(
        res.is_ok(),
        "explicit Allow must pass the permission gate, got: {res:?}"
    );
}

#[test]
fn main_agent_path_global_deny_blocks() {
    // 全局 Deny 后，主代理路径任何工具被拒（不会委托、不会执行）。
    let policy = SecurityPolicy::default();
    let rules = vec![PermissionRule::Deny {
        permission: "*".into(),
        pattern: "*".into(),
    }];
    let res = check_tool_permission("read_file", &json!({}), &rules, &policy, false);
    assert!(
        matches!(res, Err(ToolExecutionError::PermissionDenied(_))),
        "global Deny must block the main agent path, got: {res:?}"
    );
}

#[test]
fn main_agent_path_ask_rule_delegates() {
    // 显式 Ask 规则 → 主代理路径同样委托 TS 确认（与默认 Ask 同分支）。
    let policy = SecurityPolicy::default();
    let rules = vec![PermissionRule::Ask {
        permission: "bash".into(),
        pattern: "*".into(),
        always: vec![],
    }];
    let res = check_tool_permission("bash", &json!({}), &rules, &policy, false);
    assert!(
        matches!(res, Err(ToolExecutionError::PermissionAsk(_))),
        "explicit Ask rule must delegate to TS, got: {res:?}"
    );
}

// ── PermissionRule serde 往返（TS JSON, tag="action"） ──────────────────────
//
// `duo-smart-layer` 从 TS 侧 JSON 配置反序列化为 `Vec<PermissionRule>`
// （serde `tag="action", rename_all="camelCase"`）。这是*配置正确性*的关键路径：
// 解析失败或意外变体会导致整份规则集静默失效。下列用例守护「TS 格式正确解析 +
// 序列化往返稳定」。

#[test]
fn permission_rule_serde_from_ts_json() {
    // 模拟 TS 发送的 JSON：action 标签小写，Ask 携带 always 字段。
    let ts_json = r#"[
        {"action":"allow","permission":"read_file","pattern":"*"},
        {"action":"deny","permission":"bash","pattern":"*"},
        {"action":"ask","permission":"edit","pattern":"*","always":["write"]}
    ]"#;
    let rules: Vec<PermissionRule> =
        serde_json::from_str(ts_json).expect("TS permission JSON must deserialize");
    assert_eq!(rules.len(), 3);
    assert!(matches!(rules[0], PermissionRule::Allow { .. }));
    assert!(matches!(rules[1], PermissionRule::Deny { .. }));
    match &rules[2] {
        PermissionRule::Ask {
            permission,
            pattern,
            always,
        } => {
            assert_eq!(permission, "edit");
            assert_eq!(pattern, "*");
            assert_eq!(always, &vec!["write".to_string()]);
        }
        other => panic!("expected Ask variant, got: {other:?}"),
    }
}

#[test]
fn permission_rule_serde_round_trip() {
    // 序列化 → 反序列化 → 序列化，两次序列化结果必须一致（配置稳定，无字段丢失）。
    let rules = vec![
        PermissionRule::Allow {
            permission: "read_file".into(),
            pattern: "*".into(),
        },
        PermissionRule::Deny {
            permission: "bash".into(),
            pattern: "rm *".into(),
        },
        PermissionRule::Ask {
            permission: "edit".into(),
            pattern: "*".into(),
            always: vec!["write".into()],
        },
    ];
    let serialized = serde_json::to_string(&rules).expect("serialize rules");
    let reparsed: Vec<PermissionRule> =
        serde_json::from_str(&serialized).expect("re-parse serialized rules");
    let v1 = serde_json::to_value(&rules).expect("to_value rules");
    let v2 = serde_json::to_value(&reparsed).expect("to_value reparsed");
    assert_eq!(v1, v2, "serde round-trip must be stable; serialized={serialized}");
}
