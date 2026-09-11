use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;

/// Rule action type.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleAction {
    Allow,
    Deny,
    Ask,
}

/// A permission rule with permission, pattern and action.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Rule {
    pub permission: String,
    pub pattern: String,
    pub action: RuleAction,
}

/// Evaluate result — mirrors the TS Rule returned by `evaluate()`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EvaluateResult {
    pub action: RuleAction,
    pub permission: String,
    pub pattern: String,
}

/// Regex cache for wildcard patterns.
static REGEX_CACHE: Lazy<std::sync::Mutex<HashMap<String, Regex>>> =
    Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

/// Convert a wildcard pattern to a regex string.
/// This precisely replicates the TS `Wildcard.match` conversion:
/// 1. Normalize backslashes to forward slashes
/// 2. Escape regex metacharacters (except * and ?)
/// 3. Convert `*` to `.*` (matches anything including separators)
/// 4. Convert `?` to `.` (matches any single char including separators)
/// 5. Trailing " *" → "( .*)?"  (makes trailing wildcard optional)
/// 6. Add `(?s)` flag (dot matches newline) and `(?i)` on Windows
/// 7. Add start/end anchors
///
/// Exposed as `pub` so the centralized security-test suite can verify the
/// generated regex always compiles (the property the docs attribute to Kani).
pub fn normalize_pattern_to_regex(pattern: &str) -> String {
    // Step 1: Normalize backslashes to forward slashes
    let normalized = pattern.replace('\\', "/");

    // Step 2: Escape regex metacharacters (except * and ?)
    let mut escaped = String::with_capacity(normalized.len() * 2);
    for c in normalized.chars() {
        match c {
            '*' | '?' => escaped.push(c),
            '.' | '+' | '^' | '$' | '(' | ')' | '|' | '[' | ']' | '{' | '}' => {
                escaped.push('\\');
                escaped.push(c);
            }
            // Backslash already normalized away, but escape if any remain
            '\\' => {
                escaped.push('\\');
                escaped.push('\\');
            }
            _ => escaped.push(c),
        }
    }

    // Step 3: Convert * to .* (matches anything including separators)
    escaped = escaped.replace('*', ".*");

    // Step 4: Convert ? to . (matches any single char including separators)
    escaped = escaped.replace('?', ".");

    // Step 5: Trailing " *" → "( .*)?" (makes trailing wildcard optional)
    // TS: if (escaped.endsWith(" .*")) { escaped = escaped.slice(0, -3) + "( .*)?" }
    if escaped.ends_with(" .*") {
        let len = escaped.len();
        escaped.truncate(len - 3);
        escaped.push_str("( .*)?");
    }

    // Step 6 & 7: Add flags and anchors
    // TS uses "s" flag (dot matches newline) always, "i" flag on Windows
    let flags = if cfg!(target_os = "windows") {
        "(?si)"
    } else {
        "(?s)"
    };
    format!("{}^{}$", flags, escaped)
}

/// Match a string against a wildcard pattern.
/// Replicates the behavior of TS `Wildcard.match(str, pattern)`.
/// Note: parameter order is (input, pattern) — same as TS.
pub fn wildcard_match(input: &str, pattern: &str) -> bool {
    // Normalize backslashes in both input and pattern (TS does this)
    let input_normalized = input.replace('\\', "/");
    let regex_str = normalize_pattern_to_regex(pattern);

    // Use cached regex if available
    let regex = {
        // Same poisoning recovery as `duo_utils::sync::lock`, inlined: this
        // crate is a dependency-light leaf (no rusqlite/dirs), so pulling in
        // duo-utils for eight lines would drag heavy transitive deps into
        // every consumer of the permission engine.
        let mut cache = REGEX_CACHE.lock().unwrap_or_else(|poisoned| {
            tracing::warn!("REGEX_CACHE mutex poisoned; recovering the guard");
            poisoned.into_inner()
        });
        if let Some(re) = cache.get(&regex_str) {
            re.clone()
        } else {
            let re = Regex::new(&regex_str).unwrap_or_else(|e| {
                tracing::warn!("Invalid wildcard regex for pattern '{}': {}", pattern, e);
                Regex::new("(?s)^$").expect("invariant: static regex pattern is valid")
            });
            cache.insert(regex_str.clone(), re.clone());
            re
        }
    };

    regex.is_match(&input_normalized)
}

