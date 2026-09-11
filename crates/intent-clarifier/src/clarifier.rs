//! Intent clarifier: orchestrates classification, entity extraction, and ambiguity detection.

use std::sync::Arc;
use duo_types::{Ambiguity, ClarificationResult, Entity, IntentClarifyRequest, PatternQueryRequest, SuggestedMode};
use memory_system::ambiguity::{AmbiguityDetector, Resolution};

/// Main clarifier struct — optionally backed by L5 memory for user preference overrides.
pub struct IntentClarifier {
    memory: Option<Arc<memory_system::MemorySystem>>,
}

impl IntentClarifier {
    /// Create a new `IntentClarifier` instance with an optional memory system for L5 lookups.
    pub fn new(memory: Option<Arc<memory_system::MemorySystem>>) -> anyhow::Result<Self> {
        Ok(Self { memory })
    }

    /// Classify, extract entities, detect ambiguities, and suggest a mode.
    ///
    /// When a `user_id` is provided in the request and L5 memory is available,
    /// queries `command_pref` patterns for a high-confidence override of the
    /// suggested mode.
    pub fn clarify(&self, req: &IntentClarifyRequest) -> anyhow::Result<ClarificationResult> {
        let input = &req.user_input;

        // 1. Classify intent
        let (intent_type, confidence) = crate::classifier::classify_intent(input);

        // 2. Extract entities
        let entities = extract_entities(input);

        // 3. Detect ambiguities (local heuristics)
        let mut ambiguities = detect_ambiguities(input, confidence);

        // 3.5 Augment with L5 memory-based deixis resolution (if available)
        if let Some(memory) = &self.memory {
            let user_id = req.user_id.clone().unwrap_or_default();
            if !user_id.is_empty() {
                let query = PatternQueryRequest {
                    user_id,
                    pattern_type: None, // both deixis + command_pref
                    project_id: None,
                    limit: 50,
                    offset: 0,
                };
                if let Ok(result) = memory.query_patterns(&query)
                    && !result.patterns.is_empty()
                        && let Some(resolution) =
                            AmbiguityDetector::new().detect_and_resolve(input, &result.patterns)
                        {
                            match resolution {
                                Resolution::NeedsClarification { candidates } => {
                                    ambiguities.push(Ambiguity {
                                        question: "请确认指代消解（基于历史偏好）".to_string(),
                                        options: candidates,
                                    });
                                }
                                Resolution::ResolvedWithExpansion { value, expansion, .. } => {
                                    let mut options = vec![value];
                                    options.extend(expansion);
                                    ambiguities.push(Ambiguity {
                                        question: "指代存在歧义，建议如下（可确认或直接回复）"
                                            .to_string(),
                                        options,
                                    });
                                }
                                Resolution::Resolved { value, .. } => {
                                    tracing::info!(
                                        resolved = %value,
                                        "歧义已基于历史偏好自动消解（高置信）"
                                    );
                                }
                                Resolution::NotEffective => {
                                    // 冷启动（样本不足）：不干预，退回原行为
                                }
                            }
                        }
            }
        }

        // 4. Suggested mode mapping
        let mut suggested_mode = match intent_type.as_str() {
            "feature_request" => SuggestedMode::Agent,
            "bug_fix" => SuggestedMode::Agent,
            "refactoring" => SuggestedMode::Agent,
            "question" => SuggestedMode::Chat,
            "configuration" => SuggestedMode::Agent,
            _ => SuggestedMode::Agent, // "general" and any unknown
        };

        // 5. Override with L5 pattern if user_id provided and memory is available
        if let (Some(user_id), Some(memory)) = (&req.user_id, &self.memory) {
            let query = PatternQueryRequest {
                user_id: user_id.clone(),
                pattern_type: Some("command_pref".to_string()),
                project_id: None,
                limit: 5,
                offset: 0,
            };
            if let Ok(result) = memory.query_patterns(&query) {
                // Look for a pattern whose key matches the intent prefix
                if let Some(pref) = result.patterns.iter().find(|p| {
                    p.pattern_key.starts_with("intent:") && p.confidence >= 0.75
                }) {
                    // Map the stored preferred_value back to SuggestedMode
                    let parsed_mode = match pref.preferred_value.as_str() {
                        "Chat" => Some(SuggestedMode::Chat),
                        "Agent" => Some(SuggestedMode::Agent),

                        _ => None,
                    };
                    if let Some(mode) = parsed_mode {
                        tracing::info!(
                            original = ?suggested_mode, overridden = ?mode,
                            confidence = pref.confidence,
                            "L5 pattern override: high-confidence command_pref found"
                        );
                        suggested_mode = mode;
                    }
                }
            }
        }

        Ok(ClarificationResult {
            intent_type,
            confidence,
            entities,
            ambiguities,
            suggested_mode,
        })
    }
}

