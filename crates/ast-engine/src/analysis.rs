//! AST analysis module — regex-based extraction for Phase 1.
//!
//! Per architecture decision 8-5: Phase 1 uses regex extraction,
//! no tree-sitter grammar crate is introduced.

use duo_types::{AstResult, FunctionDef};
use regex::Regex;
use std::sync::LazyLock;

// ─── Cached regex patterns (compiled once, reused forever) ────────────────

// Function extraction patterns
static RUST_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*[<(]").expect("invariant: static regex pattern is valid")
});

static TS_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?m)^\s*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\())",
    ).expect("invariant: static regex pattern is valid")
});

static PY_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*(?:async\s+)?def\s+(\w+)\s*\(").expect("invariant: static regex pattern is valid")
});

static GO_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w+)\s*\(").expect("invariant: static regex pattern is valid")
});

static JAVA_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?m)^\s*(?:public|private|protected|static|final|synchronized|abstract|native)\s+.*\s+(\w+)\s*\(",
    ).expect("invariant: static regex pattern is valid")
});

static C_CPP_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?m)^\s*(?:(?:static|inline|extern|virtual|const|unsigned|signed|void|int|long|short|float|double|char|bool|auto|struct\s+\w+|enum\s+\w+|class\s+\w+|\w+_t)\s+)+\**\s*(\w+)\s*\(",
    ).expect("invariant: static regex pattern is valid")
});

static CSHARP_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?m)^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|new)\s+)*\w+(?:<[^>]+>)?(?:\[\])?\s+(\w+)\s*\(",
    ).expect("invariant: static regex pattern is valid")
});

static RUBY_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*def\s+(?:self\.)?(\w+[?!]?)").expect("invariant: static regex pattern is valid")
});

static SCALA_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*def\s+(\w+)\s*[\[(]").expect("invariant: static regex pattern is valid")
});

static PHP_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*(?:public|private|protected|static|abstract|final)\s+function\s+(\w+)\s*\(").expect("invariant: static regex pattern is valid")
});

static ZIG_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*(?:pub\s+)?fn\s+(\w+)\s*\(").expect("invariant: static regex pattern is valid")
});

static KOTLIN_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*(?:(?:public|private|protected|internal|override|open|suspend|inline)\s+)*fun\s+(?:<[^>]+>\s+)?(?:\w+\.)?(\w+)\s*[\[(]").expect("invariant: static regex pattern is valid")
});

static LUA_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*(?:local\s+)?function\s+(\w+(?:\.\w+)*)\s*\(").expect("invariant: static regex pattern is valid")
});

static SWIFT_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*(?:(?:public|private|internal|fileprivate|open|static|override|class|final|async|throws|rethrows|mutating|nonmutating)\s+)*func\s+(\w+)\s*[\(<]").expect("invariant: static regex pattern is valid")
});

static LUA_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^\s*(?:local\s+)?\w+\s*=\s*require\s*\(\s*['"][^'"]+['"]"#).expect("invariant: static regex pattern is valid")
});

static SWIFT_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*import\s+[\w.]+").expect("invariant: static regex pattern is valid")
});

// Import extraction patterns
static RUST_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^use\s+[\w:]+").expect("invariant: static regex pattern is valid")
});

static TS_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^import\s+.+from\s+['"]"#).expect("invariant: static regex pattern is valid")
});

static PY_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^(?:import\s+\w+|from\s+\w+\s+import)").expect("invariant: static regex pattern is valid")
});

static GO_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^\s*import\s+(?:\(\s*)?"[^"]*""#).expect("invariant: static regex pattern is valid")
});

static JAVA_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*import\s+(?:static\s+)?[\w.]+(?:\.\*)?;").expect("invariant: static regex pattern is valid")
});

static C_CPP_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"#include\s*(?:<[^>]+>|"[^"]+")"#).expect("invariant: static regex pattern is valid")
});

static CSHARP_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*using\s+[\w.]+;").expect("invariant: static regex pattern is valid")
});

static RUBY_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^\s*require(?:_relative)?\s+['"][^'"]+['"]"#).expect("invariant: static regex pattern is valid")
});

static SCALA_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*import\s+[\w.]+(?:\.\{[\w,\s]+\})?").expect("invariant: static regex pattern is valid")
});