/// Evaluate a list of rules against a permission and pattern string.
/// Replicates TS `evaluate(permission, pattern, ...rulesets)`.
/// Returns the last matching rule (equivalent to TS `findLast`).
/// If no rule matches, returns a default Ask rule.
pub fn evaluate(permission: &str, pattern: &str, rules: &[Rule]) -> EvaluateResult {
    // findLast: iterate from end, return first match where both
    // Wildcard.match(permission, rule.permission) AND Wildcard.match(pattern, rule.pattern)
    for rule in rules.iter().rev() {
        if wildcard_match(permission, &rule.permission) && wildcard_match(pattern, &rule.pattern) {
            return EvaluateResult {
                action: rule.action.clone(),
                permission: rule.permission.clone(),
                pattern: rule.pattern.clone(),
            };
        }
    }
    // Default: { action: "ask", permission, pattern: "*" }
    EvaluateResult {
        action: RuleAction::Ask,
        permission: permission.to_string(),
        pattern: "*".to_string(),
    }
}

/// Sort rules by specificity (fromConfig logic).
/// Rules with wildcards in the permission key are sorted before specific ones.
/// This mirrors TS `fromConfig` top-level key sorting.
pub fn from_config(rules: &mut [Rule]) {
    rules.sort_by(|a, b| {
        let a_wild = a.permission.contains('*');
        let b_wild = b.permission.contains('*');
        // Wildcard permissions first (like TS: aWild ? -1 : 1)
        match (a_wild, b_wild) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => std::cmp::Ordering::Equal,
        }
    });
}

/// Edit tools that map to "edit" permission.
const EDIT_TOOLS: &[&str] = &["edit", "write", "apply_patch"];

