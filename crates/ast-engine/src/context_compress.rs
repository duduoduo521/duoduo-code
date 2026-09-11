//! Context compression for LLM.
//!
//! Reduces the amount of information fed into LLM context by extracting
//! only what's needed for the current scenario.
//!
//! 使用约束:本模块是**有损**压缩 —— `DependencyInterfaceQuery` 只保留导出签名,
//! `TaskDecomposition` 只保留符号名,两者都会丢弃函数体。因此它只能用于调用方
//! 明确只需要"接口形状"的场景(如跨 agent 依赖查询)。**禁止**用于压缩
//! `read_file` 等通用 tool_result:模型会把残缺代码当成完整代码。通用上下文
//! 裁剪请用 agent-executor 的 `preflight_compress`(带 `...[truncated]` 标记)。

use anyhow::Result;
use crate::parser::with_parser;
use crate::structural_diff::extract_export_signatures;

/// Compression scenario determines what information to keep.
#[derive(Clone, Debug, PartialEq)]
pub enum CompressionScenario {
    /// Query dependencies: only export signatures (name + params + return type)
    DependencyInterfaceQuery,
    /// Adapt to another agent's interface change: only changed symbol signatures + context
    AdaptInterfaceChange,
    /// Conflict resolution: only the conflict region + surrounding AST nodes
    ConflictRewrite,
    /// Scheduler task decomposition: only project structure summary
    TaskDecomposition,
}

/// Compress code content based on the scenario.
pub fn compress_context(
    code: &str,
    language: &str,
    scenario: CompressionScenario,
    focus_symbols: Option<&[String]>,
) -> Result<String> {
    match scenario {
        CompressionScenario::DependencyInterfaceQuery => {
            compress_to_interface(code, language)
        }
        CompressionScenario::AdaptInterfaceChange => {
            compress_to_changes(code, language, focus_symbols.unwrap_or(&[]))
        }
        CompressionScenario::ConflictRewrite => {
            // For conflict rewrite, we need the full file but marked up
            // In Phase 2, we can extract just the conflicting region
            Ok(code.to_string())
        }
        CompressionScenario::TaskDecomposition => {
            compress_to_structure_summary(code, language)
        }
    }
}

/// Compress to interface signatures only (function name + params + return type).
fn compress_to_interface(code: &str, language: &str) -> Result<String> {
    let signatures = extract_export_signatures(code, language)?;
    let mut result = String::new();
    for (_name, signature) in signatures {
        result.push_str(&format!("{}\n", signature));
    }
    if result.is_empty() {
        // Fallback: return the code as-is if we can't extract signatures
        result = code.to_string();
    }
    Ok(result)
}

/// Compress to only the changed symbols and their context.
fn compress_to_changes(code: &str, language: &str, focus_symbols: &[String]) -> Result<String> {
    if focus_symbols.is_empty() {
        return compress_to_interface(code, language);
    }

    let tree = with_parser(language, |parser| parser.parse(code, None))
        .ok_or_else(|| anyhow::anyhow!("Unsupported language: {}", language))?
        .ok_or_else(|| anyhow::anyhow!("Failed to parse code"))?;

    let mut result = String::new();
    let mut found = false;

    // Walk the tree and extract nodes matching focus symbols
    extract_matching_nodes(tree.root_node(), code, focus_symbols, &mut result, &mut found);

    if !found {
        // Fallback: return interface signatures
        return compress_to_interface(code, language);
    }

    Ok(result)
}

/// Recursively extract nodes that match focus symbols.
fn extract_matching_nodes(
    node: tree_sitter::Node,
    code: &str,
    focus_symbols: &[String],
    result: &mut String,
    found: &mut bool,
) {
    if let Some(name_node) = node.child_by_field_name("name") {
        let name = name_node.utf8_text(code.as_bytes()).unwrap_or("");
        if focus_symbols.iter().any(|s| s == name) {
            let text = node.utf8_text(code.as_bytes()).unwrap_or("");
            result.push_str(&format!("{}\n\n", text.trim()));
            *found = true;
            return; // Don't recurse into matched nodes
        }
    }

    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            extract_matching_nodes(child, code, focus_symbols, result, found);
        }
    }
}

/// Compress to a project structure summary (file list + module relationships).
fn compress_to_structure_summary(code: &str, language: &str) -> Result<String> {
    let signatures = extract_export_signatures(code, language)?;
    let mut result = String::new();
    result.push_str("// Exported symbols:\n");
    for (name, _signature) in &signatures {
        result.push_str(&format!("// - {}\n", name));
    }
    if result.is_empty() {
        result = "// (no exported symbols found)\n".to_string();
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compress_interface_query() {
        let code = "fn add(a: i32, b: i32) -> i32 { a + b }\nfn multiply(a: i32, b: i32) -> i32 { a * b }";
        let compressed = compress_context(code, "rust", CompressionScenario::DependencyInterfaceQuery, None).unwrap();
        assert!(compressed.len() <= code.len());
    }

    #[test]
    fn compress_changes_focus() {
        let code = "fn add(a: i32, b: i32) -> i32 { a + b }\nfn multiply(a: i32, b: i32) -> i32 { a * b }";
        let focus = vec!["add".to_string()];
        let compressed = compress_context(code, "rust", CompressionScenario::AdaptInterfaceChange, Some(&focus)).unwrap();
        assert!(compressed.contains("add"));
    }

    #[test]
    fn compress_structure_summary() {
        let code = "fn main() {}\nstruct Foo {}";
        let compressed = compress_context(code, "rust", CompressionScenario::TaskDecomposition, None).unwrap();
        assert!(compressed.contains("main") || compressed.contains("Foo"));
    }
}
