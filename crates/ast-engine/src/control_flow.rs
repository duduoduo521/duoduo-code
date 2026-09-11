//! Control-flow skeleton extraction.
//!
//! Produces a *lossy* summary of a function body: the control-flow backbone
//! (conditionals / loops / match / try) plus the names of called functions,
//! indented to reflect nesting. It deliberately omits expressions, literals,
//! and most statements — the goal is to let an LLM judge whether two functions
//! are *isomorphic flows* ("check VIP → query rate → multiply") without
//! reading the full source.
//!
//! This is **preview-only**. It must never be used as the basis for editing a
//! real file; the LLM is expected to `read_file` the actual implementation
//! before modifying anything.
//!
//! Two paths:
//! - tree-sitter enabled languages: walk the AST, emitting control-flow nodes
//!   and call expressions keyed by generic node-kind substrings (language
//!   agnostic).
//! - other languages: regex keyword-line fallback.

use tree_sitter::Node;

use crate::parser::{detect_language, with_parser};

/// Node-kind substrings that denote a control-flow branch.
/// Matched case-insensitively against `node.kind()`.
const CONTROL_KINDS: &[(&str, &str)] = &[
    ("if_statement", "if"),
    ("if_expression", "if"),
    ("else_clause", "else"),
    ("else_if_clause", "else if"),
    ("for_statement", "for"),
    ("for_expression", "for"),
    ("while_statement", "while"),
    ("while_expression", "while"),
    ("loop_statement", "loop"),
    ("loop_expression", "loop"),
    ("match_expression", "match"),
    ("match_statement", "match"),
    ("match_arm", "case"),
    ("match_pattern", "case"),
    ("switch_statement", "switch"),
    ("case_statement", "case"),
    ("try_statement", "try"),
    ("try_expression", "try"),
    ("try_block", "try"),
    ("catch_clause", "catch"),
    ("catch", "catch"),
    ("except_clause", "except"),
    ("finally_clause", "finally"),
    ("with_statement", "with"),
    ("return_statement", "return"),
    ("return_expression", "return"),
    ("throw_statement", "throw"),
    ("raise_statement", "raise"),
];

/// Node-kind substrings that denote a function/method call.
const CALL_KINDS: &[&str] = &[
    "call_expression",
    "invocation_expression",
    "call",
    "method_invocation",
];