/// Get disabled tool list from rules.
/// A tool is disabled if its last matching rule has pattern "*" and action Deny.
/// Mirrors TS `disabled(tools, ruleset)`.
pub fn disabled(tool_names: &[&str], rules: &[Rule]) -> Vec<String> {
    tool_names
        .iter()
        .filter_map(|&name| {
            let permission = if EDIT_TOOLS.contains(&name) {
                "edit"
            } else {
                name
            };
            // findLast: iterate from end
            for rule in rules.iter().rev() {
                if wildcard_match(permission, &rule.permission) {
                    if rule.pattern == "*" && rule.action == RuleAction::Deny {
                        return Some(name.to_string());
                    }
                    break;
                }
            }
            None
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wildcard_exact_match() {
        assert!(wildcard_match("read_file", "read_file"));
        assert!(!wildcard_match("read_file", "write_file"));
    }

    #[test]
    fn test_wildcard_single_star() {
        assert!(wildcard_match("read_file", "read_*"));
        assert!(wildcard_match("read_dir", "read_*"));
        assert!(!wildcard_match("write_file", "read_*"));
        // * matches anything including separators (TS semantics)
        assert!(wildcard_match("read_file/deep", "read_*"));
    }

    #[test]
    fn test_wildcard_double_star() {
        // In TS, ** is just * applied twice → .*.* which is equivalent to .*
        assert!(wildcard_match("anything/here/and/there", "**"));
        assert!(wildcard_match("src/main.rs", "src/**"));
        assert!(wildcard_match("src/deep/nested/file.rs", "src/**"));
    }

    #[test]
    fn test_wildcard_question_mark() {
        assert!(wildcard_match("read_file1", "read_file?"));
        assert!(!wildcard_match("read_file12", "read_file?"));
        // ? matches any single char including separator (TS semantics)
        assert!(wildcard_match("read/file", "read?file"));
    }

    #[test]
    fn test_wildcard_trailing_space_star() {
        // "ls *" should match "ls" (no args) and "ls -la" (with args)
        assert!(wildcard_match("ls", "ls *"));
        assert!(wildcard_match("ls -la", "ls *"));
        assert!(wildcard_match("ls foo bar", "ls *"));
        // "ls*" (no space) should match "ls" and "lstmeval"
        assert!(wildcard_match("ls", "ls*"));
        assert!(wildcard_match("lstmeval", "ls*"));
        // "ls *" should NOT match "lstmeval"
        assert!(!wildcard_match("lstmeval", "ls *"));
        // Multi-word commands
        assert!(wildcard_match("git status", "git *"));
        assert!(wildcard_match("git", "git *"));
        assert!(wildcard_match("git commit -m foo", "git *"));
    }

    #[test]
    fn test_wildcard_normalize_slashes() {
        assert!(wildcard_match(
            "C:/Windows/System32/*",
            "C:\\Windows\\System32\\*"
        ));
        assert!(wildcard_match(
            "C:/Windows/System32/drivers",
            "C:\\Windows\\System32\\*"
        ));
    }

    #[test]
    fn test_wildcard_escape_metachars() {
        // "foo+bar" should match literally (no regex meaning for +)
        assert!(wildcard_match("foo+bar", "foo+bar"));
        // $ is line-end anchor in regex — must be escaped
        assert!(wildcard_match("foo$bar", "foo$bar"));
        // {} are quantifier delimiters in regex — must be escaped
        assert!(wildcard_match("foo{bar}", "foo{bar}"));
        assert!(wildcard_match("${env}", "${env}"));
    }

    #[test]
    fn test_evaluate_find_last() {
        let rules = vec![
            Rule {
                permission: "*".to_string(),
                pattern: "*".to_string(),
                action: RuleAction::Allow,
            },
            Rule {
                permission: "write_*".to_string(),
                pattern: "*".to_string(),
                action: RuleAction::Deny,
            },
        ];
        let result = evaluate("write_file", "*", &rules);
        assert_eq!(result.action, RuleAction::Deny);
        assert_eq!(result.permission, "write_*");
    }

    #[test]
    fn test_evaluate_default_ask() {
        let rules = vec![Rule {
            permission: "read_*".to_string(),
            pattern: "*".to_string(),
            action: RuleAction::Allow,
        }];
        let result = evaluate("write_file", "*", &rules);
        assert_eq!(result.action, RuleAction::Ask);
        assert_eq!(result.permission, "write_file");
        assert_eq!(result.pattern, "*");
    }

    #[test]
    fn test_evaluate_both_permission_and_pattern_match() {
        let rules = vec![
            Rule {
                permission: "bash".to_string(),
                pattern: "ls *".to_string(),
                action: RuleAction::Allow,
            },
            Rule {
                permission: "bash".to_string(),
                pattern: "rm *".to_string(),
                action: RuleAction::Deny,
            },
        ];
        // Should match the rm rule (last match)
        let result = evaluate("bash", "rm -rf /", &rules);
        assert_eq!(result.action, RuleAction::Deny);
        // Should match the ls rule
        let result = evaluate("bash", "ls -la", &rules);
        assert_eq!(result.action, RuleAction::Allow);
        // Should not match either (permission mismatch)
        let result = evaluate("read", "ls -la", &rules);
        assert_eq!(result.action, RuleAction::Ask);
    }

    #[test]
    fn test_from_config_sorts_wildcards_first() {
        let mut rules = vec![
            Rule {
                permission: "read_file".to_string(),
                pattern: "*".to_string(),
                action: RuleAction::Allow,
            },
            Rule {
                permission: "*".to_string(),
                pattern: "*".to_string(),
                action: RuleAction::Deny,
            },
        ];
        from_config(&mut rules);
        // Wildcard permission should come first
        assert_eq!(rules[0].permission, "*");
        assert_eq!(rules[1].permission, "read_file");
    }

    #[test]
    fn test_disabled() {
        let rules = vec![
            Rule {
                permission: "*".to_string(),
                pattern: "*".to_string(),
                action: RuleAction::Allow,
            },
            Rule {
                permission: "bash".to_string(),
                pattern: "*".to_string(),
                action: RuleAction::Deny,
            },
        ];
        let result = disabled(&["read_file", "bash", "write_file"], &rules);
        assert_eq!(result, vec!["bash"]);
    }

    #[test]
    fn test_disabled_edit_tools() {
        let rules = vec![Rule {
            permission: "edit".to_string(),
            pattern: "*".to_string(),
            action: RuleAction::Deny,
        }];
        // "write" and "apply_patch" map to "edit" permission
        let result = disabled(&["write", "apply_patch", "read"], &rules);
        assert!(result.contains(&"write".to_string()));
        assert!(result.contains(&"apply_patch".to_string()));
        assert!(!result.contains(&"read".to_string()));
    }
}
