//! Keyword-based rule intent classifier.

/// A single intent category with its associated keywords.
struct IntentRule {
    intent_type: &'static str,
    keywords: &'static [&'static str],
}

/// All supported intent rules, ordered by priority.
const INTENT_RULES: &[IntentRule] = &[
    IntentRule {
        intent_type: "feature_request",
        keywords: &["add", "create", "implement", "new feature", "build", "develop", "want",
                     "添加", "创建", "实现", "新增", "开发", "构建"],
    },
    IntentRule {
        intent_type: "bug_fix",
        keywords: &["fix", "bug", "error", "crash", "broken", "issue", "problem", "debug",
                     "修复", "缺陷", "错误", "崩溃", "报错", "异常", "故障"],
    },
    IntentRule {
        intent_type: "refactoring",
        keywords: &[
            "refactor",
            "restructure",
            "optimize",
            "improve",
            "clean up",
            "rewrite",
            "重构",
            "优化",
            "调整",
            "简化",
            "改进",
        ],
    },
    IntentRule {
        intent_type: "question",
        keywords: &["how", "what", "why", "explain", "help", "?",
                     "怎么", "如何", "为什么", "什么", "解释", "说明"],
    },
    IntentRule {
        intent_type: "configuration",
        keywords: &["config", "setting", "configure", "setup", "install",
                     "配置", "设置", "环境变量", "参数"],
    },
];

/// Base score multiplier for confidence calculation.
const BASE_SCORE: f64 = 0.85;

/// Classify user input into an intent type with a confidence score.
///
/// Returns `(intent_type, confidence)`. If no keywords match, returns
/// `("general", 0.3)`.
pub fn classify_intent(input: &str) -> (String, f64) {
    let lower = input.to_lowercase();

    let mut best_intent = String::from("general");
    let mut best_count: usize = 0;
    let mut best_total: usize = 0;

    for rule in INTENT_RULES {
        let matched = rule
            .keywords
            .iter()
            .filter(|kw| lower.contains(*kw))
            .count();

        if matched > best_count {
            best_count = matched;
            best_intent = rule.intent_type.to_string();
            best_total = rule.keywords.len();
        }
    }

    if best_count == 0 {
        return (String::from("general"), 0.3);
    }

    let confidence = (best_count as f64 / best_total as f64) * BASE_SCORE;
    // Clamp to [0.0, 1.0]
    let confidence = confidence.min(1.0);

    (best_intent, confidence)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_feature_request() {
        let (intent, conf) = classify_intent("Add a new login page");
        assert_eq!(intent, "feature_request");
        assert!(conf > 0.0);
    }

    #[test]
    fn test_bug_fix() {
        let (intent, conf) = classify_intent("Fix the crash on startup");
        assert_eq!(intent, "bug_fix");
        assert!(conf > 0.0);
    }

    #[test]
    fn test_refactoring() {
        let (intent, conf) = classify_intent("Refactor the module and optimize performance");
        assert_eq!(intent, "refactoring");
        assert!(conf > 0.0);
    }

    #[test]
    fn test_question() {
        let (intent, conf) = classify_intent("How does this work?");
        assert_eq!(intent, "question");
        assert!(conf > 0.0);
    }

    #[test]
    fn test_configuration() {
        let (intent, conf) = classify_intent("Configure the settings for deployment");
        assert_eq!(intent, "configuration");
        assert!(conf > 0.0);
    }

    #[test]
    fn test_general_fallback() {
        let (intent, conf) = classify_intent("random text without keywords");
        assert_eq!(intent, "general");
        assert!((conf - 0.3).abs() < f64::EPSILON);
    }

    #[test]
    fn test_empty_input() {
        let (intent, conf) = classify_intent("");
        assert_eq!(intent, "general");
        assert!((conf - 0.3).abs() < f64::EPSILON);
    }

    #[test]
    fn test_case_insensitive() {
        let (intent, _) = classify_intent("FIX the BUG");
        assert_eq!(intent, "bug_fix");
    }

    #[test]
    fn test_multi_category_picks_highest() {
        // "add" → feature_request (1/7), "fix" → bug_fix (1/8)
        // feature_request: 1/7 ≈ 0.142, bug_fix: 1/8 = 0.125
        let (intent, _) = classify_intent("add fix");
        assert_eq!(intent, "feature_request");
    }

    #[test]
    fn test_confidence_range() {
        let (_, conf) = classify_intent("add create implement new feature build develop want");
        assert!(conf <= 1.0);
        assert!(conf > 0.0);
    }

    // ── Chinese keyword tests ──────────────────────────────────────

    #[test]
    fn test_chinese_feature_request() {
        let (intent, conf) = classify_intent("添加一个新的登录页面");
        assert_eq!(intent, "feature_request");
        assert!(conf > 0.0);
    }

    #[test]
    fn test_chinese_bug_fix() {
        let (intent, conf) = classify_intent("修复启动时的崩溃问题");
        assert_eq!(intent, "bug_fix");
        assert!(conf > 0.0);
    }

    #[test]
    fn test_chinese_refactoring() {
        let (intent, conf) = classify_intent("重构这个模块并优化性能");
        assert_eq!(intent, "refactoring");
        assert!(conf > 0.0);
    }

    #[test]
    fn test_chinese_question() {
        let (intent, conf) = classify_intent("这个功能怎么使用？");
        assert_eq!(intent, "question");
        assert!(conf > 0.0);
    }

    #[test]
    fn test_chinese_configuration() {
        let (intent, conf) = classify_intent("配置部署的环境变量");
        assert_eq!(intent, "configuration");
        assert!(conf > 0.0);
    }
}
