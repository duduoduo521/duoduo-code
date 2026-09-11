//! Structural diff generation.
//!
//! Compares two versions of a file and generates a structured change list
//! identifying which functions/classes/exports were added, removed, modified,
//! or renamed.

use crate::parser::with_parser;
use anyhow::Result;
use duo_types::*;
use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::LazyLock;

/// Symbol information extracted from a file's AST.
#[derive(Clone, Debug)]
#[allow(dead_code)]
struct SymbolInfo {
    name: String,
    kind: String, // "function", "class", "method", "variable", "import", "export"
    signature: String,
    start_line: usize,
    end_line: usize,
}

// ─── Parse result cache ───────────────────────────────────────────────────
// Avoids re-parsing identical content. Key = (language, content_hash).

type SymbolCache = std::sync::RwLock<HashMap<(String, u64), Vec<SymbolInfo>>>;

static SYMBOL_CACHE: LazyLock<SymbolCache> = LazyLock::new(|| SymbolCache::new(HashMap::new()));

/// Compute a lightweight hash of source code content for cache keying.
fn content_hash(code: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    code.hash(&mut hasher);
    hasher.finish()
}

/// Generate a structural diff between old and new versions of a file.
pub fn generate_structural_diff(
    file_path: &str,
    old_code: &str,
    new_code: &str,
    language: &str,
    agent_id: &str,
) -> Result<StructuredChangeList> {
    // Check if language is enabled at compile time
    if !crate::is_language_enabled(language) {
        // Fallback: return empty change list (no structural analysis available)
        return Ok(StructuredChangeList {
            file: file_path.to_string(),
            agent_id: agent_id.to_string(),
            changes: vec![],
        });
    }

    let old_symbols = extract_symbols(old_code, language)?;
    let new_symbols = extract_symbols(new_code, language)?;

    let mut changes = Vec::new();
    let mut old_map: HashMap<&str, &SymbolInfo> = HashMap::new();
    let mut new_map: HashMap<&str, &SymbolInfo> = HashMap::new();

    for s in &old_symbols {
        old_map.insert(&s.name, s);
    }
    for s in &new_symbols {
        new_map.insert(&s.name, s);
    }

    // Detect removed symbols
    for (name, old_sym) in &old_map {
        if !new_map.contains_key(name) {
            changes.push(FileChangeEntry {
                symbol_name: (*name).to_string(),
                change_kind: SymbolChangeKind::Removed,
                old_signature: Some(old_sym.signature.clone()),
                new_signature: None,
            });
        }
    }

    // Detect added symbols
    for (name, new_sym) in &new_map {
        if !old_map.contains_key(name) {
            changes.push(FileChangeEntry {
                symbol_name: (*name).to_string(),
                change_kind: SymbolChangeKind::Added,
                old_signature: None,
                new_signature: Some(new_sym.signature.clone()),
            });
        }
    }

    // Detect modified symbols (same name, different signature)
    for (name, new_sym) in &new_map {
        if let Some(old_sym) = old_map.get(name)
            && old_sym.signature != new_sym.signature {
                changes.push(FileChangeEntry {
                    symbol_name: (*name).to_string(),
                    change_kind: SymbolChangeKind::Modified,
                    old_signature: Some(old_sym.signature.clone()),
                    new_signature: Some(new_sym.signature.clone()),
                });
            }
    }

    Ok(StructuredChangeList {
        file: file_path.to_string(),
        agent_id: agent_id.to_string(),
        changes,
    })
}

/// Extract all exported/importable symbols from a file.
pub fn extract_export_signatures(code: &str, language: &str) -> Result<Vec<(String, String)>> {
    let symbols = extract_symbols(code, language)?;
    Ok(symbols
        .iter()
        .map(|s| (s.name.clone(), s.signature.clone()))
        .collect())
}

