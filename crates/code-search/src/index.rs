//! Code search index module — in-memory symbol and file index.
//!
//! Phase 1 uses a `Vec<FileIndex>` guarded by a `Mutex` for storage.
//! Symbol extraction delegates to `ast-engine` regex-based analysis.

use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::Mutex;

use anyhow::Result;
use ast_engine::{analyze, detect_language};
use duo_types::{FileIndex, Symbol, SymbolKind};
use regex::Regex;
use security_design::sanitize::is_sensitive_path;

// ─── Cached regex patterns (compiled once, reused forever) ────────────────

// Rust patterns
static RUST_STRUCT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^(?:pub\s+)?struct\s+(\w+)").expect("invariant: static regex pattern is valid")
});
static RUST_ENUM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^(?:pub\s+)?enum\s+(\w+)").expect("invariant: static regex pattern is valid")
});
static RUST_TRAIT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^(?:pub\s+)?trait\s+(\w+)").expect("invariant: static regex pattern is valid")
});
static RUST_MOD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^(?:pub\s+)?mod\s+(\w+)").expect("invariant: static regex pattern is valid")
});
static RUST_CONST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^(?:pub\s+)?const\s+(\w+)").expect("invariant: static regex pattern is valid")
});

// TypeScript patterns
static TS_CLASS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)").expect("invariant: static regex pattern is valid")
});
static TS_INTERFACE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^(?:export\s+)?interface\s+(\w+)").expect("invariant: static regex pattern is valid")
});
static TS_ENUM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^(?:export\s+)?enum\s+(\w+)").expect("invariant: static regex pattern is valid")
});
static TS_NAMESPACE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^(?:export\s+)?namespace\s+(\w+)").expect("invariant: static regex pattern is valid")
});
static TS_CONST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^(?:export\s+)?const\s+(\w+)\s*=").expect("invariant: static regex pattern is valid")
});

// Python patterns
static PY_CLASS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^class\s+(\w+)").expect("invariant: static regex pattern is valid")
});
static PY_CONST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^([A-Z][A-Z0-9_]*)\s*=").expect("invariant: static regex pattern is valid")
});

pub(super) struct Inner {
    pub(super) files: Vec<FileIndex>,
    /// Path → index in `files` for O(1) lookup
    pub(super) path_index: HashMap<String, usize>,
}

/// In-memory code search engine.
///
/// Indexes source files and provides symbol search, file search, and
/// per-file symbol lookup capabilities.
pub struct CodeSearch {
    inner: Mutex<Inner>,
}

impl CodeSearch {
    /// Create a new empty `CodeSearch`.
    pub fn new() -> Result<Self> {
        Ok(Self {
            inner: Mutex::new(Inner {
                files: Vec::new(),
                path_index: HashMap::new(),
            }),
        })
    }

    /// Index a file — parse source code and extract symbols.
    ///
    /// If `language` is empty, attempts auto-detection from the file path.
    /// Uses `ast_engine::analyze` for function extraction, plus regex-based
    /// class/interface/struct extraction.
    ///
    /// If a file at the same path already exists in the index, it is replaced.
    pub fn index_file(&self, path: &str, content: &str, language: &str) -> Result<()> {
        // Security: never index project-internal sensitive files (keys, .env, db).
        if is_sensitive_path(path) {
            return Ok(());
        }

        let lang = if language.is_empty() {
            detect_language(path).unwrap_or_default()
        } else {
            language.to_string()
        };

        let mut symbols = Vec::new();

        // 1. Extract function definitions via ast-engine
        let ast_result = analyze(content, &lang);
        for func in &ast_result.functions {
            symbols.push(Symbol {
                name: func.name.clone(),
                kind: SymbolKind::Function,
                range_start: Some(func.start_line),
                range_end: Some(func.end_line),
                documentation: func.documentation.clone(),
            });
        }

        // 2. Extract structs, enums, traits, impls, interfaces, classes via regex
        symbols.extend(extract_struct_like_symbols(content, &lang));

        // 3. Extract constants
        symbols.extend(extract_constants(content, &lang));

        let now = chrono::Utc::now().to_rfc3339();

        let file_index = FileIndex {
            path: path.to_string(),
            language: lang,
            last_modified: now,
            symbols,
        };

        let mut inner = self.inner.lock().map_err(|e| {
            anyhow::anyhow!("failed to acquire inner lock: {e}")
        })?;

        // Upsert: replace if path already exists
        if let Some(&pos) = inner.path_index.get(path) {
            inner.files[pos] = file_index;
        } else {
            let len = inner.files.len();
            inner.path_index.insert(path.to_string(), len);
            inner.files.push(file_index);
        }

        Ok(())
    }