impl Default for IntentClarifier {
    fn default() -> Self {
        Self::new(None).expect("Failed to initialize intent-clarifier")
    }
}

/// Extract entities from input: quoted strings and CamelCase / snake_case identifiers.
fn extract_entities(input: &str) -> Vec<Entity> {
    let mut entities = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // 1. Extract double-quoted strings
    let mut in_quotes = false;
    let mut start = 0;
    for (i, ch) in input.char_indices() {
        if ch == '"' {
            if in_quotes {
                // Closing quote
                let value: String = input[start..i].to_string();
                if !value.is_empty() && seen.insert(value.clone()) {
                    entities.push(Entity {
                        name: "quoted_string".to_string(),
                        value,
                    });
                }
                in_quotes = false;
            } else {
                // Opening quote
                start = i + ch.len_utf8();
                in_quotes = true;
            }
        }
    }

    // 2. Extract CamelCase identifiers (e.g. MyComponent, HttpRequestParser)
    //    Must start with uppercase and contain at least one uppercase-lowercase transition.
    for token in input.split(|c: char| !c.is_alphanumeric() && c != '_') {
        if token.is_empty() {
            continue;
        }
        if is_camel_case(token) && seen.insert(token.to_string()) {
            entities.push(Entity {
                name: "identifier".to_string(),
                value: token.to_string(),
            });
        }
    }

    // 3. Extract snake_case identifiers (e.g. my_function, HTTP_REQUEST)
    for token in input.split(|c: char| !c.is_alphanumeric() && c != '_') {
        if token.is_empty() {
            continue;
        }
        if is_snake_case(token) && seen.insert(token.to_string()) {
            entities.push(Entity {
                name: "identifier".to_string(),
                value: token.to_string(),
            });
        }
    }

    entities
}

/// Check if a token is CamelCase: starts with uppercase, has at least one
/// uppercase-to-lowercase transition, and is at least 2 chars.
/// Only matches ASCII tokens — code identifiers are ASCII by convention,
/// and this avoids false positives from Turkish İ (U+0130) etc.
fn is_camel_case(token: &str) -> bool {
    let chars: Vec<char> = token.chars().collect();
    if chars.len() < 2 {
        return false;
    }
    // Only ASCII tokens qualify as code identifiers
    if !token.is_ascii() {
        return false;
    }
    if !chars[0].is_uppercase() {
        return false;
    }
    // Must contain at least one transition from uppercase to lowercase
    let mut has_upper = false;
    let mut has_lower = false;
    for &ch in &chars {
        if ch.is_uppercase() {
            has_upper = true;
        }
        if ch.is_lowercase() {
            has_lower = true;
        }
    }
    has_upper && has_lower && !token.contains('_')
}

/// Check if a token is snake_case: contains underscores with alphanumeric segments.
fn is_snake_case(token: &str) -> bool {
    if !token.contains('_') {
        return false;
    }
    // Must have at least one character on each side of an underscore
    let parts: Vec<&str> = token.split('_').collect();
    if parts.len() < 2 {
        return false;
    }
    parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_alphanumeric()))
}

