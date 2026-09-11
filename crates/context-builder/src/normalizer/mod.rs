//! Code block format normalizer for prompt text.
//!
//! Normalizes code blocks within markdown-formatted prompts to eliminate
//! formatting differences that cause cache misses. Rules:
//!
//! 1. Detect ` ```...``` ` fenced code blocks
//! 2. Normalize indentation (strip common leading indent, convert tabs to spaces)
//! 3. Remove trailing whitespace from each line
//! 4. Collapse consecutive blank lines to at most one
//! 5. Preserve non-code text (markdown prose) unchanged

use std::sync::LazyLock;

use regex::Regex;

/// Regex matching markdown fenced code blocks: ```lang\\ncode\\n```
///
/// Captures:
/// - Group 1: optional language identifier (e.g. "rust", "json")
/// - Group 2: code content between fences
static CODE_FENCE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)```(\w*)\n(.*?)```").expect("invariant: static regex pattern is valid")
});

/// Normalize code blocks within a prompt string.
///
/// Scans for markdown fenced code blocks and applies format normalization
/// to each code block's content. Non-code text is left unchanged.
///
/// This is designed to be called after prompt assembly but before sending
/// to the LLM, ensuring that semantically identical code with different
/// formatting produces the same prompt hash for cache matching.
pub fn normalize_code_blocks(text: &str) -> String {
    CODE_FENCE_RE.replace_all(text, |caps: &regex::Captures| {
        let lang = caps
            .get(1)
            .expect("invariant: capture group 1 is non-optional in CODE_FENCE_RE pattern")
            .as_str();
        let code = caps
            .get(2)
            .expect("invariant: capture group 2 is non-optional in CODE_FENCE_RE pattern")
            .as_str();
        let normalized = normalize_code(code);
        // The closing fence must sit on its own line (CommonMark): capture
        // group 2 already drops the trailing newline and `normalize_code`
        // trims, so emit it explicitly.
        format!("```{}\n{}\n```", lang, normalized)
    }).to_string()
}

