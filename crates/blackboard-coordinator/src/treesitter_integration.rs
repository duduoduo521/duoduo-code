//! Tree-sitter integration for the blackboard system.
//!
//! Bridges ast-engine capabilities into blackboard operations:
//! - AST hash computation for optimistic lock validation
//! - Structural diff generation for change notifications
//! - Syntax validation for stable submission checks
//! - Rename detection for dependency graph updates
//! - Context compression for LLM context management
//! - Intent consistency verification

use anyhow::Result;
use std::sync::Arc;
use tracing::warn;

use ast_engine::*;
use blackboard_store::BlackboardStore;
use duo_types::*;

/// Tree-sitter integration layer for the blackboard.
pub struct TreeSitterIntegration {
    #[allow(dead_code)]
    store: Arc<BlackboardStore>,
}

impl TreeSitterIntegration {
    pub fn new(store: Arc<BlackboardStore>) -> Self {
        Self { store }
    }

    /// Compute AST hash for a file's content.
    /// Returns the hash string, or empty string if the language is unsupported.
    pub fn compute_ast_hash(&self, code: &str, language: &str) -> String {
        match compute_ast_hash(code, language) {
            Ok(hash) => hash,
            Err(e) => {
                warn!(error = %e, language = language, "AST hash computation failed, falling back to content hash");
                // Fallback: simple content hash
                use std::collections::hash_map::DefaultHasher;
                use std::hash::{Hash, Hasher};
                let mut hasher = DefaultHasher::new();
                code.hash(&mut hasher);
                format!("{:016x}", hasher.finish())
            }
        }
    }

    /// Validate syntax of code before stable submission.
    /// Returns None if valid, Some(error_message) if invalid.
    pub fn validate_syntax(
        &self,
        code: &str,
        language: &str,
        skip_syntax_check: bool,
    ) -> Option<String> {
        if skip_syntax_check {
            return None;
        }
        // G12: explicitly skip languages without an enabled tree-sitter grammar
        // (e.g. markdown/yaml/json) instead of relying on the Err→None fallthrough,
        // which produced misleading "Syntax validation failed" warnings.
        if !ast_engine::is_language_enabled(language) {
            return None;
        }
        match ast_engine::structural_diff::validate_syntax(code, language) {
            Ok(result) => result,
            Err(e) => {
                warn!(error = %e, "Syntax validation failed, allowing submission");
                None
            }
        }
    }

    /// Generate a structural diff between old and new file versions.
    /// Returns a StructuredChangeList for change notifications.
    pub fn generate_structural_diff(
        &self,
        file_path: &str,
        old_code: &str,
        new_code: &str,
        language: &str,
        agent_id: &str,
    ) -> StructuredChangeList {
        match ast_engine::generate_structural_diff(file_path, old_code, new_code, language, agent_id) {
            Ok(diff) => diff,
            Err(e) => {
                warn!(error = %e, "Structural diff generation failed, returning empty");
                StructuredChangeList {
                    file: file_path.to_string(),
                    agent_id: agent_id.to_string(),
                    changes: vec![],
                }
            }
        }
    }

    /// Detect renames between old and new export lists.
    /// Returns a list of (old_name, new_name) pairs.
    pub fn detect_renames(
        &self,
        old_exports: &[String],
        new_exports: &[String],
        already_renamed: &[String],
    ) -> Vec<(String, String)> {
        ast_engine::detect_renames(old_exports, new_exports, already_renamed)
    }

    /// Compress context for LLM based on the scenario.
    pub fn compress_context(
        &self,
        code: &str,
        language: &str,
        scenario: CompressionScenario,
        focus_symbols: Option<&[String]>,
    ) -> Result<String> {
        ast_engine::compress_context(code, language, scenario, focus_symbols)
    }

    /// Extract export signatures from a file.
    pub fn extract_export_signatures(&self, code: &str, language: &str) -> Vec<(String, String)> {
        match ast_engine::structural_diff::extract_export_signatures(code, language) {
            Ok(sigs) => sigs,
            Err(e) => {
                warn!(error = %e, "Export signature extraction failed");
                vec![]
            }
        }
    }

    /// Check intent consistency between declared intent and actual changes.
    pub fn check_intent_consistency(
        &self,
        old_code: &str,
        new_code: &str,
        language: &str,
        declared_files: &[String],
    ) -> Vec<String> {
        match ast_engine::structural_diff::check_intent_consistency(old_code, new_code, language, declared_files) {
            Ok(inconsistencies) => inconsistencies,
            Err(e) => {
                warn!(error = %e, "Intent consistency check failed");
                vec![]
            }
        }
    }

    /// Detect language from file extension.
    pub fn detect_language(&self, filename: &str) -> Option<String> {
        ast_engine::detect_language(filename)
    }

    /// Full submission validation pipeline.
    /// Runs: syntax check → intent consistency check → export signature extraction.
    pub fn validate_submission(
        &self,
        old_code: &str,
        new_code: &str,
        language: &str,
        declared_files: &[String],
        skip_syntax_check: bool,
    ) -> SubmissionValidationResult {
        // Step 1: Syntax validation
        let syntax_error = self.validate_syntax(new_code, language, skip_syntax_check);

        // Step 2: Intent consistency check
        let inconsistencies = if syntax_error.is_none() {
            self.check_intent_consistency(old_code, new_code, language, declared_files)
        } else {
            vec![] // Skip intent check if syntax is broken
        };

        // Step 3: Compute AST hash
        let ast_hash = self.compute_ast_hash(new_code, language);

        // Step 4: Extract export signatures
        let exports = self.extract_export_signatures(new_code, language);

        SubmissionValidationResult {
            syntax_error,
            inconsistencies,
            ast_hash,
            exports,
        }
    }
}

/// Result of full submission validation.
#[derive(Clone, Debug)]
pub struct SubmissionValidationResult {
    pub syntax_error: Option<String>,
    pub inconsistencies: Vec<String>,
    pub ast_hash: String,
    pub exports: Vec<(String, String)>,
}

impl SubmissionValidationResult {
    /// Is the submission valid (no syntax errors)?
    pub fn is_valid(&self) -> bool {
        self.syntax_error.is_none()
    }

    /// Are there any issues to report?
    pub fn has_issues(&self) -> bool {
        self.syntax_error.is_some() || !self.inconsistencies.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::TreeSitterIntegration;
    use blackboard_store::BlackboardStore;
    use std::sync::Arc;

    fn ts() -> TreeSitterIntegration {
        TreeSitterIntegration::new(Arc::new(
            BlackboardStore::open_in_memory("ts-test").unwrap(),
        ))
    }

    #[test]
    fn validate_syntax_skip_flag_bypasses_gate() {
        // skip_syntax_check = true => even invalid code is allowed (expert escape hatch)
        assert_eq!(ts().validate_syntax("fn main( {", "rust", true), None);
    }

    #[test]
    fn validate_syntax_skips_unsupported_language_g12() {
        // Languages without a tree-sitter grammar must be allowed (no misleading warn)
        assert_eq!(ts().validate_syntax("# title\n\nbody", "markdown", false), None);
    }
}
