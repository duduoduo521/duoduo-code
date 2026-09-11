//! Truncate content to fit within a token budget.
//!
//! Provides both in-memory truncation and a variant that writes the full
//! content to a temp file when truncation is needed.

use anyhow::Result;

/// Truncate content to fit within a token budget.
///
/// Uses a simple UTF-16-based token estimator (roughly 1 token per 4 UTF-16
/// code units). Returns a truncated string with an ellipsis indicator when the
/// budget is exceeded.
pub fn truncate_content(content: &str, max_tokens: usize) -> Result<String> {
    let utf16_len = content.encode_utf16().count();
    let current_tokens = utf16_len.div_ceil(4);

    if current_tokens <= max_tokens {
        return Ok(content.to_string());
    }

    // Truncate at character boundary proportional to max_tokens
    let max_utf16 = max_tokens * 4;
    let mut acc = 0;
    let mut end = content.len();
    for (i, c) in content.char_indices() {
        if acc >= max_utf16 {
            end = i;
            break;
        }
        acc += c.len_utf16();
    }

    let mut truncated = content[..end].to_string();
    truncated.push_str("\n\n... [output truncated] ...");
    Ok(truncated)
}

/// Write truncated content to a temp file and return a summary.
///
/// When the content fits within the token budget, returns it as-is.
/// Otherwise, writes the full content to a temp file and appends a note
/// with the file path to the truncated output.
pub fn truncate_with_file(
    content: &str,
    max_tokens: usize,
    temp_dir: &std::path::Path,
) -> Result<String> {
    let truncated = truncate_content(content, max_tokens)?;
    if truncated.len() == content.len() {
        return Ok(content.to_string());
    }

    // Write full content to temp file
    let file_id = uuid::Uuid::new_v4().to_string();
    let file_path = temp_dir.join(format!("truncate-{}.txt", file_id));
    std::fs::write(&file_path, content)?;

    let summary = format!(
        "{}\n\n[Full output written to: {}]",
        truncated,
        file_path.display()
    );
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_truncate_short_content() {
        let result = truncate_content("hello", 100).unwrap();
        assert_eq!(result, "hello");
    }

    #[test]
    fn test_truncate_long_content() {
        let long = "a".repeat(1000);
        let result = truncate_content(&long, 10).unwrap();
        assert!(result.contains("[output truncated]"));
        assert!(result.len() < long.len());
    }

    #[test]
    fn test_truncate_with_file_short_content() {
        let dir = std::env::temp_dir();
        let result = truncate_with_file("short", 100, &dir).unwrap();
        assert_eq!(result, "short");
    }

    #[test]
    fn test_truncate_with_file_long_content() {
        let dir = std::env::temp_dir();
        let long = "b".repeat(2000);
        let result = truncate_with_file(&long, 10, &dir).unwrap();
        assert!(result.contains("[Full output written to:"));
    }
}