static PHP_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^\s*(?:use\s+[\w\\]+(?:\s+as\s+\w+)?;|require(?:_once)?\s+['"][^'"]+['"]|include(?:_once)?\s+['"][^'"]+['"])"#).expect("invariant: static regex pattern is valid")
});

static ZIG_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)const\s+\w+\s*=\s*@import\s*\(\s*"[^"]*""#).expect("invariant: static regex pattern is valid")
});

static KOTLIN_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*import\s+[\w.]+(?:\.\*)?").expect("invariant: static regex pattern is valid")
});

// ─── OPT-17: regex fallback for markup / contract / script languages ──────
// These have no tree-sitter grammar compiled by default; index them via regex.

// SQL: CREATE FUNCTION / PROCEDURE (schema-level routines) + CREATE TABLE /
// VIEW (schema-level structures). Three alternation branches so the name lands
// in capture group 1 (function/procedure), 2 (table), or 3 (view) — the
// extractor follows that chain. Tables/views become Function-shaped entities
// on the regex fallback path, exactly like the css-selector entities.
static SQL_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?im)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+([\w.]+)|^\s*CREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMPORARY\s+|TEMP\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)|^\s*CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)",
    )
    .expect("invariant: static regex pattern is valid")
});

// Shell/Bash: `function name {` or `name() {`
static SHELL_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)(?:function\s+(\w+)|\b(\w+)\s*\(\s*\)\s*\{)").expect("invariant: static regex pattern is valid")
});

// HTML: element id="..." or the first class token of class="..."
static HTML_SYM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?im)(?:\bid\s*=\s*["']([\w-]+)["']|\bclass\s*=\s*["']\s*([\w-]+))"#).expect("invariant: static regex pattern is valid")
});

// CSS: .class / #id selectors and @keyframes names
static CSS_SYM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?im)(?:\.([\w-]+)\s*[,{]|\#([\w-]+)\s*[,{]|@keyframes\s+([\w-]+))"#).expect("invariant: static regex pattern is valid")
});

// HTML: <script src="..."> and <link href="..."> as imports
static HTML_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?im)<(?:script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']|link\b[^>]*\bhref\s*=\s*["']([^"']+)["'])"#).expect("invariant: static regex pattern is valid")
});

// CSS: @import "...";
static CSS_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?im)@import\s+["']([^"']+)["']"#).expect("invariant: static regex pattern is valid")
});

// ─── OPT-17: grammar-less languages (regex fallback) ───────────────
// These reuse the regex path (no tree-sitter grammar compiled), consistent
// with the Phase-1 design. Symbol extraction is shallower than the 15
// core languages (functions / struct-like names only).

// Dart: expression-body `name(params) =>`, `function name`, and type decls
// (class / mixin / enum / extension).
static DART_SYM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?m)(?:(?:async\s+)?function\s+([\w$]+)|\b([\w$]+)\s*\([^;{]*\)\s*=>|^\s*(?:abstract\s+|final\s+|sealed\s+|base\s+)?(?:class|mixin|enum|extension)\s+([\w$]+))",
    )
    .expect("invariant: static regex pattern is valid")
});

// Elixir: `def` / `defp`.
static ELIXIR_FN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*defp?\s+([\w!?]+)").expect("invariant: static regex pattern is valid")
});

// Protobuf: message / service / enum / rpc.
static PROTO_SYM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*(?:message|service|enum|rpc)\s+([\w.]+)").expect("invariant: static regex pattern is valid")
});

// GraphQL: type / interface / input / enum / scalar / union.
static GRAPHQL_SYM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*(?:type|interface|input|enum|scalar|union)\s+([\w]+)").expect("invariant: static regex pattern is valid")
});

// Dart imports (`import 'package:...';`).
static DART_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^\s*import\s+['"][^'"]+['"]"#).expect("invariant: static regex pattern is valid")
});

// Elixir imports (`import` / `alias` / `use`).
static ELIXIR_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*(?:import|alias|use)\s+([\w.]+)").expect("invariant: static regex pattern is valid")
});

// Protobuf imports (`import "google/protobuf/...";`).
static PROTO_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^\s*import\s+["']([^"']+)["']"#).expect("invariant: static regex pattern is valid")
});

// Complexity pattern
static COMPLEXITY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:\bif\b|\bfor\b|\bwhile\b|\bmatch\b|\bswitch\b|\bcatch\b|\belif\b|&&|\|\|)"#).expect("invariant: static regex pattern is valid")
});