/// Normalize a single code block's content.
///
/// Steps:
/// 1. Compute minimum indentation across non-empty lines
/// 2. Strip that common indentation
/// 3. Convert remaining leading tabs to 4 spaces
/// 4. Remove trailing whitespace from each line
/// 5. Collapse consecutive blank lines to at most one
fn normalize_code(code: &str) -> String {
    let lines: Vec<&str> = code.lines().collect();
    if lines.is_empty() {
        return String::new();
    }

    // Compute minimum indentation (ignoring empty lines)
    let min_indent = lines.iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.chars().take_while(|c| c.is_whitespace()).count())
        .min()
        .unwrap_or(0);

    let mut result = String::with_capacity(code.len());
    let mut prev_empty = false;

    for line in &lines {
        // Strip common leading indent (only from non-empty lines)
        let dedented = if !line.trim().is_empty() && line.len() > min_indent {
            let leading_ws = line.chars().take_while(|c| c.is_whitespace()).count();
            if leading_ws >= min_indent {
                // `min_indent` counts *chars*, but slicing is by *bytes*.
                // `char::is_whitespace` accepts multi-byte whitespace
                // (NBSP U+00A0 = 2 bytes, ideographic space U+3000 = 3 bytes),
                // so a raw `&line[min_indent..]` can land inside a char and
                // panic. Map the char offset to its byte offset instead.
                let byte_offset = line
                    .char_indices()
                    .nth(min_indent)
                    .map(|(idx, _)| idx)
                    .unwrap_or(line.len());
                &line[byte_offset..]
            } else {
                line
            }
        } else {
            line
        };

        // Remove trailing whitespace
        let trimmed = dedented.trim_end();

        // Collapse consecutive blank lines
        if trimmed.is_empty() {
            if !prev_empty {
                result.push('\n');
                prev_empty = true;
            }
            continue;
        }
        prev_empty = false;

        // Convert leading tabs to 4 spaces (preserving relative indent)
        let leading_ws_count = trimmed.chars().take_while(|c| *c == '\t' || *c == ' ').count();
        let leading_ws: String = trimmed[..leading_ws_count]
            .chars()
            .map(|c| if c == '\t' { "    " } else { " " })
            .collect();
        let content = &trimmed[leading_ws_count..];

        result.push_str(&leading_ws);
        result.push_str(content);
        result.push('\n');
    }

    // Remove trailing newline added by the loop
    result.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_empty_input() {
        assert_eq!(normalize_code_blocks(""), "");
    }

    #[test]
    fn normalize_preserves_non_code_text() {
        let input = "Hello world\nNo code here\nJust text";
        assert_eq!(normalize_code_blocks(input), input);
    }

    #[test]
    fn normalize_strips_common_indent() {
        let input = "```rust\n    fn main() {\n        println!(\"hello\");\n    }\n```";
        let result = normalize_code_blocks(input);
        // Common indent of 4 should be stripped
        assert!(result.contains("fn main()"));
        assert!(result.contains("    println!"));
        assert!(!result.contains("        println!"));
    }

    #[test]
    fn normalize_converts_tabs_to_spaces() {
        let input = "```rust\nfn main() {\n\tprintln!(\"hello\");\n}\n```";
        let result = normalize_code_blocks(input);
        assert!(result.contains("    println!"));
        assert!(!result.contains("\t"));
    }

    #[test]
    fn normalize_removes_trailing_whitespace() {
        let input = "```rust\nfn main() {   \n    let x = 1;   \n}\n```";
        let result = normalize_code_blocks(input);
        assert!(!result.contains("   \n"));
        assert!(result.contains("fn main() {"));
    }

    #[test]
    fn normalize_collapses_blank_lines() {
        let input = "```rust\nfn a() {}\n\n\n\nfn b() {}\n```";
        let result = normalize_code_blocks(input);
        // At most one blank line between functions
        assert!(!result.contains("\n\n\n"));
    }

    #[test]
    fn normalize_preserves_language_tag() {
        let input = "```typescript\nconst x: number = 1;\n```";
        let result = normalize_code_blocks(input);
        assert!(result.contains("```typescript"));
    }

    #[test]
    fn normalize_multiple_code_blocks() {
        let input = "Some text\n```rust\n\tfn a() {}\n```\nMore text\n```python\n\tdef b():\n\t\tpass\n```";
        let result = normalize_code_blocks(input);
        assert!(result.contains("Some text"));
        assert!(result.contains("More text"));
        // Tab-only common indent is stripped; the fn/def are at base level
        assert!(result.contains("fn a()"));
        // After stripping the common 1-tab indent, the remaining 1-tab on 'pass' becomes 4 spaces
        assert!(result.contains("def b():"));
        assert!(result.contains("    pass"));  // 1 remaining tab → 4 spaces
    }

    #[test]
    fn normalize_idempotent() {
        let input = "```rust\n    fn main() {\n        println!(\"hi\");\n    }\n```";
        let first = normalize_code_blocks(input);
        let second = normalize_code_blocks(&first);
        assert_eq!(first, second);
    }

    /// Regression (P1-19): `min_indent` counts *chars* but slicing is by
    /// *bytes*. NBSP (U+00A0) is `char::is_whitespace` yet occupies 2 bytes,
    /// so `&line[min_indent..]` landed inside a char and panicked.
    #[test]
    fn normalize_multi_byte_whitespace_indent_does_not_panic() {
        let nbsp = '\u{a0}';
        let input = format!("```rust\n{nbsp}fn main() {{\n{nbsp}{nbsp}println!(\"hi\");\n{nbsp}}}\n```");
        let result = normalize_code_blocks(&input);
        assert!(result.contains("fn main()"), "got {result:?}");
        assert!(result.contains("println!(\"hi\");"), "got {result:?}");
    }

    /// Regression (P1-20): the closing fence must sit on its own line. It used
    /// to be emitted as ```` ```rust\ncode``` ````, so per CommonMark the block
    /// never closed and all following prose was swallowed into it.
    #[test]
    fn normalize_emits_closing_fence_on_its_own_line() {
        let input = "```rust\nfn main() {}\n```";
        let result = normalize_code_blocks(input);
        assert!(
            result.ends_with("fn main() {}\n```"),
            "closing fence must be on its own line, got {result:?}"
        );
    }
}