/// Extract a control-flow skeleton directly from an already-parsed function
/// node. This is the zero-reparse fast path: callers that already hold the
/// tree-sitter tree (e.g. the KG indexer during `extract_via_ast`) pass the
/// function-definition `node` and avoid re-parsing the source.
///
/// The walk is bounded by a node budget (`SKELETON_NODE_BUDGET`) and a depth
/// cap. Skeletons are a lossy preview, so truncating an enormous function body
/// is acceptable — and crucially it prevents indexing from spending O(tree
/// size) time on every function in a large file (which previously made
/// indexing orders of magnitude slower than before skeletons were added).
///
/// Returns `None` when the node yields no control-flow signal.
pub fn skeleton_from_node(node: tree_sitter::Node, code: &str) -> Option<String> {
    let mut out = String::new();
    let mut budget = SKELETON_NODE_BUDGET;
    walk(node, 0, &mut out, code.as_bytes(), &mut budget);
    out = out.trim_end().to_string();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Max AST nodes visited while building one function's skeleton. A typical
/// function yields a handful of control-flow lines well under this; the cap
/// only bites on pathological multi-thousand-line functions, where a truncated
/// preview is fine.
const SKELETON_NODE_BUDGET: usize = 1500;
/// Max nesting depth emitted for one skeleton.
const SKELETON_MAX_DEPTH: usize = 24;

/// Extract a control-flow skeleton for the given source span.
///
/// `code` is the full file content; `start_line`/`end_line` are 1-based and
/// inclusive (matching `code_snippet_of`). Returns `None` when the span is
/// degenerate or no skeleton could be produced.
///
/// This is a self-contained fallback that re-parses the sliced source. Prefer
/// [`skeleton_from_node`] when the parsed tree is already available.
pub fn control_flow_skeleton(
    code: &str,
    language: &str,
    start_line: usize,
    end_line: usize,
) -> Option<String> {
    if start_line == 0 || end_line < start_line {
        return None;
    }
    let lang = detect_language_from_name(language)?;

    // Slice the function source for parsing.
    let start = start_line.saturating_sub(1);
    let len = end_line - start_line + 1;
    let src: Vec<&str> = code.lines().skip(start).take(len).collect();
    let source = src.join("\n");
    if source.trim().is_empty() {
        return None;
    }

    // Prefer tree-sitter; fall back to keyword lines.
    // `with_parser` returns `Option<R>` where the closure returns `Option<String>`,
    // so the result is `Option<Option<String>>`; flatten it.
    let source_owned = source.clone();
    let skeleton: Option<String> = with_parser(&lang, |parser| {
        let tree = parser.parse(&source, None)?;
        skeleton_from_node(tree.root_node(), &source)
    })
    .flatten()
    .or_else(|| keyword_fallback(&source_owned, &lang));

    skeleton.filter(|s| !s.trim().is_empty())
}

/// Map a user-facing language name (e.g. "ts", "py") to the canonical name
/// `detect_language` understands. Returns `None` for unknown languages.
fn detect_language_from_name(language: &str) -> Option<String> {
    // `detect_language` takes a filename; synthesize one.
    let ext = match language {
        "rust" | "rs" => "rs",
        "typescript" | "ts" | "tsx" => "ts",
        "javascript" | "js" | "jsx" | "mjs" | "cjs" => "js",
        "python" | "py" | "pyi" | "pyw" => "py",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" => "cpp",
        "csharp" | "c#" | "cs" => "cs",
        "ruby" | "rb" => "rb",
        "php" => "php",
        "kotlin" | "kt" | "kts" => "kt",
        "scala" => "scala",
        "lua" => "lua",
        "zig" => "zig",
        "sql" => "sql",
        "shell" | "sh" | "bash" => "sh",
        "dart" => "dart",
        "elixir" | "ex" | "exs" => "ex",
        "svelte" => "svelte",
        "clojure" | "clj" => "clj",
        "erlang" | "erl" | "hrl" => "erl",
        "ada" | "adb" | "ads" => "adb",
        "dockerfile" => "dockerfile",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "json" => "json",
        "html" | "htm" => "html",
        "css" | "scss" | "less" => "css",
        "nix" => "nix",
        "ocaml" => "ml",
        "pascal" | "pas" => "pas",
        "powershell" | "ps1" => "ps1",
        "r" => "r",
        "fortran" | "f90" | "f" => "f90",
        "solidity" | "sol" => "sol",
        "xml" => "xml",
        "cmake" => "cmake",
        "fish" => "fish",
        "julia" | "jl" => "jl",
        _ => return None,
    };
    detect_language(&format!("x.{ext}"))
}

/// Recursively walk the AST, emitting control-flow lines.
///
/// `budget` is a mutable node-visit counter shared across the whole walk; it
/// is decremented on every node visited and the walk bails out as soon as it
/// hits zero. This bounds worst-case work to `SKELETON_NODE_BUDGET` nodes per
/// function regardless of body size. `depth` is capped at
/// `SKELETON_MAX_DEPTH`.
fn walk(node: Node, depth: usize, out: &mut String, source: &[u8], budget: &mut usize) {
    // Budget / depth guard: stop emitting once exhausted. We still return
    // early so a giant body does not keep recursing for nothing.
    if *budget == 0 || depth > SKELETON_MAX_DEPTH {
        return;
    }
    *budget -= 1;

    let kind = node.kind();
    // `node.kind()` returns a `&'static str` from tree-sitter's static symbol
    // table; for standard grammars (rust/ts/py/go/java, …) it is already
    // lowercase snake_case, so we avoid a heap allocation in the common case.
    // Only fall back to `to_lowercase()` when the kind contains an uppercase
    // letter (some third-party grammars use CamelCase) so control-flow
    // detection still matches.
    let lower = if kind.bytes().any(|b| b.is_ascii_uppercase()) {
        kind.to_lowercase()
    } else {
        kind.to_string()
    };

    // Control-flow branch.
    for (substr, label) in CONTROL_KINDS {
        if lower.contains(substr) {
            // Skip bare `else`/`catch`/`finally` wrappers that just wrap a block;
            // their child `if`/`try` already carries the signal. We still emit
            // `else`/`catch` as markers so the branch structure is visible.
            let indent = "  ".repeat(depth);
            out.push_str(&indent);
            out.push_str(label);
            // For `if`/`while`/`for`/`match`/`switch`, append a short condition
            // snippet (first child that is not a block) when cheap.
            if let Some(cond) = control_condition(node, source) {
                out.push(' ');
                out.push_str(&cond);
            }
            out.push('\n');
            break;
        }
    }

    // Call expression → emit the callee name at current depth.
    if CALL_KINDS.iter().any(|k| lower.contains(k))
        && let Some(name) = call_name(node, source) {
            let indent = "  ".repeat(depth);
            out.push_str(&indent);
            out.push_str("→ ");
            out.push_str(&name);
            out.push('\n');
        }

    // Recurse; compute child depth based on whether this node is a block-like
    // container so nesting reads naturally.
    let child_depth = if is_block_like(kind, &lower) { depth + 1 } else { depth };
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk(child, child_depth, out, source, budget);
    }
}