// Parameter extraction patterns
static RUST_PARAM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\w+)\s*:").expect("invariant: static regex pattern is valid")
});

static DEFAULT_PARAM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\w+)\s*[:\?]").expect("invariant: static regex pattern is valid")
});

/// Extract function definitions from source code using regex.
///
/// Supports Rust, TypeScript/JavaScript, Python, Go, Java, C/C++, C#,
/// Ruby, Scala, PHP, Zig, and Kotlin.
/// Returns a list of `FunctionDef` with name, approximate line numbers, and parameters.
pub fn extract_functions(code: &str, language: &str) -> Vec<FunctionDef> {
    let re: &Regex = match language {
        "rust" => &RUST_FN_RE,
        "typescript" | "javascript" | "ts" | "js" => &TS_FN_RE,
        "python" | "py" => &PY_FN_RE,
        "go" => &GO_FN_RE,
        "java" => &JAVA_FN_RE,
        "c" | "cpp" | "c++" => &C_CPP_FN_RE,
        "csharp" | "c#" => &CSHARP_FN_RE,
        "ruby" => &RUBY_FN_RE,
        "scala" => &SCALA_FN_RE,
        "php" => &PHP_FN_RE,
        "zig" => &ZIG_FN_RE,
        "kotlin" => &KOTLIN_FN_RE,
        "swift" => &SWIFT_FN_RE,
        "lua" => &LUA_FN_RE,
        // OPT-17: markup / contract / script languages (regex fallback)
        "sql" => &SQL_FN_RE,
        "shell" => &SHELL_FN_RE,
        "html" => &HTML_SYM_RE,
        "css" => &CSS_SYM_RE,
        // OPT-17: grammar-less languages (regex fallback, consistent with Phase-1)
        "dart" => &DART_SYM_RE,
        "elixir" => &ELIXIR_FN_RE,
        "vue" | "svelte" => &TS_FN_RE,
        "protobuf" => &PROTO_SYM_RE,
        "graphql" => &GRAPHQL_SYM_RE,
        _ => return Vec::new(),
    };

    let mut functions = Vec::new();

    for (line_idx, line) in code.lines().enumerate() {
        let line_num = line_idx + 1;

        for cap in re.captures_iter(line) {
            // The function name may be in capture group 1 or 2 depending on the pattern
            let name = cap
                .get(1)
                .or_else(|| cap.get(2))
                .or_else(|| cap.get(3))
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();

            if name.is_empty() {
                continue;
            }

            // Extract parameters from the same line (best-effort, regex-based)
            let parameters = extract_params_from_line(line, language);

            let end_line = estimate_end_line(code, line_idx, language);

            functions.push(FunctionDef {
                name,
                return_type: None,
                start_line: line_num,
                end_line,
                parameters,
                documentation: None,
            });
        }
    }

    functions
}

/// Extract import statements from source code using regex.
///
/// Returns the full import line as a string for each match.
pub fn extract_imports(code: &str, language: &str) -> Vec<String> {
    let re: &Regex = match language {
        "rust" => &RUST_IMPORT_RE,
        "typescript" | "javascript" | "ts" | "js" => &TS_IMPORT_RE,
        "python" | "py" => &PY_IMPORT_RE,
        "go" => &GO_IMPORT_RE,
        "java" => &JAVA_IMPORT_RE,
        "c" | "cpp" | "c++" => &C_CPP_IMPORT_RE,
        "csharp" | "c#" => &CSHARP_IMPORT_RE,
        "ruby" => &RUBY_IMPORT_RE,
        "scala" => &SCALA_IMPORT_RE,
        "php" => &PHP_IMPORT_RE,
        "zig" => &ZIG_IMPORT_RE,
        "kotlin" => &KOTLIN_IMPORT_RE,
        "swift" => &SWIFT_IMPORT_RE,
        "lua" => &LUA_IMPORT_RE,
        // OPT-17: markup / contract / grammar-less languages with imports
        "html" => &HTML_IMPORT_RE,
        "css" => &CSS_IMPORT_RE,
        "dart" => &DART_IMPORT_RE,
        "elixir" => &ELIXIR_IMPORT_RE,
        "vue" | "svelte" => &TS_IMPORT_RE,
        "protobuf" => &PROTO_IMPORT_RE,
        _ => return Vec::new(),
    };

    re.captures_iter(code)
        .filter_map(|cap| cap.get(0).map(|m| m.as_str().to_string()))
        .collect()
}

