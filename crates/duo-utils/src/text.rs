//! Text utility functions for DuoDuo smart layer.
//!
//! Provides token estimation, text truncation by token budget,
//! and ISO 8601 timestamp formatting.

use chrono::Utc;

/// Check if a character is a CJK (Chinese/Japanese/Korean) ideograph or
/// related character that typically costs more tokens in LLM tokenizers.
///
/// Covers CJK Unified Ideographs, Hiragana, Katakana, Hangul, and
/// common CJK punctuation/symbols. Each of these characters is estimated
/// as 2 tokens (vs ~0.25 token per ASCII character).
fn is_cjk_char(ch: char) -> bool {
    matches!(
        ch,
        '\u{4E00}'..='\u{9FFF}'   // CJK Unified Ideographs
        | '\u{3400}'..='\u{4DBF}' // CJK Unified Ideographs Extension A
        | '\u{20000}'..='\u{2A6DF}' // CJK Unified Ideographs Extension B
        | '\u{2A700}'..='\u{2B73F}' // CJK Unified Ideographs Extension C
        | '\u{2B740}'..='\u{2B81F}' // CJK Unified Ideographs Extension D
        | '\u{2B820}'..='\u{2CEAF}' // CJK Unified Ideographs Extension E
        | '\u{2CEB0}'..='\u{2EBEF}' // CJK Unified Ideographs Extension F
        | '\u{FF00}'..='\u{FFEF}' // Fullwidth Forms
        | '\u{F900}'..='\u{FAFF}' // CJK Compatibility Ideographs
        | '\u{2E80}'..='\u{2EFF}' // CJK Radicals Supplement
        | '\u{2F00}'..='\u{2FDF}' // Kangxi Radicals
        | '\u{3000}'..='\u{303F}' // CJK Symbols and Punctuation
        | '\u{FE30}'..='\u{FE4F}' // CJK Compatibility Forms
        | '\u{FE50}'..='\u{FE6F}' // Small Form Variants
        | '\u{2000}'..='\u{206F}' // General Punctuation (includes 、，。etc.)
    )
}

/// Simple token count estimation with CJK-aware heuristic.
///
/// Token estimation strategy:
/// - CJK characters (Chinese/Japanese/Korean): **2 tokens per character**
///   — LLM tokenizers (GPT-4, Claude, etc.) typically encode CJK ideographs
///   as 1-3 tokens each; 2 is a reasonable mid-point estimate.
/// - ASCII characters: **1 token per 4 characters**
///   — Consistent with the original English/code heuristic (~4 chars/token).
/// - Other Unicode characters: **1 token per 2 characters**
///   — Covers accented Latin, Cyrillic, etc., which fall between ASCII and CJK.
pub fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let mut tokens: usize = 0;
    let mut ascii_count: usize = 0;
    for ch in text.chars() {
        if is_cjk_char(ch) {
            // Flush pending ASCII
            tokens += ascii_count.div_ceil(4);
            ascii_count = 0;
            tokens += 2;
        } else if ch.is_ascii() {
            ascii_count += 1;
        } else {
            // Flush pending ASCII
            tokens += ascii_count.div_ceil(4);
            ascii_count = 0;
            // Other Unicode: ~2 chars per token
            tokens += 1;
        }
    }
    // Flush remaining ASCII
    tokens += ascii_count.div_ceil(4);
    tokens
}

