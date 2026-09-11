//! AST hash computation.
//!
//! Computes a deterministic hash of a file's AST structure,
//! ignoring whitespace, comments, and formatting differences.
//! Two files that differ only in formatting/comments will produce the same hash.

use crate::parser::with_parser;
use anyhow::Result;
use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::LazyLock;
use tree_sitter::Node;

// ─── AST hash cache ───────────────────────────────────────────────────────
// Avoids re-parsing identical content. Key = (language, content_hash).

static HASH_CACHE: LazyLock<std::sync::RwLock<HashMap<(String, u64), String>>> =
    LazyLock::new(|| std::sync::RwLock::new(HashMap::new()));

/// Compute a lightweight hash of source code content for cache keying.
fn content_hash(code: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    code.hash(&mut hasher);
    hasher.finish()
}

/// Compute the AST hash for a source file.
///
/// The hash is based on the semantic structure of the code:
/// - Function declarations, class definitions, imports, exports
/// - Control flow structures
/// - Type annotations
///
/// Ignored (not included in hash):
/// - Whitespace, comments, formatting
/// - String literal values
/// - Numeric literal values
///
/// Results are cached by `(language, content_hash)` — identical code
/// will return the cached hash without re-parsing.
pub fn compute_ast_hash(code: &str, language: &str) -> Result<String> {
    // Check if language is enabled at compile time
    if !crate::is_language_enabled(language) {
        // Fallback: use content hash instead of AST hash
        return Ok(fallback_content_hash(code));
    }

    let hash = content_hash(code);
    let key = (language.to_string(), hash);

    // Fast path: check read-locked cache
    {
        let cache = duo_utils::sync::read(&HASH_CACHE);
        if let Some(cached) = cache.get(&key) {
            return Ok(cached.clone());
        }
    }

    // Cache miss — parse using cached Parser
    let tree = with_parser(language, |parser| parser.parse(code, None))
        .ok_or_else(|| anyhow::anyhow!("Unsupported language: {}", language))?
        .ok_or_else(|| anyhow::anyhow!("Failed to parse code"))?;

    let mut hasher = DefaultHasher::new();
    hash_node(tree.root_node(), &mut hasher);

    let result = format!("{:016x}", hasher.finish());

    // Store in cache
    {
        let mut cache = duo_utils::sync::write(&HASH_CACHE);
        cache.insert(key, result.clone());
    }

    Ok(result)
}

/// Recursively hash a tree-sitter node and its semantic children.
fn hash_node(node: Node, hasher: &mut impl Hasher) {
    let kind = node.kind();
    let child_count = node.child_count();

    // Skip non-semantic node types
    if should_skip_node(kind) {
        return;
    }

    // Hash the node kind
    kind.hash(hasher);

    // For certain node types, also hash the text content (identifiers, types)
    if is_identifier_node(kind) {
        // We don't hash the actual text to avoid trivial changes affecting the hash
        // Instead, hash the kind + presence
        "identifier_present".hash(hasher);
    }

    // Recursively hash children
    for i in 0..child_count {
        if let Some(child) = node.child(i) {
            hash_node(child, hasher);
        }
    }
}

/// Determine if a node type should be skipped (non-semantic).
fn should_skip_node(kind: &str) -> bool {
    matches!(
        kind,
        // Whitespace and formatting
        " " | "\n" | "\t" | "\r" |
        // Comments
        "comment" | "line_comment" | "block_comment" | "doc_comment" |
        // Punctuation that doesn't affect semantics
        ";" | "," | "(" | ")" | "{" | "}" | "[" | "]" |
        // Formatting-only nodes
        "optional_comma"
    )
}

/// Determine if a node represents an identifier that contributes to semantics.
fn is_identifier_node(kind: &str) -> bool {
    matches!(
        kind,
        "identifier"
            | "type_identifier"
            | "property_identifier"
            | "field_identifier"
            | "function_name"
            | "name"
    )
}

/// Fallback hash using raw content when AST parsing is unavailable.
/// Uses the same hasher and format as the AST hash for consistency.
fn fallback_content_hash(content: &str) -> String {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_code_same_hash() {
        let code = "fn main() { println!(\"hello\"); }";
        let h1 = compute_ast_hash(code, "rust").unwrap();
        let h2 = compute_ast_hash(code, "rust").unwrap();
        assert_eq!(h1, h2);
    }

    #[test]
    fn formatting_change_same_hash() {
        let code1 = "fn main(){println!(\"hello\");}";
        let code2 = "fn main() {\n    println!(\"hello\");\n}\n";
        let h1 = compute_ast_hash(code1, "rust").unwrap();
        let h2 = compute_ast_hash(code2, "rust").unwrap();
        assert_eq!(h1, h2, "Formatting changes should not affect AST hash");
    }

    #[test]
    fn comment_change_same_hash() {
        let code1 = "fn main() { println!(\"hello\"); }";
        let code2 = "// A comment\nfn main() { println!(\"hello\"); }";
        let h1 = compute_ast_hash(code1, "rust").unwrap();
        let h2 = compute_ast_hash(code2, "rust").unwrap();
        assert_eq!(h1, h2, "Comments should not affect AST hash");
    }

    #[test]
    fn semantic_change_different_hash() {
        let code1 = "fn main() { println!(\"hello\"); }";
        let code2 = "fn main() { println!(\"world\"); }\nfn foo() {}";
        let h1 = compute_ast_hash(code1, "rust").unwrap();
        let h2 = compute_ast_hash(code2, "rust").unwrap();
        assert_ne!(h1, h2, "Semantic changes should produce different hashes");
    }

    #[test]
    fn typescript_hash_stable() {
        let code = "function add(a: number, b: number): number { return a + b; }";
        let h1 = compute_ast_hash(code, "typescript").unwrap();
        let h2 = compute_ast_hash(code, "typescript").unwrap();
        assert_eq!(h1, h2);
    }

    #[test]
    fn python_hash_stable() {
        let code = "def hello():\n    print('hello')";
        let h1 = compute_ast_hash(code, "python").unwrap();
        let h2 = compute_ast_hash(code, "python").unwrap();
        assert_eq!(h1, h2);
    }

    #[test]
    fn hash_cache_hit() {
        let code = "fn main() {}";
        let h1 = compute_ast_hash(code, "rust").unwrap();
        let h2 = compute_ast_hash(code, "rust").unwrap();
        assert_eq!(h1, h2);
        // Verify cache actually has an entry
        let cache = duo_utils::sync::read(&HASH_CACHE);
        let key = ("rust".to_string(), content_hash(code));
        assert!(cache.contains_key(&key));
    }
}
