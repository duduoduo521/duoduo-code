//! Rename detection (anchor migration).
//!
//! When a symbol is renamed (e.g., formatTime → formatTimestamp),
//! tree-sitter can detect this automatically by comparing old and new exports.
//!
//! Safety constraint: each symbol can only be renamed once per task cycle.

use std::collections::HashSet;

/// Detect renames between old and new symbol lists.
///
/// Heuristic: if a symbol exists in old but not in new, and a similar symbol
/// exists in new but not in old, treat it as a rename.
///
/// Similarity criteria:
/// - Levenshtein distance < 50% of the longer name
/// - OR one name is a prefix/suffix of the other
///
/// Safety: each symbol can only be renamed once per task cycle.
pub fn detect_renames(
    old_exports: &[String],
    new_exports: &[String],
    already_renamed: &[String], // symbols that have already been renamed in this cycle
) -> Vec<(String, String)> {
    let old_set: HashSet<&str> = old_exports.iter().map(|s| s.as_str()).collect();
    let new_set: HashSet<&str> = new_exports.iter().map(|s| s.as_str()).collect();

    // Symbols removed from old
    let removed: Vec<&str> = old_set.difference(&new_set).copied().collect();
    // Symbols added in new
    let added: Vec<&str> = new_set.difference(&old_set).copied().collect();

    let mut renames = Vec::new();

    for old_name in &removed {
        // Safety: skip symbols that have already been renamed
        if already_renamed.iter().any(|r| r == *old_name) {
            continue;
        }

        // Find the best matching new name
        let best_match = added.iter().find(|new_name| {
            is_likely_rename(old_name, new_name)
        });

        if let Some(new_name) = best_match {
            renames.push((old_name.to_string(), new_name.to_string()));
        }
    }

    renames
}

/// Check if two names are likely a rename.
fn is_likely_rename(old_name: &str, new_name: &str) -> bool {
    // Same name is not a rename
    if old_name == new_name {
        return false;
    }

    // Prefix match (e.g., formatTime → formatTimestamp)
    if new_name.starts_with(old_name) || old_name.starts_with(new_name) {
        return true;
    }

    // Suffix match (e.g., getUser → fetchUser)
    if new_name.ends_with(old_name) || old_name.ends_with(new_name) {
        return true;
    }

    // Levenshtein distance check
    let distance = levenshtein_distance(old_name, new_name);
    let max_len = old_name.len().max(new_name.len());
    if max_len > 0 && distance < max_len / 2 {
        return true;
    }

    false
}

/// Compute Levenshtein edit distance between two strings.
fn levenshtein_distance(a: &str, b: &str) -> usize {
    let a_len = a.chars().count();
    let b_len = b.chars().count();

    if a_len == 0 { return b_len; }
    if b_len == 0 { return a_len; }

    let mut matrix = vec![vec![0; b_len + 1]; a_len + 1];

    for (i, row) in matrix.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in matrix[0].iter_mut().enumerate() {
        *cell = j;
    }

    for (i, a_char) in a.chars().enumerate() {
        for (j, b_char) in b.chars().enumerate() {
            let cost = if a_char == b_char { 0 } else { 1 };
            matrix[i + 1][j + 1] = (matrix[i][j + 1] + 1)
                .min(matrix[i + 1][j] + 1)
                .min(matrix[i][j] + cost);
        }
    }

    matrix[a_len][b_len]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_simple_rename() {
        let old = vec!["formatTime".to_string(), "getUser".to_string()];
        let new = vec!["formatTimestamp".to_string(), "getUser".to_string()];
        let renames = detect_renames(&old, &new, &[]);
        assert_eq!(renames.len(), 1);
        assert_eq!(renames[0], ("formatTime".to_string(), "formatTimestamp".to_string()));
    }

    #[test]
    fn detect_prefix_rename() {
        let old = vec!["getUser".to_string()];
        let new = vec!["fetchUser".to_string()];
        let renames = detect_renames(&old, &new, &[]);
        assert_eq!(renames.len(), 1);
        assert_eq!(renames[0], ("getUser".to_string(), "fetchUser".to_string()));
    }

    #[test]
    fn no_rename_when_just_added() {
        let old = vec!["formatTime".to_string()];
        let new = vec!["formatTime".to_string(), "parseConfig".to_string()];
        let renames = detect_renames(&old, &new, &[]);
        assert!(renames.is_empty());
    }

    #[test]
    fn safety_constraint_blocks_double_rename() {
        let old = vec!["formatTime".to_string()];
        let new = vec!["formatTimestamp".to_string()];
        // Already renamed once
        let already = vec!["formatTime".to_string()];
        let renames = detect_renames(&old, &new, &already);
        assert!(renames.is_empty(), "Should block double rename within same cycle");
    }

    #[test]
    fn levenshtein_distance_test() {
        assert_eq!(levenshtein_distance("kitten", "sitting"), 3);
        assert_eq!(levenshtein_distance("", "abc"), 3);
        assert_eq!(levenshtein_distance("abc", "abc"), 0);
    }
}