/// Extract symbols from a source file using tree-sitter, with caching.
///
/// If the same `(language, code)` pair was parsed before, returns the cached
/// result instead of re-parsing.
fn extract_symbols(code: &str, language: &str) -> Result<Vec<SymbolInfo>> {
    let hash = content_hash(code);
    let key = (language.to_string(), hash);

    // Fast path: check read-locked cache
    {
        let cache = duo_utils::sync::read(&SYMBOL_CACHE);
        if let Some(symbols) = cache.get(&key) {
            return Ok(symbols.clone());
        }
    }

    // Cache miss — parse using cached Parser
    let tree = with_parser(language, |parser| parser.parse(code, None))
        .ok_or_else(|| anyhow::anyhow!("Unsupported language: {}", language))?
        .ok_or_else(|| anyhow::anyhow!("Failed to parse code"))?;

    let mut symbols = Vec::new();
    collect_symbols(tree.root_node(), code, &mut symbols);

    // Store in cache
    {
        let mut cache = duo_utils::sync::write(&SYMBOL_CACHE);
        cache.insert(key, symbols.clone());
    }

    Ok(symbols)
}

/// Collect symbols from a tree-sitter node recursively.
fn collect_symbols(node: tree_sitter::Node, code: &str, symbols: &mut Vec<SymbolInfo>) {
    match node.kind() {
        // Rust + Python ("function_definition" is Python's def node)
        "function_item" => {
            // Rust fn
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = name_node
                    .utf8_text(code.as_bytes())
                    .unwrap_or("")
                    .to_string();
                let signature = extract_signature(&node, code);
                symbols.push(SymbolInfo {
                    name,
                    kind: "function".to_string(),
                    signature,
                    start_line: node.start_position().row + 1,
                    end_line: node.end_position().row + 1,
                });
            }
        }
        "struct_item" | "struct_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = name_node
                    .utf8_text(code.as_bytes())
                    .unwrap_or("")
                    .to_string();
                symbols.push(SymbolInfo {
                    name: name.clone(),
                    kind: "struct".to_string(),
                    signature: format!("struct {}", name),
                    start_line: node.start_position().row + 1,
                    end_line: node.end_position().row + 1,
                });
            }
        }
        "enum_item" | "enum_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = name_node
                    .utf8_text(code.as_bytes())
                    .unwrap_or("")
                    .to_string();
                symbols.push(SymbolInfo {
                    name: name.clone(),
                    kind: "enum".to_string(),
                    signature: format!("enum {}", name),
                    start_line: node.start_position().row + 1,
                    end_line: node.end_position().row + 1,
                });
            }
        }
        "impl_item" => {
            // Rust impl block - extract trait/type name
            if let Some(type_node) = node.child_by_field_name("type") {
                let name = type_node
                    .utf8_text(code.as_bytes())
                    .unwrap_or("")
                    .to_string();
                symbols.push(SymbolInfo {
                    name: name.clone(),
                    kind: "impl".to_string(),
                    signature: format!("impl {}", name),
                    start_line: node.start_position().row + 1,
                    end_line: node.end_position().row + 1,
                });
            }
        }
        "trait_item" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = name_node
                    .utf8_text(code.as_bytes())
                    .unwrap_or("")
                    .to_string();
                symbols.push(SymbolInfo {
                    name: name.clone(),
                    kind: "trait".to_string(),
                    signature: format!("trait {}", name),
                    start_line: node.start_position().row + 1,
                    end_line: node.end_position().row + 1,
                });
            }
        }
        // TypeScript
        "class_declaration" | "class" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = name_node
                    .utf8_text(code.as_bytes())
                    .unwrap_or("")
                    .to_string();
                symbols.push(SymbolInfo {
                    name: name.clone(),
                    kind: "class".to_string(),
                    signature: format!("class {}", name),
                    start_line: node.start_position().row + 1,
                    end_line: node.end_position().row + 1,
                });
            }
        }
        "interface_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = name_node
                    .utf8_text(code.as_bytes())
                    .unwrap_or("")
                    .to_string();
                symbols.push(SymbolInfo {
                    name: name.clone(),
                    kind: "interface".to_string(),
                    signature: format!("interface {}", name),
                    start_line: node.start_position().row + 1,
                    end_line: node.end_position().row + 1,
                });
            }
        }
        "type_alias_declaration" | "type_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = name_node
                    .utf8_text(code.as_bytes())
                    .unwrap_or("")
                    .to_string();
                symbols.push(SymbolInfo {
                    name: name.clone(),
                    kind: "type".to_string(),
                    signature: format!("type {}", name),
                    start_line: node.start_position().row + 1,
                    end_line: node.end_position().row + 1,
                });
            }
        }
        // Go
        "method_definition" | "method_declaration" => {
            // TS/JS methods inside classes
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = name_node
                    .utf8_text(code.as_bytes())
                    .unwrap_or("")
                    .to_string();
                let signature = extract_signature(&node, code);
                symbols.push(SymbolInfo {
                    name,
                    kind: "method".to_string(),
                    signature,
                    start_line: node.start_position().row + 1,
                    end_line: node.end_position().row + 1,
                });
            }
        }
        // Python
        "function_definition" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = name_node
                    .utf8_text(code.as_bytes())
                    .unwrap_or("")
                    .to_string();
                let signature = extract_signature(&node, code);
                symbols.push(SymbolInfo {
                    name,
                    kind: "function".to_string(),
                    signature,
                    start_line: node.start_position().row + 1,
                    end_line: node.end_position().row + 1,
                });
            }
        }
        "class_definition" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = name_node
                    .utf8_text(code.as_bytes())
                    .unwrap_or("")
                    .to_string();
                symbols.push(SymbolInfo {
                    name: name.clone(),
                    kind: "class".to_string(),
                    signature: format!("class {}", name),
                    start_line: node.start_position().row + 1,
                    end_line: node.end_position().row + 1,
                });
            }
        }
        "function_declaration" => {
            // TS/JS standalone function declarations + Go function declarations
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = name_node
                    .utf8_text(code.as_bytes())
                    .unwrap_or("")
                    .to_string();
                let signature = extract_signature(&node, code);
                symbols.push(SymbolInfo {
                    name,
                    kind: "function".to_string(),
                    signature,
                    start_line: node.start_position().row + 1,
                    end_line: node.end_position().row + 1,
                });
            }
        }
        _ => {}
    }

    // Recurse into children
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            collect_symbols(child, code, symbols);
        }
    }
}

