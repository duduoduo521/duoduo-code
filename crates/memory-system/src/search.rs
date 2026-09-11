//! Search module for memory-system.
//!
//! Provides simple token-overlap scoring (Jaccard similarity) and
//! a whitespace/punctuation tokenizer.

use std::collections::HashSet;

/// Calculate relevance between a query and content using Jaccard similarity.
///
/// Returns a score between 0.0 and 1.0 where 1.0 means perfect overlap.
pub fn calculate_relevance(query: &str, content: &str) -> f64 {
    let query_tokens: HashSet<String> = tokenize(query).into_iter().collect();
    let content_tokens: HashSet<String> = tokenize(content).into_iter().collect();

    if query_tokens.is_empty() && content_tokens.is_empty() {
        return 1.0;
    }
    if query_tokens.is_empty() || content_tokens.is_empty() {
        return 0.0;
    }

    let intersection = query_tokens.intersection(&content_tokens).count() as f64;
    let union = query_tokens.union(&content_tokens).count() as f64;

    if union == 0.0 {
        return 0.0;
    }

    intersection / union
}

/// R-02: Reciprocal Rank Fusion combines ranked result lists from heterogeneous
/// sources (FTS5 keyword, vector cosine, KG, Jaccard) whose raw scores live on
/// incompatible scales. RRF uses only each item's *rank*, so sources need not
/// have comparable scores. `k` dampens top-rank influence (commonly 60).
pub fn reciprocal_rank_fusion(lists: &[Vec<String>], k: f64) -> Vec<(String, f64)> {
    use std::collections::HashMap;
    let mut scores: HashMap<String, f64> = HashMap::new();
    for list in lists {
        for (rank, id) in list.iter().enumerate() {
            let r = (rank + 1) as f64;
            *scores.entry(id.clone()).or_insert(0.0) += 1.0 / (k + r);
        }
    }
    let mut out: Vec<(String, f64)> = scores.into_iter().collect();
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// Tokenize text into lowercase word tokens.
pub fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut ascii_buf = String::new();

    for ch in text.to_lowercase().chars() {
        if is_cjk(ch) {
            // Flush any pending ASCII token
            if !ascii_buf.is_empty() {
                for word in ascii_buf.split(|c: char| c.is_whitespace() || c.is_ascii_punctuation()) {
                    let w = word.to_string();
                    if !w.is_empty() {
                        tokens.push(w);
                    }
                }
                ascii_buf.clear();
            }
            // Each CJK character is its own token
            tokens.push(ch.to_string());
        } else {
            ascii_buf.push(ch);
        }
    }

    // Flush remaining ASCII buffer
    if !ascii_buf.is_empty() {
        for word in ascii_buf.split(|c: char| c.is_whitespace() || c.is_ascii_punctuation()) {
            let w = word.to_string();
            if !w.is_empty() {
                tokens.push(w);
            }
        }
    }

    tokens
}

/// Generate n-gram tokenized text for FTS5 Chinese search.
///
/// Rules: CJK segments → 2-gram + 3-gram, English/numbers → preserve original words,
/// single CJK characters are also preserved.
pub fn generate_ngram(text: &str) -> String {
    let mut result = Vec::new();
    let mut cjk_buf = Vec::new();

    for ch in text.chars() {
        if is_cjk(ch) {
            cjk_buf.push(ch);
        } else {
            // flush CJK buffer → generate 2-gram and 3-gram
            if cjk_buf.len() >= 2 {
                for window in cjk_buf.windows(2) {
                    result.push(window.iter().collect::<String>());
                }
            }
            if cjk_buf.len() >= 3 {
                for window in cjk_buf.windows(3) {
                    result.push(window.iter().collect::<String>());
                }
            }
            // single CJK characters are also preserved
            for c in &cjk_buf {
                result.push(c.to_string());
            }
            cjk_buf.clear();
            // non-CJK characters preserved as-is
            if !ch.is_whitespace() {
                result.push(ch.to_lowercase().to_string());
            }
        }
    }
    // flush remaining CJK buffer
    if cjk_buf.len() >= 2 {
        for window in cjk_buf.windows(2) {
            result.push(window.iter().collect::<String>());
        }
    }
    if cjk_buf.len() >= 3 {
        for window in cjk_buf.windows(3) {
            result.push(window.iter().collect::<String>());
        }
    }
    for c in &cjk_buf {
        result.push(c.to_string());
    }

    result.join(" ")
}

/// Check if a character is a CJK (Chinese/Japanese/Korean) character.
fn is_cjk(ch: char) -> bool {
    let cp = ch as u32;
    // CJK Unified Ideographs
    (0x4E00..=0x9FFF).contains(&cp)
    // CJK Extension A
    || (0x3400..=0x4DBF).contains(&cp)
    // CJK Extension B
    || (0x20000..=0x2A6DF).contains(&cp)
    // CJK Compatibility Ideographs
    || (0xF900..=0xFAFF).contains(&cp)
    // CJK Radicals / Kangxi Radicals
    || (0x2F00..=0x2FDF).contains(&cp)
    // Hiragana
    || (0x3040..=0x309F).contains(&cp)
    // Katakana
    || (0x30A0..=0x30FF).contains(&cp)
    // Hangul Syllables
    || (0xAC00..=0xD7AF).contains(&cp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_basic() {
        let tokens = tokenize("Hello, World! This is a test.");
        assert_eq!(
            tokens,
            vec!["hello", "world", "this", "is", "a", "test"]
        );
    }

    #[test]
    fn tokenize_empty() {
        let tokens = tokenize("");
        assert!(tokens.is_empty());
    }

    #[test]
    fn tokenize_punctuation_only() {
        let tokens = tokenize("!!! ??? ...");
        assert!(tokens.is_empty());
    }

    #[test]
    fn tokenize_mixed_whitespace() {
        let tokens = tokenize("foo\tbar\nbaz  qux");
        assert_eq!(tokens, vec!["foo", "bar", "baz", "qux"]);
    }

    #[test]
    fn relevance_identical() {
        let score = calculate_relevance("hello world", "hello world");
        assert!((score - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn relevance_no_overlap() {
        let score = calculate_relevance("hello", "world");
        assert!((score - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn relevance_partial_overlap() {
        let score = calculate_relevance("hello world", "world foo");
        // intersection = {"world"} = 1, union = {"hello", "world", "foo"} = 3
        assert!((score - 1.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn relevance_both_empty() {
        let score = calculate_relevance("", "");
        assert!((score - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn relevance_one_empty() {
        let score = calculate_relevance("hello", "");
        assert!((score - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn relevance_case_insensitive() {
        let score = calculate_relevance("Hello World", "hello world");
        assert!((score - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn tokenize_chinese() {
        let tokens = tokenize("你好世界测试");
        assert_eq!(tokens, vec!["你", "好", "世", "界", "测", "试"]);
    }

    #[test]
    fn tokenize_mixed_chinese_english() {
        let tokens = tokenize("使用React组件");
        // "使用" -> "使", "用"; then "react"; then "组件" -> "组", "件"
        assert!(tokens.contains(&"使".to_string()));
        assert!(tokens.contains(&"react".to_string()));
        assert!(tokens.contains(&"组".to_string()));
    }

    #[test]
    fn relevance_chinese() {
        let score = calculate_relevance("前端开发", "前端开发框架");
        // Should have reasonable overlap due to CJK character-level tokens
        assert!(score > 0.3);
    }
}