/// Calculate cyclomatic complexity using a simple keyword-count heuristic.
///
/// Counts occurrences of branching/looping keywords (`if`, `for`, `while`,
/// `match`, `switch`, `catch`, `elif`, `&&`, `||`) and adds 1 for the base path.
pub fn count_complexity(code: &str) -> usize {
    let count = COMPLEXITY_RE.find_iter(code).count();
    count + 1
}

/// Perform full AST analysis on source code.
///
/// Combines function extraction, import extraction, and complexity calculation
/// into a single `AstResult`.
pub fn analyze(code: &str, language: &str) -> AstResult {
    let functions = extract_functions(code, language);
    let _imports = extract_imports(code, language);
    let _complexity = count_complexity(code);

    // Use the language string as the file_path placeholder;
    // callers should override this with the actual path if needed.
    AstResult {
        file_path: String::new(),
        language: language.to_string(),
        functions,
        errors: None,
    }
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/// Best-effort parameter extraction from a single function signature line.
fn extract_params_from_line(line: &str, language: &str) -> Vec<String> {
    // Find the parenthesised parameter list on this line
    let start = match line.find('(') {
        Some(s) => s + 1,
        None => return Vec::new(),
    };

    let depth_end = &line[start..]
        .char_indices()
        .fold((0usize, None), |(depth, end), (i, c)| {
            if end.is_some() {
                (depth, end)
            } else if c == '(' {
                (depth + 1, None)
            } else if c == ')' {
                if depth == 0 {
                    (depth, Some(i))
                } else {
                    (depth - 1, None)
                }
            } else {
                (depth, end)
            }
        });

    let end = match depth_end.1 {
        Some(i) => start + i,
        None => return Vec::new(),
    };

    let params_str = &line[start..end];

    if params_str.trim().is_empty() {
        return Vec::new();
    }

    // Split by comma, take the identifier before `:` (Python/TS) or before `:`/before type annotation (Rust)
    let re: &Regex = match language {
        "rust" => &RUST_PARAM_RE,
        _ => &DEFAULT_PARAM_RE,
    };

    params_str
        .split(',')
        .filter_map(|param| {
            re.captures(param.trim())
                .and_then(|c| c.get(1))
                .map(|m: regex::Match| m.as_str().to_string())
        })
        .collect()
}

/// Estimate the end line of a function body by tracking brace indentation.
///
/// Starts from `start_line_idx` (0-based) and looks for matching `{}` pairs.
/// For Python, looks for the next dedent.
fn estimate_end_line(code: &str, start_line_idx: usize, language: &str) -> usize {
    let lines: Vec<&str> = code.lines().collect();
    let total_lines = lines.len();

    if language == "python" || language == "py" || language == "ruby" || language == "lua" {
        // Python/Ruby/Lua: find the def line's indentation, then find the first line
        // at the same or lower indentation after the body.
        let def_indent = lines
            .get(start_line_idx)
            .map(|l| l.len() - l.trim_start().len())
            .unwrap_or(0);

        for (i, line) in lines.iter().enumerate().skip(start_line_idx + 1).take(total_lines - start_line_idx - 1) {
            let line = *line;
            if line.trim().is_empty() {
                continue;
            }
            let current_indent = line.len() - line.trim_start().len();
            if current_indent <= def_indent {
                return i; // 1-based
            }
        }
        return total_lines; // Function extends to end of file
    }

    // Brace-based languages (Rust, TS, JS):
    // Find the opening brace and match to closing brace.
    let mut depth = 0u32;
    let mut found_open = false;

    for (i, l) in lines.iter().enumerate().skip(start_line_idx).take(total_lines - start_line_idx) {
        for ch in l.chars() {
            match ch {
                '{' => {
                    depth += 1;
                    found_open = true;
                }
                '}' => {
                    depth = depth.saturating_sub(1);
                    if found_open && depth == 0 {
                        return i + 1; // 1-based
                    }
                }
                _ => {}
            }
        }
    }

    total_lines.max(start_line_idx + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_rust_functions() {
        let code = r#"
fn main() {
    println!("hello");
}

pub async fn fetch_data(url: &str) -> Result<String> {
    todo!()
}
"#;
        let funcs = extract_functions(code, "rust");
        assert_eq!(funcs.len(), 2);
        assert_eq!(funcs[0].name, "main");
        assert_eq!(funcs[1].name, "fetch_data");
    }

    #[test]
    fn extract_ts_functions() {
        let code = r#"
function add(a: number, b: number): number {
    return a + b;
}

const greet = (name: string) => {
    console.log(name);
};

async function loadData() {}
"#;
        let funcs = extract_functions(code, "typescript");
        assert_eq!(funcs.len(), 3);
        assert!(funcs.iter().any(|f| f.name == "add"));
        assert!(funcs.iter().any(|f| f.name == "greet"));
        assert!(funcs.iter().any(|f| f.name == "loadData"));
    }

    #[test]
    fn extract_python_functions() {
        let code = r#"
def hello():
    print("hello")

async def fetch(url):
    pass
"#;
        let funcs = extract_functions(code, "python");
        assert_eq!(funcs.len(), 2);
        assert_eq!(funcs[0].name, "hello");
        assert_eq!(funcs[1].name, "fetch");
    }

    #[test]
    fn extract_rust_imports() {
        let code = r#"
use std::collections::HashMap;
use anyhow::Result;
"#;
        let imports = extract_imports(code, "rust");
        assert_eq!(imports.len(), 2);
        assert!(imports[0].contains("std::collections::HashMap"));
    }

    #[test]
    fn extract_ts_imports() {
        let code = r#"
import React from 'react';
import { useState } from 'react';
"#;
        let imports = extract_imports(code, "typescript");
        assert_eq!(imports.len(), 2);
    }

    #[test]
    fn extract_python_imports() {
        let code = r#"
import os
from typing import List
"#;
        let imports = extract_imports(code, "python");
        assert_eq!(imports.len(), 2);
    }

    #[test]
    fn count_complexity_simple() {
        let code = "if x > 0 { for i in 0..10 { if i % 2 == 0 { } } }";
        let c = count_complexity(code);
        assert_eq!(c, 4); // 2x if + 1x for + 1 base
    }

    #[test]
    fn count_complexity_base() {
        let code = "let x = 1;";
        let c = count_complexity(code);
        assert_eq!(c, 1); // base path only
    }

    #[test]
    fn analyze_combines_results() {
        let code = r#"
use std::io;

fn main() {
    if true {
        println!("hi");
    }
}
"#;
        let result = analyze(code, "rust");
        assert_eq!(result.language, "rust");
        assert_eq!(result.functions.len(), 1);
        assert_eq!(result.functions[0].name, "main");
    }

    #[test]
    fn unknown_language_returns_empty() {
        let code = "fn main() {}";
        let funcs = extract_functions(code, "unknown");
        assert!(funcs.is_empty());
        let imports = extract_imports(code, "unknown");
        assert!(imports.is_empty());
    }

    #[test]
    fn estimate_end_line_brace_based() {
        let code = "fn main() {\n    println!(\"hi\");\n}\nfn other() {}\n";
        let end = estimate_end_line(code, 0, "rust");
        assert_eq!(end, 3); // closing brace is on line 3 (1-based)
    }

    #[test]
    fn extract_sql_functions() {
        let code = "CREATE FUNCTION add(a int, b int) RETURNS int AS $$ BEGIN RETURN a+b; END; $$ LANGUAGE sql;";
        let funcs = extract_functions(code, "sql");
        assert!(funcs.iter().any(|f| f.name == "add"));
        let code2 = "CREATE OR REPLACE PROCEDURE refresh() LANGUAGE plpgsql AS $$ BEGIN END; $$";
        let procs = extract_functions(code2, "sql");
        assert!(procs.iter().any(|f| f.name == "refresh"));
    }

    /// KG schema extraction: CREATE TABLE / VIEW must surface as entities on
    /// the regex fallback path — a schema file (migration, DDL) otherwise
    /// contributes nothing to the graph.
    #[test]
    fn extract_sql_tables_and_views() {
        let code = "CREATE TABLE users (id INT PRIMARY KEY);\n\
                    CREATE TABLE IF NOT EXISTS order_items (id INT, order_id INT);\n\
                    create view active_users as select * from users;\n\
                    CREATE GLOBAL TEMPORARY TABLE staging (id INT);";
        let entities = extract_functions(code, "sql");
        let names: Vec<&str> = entities.iter().map(|f| f.name.as_str()).collect();
        for expected in ["users", "order_items", "active_users", "staging"] {
            assert!(
                names.contains(&expected),
                "expected {expected} among {names:?}"
            );
        }
        // Non-DDL lines must not produce phantom entities.
        assert!(extract_functions("INSERT INTO users VALUES (1);", "sql").is_empty());
        assert!(extract_functions("SELECT * FROM users;", "sql").is_empty());
    }

    #[test]
    fn extract_shell_functions() {
        let code = "function hello {\n  echo hi\n}\n\ndo_work() {\n  echo done\n}";
        let funcs = extract_functions(code, "shell");
        assert!(funcs.iter().any(|f| f.name == "hello"));
        assert!(funcs.iter().any(|f| f.name == "do_work"));
    }

    #[test]
    fn extract_html_symbols() {
        let code = "<div id=\"main\" class=\"container active\">";
        let syms = extract_functions(code, "html");
        let names: Vec<&str> = syms.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"main"));
        assert!(names.contains(&"container"));
    }

    #[test]
    fn extract_css_symbols() {
        let code = ".btn { color: red; }\n#header { }\n@keyframes spin { }";
        let syms = extract_functions(code, "css");
        let names: Vec<&str> = syms.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"btn"));
        assert!(names.contains(&"header"));
        assert!(names.contains(&"spin"));
    }

    #[test]
    fn extract_html_imports() {
        let code = "<script src=\"./app.js\"></script>\n<link rel=\"stylesheet\" href=\"./a.css\">";
        let imports = extract_imports(code, "html");
        assert!(imports.iter().any(|i| i.contains("./app.js")));
        assert!(imports.iter().any(|i| i.contains("./a.css")));
    }

    #[test]
    fn extract_dart_symbols() {
        let code = "class Foo {\n  void bar() {}\n}\nint add(int a) => a + 1;\nfunction baz() {}";
        let syms = extract_functions(code, "dart");
        let names: Vec<&str> = syms.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"Foo"));
        assert!(names.contains(&"add"));
        assert!(names.contains(&"baz"));
    }

    #[test]
    fn extract_elixir_functions() {
        let code = "def hello(name) do\n  :ok\nend\ndefp greet, do: :hi";
        let funcs = extract_functions(code, "elixir");
        assert!(funcs.iter().any(|f| f.name == "hello"));
        assert!(funcs.iter().any(|f| f.name == "greet"));
    }

    #[test]
    fn extract_protobuf_symbols() {
        let code = "message User {\n  string name = 1;\n}\nservice UserService {\n  rpc GetUser (User) returns (User);\n}";
        let syms = extract_functions(code, "protobuf");
        let names: Vec<&str> = syms.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"User"));
        assert!(names.contains(&"UserService"));
        assert!(names.contains(&"GetUser"));
    }

    #[test]
    fn extract_graphql_symbols() {
        let code = "type User {\n  id: ID!\n}\ninterface Node {\n  id: ID!\n}\nenum Role { ADMIN USER }";
        let syms = extract_functions(code, "graphql");
        let names: Vec<&str> = syms.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"User"));
        assert!(names.contains(&"Node"));
        assert!(names.contains(&"Role"));
    }

    #[test]
    fn extract_vue_svelte_functions() {
        let code = "<script setup>\nfunction inc() {}\nconst dec = () => {}\n</script>";
        let vue = extract_functions(code, "vue");
        assert!(vue.iter().any(|f| f.name == "inc"));
        assert!(vue.iter().any(|f| f.name == "dec"));
        let svelte = extract_functions(code, "svelte");
        assert!(svelte.iter().any(|f| f.name == "inc"));
    }

    #[test]
    fn extract_dart_elixir_protobuf_imports() {
        let dart = "import 'package:foo/bar.dart';";
        let di = extract_imports(dart, "dart");
        assert!(di.iter().any(|i| i.contains("package:foo/bar.dart")));
        let elixir = "import Foo\nalias Bar\nuse Mix";
        let ei = extract_imports(elixir, "elixir");
        assert!(ei.iter().any(|i| i.contains("Foo")));
        let proto = "import \"google/protobuf/empty.proto\";";
        let pi = extract_imports(proto, "protobuf");
        assert!(pi.iter().any(|i| i.contains("google/protobuf/empty.proto")));
    }
}