/// Extract a function/method signature from its AST node.
fn extract_signature(node: &tree_sitter::Node, code: &str) -> String {
    // Get the first line of the function as the signature
    let start = node.start_position();
    let end_byte = code
        .lines()
        .nth(start.row)
        .map(|line| {
            // Find the end of the signature (opening brace or colon)
            let line_text = line;
            if let Some(pos) = line_text.find('{') {
                code.lines()
                    .take(start.row + 1)
                    .map(|l| l.len() + 1)
                    .sum::<usize>()
                    - (line_text.len() - pos)
            } else if let Some(pos) = line_text.find(':') {
                code.lines()
                    .take(start.row + 1)
                    .map(|l| l.len() + 1)
                    .sum::<usize>()
                    - (line_text.len() - pos)
            } else {
                node.end_byte()
            }
        })
        .unwrap_or(node.end_byte());

    let sig_text = &code[node.start_byte()..end_byte.min(code.len())];
    sig_text.trim().to_string()
}

/// Validate syntax of code using tree-sitter.
pub fn validate_syntax(code: &str, language: &str) -> Result<Option<String>> {
    let tree = with_parser(language, |parser| parser.parse(code, None))
        .ok_or_else(|| anyhow::anyhow!("Unsupported language: {}", language))?
        .ok_or_else(|| anyhow::anyhow!("Failed to parse code"))?;

    let root = tree.root_node();
    if root.has_error() {
        // Find the first error node
        let error_node = find_first_error(root);
        match error_node {
            Some(node) => {
                let line = node.start_position().row + 1;
                let col = node.start_position().column + 1;
                Ok(Some(format!(
                    "Syntax error at line {}, column {}",
                    line, col
                )))
            }
            None => Ok(Some("Syntax error found".to_string())),
        }
    } else {
        Ok(None)
    }
}