    /// Search symbols across all indexed files.
    ///
    /// Performs case-insensitive substring matching on symbol names.
    /// Returns up to `limit` results sorted by symbol name.
    pub fn search_symbols(&self, query: &str, limit: usize) -> Result<Vec<Symbol>> {
        let inner = self.inner.lock().map_err(|e| {
            anyhow::anyhow!("failed to acquire inner lock: {e}")
        })?;

        let query_lower = query.to_lowercase();
        // [R-05] Collect all matches first, then sort by name, then truncate.
        // Truncating before sorting would cap the result to the first `limit`
        // matches in iteration order and could drop alphabetically-earlier names.
        let mut results: Vec<Symbol> = inner
            .files
            .iter()
            .flat_map(|f| f.symbols.iter())
            .filter(|s| s.name.to_lowercase().contains(&query_lower))
            .cloned()
            .collect();

        // Sort by name for deterministic output
        results.sort_by(|a, b| a.name.cmp(&b.name));
        results.truncate(limit);
        Ok(results)
    }

    /// Search files by path or language filter.
    ///
    /// Performs case-insensitive substring matching on both `path` and `language`.
    /// A file matches if its path OR language contains the query string.
    /// Returns up to `limit` results.
    pub fn search_files(&self, query: &str, limit: usize) -> Result<Vec<FileIndex>> {
        let inner = self.inner.lock().map_err(|e| {
            anyhow::anyhow!("failed to acquire inner lock: {e}")
        })?;

        let query_lower = query.to_lowercase();
        let results: Vec<FileIndex> = inner
            .files
            .iter()
            .filter(|f| {
                f.path.to_lowercase().contains(&query_lower)
                    || f.language.to_lowercase().contains(&query_lower)
            })
            .take(limit)
            .cloned()
            .collect();

        Ok(results)
    }

    /// Get all symbols for a specific file path.
    ///
    /// Returns an empty vec if the file is not indexed.
    pub fn get_file_symbols(&self, path: &str) -> Result<Vec<Symbol>> {
        let inner = self.inner.lock().map_err(|e| {
            anyhow::anyhow!("failed to acquire inner lock: {e}")
        })?;

        let symbols = inner
            .path_index
            .get(path)
            .and_then(|&idx| inner.files.get(idx))
            .map(|f| f.symbols.clone())
            .unwrap_or_default();

        Ok(symbols)
    }

    /// Return the number of indexed files.
    pub fn file_count(&self) -> Result<usize> {
        let inner = self.inner.lock().map_err(|e| {
            anyhow::anyhow!("failed to acquire inner lock: {e}")
        })?;
        Ok(inner.files.len())
    }

    /// Return the total number of indexed symbols across all files.
    pub fn symbol_count(&self) -> Result<usize> {
        let inner = self.inner.lock().map_err(|e| {
            anyhow::anyhow!("failed to acquire inner lock: {e}")
        })?;
        Ok(inner.files.iter().map(|f| f.symbols.len()).sum())
    }