/// Truncate text to fit within a token budget.
///
/// Uses the same CJK-aware heuristic as `estimate_tokens` to compute
/// a character-level budget. Walks through characters, accumulating token
/// cost, and truncates when the budget would be exceeded.
///
/// Returns the input text unchanged if it fits within the budget.
/// Otherwise, truncates at the character position where the budget is
/// exhausted and appends `"...[truncated]"`.
///
/// The truncation suffix `"...[truncated]"` (~14 chars, ~4 tokens) is
/// reserved from the budget so the returned string always fits within it.
pub fn truncate_to_token_budget(text: &str, budget: usize) -> String {
    if budget == 0 {
        return String::new();
    }

    // Reserve tokens for the truncation suffix so the result stays within budget.
    // "...[truncated]" = 14 ASCII chars ≈ ceil(14/4) = 4 tokens.
    const TRUNCATED_SUFFIX: &str = "...[truncated]";
    const SUFFIX_RESERVE: usize = 4;

    let effective_budget = budget.saturating_sub(SUFFIX_RESERVE);
    if effective_budget == 0 {
        // Budget too small for any content — just return the suffix as indicator
        return TRUNCATED_SUFFIX.to_string();
    }

    let mut token_cost: usize = 0;

    // Walk through characters, accumulating token cost using the same
    // heuristic as estimate_tokens. Track the byte position where we
    // would exceed the budget.
    let mut ascii_run: usize = 0;
    let mut ascii_run_start_tokens: usize = 0;
    let mut last_safe_byte: usize = 0;

    for (byte_pos, ch) in text.char_indices() {
        let char_tokens = if is_cjk_char(ch) {
            2
        } else if ch.is_ascii() {
            // ASCII tokens are computed in batches of 4; we can't know
            // the exact cost until we see the next non-ASCII char or end.
            // For truncation, use a conservative per-char estimate of 0.25.
            // We'll track the exact cost below.
            0 // handled specially
        } else {
            1
        };

        if ch.is_ascii() {
            if ascii_run == 0 {
                ascii_run_start_tokens = token_cost;
            }
            ascii_run += 1;
            // Check if adding this ASCII char would exceed effective_budget.
            // Exact cost of the ASCII run so far: ceil(ascii_run / 4)
            let run_cost = ascii_run.div_ceil(4);
            if ascii_run_start_tokens + run_cost > effective_budget {
                // Would exceed — find the max ASCII chars we can keep
                // Need: ceil(keep / 4) + ascii_run_start_tokens <= effective_budget
                // => keep / 4 <= effective_budget - ascii_run_start_tokens
                // => keep <= (effective_budget - ascii_run_start_tokens) * 4
                let max_keep = (effective_budget - ascii_run_start_tokens) * 4;
                if max_keep == 0 {
                    // Can't fit any of this ASCII run
                    // last_safe_byte is already set correctly
                    let truncate_at = last_safe_byte;
                    return format!("{}{}", &text[..truncate_at], TRUNCATED_SUFFIX);
                } else {
                    let offset = max_keep.min(ascii_run);
                    // byte position: start of ASCII run + offset bytes (ASCII = 1 byte each)
                    let run_start_byte = byte_pos - (ascii_run - 1);
                    let truncate_at = run_start_byte + offset;
                    return format!("{}{}", &text[..truncate_at], TRUNCATED_SUFFIX);
                }
            }
            last_safe_byte = byte_pos + ch.len_utf8();
        } else {
            // Flush the ASCII run first
            if ascii_run > 0 {
                token_cost = ascii_run_start_tokens + ascii_run.div_ceil(4);
                ascii_run = 0;
            }
            token_cost += char_tokens;
            if token_cost > effective_budget {
                let truncate_at = last_safe_byte;
                return format!("{}{}", &text[..truncate_at], TRUNCATED_SUFFIX);
            }
            last_safe_byte = byte_pos + ch.len_utf8();
        }
    }

    // Entire text fits within budget
    text.to_string()
}