/// Detect ambiguities in the user input based on confidence and heuristics.
fn detect_ambiguities(input: &str, confidence: f64) -> Vec<Ambiguity> {
    let mut ambiguities = Vec::new();

    // Low confidence
    if confidence < 0.5 {
        ambiguities.push(Ambiguity {
            question: "Low confidence in intent classification".to_string(),
            options: vec![
                "feature_request".to_string(),
                "bug_fix".to_string(),
                "refactoring".to_string(),
                "question".to_string(),
                "configuration".to_string(),
                "general".to_string(),
            ],
        });
    }

    // Input too short
    if input.len() < 10 {
        ambiguities.push(Ambiguity {
            question: "Input too short for reliable classification".to_string(),
            options: vec![
                "Provide more detail about the task".to_string(),
                "Specify the intent explicitly".to_string(),
            ],
        });
    }

    // Multiple intent signals detected — check if keywords from >1 category match
    let lower = input.to_lowercase();
    let category_keywords: &[&[&str]] = &[
        &["add", "create", "implement", "new feature", "build", "develop", "want"],
        &["fix", "bug", "error", "crash", "broken", "issue", "problem", "debug"],
        &["refactor", "restructure", "optimize", "improve", "clean up", "rewrite"],
        &["how", "what", "why", "explain", "help", "?"],
        &["config", "setting", "configure", "setup", "install"],
    ];

    let matched_categories = category_keywords
        .iter()
        .filter(|keywords| keywords.iter().any(|kw| lower.contains(*kw)))
        .count();

    if matched_categories > 1 {
        ambiguities.push(Ambiguity {
            question: "Multiple intent signals detected".to_string(),
            options: vec![
                "Clarify the primary intent".to_string(),
                "Split into separate requests".to_string(),
            ],
        });
    }

    ambiguities
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clarify_feature_request() {
        let clarifier = IntentClarifier::new(None).unwrap();
        let req = IntentClarifyRequest {
            user_input: "Add a new login page for \"UserAuth\"".to_string(),
            project_context: None,
            user_id: None,
        };
        let result = clarifier.clarify(&req).unwrap();
        assert_eq!(result.intent_type, "feature_request");
        assert_eq!(result.suggested_mode, SuggestedMode::Agent);
        // Should have extracted "UserAuth" as a quoted string entity
        assert!(result.entities.iter().any(|e| e.value == "UserAuth"));
    }

    #[test]
    fn test_clarify_bug_fix() {
        let clarifier = IntentClarifier::new(None).unwrap();
        let req = IntentClarifyRequest {
            user_input: "Fix the crash on startup".to_string(),
            project_context: None,
            user_id: None,
        };
        let result = clarifier.clarify(&req).unwrap();
        assert_eq!(result.intent_type, "bug_fix");
        assert_eq!(result.suggested_mode, SuggestedMode::Agent);
    }

    #[test]
    fn test_clarify_question() {
        let clarifier = IntentClarifier::new(None).unwrap();
        let req = IntentClarifyRequest {
            user_input: "How does the authentication module work?".to_string(),
            project_context: None,
            user_id: None,
        };
        let result = clarifier.clarify(&req).unwrap();
        assert_eq!(result.intent_type, "question");
        assert_eq!(result.suggested_mode, SuggestedMode::Chat);
    }

    #[test]
    fn test_clarify_general() {
        let clarifier = IntentClarifier::new(None).unwrap();
        let req = IntentClarifyRequest {
            user_input: "random text without keywords".to_string(),
            project_context: None,
            user_id: None,
        };
        let result = clarifier.clarify(&req).unwrap();
        assert_eq!(result.intent_type, "general");
        assert_eq!(result.suggested_mode, SuggestedMode::Agent);
    }

    #[test]
    fn test_extract_entities_quoted_string() {
        let entities = extract_entities("Create a \"LoginComponent\" for the app");
        assert!(entities.iter().any(|e| e.value == "LoginComponent" && e.name == "quoted_string"));
    }

    #[test]
    fn test_extract_entities_camel_case() {
        let entities = extract_entities("Fix the HttpRequestParser module");
        assert!(entities.iter().any(|e| e.value == "HttpRequestParser" && e.name == "identifier"));
    }

    #[test]
    fn test_extract_entities_snake_case() {
        let entities = extract_entities("Update the user_auth_handler function");
        assert!(entities.iter().any(|e| e.value == "user_auth_handler" && e.name == "identifier"));
    }

    #[test]
    fn test_extract_entities_dedup() {
        let entities = extract_entities("Fix the \"HttpHandler\" and HttpHandler");
        // "HttpHandler" appears both as quoted and CamelCase — should only appear once
        let count = entities.iter().filter(|e| e.value == "HttpHandler").count();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_detect_ambiguities_low_confidence() {
        let ambiguities = detect_ambiguities("x", 0.3);
        assert!(ambiguities.iter().any(|a| a.question.contains("Low confidence")));
    }

    #[test]
    fn test_detect_ambiguities_short_input() {
        let ambiguities = detect_ambiguities("hi", 0.8);
        assert!(ambiguities.iter().any(|a| a.question.contains("too short")));
    }

    #[test]
    fn test_detect_ambiguities_multiple_signals() {
        let ambiguities = detect_ambiguities("Fix the bug and add a new feature", 0.8);
        assert!(ambiguities.iter().any(|a| a.question.contains("Multiple intent")));
    }

    #[test]
    fn test_detect_ambiguities_none() {
        let ambiguities = detect_ambiguities("Fix the crash on startup quickly", 0.8);
        // Only one category matched, input is long enough, confidence is high
        assert!(ambiguities.is_empty());
    }

    #[test]
    fn test_default_impl() {
        let _clarifier = IntentClarifier::default();
    }
}
