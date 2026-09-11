//! RunLoop constants for P2-01/P2-05.
//!
//! `MAX_STEPS` and crash-recovery constants. Event streaming is handled by
//! `LoopStreamEvent` in `event_bus/mod.rs` (the old `RunLoopEvent` enum has
//! been removed — it was superseded by the finer-grained `LoopStreamEvent`).

use serde::{Deserialize, Serialize};

/// Maximum number of tool-call rounds before forcing completion.
pub const MAX_STEPS: u32 = 50;

/// Prompt injected when MAX_STEPS is reached.
/// Mirrors TS `max-steps.txt` content.
pub const MAX_STEPS_PROMPT: &str = "CRITICAL - MAXIMUM STEPS REACHED\n\
The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.\n\
\nSTRICT REQUIREMENTS:\n\
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)\n\
2. MUST provide a text response summarizing work done so far\n\
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use\n\
\nResponse must include:\n\
- Statement that maximum steps for this agent have been reached\n\
- Summary of what has been accomplished so far\n\
- List of any remaining tasks that were not completed\n\
- Recommendations for what should be done next\n\
\nAny attempt to use tools is a critical violation. Respond with text ONLY.";

/// Output format specification for structured output.
/// Mirrors TS `MessageV2.OutputFormatJsonSchema`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutputFormat {
    /// JSON schema structured output.
    JsonSchema {
        /// The JSON schema to validate against.
        schema: serde_json::Value,
        /// Number of retry attempts (default 2).
        #[serde(default = "default_retry_count")]
        retry_count: u32,
    },
}

fn default_retry_count() -> u32 {
    2
}

/// Detect if the last assistant message has an error (crash indicator)
/// and generate a progress summary from completed tool results.
pub fn generate_crash_recovery_summary(
    tool_results: &[(String, String)], // (tool_name, result)
) -> String {
    if tool_results.is_empty() {
        return "The previous session was interrupted before any tools completed.".to_string();
    }
    let mut summary = String::from("Previous session was interrupted. Completed work:\n");
    for (name, result) in tool_results {
        let truncated = if result.len() > 200 {
            // Truncate at char boundary to avoid splitting multi-byte chars
            let mut end = 200;
            while end > 0 && !result.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}...", &result[..end])
        } else {
            result.clone()
        };
        summary.push_str(&format!("- {}: {}\n", name, truncated));
    }
    summary.push_str("\nPlease continue from where we left off.");
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_max_steps_constant() {
        assert_eq!(MAX_STEPS, 50);
    }

    #[test]
    fn test_crash_recovery_empty() {
        let summary = generate_crash_recovery_summary(&[]);
        assert!(summary.contains("interrupted before any tools completed"));
    }

    #[test]
    fn test_crash_recovery_with_results() {
        let results = vec![
            ("read_file".to_string(), "file contents here".to_string()),
            ("bash".to_string(), "command output".to_string()),
        ];
        let summary = generate_crash_recovery_summary(&results);
        assert!(summary.contains("read_file"));
        assert!(summary.contains("bash"));
        assert!(summary.contains("continue from where we left off"));
    }

    #[test]
    fn test_crash_recovery_truncation() {
        let long_result = "x".repeat(300);
        let results = vec![("tool".to_string(), long_result)];
        let summary = generate_crash_recovery_summary(&results);
        // The function truncates at 200 chars with "..." suffix
        assert!(summary.contains("..."));
        // Should not contain the full 300-char string
        assert!(!summary.contains(&"x".repeat(300)));
    }
}