/// Return the current UTC time as an ISO 8601 formatted string.
///
/// Format example: `"2025-06-27T12:34:56.789Z"`
pub fn format_timestamp() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_tokens_empty() {
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn estimate_tokens_basic() {
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
        assert_eq!(estimate_tokens("abcdefgh"), 2);
        assert_eq!(estimate_tokens("abcdefghi"), 3);
    }

    #[test]
    fn estimate_tokens_cjk() {
        // Each CJK char = 2 tokens
        assert_eq!(estimate_tokens("你好"), 4);
        assert_eq!(estimate_tokens("你好世界"), 8);
        // Mixed: "abc" = 1 token (ceil(3/4)), "你好" = 4 tokens => total 5
        assert_eq!(estimate_tokens("abc你好"), 5);
        // Mixed: "abcd" = 1, "你" = 2, "efgh" = 1 => total 4
        assert_eq!(estimate_tokens("abcd你efgh"), 4);
    }

    #[test]
    fn estimate_tokens_pure_cjk() {
        // Pure CJK string: 5 chars × 2 tokens = 10
        assert_eq!(estimate_tokens("你好世界吗"), 10);
    }

    #[test]
    fn estimate_tokens_cjk_punctuation() {
        // CJK punctuation (，。) counts as CJK: 2 tokens each
        // 你好，世界。 = 6 CJK chars × 2 tokens = 12
        assert_eq!(estimate_tokens("你好，世界。"), 12);
    }

    #[test]
    fn estimate_tokens_mixed_long() {
        // "Hello " = 6 ASCII = 2 tokens, "你好" = 4 tokens, " World" = 6 ASCII = 2 tokens
        // Total = 8
        assert_eq!(estimate_tokens("Hello 你好 World"), 8);
    }

    #[test]
    fn truncate_within_budget() {
        let text = "hello world";
        assert_eq!(truncate_to_token_budget(text, 100), text);
    }

    #[test]
    fn truncate_exceeds_budget() {
        let text = "a".repeat(20);
        // budget = 6: effective_budget = 6 - 4 (suffix reserve) = 2 tokens = 8 chars
        let result = truncate_to_token_budget(&text, 6);
        assert!(result.ends_with("...[truncated]"));
        assert!(result.len() < text.len() + 20); // sanity
    }

    #[test]
    fn truncate_zero_budget() {
        assert_eq!(truncate_to_token_budget("hello", 0), "");
    }

    #[test]
    fn truncate_cjk_within_budget() {
        // 4 CJK chars = 8 tokens, need budget >= 8 + 4 (suffix reserve) = 12 to not truncate
        let text = "你好世界";
        assert_eq!(truncate_to_token_budget(text, 12), text);
    }

    #[test]
    fn truncate_cjk_exceeds_budget() {
        // 4 CJK chars = 8 tokens, budget 8 should truncate (effective_budget = 8-4 = 4)
        // Can keep 2 CJK chars (4 tokens) then suffix
        let text = "你好世界";
        let result = truncate_to_token_budget(text, 8);
        assert!(result.ends_with("...[truncated]"));
        assert!(result.starts_with("你好"));
    }

    #[test]
    fn truncate_mixed_cjk_ascii() {
        // "abcd你好" = 1 (abcd) + 4 (你好) = 5 tokens
        let text = "abcd你好";
        // Budget 7: effective_budget = 7-4 = 3 tokens
        // Can keep "abcd" (1 token) + 1 CJK char (2 tokens) = 3 tokens
        let result = truncate_to_token_budget(text, 7);
        assert!(result.ends_with("...[truncated]"));
        assert!(result.starts_with("abcd你"));
    }

    #[test]
    fn truncate_preserves_full_text_when_fits() {
        // Mixed text that exactly fits budget (with suffix reserve)
        let text = "你好abc";
        // 你好 = 4 tokens, abc = 1 token => 5 tokens total
        // Need budget >= 5 + 4 (suffix reserve) = 9 to not truncate
        assert_eq!(truncate_to_token_budget(text, 9), text);
        assert_eq!(truncate_to_token_budget(text, 10), text);
    }

    #[test]
    fn format_timestamp_is_rfc3339() {
        let ts = format_timestamp();
        // Should parse as a valid RFC 3339 / ISO 8601 timestamp
        assert!(chrono::DateTime::parse_from_rfc3339(&ts).is_ok());
    }
}
