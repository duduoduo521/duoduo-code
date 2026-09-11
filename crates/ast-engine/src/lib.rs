//! AST engine with tree-sitter support.
//!
//! Provides precise AST analysis capabilities:
//! - Function/class/import/export extraction via tree-sitter
//! - AST hash computation (semantic structure hash, ignoring whitespace/comments)
//! - Structural diff generation (function-level change detection)
//! - Rename detection (anchor migration)
//! - Export signature extraction
//! - Dependency graph construction from imports
//! - Syntax validation
//! - Intent consistency verification

pub mod analysis;
pub mod parser;
pub mod ast_hash;
pub mod structural_diff;
pub mod rename_detector;
pub mod context_compress;
pub mod control_flow;

// Re-export Phase 1 compatible API
pub use analysis::{analyze, count_complexity, extract_functions, extract_imports};
pub use parser::{detect_language, AstEngine, with_parser};
pub use ast_hash::compute_ast_hash;
pub use structural_diff::generate_structural_diff;
pub use rename_detector::detect_renames;
pub use context_compress::{compress_context, CompressionScenario};
pub use control_flow::{control_flow_skeleton, skeleton_from_node};

/// Returns the list of language names this engine can process via tree-sitter.
///
/// Every entry has a 0.24-compatible `tree-sitter-*` grammar crate compiled into
/// the binary (no feature gating). All of these (including the extra languages
/// added via the `tree-sitter-language ^0.1` abstraction layer) are verified
/// ABI 13/14 by the `all_enabled_languages_abi_compatible_with_024` test, so they
/// load on the shared tree-sitter 0.24.5 runtime.
pub fn enabled_languages() -> Vec<&'static str> {
    vec![
        "rust", "typescript", "javascript", "python", "go", "java", "c", "cpp",
        "csharp", "ruby", "scala", "php", "lua", "dart", "elixir", "yaml",
        "json", "html", "css", "shell", "haskell", "nix", "ocaml", "pascal",
        "powershell", "r", "fortran", "solidity", "xml", "cmake", "fish",
        "julia", "kotlin", "zig", "sql", "toml", "svelte", "clojure",
        "erlang", "ada", "dockerfile",
    ]
}

/// Returns `true` if the given language name is enabled at compile time.
pub fn is_language_enabled(language: &str) -> bool {
    enabled_languages().contains(&language)
}
