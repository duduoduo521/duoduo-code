//! code-search crate for DuoDuo smart layer.
//!
//! Provides in-memory code search with symbol extraction, file indexing,
//! and cross-file symbol search. Delegates AST analysis to `ast-engine`.

pub mod index;

pub use index::CodeSearch;