/// A node is "block-like" if it introduces a new nesting level (a statement
/// block, function body, etc.). We treat any named child-block as increasing
/// depth so conditionals nest their bodies.
///
/// `lower` is the already-lowercased kind string (see `walk`), reused here to
/// avoid recomputing it per node.
fn is_block_like(kind: &str, lower: &str) -> bool {
    let _ = kind;
    lower.contains("block")
        || lower.contains("_body")
        || lower.contains("body")
        || CONTROL_KINDS.iter().any(|(s, _)| lower.contains(s))
}

/// Best-effort condition text for an `if`/`while`/`for`/`match` node.
fn control_condition(node: Node, source: &[u8]) -> Option<String> {
    let lower = node.kind().to_lowercase();
    let is_branch = lower.contains("if")
        || lower.contains("while")
        || lower.contains("for")
        || lower.contains("match")
        || lower.contains("switch");
    if !is_branch {
        return None;
    }
    // First named child that is not a block and not the keyword itself.
    let mut cursor = node.walk();
    let mut cond = String::new();
    for child in node.children(&mut cursor) {
        let ck = child.kind().to_lowercase();
        if ck.contains("block") || ck.contains("body") || ck == "else" {
            continue;
        }
        let text = child
            .utf8_text(source)
            .unwrap_or("")
            .trim()
            .to_string();
        if !text.is_empty() {
            cond = text;
            break;
        }
    }
    if cond.is_empty() {
        return None;
    }
    // Truncate to keep skeleton compact.
    let truncated: String = cond.chars().take(60).collect();
    if truncated.len() < cond.len() {
        Some(format!("{truncated}…"))
    } else {
        Some(truncated)
    }
}

/// Extract the callee name from a call expression node.
fn call_name(node: Node, source: &[u8]) -> Option<String> {
    // call_expression → first child is the function/callee.
    let mut cursor = node.walk();
    let mut name = String::new();
    for child in node.children(&mut cursor) {
        let ck = child.kind().to_lowercase();
        if ck.contains("block") || ck.contains("argument") || ck.contains("parameter") {
            continue;
        }
        let text = child
            .utf8_text(source)
            .unwrap_or("")
            .trim()
            .to_string();
        if !text.is_empty() && !text.starts_with('(') {
            name = text;
            break;
        }
    }
    if name.is_empty() {
        return None;
    }
    // Keep only the identifier-ish head (before `(` or `.` chains are fine).
    let head: String = name.chars().take(50).collect();
    Some(head)
}

/// Regex keyword-line fallback for languages without tree-sitter support.
fn keyword_fallback(source: &str, _lang: &str) -> Option<String> {
    let kw_re = regex::Regex::new(
        r"(?i)^\s*(if|else|elif|for|while|switch|case|match|try|catch|except|finally|with|return|throw|raise|break|continue)\b",
    )
    .ok()?;
    let call_re = regex::Regex::new(r"(?i)([A-Za-z_][A-Za-z0-9_]*)\s*\(").ok()?;

    let mut out = String::new();
    for line in source.lines() {
        if kw_re.is_match(line) {
            out.push_str(line.trim());
            out.push('\n');
        } else {
            for cap in call_re.captures_iter(line) {
                if let Some(m) = cap.get(1) {
                    out.push_str("→ ");
                    out.push_str(m.as_str());
                    out.push('\n');
                }
            }
        }
    }
    if out.trim().is_empty() {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeleton_detects_if_and_call() {
        let code = r#"
fn calc(vip: bool, rate: f64, n: f64) -> f64 {
    if vip {
        let r = lookup_rate();
        return r * n;
    }
    return rate * n;
}
"#;
        let sk = control_flow_skeleton(code, "rust", 2, 8).unwrap();
        assert!(sk.contains("if"), "expected if branch: {sk}");
        assert!(sk.contains("→ lookup_rate"), "expected call: {sk}");
        assert!(sk.contains("return"), "expected return: {sk}");
    }
}
