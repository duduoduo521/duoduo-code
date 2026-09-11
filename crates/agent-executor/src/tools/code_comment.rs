//! Code comment metadata recording.
//!
//! Records review comments about specific code locations, with optional
//! path-traversal protection when a project root is provided.

use anyhow::Result;
use blackboard_coordinator::BlackboardCoordinator;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// A code comment record pointing to a specific file/line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeComment {
    pub file_path: String,
    pub line_number: Option<u32>,
    pub comment: String,
    pub author: Option<String>,
}

/// Create a code comment record.
///
/// When `project_path` is provided, validates that the resolved file path
/// stays within the project root (path-traversal protection).
pub fn create_code_comment(
    file_path: &str,
    line_number: Option<u32>,
    comment: &str,
    project_path: Option<&Path>,
) -> Result<CodeComment> {
    // Security check: ensure path is within project if project_path is set
    if let Some(pp) = project_path
        && !file_path.starts_with('/') && !file_path.starts_with('\\') {
            let full_path = pp.join(file_path);
            let canonical_pp = pp.canonicalize().unwrap_or_else(|_| pp.to_path_buf());
            if let Ok(canonical) = full_path.canonicalize()
                && !canonical.starts_with(&canonical_pp) {
                    anyhow::bail!("Path traversal detected: {}", file_path);
                }
        }

    Ok(CodeComment {
        file_path: file_path.to_string(),
        line_number,
        comment: comment.to_string(),
        author: None,
    })
}

/// Create a code comment AND persist it as a blackboard annotation (G5 回流).
///
/// Mirrors the TS-side `code_comment.ts` bridge: a review comment recorded by a
/// Rust-native tool also flows into the blackboard `file_annotations` table so
/// the loop's Reflect phase can surface it. Path-traversal validation is reused
/// from [`create_code_comment`] before writing.
pub fn create_code_comment_and_annotate(
    coordinator: &BlackboardCoordinator,
    file_path: &str,
    line_number: Option<u32>,
    comment: &str,
    author: &str,
    project_path: Option<&Path>,
) -> Result<i64> {
    // Reuse the same validation (path-traversal guard) as create_code_comment.
    let _ = create_code_comment(file_path, line_number, comment, project_path)?;
    let content = match line_number {
        Some(line) => format!("L{}: {}", line, comment),
        None => comment.to_string(),
    };
    let id = coordinator.add_file_annotation(file_path, author, "review", &content)?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_code_comment() {
        let comment = create_code_comment("src/main.rs", Some(42), "TODO: refactor", None).unwrap();
        assert_eq!(comment.file_path, "src/main.rs");
        assert_eq!(comment.line_number, Some(42));
        assert_eq!(comment.comment, "TODO: refactor");
        assert!(comment.author.is_none());
    }

    #[test]
    fn test_create_code_comment_without_line() {
        let comment = create_code_comment("lib.rs", None, "General note", None).unwrap();
        assert!(comment.line_number.is_none());
    }
}
