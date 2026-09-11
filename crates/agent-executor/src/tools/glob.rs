//! Glob-based file search using the `ignore` crate (ripgrep walker).
//!
//! Searches for files matching a glob pattern within a project directory,
//! with built-in protection for sensitive paths (.ssh, .aws, etc.).

use anyhow::Result;
use std::path::Path;

/// Protected/sensitive path patterns that should never appear in search results.
const PROTECTED_PATTERNS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".env",
    "credentials",
    "id_rsa",
    "id_ed25519",
    ".npmrc",
    ".pypirc",
];

/// Check if a path contains protected/sensitive patterns.
pub fn is_protected_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    PROTECTED_PATTERNS.iter().any(|p| normalized.contains(p))
}

/// Search for files matching a glob pattern using the `ignore` crate (ripgrep).
///
/// Returns up to `max_results` file paths (relative to `project_path`),
/// sorted alphabetically. Hard cap of 100 results.
pub fn glob_search(pattern: &str, project_path: &Path, max_results: usize) -> Result<Vec<String>> {
    let mut results = Vec::new();
    let max_results = max_results.min(100);

    let mut builder = ignore::WalkBuilder::new(project_path);
    builder
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true);

    let prefix = project_path
        .to_str()
        .unwrap_or("")
        .trim_end_matches('/');

    for entry in builder.build().filter_map(|e| e.ok()) {
        if results.len() >= max_results {
            break;
        }
        let path = entry.path();
        if let Some(path_str) = path.to_str() {
            let relative = path_str
                .strip_prefix(prefix)
                .unwrap_or(path_str)
                .trim_start_matches('/');

            if is_protected_path(relative) {
                continue;
            }

            if glob_match(pattern, relative) {
                results.push(relative.to_string());
            }
        }
    }

    results.sort();
    Ok(results)
}

/// Simple glob pattern matching supporting `*` (any non-separator) and `**` (any path).
fn glob_match(pattern: &str, path: &str) -> bool {
    let pattern = pattern.trim_start_matches("./");
    let path = path.trim_start_matches("./");

    if pattern == "**" || pattern == "**/*" {
        return true;
    }

    // Convert glob to regex for matching
    let mut regex_str = String::new();
    regex_str.push('^');
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next(); // consume second *
                    // ** matches any path including separators
                    let next = chars.peek();
                    if next == Some(&'/') {
                        chars.next();
                        regex_str.push_str("(.*/)?");
                    } else {
                        regex_str.push_str(".*");
                    }
                } else {
                    // Single * matches any non-separator
                    regex_str.push_str("[^/]*");
                }
            }
            '?' => regex_str.push_str("[^/]"),
            '.'
            | '^'
            | '$'
            | '+'
            | '('
            | ')'
            | '|'
            | '['
            | ']'
            | '{'
            | '}'
            | '\\' => {
                regex_str.push('\\');
                regex_str.push(c);
            }
            _ => regex_str.push(c),
        }
    }
    regex_str.push('$');

    match regex::Regex::new(&regex_str) {
        Ok(re) => re.is_match(path),
        Err(_) => path.contains(pattern),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_protected_path() {
        assert!(is_protected_path(".ssh/config"));
        assert!(is_protected_path("/home/user/.aws/credentials"));
        assert!(!is_protected_path("src/main.rs"));
        assert!(is_protected_path("dir/.env"));
        assert!(is_protected_path("id_rsa"));
    }

    #[test]
    fn test_glob_match_star_star_rs() {
        assert!(glob_match("**/*.rs", "src/main.rs"));
        assert!(glob_match("**/*.rs", "main.rs"));
        assert!(!glob_match("**/*.rs", "src/main.ts"));
    }

    #[test]
    fn test_glob_match_single_star() {
        assert!(glob_match("*.rs", "main.rs"));
        assert!(!glob_match("*.rs", "src/main.rs"));
    }

    #[test]
    fn test_glob_match_src_star_star() {
        assert!(glob_match("src/**", "src/main.rs"));
        assert!(glob_match("src/**", "src/foo/bar.rs"));
    }

    #[test]
    fn test_glob_match_double_star() {
        assert!(glob_match("**", "anything"));
        assert!(glob_match("**/*", "src/main.rs"));
    }
}