    /// Remove a file from the index by path.
    ///
    /// Returns `true` if the file existed and was removed.
    pub fn remove_file(&self, path: &str) -> Result<bool> {
        let mut inner = self.inner.lock().map_err(|e| {
            anyhow::anyhow!("failed to acquire inner lock: {e}")
        })?;

        if let Some(idx) = inner.path_index.remove(path) {
            inner.files.remove(idx);
            // Rebuild path_index after removal (indices shifted)
            inner.path_index = inner
                .files
                .iter()
                .enumerate()
                .map(|(i, f)| (f.path.clone(), i))
                .collect();
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

impl Default for CodeSearch {
    fn default() -> Self {
        Self::new().expect("Failed to initialize code-search")
    }
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/// Extract struct/enum/trait/impl/interface/class definitions via cached regex.
fn extract_struct_like_symbols(code: &str, language: &str) -> Vec<Symbol> {
    let mut symbols = Vec::new();

    match language {
        "rust" => {
            extract_with_regex(&RUST_STRUCT_RE, code, SymbolKind::Struct, &mut symbols);
            extract_with_regex(&RUST_ENUM_RE, code, SymbolKind::Enum, &mut symbols);
            extract_with_regex(&RUST_TRAIT_RE, code, SymbolKind::Trait, &mut symbols);
            extract_with_regex(&RUST_MOD_RE, code, SymbolKind::Module, &mut symbols);
        }
        "typescript" | "javascript" | "ts" | "js" => {
            extract_with_regex(&TS_CLASS_RE, code, SymbolKind::Class, &mut symbols);
            extract_with_regex(&TS_INTERFACE_RE, code, SymbolKind::Interface, &mut symbols);
            extract_with_regex(&TS_ENUM_RE, code, SymbolKind::Enum, &mut symbols);
            extract_with_regex(&TS_NAMESPACE_RE, code, SymbolKind::Namespace, &mut symbols);
        }
        "python" | "py" => {
            extract_with_regex(&PY_CLASS_RE, code, SymbolKind::Class, &mut symbols);
        }
        _ => {}
    }

    symbols
}

/// Helper to extract symbols from a cached regex and push into a vec.
fn extract_with_regex(re: &Regex, code: &str, kind: SymbolKind, symbols: &mut Vec<Symbol>) {
    for cap in re.captures_iter(code) {
        if let Some(name_match) = cap.get(1) {
            let start_line = code[..name_match.start()].lines().count() + 1;
            symbols.push(Symbol {
                name: name_match.as_str().to_string(),
                kind: kind.clone(),
                range_start: Some(start_line),
                range_end: None,
                documentation: None,
            });
        }
    }
}

/// Extract constant definitions via cached regex.
fn extract_constants(code: &str, language: &str) -> Vec<Symbol> {
    let re: &Regex = match language {
        "rust" => &RUST_CONST_RE,
        "typescript" | "javascript" | "ts" | "js" => &TS_CONST_RE,
        "python" | "py" => &PY_CONST_RE,
        _ => return Vec::new(),
    };

    re.captures_iter(code)
        .filter_map(|cap| {
            cap.get(1).map(|name_match| {
                let start_line = code[..name_match.start()].lines().count() + 1;
                Symbol {
                    name: name_match.as_str().to_string(),
                    kind: SymbolKind::Constant,
                    range_start: Some(start_line),
                    range_end: None,
                    documentation: None,
                }
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_store_is_empty() {
        let cs = CodeSearch::new().unwrap();
        assert_eq!(cs.file_count().unwrap(), 0);
        assert_eq!(cs.symbol_count().unwrap(), 0);
    }

    #[test]
    fn index_rust_file() {
        let cs = CodeSearch::new().unwrap();
        let code = r#"
use std::io;

struct Config {
    port: u16,
}

fn main() {
    println!("hello");
}

const VERSION: &str = "1.0";
"#;
        cs.index_file("src/main.rs", code, "rust").unwrap();

        assert_eq!(cs.file_count().unwrap(), 1);
        let symbols = cs.get_file_symbols("src/main.rs").unwrap();
        assert!(symbols.iter().any(|s| s.name == "main" && s.kind == SymbolKind::Function));
        assert!(symbols.iter().any(|s| s.name == "Config" && s.kind == SymbolKind::Struct));
        assert!(symbols.iter().any(|s| s.name == "VERSION" && s.kind == SymbolKind::Constant));
    }

    #[test]
    fn index_ts_file() {
        let cs = CodeSearch::new().unwrap();
        let code = r#"
export interface User {
    name: string;
}

export class UserService {
    getData() {}
}

export function greet(name: string) {}
"#;
        cs.index_file("src/user.ts", code, "typescript").unwrap();

        let symbols = cs.get_file_symbols("src/user.ts").unwrap();
        assert!(symbols.iter().any(|s| s.name == "User" && s.kind == SymbolKind::Interface));
        assert!(symbols.iter().any(|s| s.name == "UserService" && s.kind == SymbolKind::Class));
        assert!(symbols.iter().any(|s| s.name == "greet" && s.kind == SymbolKind::Function));
    }

    #[test]
    fn index_python_file() {
        let cs = CodeSearch::new().unwrap();
        let code = r#"
class Calculator:
    def add(self, a, b):
        return a + b

MAX_VALUE = 100
"#;
        cs.index_file("calc.py", code, "python").unwrap();

        let symbols = cs.get_file_symbols("calc.py").unwrap();
        assert!(symbols.iter().any(|s| s.name == "Calculator" && s.kind == SymbolKind::Class));
        assert!(symbols.iter().any(|s| s.name == "add" && s.kind == SymbolKind::Function));
    }

    #[test]
    fn search_symbols_by_name() {
        let cs = CodeSearch::new().unwrap();
        let rust_code = "fn main() {}";
        let ts_code = "function mainHandler() {}";

        cs.index_file("main.rs", rust_code, "rust").unwrap();
        cs.index_file("app.ts", ts_code, "typescript").unwrap();

        let results = cs.search_symbols("main", 10).unwrap();
        assert!(results.len() >= 2);
    }

    #[test]
    fn search_files_by_path() {
        let cs = CodeSearch::new().unwrap();
        cs.index_file("src/main.rs", "fn main() {}", "rust").unwrap();
        cs.index_file("src/lib.rs", "fn lib() {}", "rust").unwrap();
        cs.index_file("app.ts", "function run() {}", "typescript").unwrap();

        let results = cs.search_files("src/", 10).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn search_files_by_language() {
        let cs = CodeSearch::new().unwrap();
        cs.index_file("main.rs", "fn main() {}", "rust").unwrap();
        cs.index_file("app.ts", "function run() {}", "typescript").unwrap();

        let results = cs.search_files("rust", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "main.rs");
    }

    #[test]
    fn get_file_symbols_nonexistent() {
        let cs = CodeSearch::new().unwrap();
        let symbols = cs.get_file_symbols("nope.rs").unwrap();
        assert!(symbols.is_empty());
    }

    #[test]
    fn upsert_replaces_existing() {
        let cs = CodeSearch::new().unwrap();
        cs.index_file("main.rs", "fn old() {}", "rust").unwrap();
        cs.index_file("main.rs", "fn new() {}", "rust").unwrap();

        assert_eq!(cs.file_count().unwrap(), 1);
        let symbols = cs.get_file_symbols("main.rs").unwrap();
        assert!(symbols.iter().any(|s| s.name == "new"));
        assert!(!symbols.iter().any(|s| s.name == "old"));
    }

    #[test]
    fn remove_file() {
        let cs = CodeSearch::new().unwrap();
        cs.index_file("main.rs", "fn main() {}", "rust").unwrap();
        assert!(cs.remove_file("main.rs").unwrap());
        assert_eq!(cs.file_count().unwrap(), 0);
        assert!(!cs.remove_file("main.rs").unwrap());
    }

    #[test]
    fn auto_detect_language_from_extension() {
        let cs = CodeSearch::new().unwrap();
        cs.index_file("main.rs", "fn main() {}", "").unwrap();

        let symbols = cs.get_file_symbols("main.rs").unwrap();
        assert!(!symbols.is_empty()); // Should detect rust and extract fn main
    }

    #[test]
    fn search_symbols_respects_limit() {
        let cs = CodeSearch::new().unwrap();
        for i in 0..5 {
            cs.index_file(&format!("f{i}.rs"), &format!("fn test_{i}() {{}}"), "rust")
                .unwrap();
        }

        let results = cs.search_symbols("test", 2).unwrap();
        assert!(results.len() <= 2);
    }
}