/// Find the first ERROR node in the tree.
fn find_first_error(node: tree_sitter::Node) -> Option<tree_sitter::Node> {
    if node.is_error() || node.is_missing() {
        return Some(node);
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i)
            && let Some(error) = find_first_error(child) {
                return Some(error);
            }
    }
    None
}

/// Check intent consistency: does the actual modified range match the declared intent?
pub fn check_intent_consistency(
    old_code: &str,
    new_code: &str,
    language: &str,
    _declared_files: &[String],
) -> Result<Vec<String>> {
    let old_symbols = extract_symbols(old_code, language)?;
    let new_symbols = extract_symbols(new_code, language)?;

    let mut inconsistencies = Vec::new();

    // Check for new symbols not in declared scope
    let old_names: std::collections::HashSet<&str> =
        old_symbols.iter().map(|s| s.name.as_str()).collect();
    for new_sym in &new_symbols {
        if !old_names.contains(new_sym.name.as_str()) {
            // New symbol added - is the file in the declared scope?
            // This is a basic check; the full scope check is done by ScopeEnforcer
            inconsistencies.push(format!(
                "New symbol '{}' added (kind: {})",
                new_sym.name, new_sym.kind
            ));
        }
    }

    Ok(inconsistencies)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_added_function() {
        let old = "fn main() {}";
        let new = "fn main() {}\nfn helper() {}";
        let diff = generate_structural_diff("test.rs", old, new, "rust", "agent1").unwrap();
        assert_eq!(diff.changes.len(), 1);
        assert_eq!(diff.changes[0].change_kind, SymbolChangeKind::Added);
        assert_eq!(diff.changes[0].symbol_name, "helper");
    }

    #[test]
    fn detect_removed_function() {
        let old = "fn main() {}\nfn helper() {}";
        let new = "fn main() {}";
        let diff = generate_structural_diff("test.rs", old, new, "rust", "agent1").unwrap();
        assert_eq!(diff.changes.len(), 1);
        assert_eq!(diff.changes[0].change_kind, SymbolChangeKind::Removed);
        assert_eq!(diff.changes[0].symbol_name, "helper");
    }

    #[test]
    fn detect_modified_function() {
        let old = "fn main() {}";
        let new = "fn main() -> i32 { 42 }";
        let diff = generate_structural_diff("test.rs", old, new, "rust", "agent1").unwrap();
        assert_eq!(diff.changes.len(), 1);
        assert_eq!(diff.changes[0].change_kind, SymbolChangeKind::Modified);
        assert_eq!(diff.changes[0].symbol_name, "main");
    }

    #[test]
    fn no_changes_detected() {
        let code = "fn main() {}";
        let diff = generate_structural_diff("test.rs", code, code, "rust", "agent1").unwrap();
        assert!(diff.changes.is_empty());
    }

    #[test]
    fn validate_syntax_correct() {
        let code = "fn main() {}";
        let result = validate_syntax(code, "rust").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn validate_syntax_error() {
        let code = "fn main( { }";
        let result = validate_syntax(code, "rust").unwrap();
        assert!(result.is_some());
    }

    #[test]
    fn typescript_diff() {
        let old = "function add(a: number, b: number) { return a + b; }";
        let new = "function add(a: number, b: number): number { return a + b; }\nfunction sub(a: number, b: number) { return a - b; }";
        let diff = generate_structural_diff("test.ts", old, new, "typescript", "agent1").unwrap();
        assert!(!diff.changes.is_empty());
    }

    #[test]
    fn extract_export_signatures_ts() {
        let code = "function add(a: number, b: number): number { return a + b; }";
        let sigs = extract_export_signatures(code, "typescript").unwrap();
        assert_eq!(sigs.len(), 1);
        assert_eq!(sigs[0].0, "add");
    }

    #[test]
    fn extract_symbols_cache_hit() {
        let code = "fn main() {}";
        // First call populates cache
        let s1 = extract_symbols(code, "rust").unwrap();
        // Second call should hit cache
        let s2 = extract_symbols(code, "rust").unwrap();
        assert_eq!(s1.len(), s2.len());
        assert_eq!(s1[0].name, s2[0].name);
    }
}
