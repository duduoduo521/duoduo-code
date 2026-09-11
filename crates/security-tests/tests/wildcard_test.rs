//! Wildcard pattern matching — `normalize_pattern_to_regex` / `wildcard_match`
//! / `evaluate`.
//!
//! Security paths: permission/rule glob matching. The conversion must:
//! - Always produce a regex that compiles (the property the docs previously
//!   attributed to Kani) — for ANY input string;
//! - Treat regex metacharacters as literal unless they are `*` / `?`;
//! - Have `*` match anything (incl. separators) and `?` match a single char.

use permission_eval::{evaluate, normalize_pattern_to_regex, wildcard_match, Rule, RuleAction};
use proptest::prelude::*;
use regex::Regex;

#[test]
fn regex_always_compiles() {
    let patterns = [
        "*", "?", "*.rs", "src/*.rs", "a.b", "a+b", "a(b)", "a[b]", "a{b", "a|b", "a^b",
        "a$", "a.c", "(x)", "[abc]", "{1,3}", "\\path", "foo*bar?baz", "src/**/test.rs",
        "a.*.b",
    ];
    for p in patterns {
        let re = normalize_pattern_to_regex(p);
        Regex::new(&re).expect(&format!("pattern '{p}' -> regex '{re}' failed to compile"));
    }
}

#[test]
fn wildcard_match_basic() {
    assert!(wildcard_match("main.rs", "*.rs"));
    assert!(wildcard_match("src/main.rs", "src/*.rs"));
    assert!(wildcard_match("a.b", "a.b"));
    assert!(!wildcard_match("aXb", "a.b")); // '.' is literal, not a wildcard
}

#[test]
fn question_mark_matches_single() {
    assert!(wildcard_match("aXb", "a?b"));
    assert!(!wildcard_match("aXXb", "a?b"));
    assert!(!wildcard_match("ab", "a?b"));
}

#[test]
fn metacharacters_are_literal() {
    assert!(wildcard_match("a.b", "a.b"));
    assert!(!wildcard_match("axb", "a.b"));
    assert!(wildcard_match("a+b", "a+b"));
    assert!(!wildcard_match("axb", "a+b"));
    assert!(wildcard_match("a(b)", "a(b)"));
    assert!(!wildcard_match("axb", "a(b)"));
}

#[test]
fn evaluate_returns_last_matching_rule() {
    // findLast semantics: a later matching rule wins over an earlier one.
    let rules = vec![
        Rule {
            permission: "*".into(),
            pattern: "*".into(),
            action: RuleAction::Allow,
        },
        Rule {
            permission: "bash".into(),
            pattern: "*".into(),
            action: RuleAction::Deny,
        },
    ];
    assert_eq!(evaluate("bash", "anything", &rules).action, RuleAction::Deny);

    let rules2 = vec![
        Rule {
            permission: "bash".into(),
            pattern: "*".into(),
            action: RuleAction::Deny,
        },
        Rule {
            permission: "bash".into(),
            pattern: "*".into(),
            action: RuleAction::Allow,
        },
    ];
    assert_eq!(evaluate("bash", "anything", &rules2).action, RuleAction::Allow);
}

proptest! {
    /// The generated regex must compile for ANY input (this is the core
    /// safety property: no input string can produce an invalid regex).
    #[test]
    fn normalize_regex_always_valid(pattern in ".*") {
        let re = normalize_pattern_to_regex(&pattern);
        prop_assert!(
            Regex::new(&re).is_ok(),
            "regex '{}' failed to compile for pattern '{}'",
            re, pattern
        );
    }

    /// wildcard_match must never panic.
    #[test]
    fn wildcard_match_never_panics(input in ".*", pattern in ".*") {
        let _ = wildcard_match(&input, &pattern);
    }

    /// The bare `*` pattern matches any input.
    #[test]
    fn star_matches_anything(input in ".*") {
        prop_assert!(wildcard_match(&input, "*"), "input {:?} not matched by '*'", input);
    }

    /// evaluate must never panic with arbitrary rules.
    #[test]
    fn evaluate_never_panics(tool in "[a-zA-Z0-9_]*", pat in "[a-zA-Z0-9_*?]*") {
        let rules = vec![
            Rule {
                permission: tool.clone(),
                pattern: pat.clone(),
                action: RuleAction::Allow,
            },
            Rule {
                permission: tool,
                pattern: pat,
                action: RuleAction::Deny,
            },
        ];
        let _ = evaluate("x", "y", &rules);
    }
}
