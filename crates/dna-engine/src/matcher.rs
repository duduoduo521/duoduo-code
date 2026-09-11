//! Rule matching and action application for the DNA engine.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use duo_types::DnaRule;
use regex::Regex;

use crate::rules::DnaEngine;

/// Cache for compiled regex patterns to avoid recompilation on every match.
/// Key: the condition string; Value: compiled Regex (or None if invalid regex).
static REGEX_CACHE: LazyLock<Mutex<HashMap<String, Option<Regex>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 对所有 enabled 规则做匹配
///
/// 匹配策略：优先尝试正则匹配，正则不合法时回退到字符串包含判断。
/// 返回按 priority 降序排列的匹配规则列表。
pub fn match_rules(engine: &DnaEngine, input: &str) -> Vec<DnaRule> {
    let rules = engine.list_rules().unwrap_or_default();

    let mut matched: Vec<DnaRule> = rules
        .into_iter()
        .filter(|rule| is_match(input, &rule.condition))
        .collect();

    // 按 priority 降序排列；None 视为 0
    matched.sort_by(|a, b| {
        let pa = a.priority.unwrap_or(0);
        let pb = b.priority.unwrap_or(0);
        pb.cmp(&pa)
    });

    matched
}

/// 判断 input 是否匹配 condition
///
/// - 先尝试将 condition 解析为正则表达式，若合法则用正则匹配
/// - 正则不合法时回退到字符串包含判断
/// - 已编译的正则会被缓存，避免重复编译；缓存超过 256 条时清空
fn is_match(input: &str, condition: &str) -> bool {
    // Check cache first
    let cached = {
        let cache = duo_utils::sync::lock(&REGEX_CACHE);
        cache.get(condition).cloned()
    };

    match cached {
        Some(Some(re)) => re.is_match(input),
        Some(None) => input.contains(condition), // Previously determined invalid regex
        None => {
            // Compile and cache
            let compiled = Regex::new(condition).ok();
            let result = match &compiled {
                Some(re) => re.is_match(input),
                None => input.contains(condition),
            };
            // Evict when cache exceeds 256 entries to prevent unbounded growth
            let mut cache = duo_utils::sync::lock(&REGEX_CACHE);
            if cache.len() >= 256 {
                cache.clear();
            }
            cache.insert(condition.to_string(), compiled);
            result
        }
    }
}

/// 应用动作 — 模板变量替换
///
/// 将 `{{variable_name}}` 格式的占位符替换为 variables 中对应的值。
/// 未找到对应变量时保留原始占位符。
pub fn apply_action(action: &str, variables: &HashMap<String, String>) -> String {
    let mut result = action.to_string();
    for (key, value) in variables {
        let placeholder = format!("{{{{{}}}}}", key); // {{key}}
        result = result.replace(&placeholder, value);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_match_contains() {
        assert!(is_match("hello world", "world"));
        assert!(!is_match("hello world", "rust"));
    }

    #[test]
    fn test_is_match_regex() {
        assert!(is_match("abc123def", r"\d+"));
        assert!(!is_match("abcdef", r"\d+"));
    }

    #[test]
    fn test_is_match_invalid_regex_falls_back_to_contains() {
        // "(unclosed" is not a valid regex — fallback to contains
        assert!(is_match("a(unclosedb", "(unclosed"));
    }

    #[test]
    fn test_match_rules_filters_and_sorts() {
        let engine = DnaEngine::new().unwrap();
        engine.add_rule(DnaRule {
            id: "1".into(),
            name: "low".into(),
            condition: "hello".into(),
            action: "a1".into(),
            enabled: true,
            priority: Some(1),
            metadata: None,
        }).unwrap();
        engine.add_rule(DnaRule {
            id: "2".into(),
            name: "high".into(),
            condition: "hello".into(),
            action: "a2".into(),
            enabled: true,
            priority: Some(10),
            metadata: None,
        }).unwrap();
        engine.add_rule(DnaRule {
            id: "3".into(),
            name: "disabled".into(),
            condition: "hello".into(),
            action: "a3".into(),
            enabled: false,
            priority: Some(100),
            metadata: None,
        }).unwrap();

        let result = match_rules(&engine, "hello world");
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, "2"); // priority 10 first
        assert_eq!(result[1].id, "1"); // priority 1 second
    }

    #[test]
    fn test_apply_action_basic() {
        let mut vars = HashMap::new();
        vars.insert("name".into(), "Alice".into());
        vars.insert("lang".into(), "Rust".into());
        let result = apply_action("Hello {{name}}, welcome to {{lang}}!", &vars);
        assert_eq!(result, "Hello Alice, welcome to Rust!");
    }

    #[test]
    fn test_apply_action_missing_variable_kept() {
        let mut vars = HashMap::new();
        vars.insert("name".into(), "Bob".into());
        let result = apply_action("Hi {{name}}, {{unknown}}!", &vars);
        assert_eq!(result, "Hi Bob, {{unknown}}!");
    }

    #[test]
    fn test_apply_action_no_variables() {
        let vars = HashMap::new();
        let result = apply_action("No placeholders here", &vars);
        assert_eq!(result, "No placeholders here");
    }
}
