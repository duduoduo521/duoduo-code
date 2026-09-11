use duo_types::{InterfaceContract, QualityCheck, SharedTypeDefinition};
use regex::Regex;
use std::sync::LazyLock;

/// 语法检查：括号匹配、未闭合字符串、末尾缺少分号、截断检测
///
/// P2-34: `language` finally matters. The semicolon heuristic is C-family
/// only — applying it to Python flagged every legitimate statement as
/// "missing semicolon" (a hard syntax error the agent then "fixed" by adding
/// `;` everywhere). Python keeps bracket/string/truncation checks.
pub fn check_syntax(code: &str, language: &str) -> Vec<QualityCheck> {
    let lang = language.trim().to_lowercase();
    let mut checks = vec![
        // ── 1. 括号匹配检查 ──
        check_bracket_balance(code),
        // ── 2. 未闭合字符串检查 ──
        check_unclosed_strings(code),
    ];
    // ── 3. 末尾缺少分号（仅 C 系语言） ──
    if !matches!(lang.as_str(), "python" | "py" | "ruby" | "rb") {
        checks.push(check_missing_semicolons(code));
    }
    // ── 4. 截断检测 ──
    checks.push(check_truncation(code));
    checks
}

/// 风格检查：行长度、命名规范
pub fn check_style(code: &str) -> Vec<QualityCheck> {
    vec![
        // ── 1. 行长度检查 ──
        check_line_length(code),
        // ── 2. 命名规范检查（snake_case 变量） ──
        check_naming_convention(code),
    ]
}

/// 接口一致性检查：验证生成的代码是否满足接口契约
///
/// 检查内容：
/// 1. 接口定义的方法是否都已实现（缺失 = 错误）
/// 2. 共享类型引用是否正确（用错枚举值 = 错误）
/// 3. 实现的方法参数/返回类型是否匹配（不匹配 = 警告）
pub fn check_interface_consistency(
    code: &str,
    contract: &InterfaceContract,
    shared_types: &[SharedTypeDefinition],
    language: &str,
) -> Vec<QualityCheck> {
    vec![
        check_methods_implemented(code, contract, language),
        check_shared_type_usage(code, shared_types, language),
        check_properties_present(code, contract, language),
    ]
}

/// 安全检查：硬编码密钥、SQL 注入模式、eval 使用
pub fn check_security(code: &str) -> Vec<QualityCheck> {
    vec![
        // ── 1. 硬编码密钥检查 ──
        check_hardcoded_secrets(code),
        // ── 2. SQL 注入模式检查 ──
        check_sql_injection(code),
        // ── 3. eval/exec 使用检查 ──
        check_dangerous_eval(code),
    ]
}

/// Standard 级安全检查：仅 sql_injection + dangerous_eval
/// 排除 hardcoded_secrets（正则假阳性率过高）
pub fn check_security_standard(code: &str) -> Vec<QualityCheck> {
    vec![
        check_sql_injection(code),
        check_dangerous_eval(code),
    ]
}

/// Full 级安全检查：sql_injection + dangerous_eval + hardcoded_secrets
pub fn check_security_full(code: &str) -> Vec<QualityCheck> {
    vec![
        check_sql_injection(code),
        check_dangerous_eval(code),
        check_hardcoded_secrets(code),
    ]
}

// ══════════════════════════════════════════════════════════
//  Syntax helpers
// ══════════════════════════════════════════════════════════

fn check_bracket_balance(code: &str) -> QualityCheck {
    let mut paren: i32 = 0;  // ()
    let mut brace: i32 = 0;  // {}
    let mut bracket: i32 = 0; // []

    let mut in_string = false;
    let mut string_delim = '\0';
    let mut prev_ch = '\0';

    for ch in code.chars() {
        // Track string boundaries — skip content inside strings
        if in_string {
            if ch == string_delim && prev_ch != '\\' {
                in_string = false;
            }
        } else {
            match ch {
                '"' | '\'' => {
                    in_string = true;
                    string_delim = ch;
                }
                '(' => paren += 1,
                ')' => paren -= 1,
                '{' => brace += 1,
                '}' => brace -= 1,
                '[' => bracket += 1,
                ']' => bracket -= 1,
                _ => {}
            }
        }
        prev_ch = ch;
    }

    let all_balanced = paren == 0 && brace == 0 && bracket == 0;

    let score = if all_balanced {
        1.0
    } else {
        // Penalise per unbalanced pair
        let imbalance = paren.unsigned_abs() + brace.unsigned_abs() + bracket.unsigned_abs();
        (1.0 - (imbalance as f64 * 0.1)).max(0.0)
    };

    QualityCheck {
        name: "syntax:bracket_balance".into(),
        passed: all_balanced,
        score,
    }
}

fn check_unclosed_strings(code: &str) -> QualityCheck {
    let mut in_string = false;
    let mut string_delim = '\0';
    let mut prev_ch = '\0';
    let mut unclosed_count: usize = 0;

    for ch in code.chars() {
        if in_string {
            if ch == string_delim && prev_ch != '\\' {
                in_string = false;
            }
        } else {
            match ch {
                '"' | '\'' => {
                    in_string = true;
                    string_delim = ch;
                }
                _ => {}
            }
        }
        prev_ch = ch;
    }

    // If still inside a string at EOF, it's unclosed
    if in_string {
        unclosed_count += 1;
    }

    QualityCheck {
        name: "syntax:unclosed_strings".into(),
        passed: unclosed_count == 0,
        score: if unclosed_count == 0 { 1.0 } else { 0.0 },
    }
}

fn check_missing_semicolons(code: &str) -> QualityCheck {
    // Simple heuristic: lines that look like statements but don't end with
    // `;`, `{`, `}`, `:`, or are not blank / comments / preprocessor.
    let mut missing = 0usize;
    let mut total_statement_lines = 0usize;

    for line in code.lines() {
        let trimmed = line.trim();

        // Skip empty, comments, block delimiters, preprocessor directives,
        // labels, and lines ending with a backslash (continuation)
        if trimmed.is_empty()
            || trimmed.starts_with("//")
            || trimmed.starts_with('#')
            || trimmed.starts_with("/*")
            || trimmed == "{"
            || trimmed == "}"
            || trimmed.ends_with('{')
            || trimmed.ends_with('}')
            || trimmed.ends_with('\\')
            || trimmed.ends_with(':')
            || trimmed.ends_with(',')
        {
            continue;
        }

        // Strip trailing line comments
        let code_part = if let Some(idx) = trimmed.rfind("//") {
            trimmed[..idx].trim_end()
        } else {
            trimmed
        };

        if code_part.is_empty() {
            continue;
        }

        // Likely a statement if it contains common patterns
        let looks_like_statement = code_part.contains('=')
            || code_part.starts_with("let ")
            || code_part.starts_with("const ")
            || code_part.starts_with("var ")
            || code_part.starts_with("return")
            || code_part.starts_with("break")
            || code_part.starts_with("continue")
            || code_part.starts_with("throw ")
            || code_part.starts_with("import ")
            || code_part.starts_with("pub ")
            || code_part.starts_with("fn ")
            || code_part.starts_with("use ")
        // Simple expressions that look like they should end with `;`
            || (code_part.contains('(') && code_part.contains(')'));

        if looks_like_statement {
            total_statement_lines += 1;
            if !code_part.ends_with(';') {
                missing += 1;
            }
        }
    }

    let passed = missing == 0;
    let score = if total_statement_lines == 0 {
        1.0
    } else {
        1.0 - (missing as f64 / total_statement_lines as f64)
    };

    QualityCheck {
        name: "syntax:missing_semicolons".into(),
        passed,
        score,
    }
}

// ══════════════════════════════════════════════════════════
//  Truncation detection
// ══════════════════════════════════════════════════════════

/// Check for signs that code was truncated by the LLM's output limit.
fn check_truncation(code: &str) -> QualityCheck {
    let trimmed = code.trim();
    let mut signals: Vec<&str> = Vec::new();

    // 1. Ends with an incomplete line — only flag if bracket balance
    //    is also off. A trailing `{` or `(` is perfectly normal in
    //    CSS/JSON/JS if the overall brackets are balanced.
    if let Some(last_line) = trimmed.lines().last() {
        let last = last_line.trim_end();
        let looks_incomplete = last.ends_with('{')
            || last.ends_with(',')
            || last.ends_with('(')
            || last.ends_with('[')
            || last.ends_with("=>")
            || last.ends_with('+')
            || last.ends_with('|')
            || last.ends_with('&');
        if looks_incomplete {
            // Only flag if brackets are actually unbalanced — this avoids
            // false positives on CSS rules, JSON objects, JS exports, etc.
            let opens = trimmed.matches('{').count() + trimmed.matches('(').count() + trimmed.matches('[').count();
            let closes = trimmed.matches('}').count() + trimmed.matches(')').count() + trimmed.matches(']').count();
            if opens > closes {
                signals.push("ends_with_incomplete_line");
            }
        }
        // Trailing minus is unusual even with balanced brackets — likely truncation
        if last.ends_with('-') && !last.contains("->") {
            signals.push("ends_with_incomplete_line");
        }
    }

    // 2. Contains truncation/placeholder markers
    let lower = code.to_lowercase();
    if lower.contains("// ... rest of")
        || lower.contains("// ... remaining")
        || lower.contains("// same as above")
    {
        signals.push("contains_ellipsis_comment");
    }
    if lower.contains("truncated")
        && (lower.contains("// truncated") || lower.contains("/* truncated"))
    {
        signals.push("contains_truncation_marker");
    }

    // 3. HTML truncation: missing closing tags
    if (lower.contains("<html") || lower.contains("<!doctype")) && !lower.contains("</html>") {
        signals.push("html_missing_closing_tag");
    }
    if lower.contains("<body") && !lower.contains("</body>") {
        signals.push("body_missing_closing_tag");
    }

    // 4. CSS truncation: unclosed braces
    let open_braces = lower.chars().filter(|&c| c == '{').count();
    let close_braces = lower.chars().filter(|&c| c == '}').count();
    if lower.contains("{") && open_braces > close_braces {
        signals.push("css_missing_closing_brace");
    }

    // 5. Ends with ellipsis
    if trimmed.ends_with("...") || trimmed.ends_with("\u{2026}") {
        signals.push("ends_with_ellipsis");
    }

    // 6. TODO / PLACEHOLDER / truncated keywords. P2-33: these must appear in
    // a *comment* to count as a truncation marker. A bare "placeholder" is a
    // legitimate token in real code (HTML `placeholder="…"`, a CSS class, a
    // variable name) and used to hard-fail every file that mentioned it.
    const KEYWORD_MARKERS: [&str; 6] = [
        "// placeholder",
        "/* placeholder",
        "# placeholder",
        "<!-- placeholder",
        "// truncated",
        "/* truncated",
    ];
    if KEYWORD_MARKERS.iter().any(|m| lower.contains(m)) {
        signals.push("contains_truncation_keyword");
    }

    // 7. Very short content relative to typical code (likely truncated mid-stream)
    // Only flag if content is less than 50 chars and looks like it started writing code
    if code.len() < 50
        && (trimmed.starts_with("fn ")
            || trimmed.starts_with("function ")
            || trimmed.starts_with("class "))
    {
        signals.push("suspiciously_short_code");
    }

    let passed = signals.is_empty();
    let score = if passed {
        1.0
    } else {
        (1.0 - signals.len() as f64 * 0.2).max(0.0)
    };

    QualityCheck {
        name: "syntax:truncation".into(),
        passed,
        score,
    }
}

// ══════════════════════════════════════════════════════════
//  Style helpers
// ══════════════════════════════════════════════════════════

fn check_line_length(code: &str) -> QualityCheck {
    let max_allowed: usize = 120;
    let mut long_lines = 0usize;
    let mut total_lines = 0usize;

    for line in code.lines() {
        total_lines += 1;
        if line.len() > max_allowed {
            long_lines += 1;
        }
    }

    let passed = long_lines == 0;
    let score = if total_lines == 0 {
        1.0
    } else {
        1.0 - (long_lines as f64 / total_lines as f64)
    };

    QualityCheck {
        name: "style:line_length".into(),
        passed,
        score,
    }
}

fn check_naming_convention(code: &str) -> QualityCheck {
    // Heuristic: look for variable declarations using let/const/var
    // and flag identifiers with uppercase characters (not SCREAMING_SNAKE for constants).
    let mut violations = 0usize;
    let mut total_declarations = 0usize;

    for line in code.lines() {
        let trimmed = line.trim();

        // Check let/var declarations — expect snake_case
        if trimmed.starts_with("let ") || trimmed.starts_with("var ") {
            total_declarations += 1;
            if let Some(name) = extract_var_name(trimmed)
                && !is_snake_case(&name)
            {
                violations += 1;
            }
        }

        // Check const declarations — allow SCREAMING_SNAKE or snake_case
        if trimmed.starts_with("const ") {
            total_declarations += 1;
            if let Some(name) = extract_var_name(trimmed)
                && !is_snake_case(&name)
                && !is_screaming_snake_case(&name)
            {
                violations += 1;
            }
        }
    }

    let passed = violations == 0;
    let score = if total_declarations == 0 {
        1.0
    } else {
        1.0 - (violations as f64 / total_declarations as f64)
    };

    QualityCheck {
        name: "style:naming_convention".into(),
        passed,
        score,
    }
}

/// Extract the variable name from a declaration like `let foo = ...;`
fn extract_var_name(line: &str) -> Option<String> {
    // Skip the keyword (let/var/const), then take the identifier before any
    // `:`, `=`, or whitespace.
    let rest = line
        .trim_start_matches("let ")
        .trim_start_matches("var ")
        .trim_start_matches("const ");
    let name: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn is_snake_case(s: &str) -> bool {
    s.chars().all(|c| c.is_lowercase() || c == '_' || c.is_ascii_digit())
}

fn is_screaming_snake_case(s: &str) -> bool {
    s.chars().all(|c| c.is_uppercase() || c == '_' || c.is_ascii_digit())
}

// ══════════════════════════════════════════════════════════
//  Security helpers
// ══════════════════════════════════════════════════════════

pub(crate) fn check_hardcoded_secrets(code: &str) -> QualityCheck {
    let secret_patterns = [
        ("password", r#"password\s*=\s*["']"#),
        ("secret", r#"secret\s*=\s*["']"#),
        ("api_key", r#"api_key\s*=\s*["']"#),
        ("apikey", r#"apikey\s*=\s*["']"#),
        ("token", r#"token\s*=\s*["']"#),
        ("access_key", r#"access_key\s*=\s*["']"#),
        ("private_key", r#"private_key\s*=\s*["']"#),
    ];

    let mut found = 0usize;
    for line in code.lines() {
        let trimmed = line.trim();
        // Skip whole-line comments so explanatory text like
        // `// password = "..."` in a comment is not flagged.
        if trimmed.starts_with("//") || trimmed.starts_with('#') {
            continue;
        }
        for (name, _pattern) in &secret_patterns {
            // Use a simple substring + heuristic approach to avoid regex dependency
            if contains_secret_pattern(trimmed, name) {
                found += 1;
                break; // one hit per line is enough
            }
        }
    }

    let passed = found == 0;
    let score = if found == 0 { 1.0 } else { 0.0 };

    QualityCheck {
        name: "security:hardcoded_secrets".into(),
        passed,
        score,
    }
}

/// Simple heuristic: `keyword` followed by optional whitespace, `=`, optional whitespace, then a quote char.
/// Expects a single (already comment-stripped) line.
fn contains_secret_pattern(line: &str, keyword: &str) -> bool {
    let lower = line.to_lowercase();
    let mut search_from = 0;

    while let Some(start) = lower[search_from..].find(keyword) {
        let abs_start = search_from + start;
        let after_keyword = &line[abs_start + keyword.len()..];

        // Walk past optional whitespace, then expect '=', then optional whitespace, then quote
        let mut chars = after_keyword.chars().peekable();
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        if chars.peek() == Some(&'=') {
            chars.next();
            while chars.peek().is_some_and(|c| c.is_whitespace()) {
                chars.next();
            }
            if chars.peek().is_some_and(|c| *c == '"' || *c == '\'') {
                // It's an assignment to a string literal — flag it
                return true;
            }
        }

        search_from = abs_start + 1;
    }

    false
}

pub(crate) fn check_sql_injection(code: &str) -> QualityCheck {
    // Detect string concatenation with SQL keywords.
    // Patterns:  "... SELECT ..." + / "... INSERT ..." + /  format!("SELECT ...")
    let sql_keywords = ["SELECT ", "INSERT ", "UPDATE ", "DELETE ", "DROP "];
    let mut found = 0usize;

    for line in code.lines() {
        let trimmed = line.trim();
        // Skip whole-line comments (// and #) to avoid false positives on
        // explanatory text such as `// SELECT * FROM users` in a comment.
        if trimmed.starts_with("//") || trimmed.starts_with('#') {
            continue;
        }
        // Strip trailing line comment before checking concatenation markers,
        // so `code; // SELECT ... + ...` is not flagged.
        let code_part = match trimmed.rfind("//") {
            Some(idx) => trimmed[..idx].trim_end(),
            None => trimmed,
        };
        let upper = code_part.to_uppercase();
        for kw in &sql_keywords {
            if upper.contains(kw) {
                // Check for concatenation indicators near the keyword
                if code_part.contains('+')
                    || code_part.contains("format!")
                    || code_part.contains("format(")
                    || code_part.contains('$')
                    || code_part.contains(".format(")
                {
                    found += 1;
                    break; // one hit per line is enough
                }
            }
        }
    }

    let passed = found == 0;
    let score = if found == 0 { 1.0 } else { 0.0 };

    QualityCheck {
        name: "security:sql_injection".into(),
        passed,
        score,
    }
}

pub(crate) fn check_dangerous_eval(code: &str) -> QualityCheck {
    let dangerous_calls = ["eval(", "exec("];
    let mut found = 0usize;

    for line in code.lines() {
        let trimmed = line.trim();
        // Skip whole-line comments
        if trimmed.starts_with("//") || trimmed.starts_with('#') {
            continue;
        }
        // Strip a trailing line comment so `code; // eval(...)` is not flagged.
        let code_part = match trimmed.rfind("//") {
            Some(idx) => trimmed[..idx].trim_end(),
            None => trimmed,
        };
        for call in &dangerous_calls {
            if code_part.contains(call) {
                found += 1;
                break;
            }
        }
    }

    let passed = found == 0;
    let score = if found == 0 { 1.0 } else { 0.0 };

    QualityCheck {
        name: "security:dangerous_eval".into(),
        passed,
        score,
    }
}

// ══════════════════════════════════════════════════════════
//  Interface Consistency helpers
// ══════════════════════════════════════════════════════════

/// Check that all methods defined in the interface contract are implemented.
fn check_methods_implemented(code: &str, contract: &InterfaceContract, language: &str) -> QualityCheck {
    let defined_methods: Vec<&str> = contract.methods.keys().map(|s| s.as_str()).collect();
    if defined_methods.is_empty() {
        return QualityCheck {
            name: "interface:methods_implemented".into(),
            passed: true,
            score: 1.0,
        };
    }

    // Extract method names from code based on language
    let implemented = extract_method_names(code, language);
    let mut missing = Vec::new();

    for method in &defined_methods {
        if !implemented.contains(&method.to_string()) {
            missing.push(method.to_string());
        }
    }

    let total = defined_methods.len();
    let implemented_count = total - missing.len();
    let score = implemented_count as f64 / total as f64;
    let passed = missing.is_empty();

    QualityCheck {
        name: "interface:methods_implemented".into(),
        passed,
        score,
    }
}

/// Check that shared types are referenced correctly.
fn check_shared_type_usage(code: &str, shared_types: &[SharedTypeDefinition], _language: &str) -> QualityCheck {
    if shared_types.is_empty() {
        return QualityCheck {
            name: "interface:shared_type_usage".into(),
            passed: true,
            score: 1.0,
        };
    }

    let mut violations = 0usize;
    let mut total_checks = 0usize;

    for st in shared_types {
        if st.kind == "enum" {
            total_checks += 1;
            // Check if the enum name is referenced in the code
            if !code.contains(&st.name) {
                continue;
            }

            // Check for incorrect enum values: extract all values used with the enum name
            // via patterns like EnumName::Value, EnumName.Value, EnumName->Value
            // and verify each value is in the enum's defined values list.
            let access_patterns = [
                (format!("{}::", st.name), "::"),
                (format!("{}.", st.name), "."),
                (format!("{}->", st.name), "->"),
            ];
            for (prefix, _sep) in &access_patterns {
                let mut search_from = 0;
                while let Some(start) = code[search_from..].find(prefix.as_str()) {
                    let abs_start = search_from + start + prefix.len();
                    let after = &code[abs_start..];
                    // Extract the identifier after the separator
                    let value: String = after.chars()
                        .take_while(|c| c.is_alphanumeric() || *c == '_')
                        .collect();
                    if !value.is_empty() && !st.values.contains(&value) {
                        violations += 1;
                    }
                    search_from = abs_start;
                }
            }
        }
    }

    let score = if total_checks == 0 {
        1.0
    } else {
        // P2-35: `violations` counts every *occurrence* of a bad enum value
        // while `total_checks` counts enum *types*, so a single enum misused
        // five times produced 1 - 5/1 = -4.0. Quality scores are defined on
        // [0, 1] — clamp so a bad enum bottoms out at 0 instead of going
        // negative and dragging the aggregate below zero.
        (1.0 - (violations as f64 / total_checks as f64)).clamp(0.0, 1.0)
    };

    QualityCheck {
        name: "interface:shared_type_usage".into(),
        passed: violations == 0,
        score,
    }
}

/// Check that properties defined in the interface contract are present.
fn check_properties_present(code: &str, contract: &InterfaceContract, _language: &str) -> QualityCheck {
    let defined_properties: Vec<&str> = contract.properties.keys().map(|s| s.as_str()).collect();
    if defined_properties.is_empty() {
        return QualityCheck {
            name: "interface:properties_present".into(),
            passed: true,
            score: 1.0,
        };
    }

    // Simple heuristic: check if property names appear in the code
    let mut missing = Vec::new();
    for prop in &defined_properties {
        if !code.contains(prop) {
            missing.push(prop.to_string());
        }
    }

    let total = defined_properties.len();
    let present_count = total - missing.len();
    let score = present_count as f64 / total as f64;
    let passed = missing.is_empty();

    QualityCheck {
        name: "interface:properties_present".into(),
        passed,
        score,
    }
}

/// Extract method names from code based on language.
fn extract_method_names(code: &str, language: &str) -> Vec<String> {
    static PHP_METHOD_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)(?:public|protected|private)\s+function\s+(\w+)")
            .expect("invariant: static regex pattern is valid")
    });
    static TS_METHOD_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)(?:(?:async\s+)?(?:public|private|protected)?\s*(?:static)?\s*(?:readonly)?\s*(\w+)\s*\(|(?:get|set)\s+(\w+))")
            .expect("invariant: static regex pattern is valid")
    });
    static RUST_METHOD_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)(?:pub\s+)?(?:async\s+)?fn\s+(\w+)")
            .expect("invariant: static regex pattern is valid")
    });
    static PYTHON_METHOD_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)def\s+(\w+)")
            .expect("invariant: static regex pattern is valid")
    });

    let mut methods = Vec::new();

    match language {
        "php" => {
            for cap in PHP_METHOD_RE.captures_iter(code) {
                if let Some(m) = cap.get(1) {
                    methods.push(m.as_str().to_string());
                }
            }
        }
        "typescript" | "javascript" => {
            for cap in TS_METHOD_RE.captures_iter(code) {
                let m = cap.get(1).or_else(|| cap.get(2));
                if let Some(m) = m {
                    methods.push(m.as_str().to_string());
                }
            }
        }
        "rust" => {
            for cap in RUST_METHOD_RE.captures_iter(code) {
                if let Some(m) = cap.get(1) {
                    methods.push(m.as_str().to_string());
                }
            }
        }
        "python" => {
            for cap in PYTHON_METHOD_RE.captures_iter(code) {
                if let Some(m) = cap.get(1) {
                    methods.push(m.as_str().to_string());
                }
            }
        }
        _ => {}
    }

    methods
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bracket_balance_ok() {
        let checks = check_syntax("fn main() { let x = [1, 2]; }", "rust");
        let bc = checks.iter().find(|c| c.name == "syntax:bracket_balance").unwrap();
        assert!(bc.passed);
        assert_eq!(bc.score, 1.0);
    }

    #[test]
    fn test_bracket_balance_unbalanced() {
        let checks = check_syntax("fn main() { let x = [1, 2; }", "rust");
        let bc = checks.iter().find(|c| c.name == "syntax:bracket_balance").unwrap();
        assert!(!bc.passed);
    }

    #[test]
    fn test_unclosed_string() {
        let checks = check_syntax(r#"let s = "hello"#, "rust");
        let uc = checks.iter().find(|c| c.name == "syntax:unclosed_strings").unwrap();
        assert!(!uc.passed);
    }

    #[test]
    fn test_closed_string_ok() {
        let checks = check_syntax(r#"let s = "hello";"#, "rust");
        let uc = checks.iter().find(|c| c.name == "syntax:unclosed_strings").unwrap();
        assert!(uc.passed);
    }

    #[test]
    fn test_line_length_ok() {
        let checks = check_style("let x = 1;");
        let ll = checks.iter().find(|c| c.name == "style:line_length").unwrap();
        assert!(ll.passed);
    }

    #[test]
    fn test_line_length_too_long() {
        let long_line = "let x = ".to_string() + &"a".repeat(200) + ";";
        let checks = check_style(&long_line);
        let ll = checks.iter().find(|c| c.name == "style:line_length").unwrap();
        assert!(!ll.passed);
    }

    #[test]
    fn test_naming_convention_snake_case_ok() {
        let checks = check_style("let my_var = 1;");
        let nc = checks.iter().find(|c| c.name == "style:naming_convention").unwrap();
        assert!(nc.passed);
    }

    #[test]
    fn test_naming_convention_camel_case_violation() {
        let checks = check_style("let myVar = 1;");
        let nc = checks.iter().find(|c| c.name == "style:naming_convention").unwrap();
        assert!(!nc.passed);
    }

    #[test]
    fn test_hardcoded_secrets_detected() {
        let checks = check_security(r#"password = "secret123""#);
        let hs = checks.iter().find(|c| c.name == "security:hardcoded_secrets").unwrap();
        assert!(!hs.passed);
    }

    #[test]
    fn test_hardcoded_secrets_ok() {
        let checks = check_security(r#"password = std::env::var("PASS")"#);
        let hs = checks.iter().find(|c| c.name == "security:hardcoded_secrets").unwrap();
        assert!(hs.passed);
    }

    #[test]
    fn test_sql_injection_detected() {
        let checks = check_security(r#"let q = "SELECT * FROM users WHERE id=" + user_id;"#);
        let si = checks.iter().find(|c| c.name == "security:sql_injection").unwrap();
        assert!(!si.passed);
    }

    #[test]
    fn test_sql_injection_ok() {
        let checks = check_security(r#"stmt.execute("SELECT * FROM users WHERE id = ?", &[&id])"#);
        let si = checks.iter().find(|c| c.name == "security:sql_injection").unwrap();
        assert!(si.passed);
    }

    #[test]
    fn test_dangerous_eval_detected() {
        let checks = check_security("eval(user_input);");
        let de = checks.iter().find(|c| c.name == "security:dangerous_eval").unwrap();
        assert!(!de.passed);
    }

    #[test]
    fn test_dangerous_eval_ok() {
        let checks = check_security("let result = safe_compute(x);");
        let de = checks.iter().find(|c| c.name == "security:dangerous_eval").unwrap();
        assert!(de.passed);
    }

    #[test]
    fn test_missing_semicolons_detected() {
        let checks = check_syntax("let x = 1\nlet y = 2\n", "rust");
        let ms = checks.iter().find(|c| c.name == "syntax:missing_semicolons").unwrap();
        assert!(!ms.passed);
    }

    #[test]
    fn test_semicolons_present_ok() {
        let checks = check_syntax("let x = 1;\nlet y = 2;\n", "rust");
        let ms = checks.iter().find(|c| c.name == "syntax:missing_semicolons").unwrap();
        assert!(ms.passed);
    }

    #[test]
    fn test_screaming_snake_const_ok() {
        let checks = check_style("const MAX_SIZE = 100;");
        let nc = checks.iter().find(|c| c.name == "style:naming_convention").unwrap();
        assert!(nc.passed);
    }

    // ── Truncation detection tests ──

    #[test]
    fn test_truncation_clean_code() {
        let checks = check_syntax("let x = 1;\nlet y = 2;\n", "rust");
        let tr = checks.iter().find(|c| c.name == "syntax:truncation").unwrap();
        assert!(tr.passed);
        assert_eq!(tr.score, 1.0);
    }

    #[test]
    fn test_truncation_ends_with_open_brace() {
        let checks = check_syntax("fn main() {", "rust");
        let tr = checks.iter().find(|c| c.name == "syntax:truncation").unwrap();
        assert!(!tr.passed);
    }

    #[test]
    fn test_truncation_ends_with_comma() {
        let checks = check_syntax("let items = [1, 2,", "rust");
        let tr = checks.iter().find(|c| c.name == "syntax:truncation").unwrap();
        assert!(!tr.passed);
    }

    #[test]
    fn test_truncation_ellipsis_comment() {
        let checks = check_syntax("fn a() {}\n// ... rest of code", "rust");
        let tr = checks.iter().find(|c| c.name == "syntax:truncation").unwrap();
        assert!(!tr.passed);
    }

    #[test]
    fn test_truncation_ends_with_ellipsis() {
        let checks = check_syntax("let data = [...", "rust");
        let tr = checks.iter().find(|c| c.name == "syntax:truncation").unwrap();
        assert!(!tr.passed);
    }

    #[test]
    fn test_truncation_html_missing_close() {
        let checks = check_syntax("<html><body><p>Hello</p>", "rust");
        let tr = checks.iter().find(|c| c.name == "syntax:truncation").unwrap();
        assert!(!tr.passed);
    }

    #[test]
    fn test_truncation_html_complete() {
        let checks = check_syntax("<html><body></body></html>", "rust");
        let tr = checks.iter().find(|c| c.name == "syntax:truncation").unwrap();
        assert!(tr.passed);
    }

    #[test]
    fn test_truncation_css_unclosed_brace() {
        let checks = check_syntax(".foo { color: red; ", "rust");
        let tr = checks.iter().find(|c| c.name == "syntax:truncation").unwrap();
        assert!(!tr.passed);
    }

    #[test]
    fn test_truncation_short_fn() {
        let checks = check_syntax("fn main()", "rust");
        let tr = checks.iter().find(|c| c.name == "syntax:truncation").unwrap();
        assert!(!tr.passed);
    }

    #[test]
    fn test_truncation_truncated_marker() {
        let checks = check_syntax("// truncated\nlet x = 1;", "rust");
        let tr = checks.iter().find(|c| c.name == "syntax:truncation").unwrap();
        assert!(!tr.passed);
    }

    // ── Comment-exemption tests (P4: avoid false positives in comments) ──

    #[test]
    fn test_sql_injection_ignores_comment_line() {
        let checks = check_security("// SELECT * FROM users WHERE id = user_id");
        let si = checks.iter().find(|c| c.name == "security:sql_injection").unwrap();
        assert!(si.passed);
    }

    #[test]
    fn test_sql_injection_ignores_trailing_comment() {
        let checks = check_security(r#"do_work(); // SELECT * FROM users WHERE id = " + user_id"#);
        let si = checks.iter().find(|c| c.name == "security:sql_injection").unwrap();
        assert!(si.passed);
    }

    #[test]
    fn test_hardcoded_secrets_ignores_comment_line() {
        let checks = check_security("// password = \"secret123\"");
        let hs = checks.iter().find(|c| c.name == "security:hardcoded_secrets").unwrap();
        assert!(hs.passed);
    }

    #[test]
    fn test_dangerous_eval_ignores_trailing_comment() {
        let checks = check_security("let _ = 1; // eval(user_input)");
        let de = checks.iter().find(|c| c.name == "security:dangerous_eval").unwrap();
        assert!(de.passed);
    }

    #[test]
    fn test_dangerous_eval_ignores_python_comment() {
        let checks = check_security("# exec(command)");
        let de = checks.iter().find(|c| c.name == "security:dangerous_eval").unwrap();
        assert!(de.passed);
    }

    #[test]
    fn test_real_violations_still_detected_after_exemption() {
        // Sanity: real (non-comment) violations must still be caught.
        let s = check_security("eval(user_input);");
        let de = s.iter().find(|c| c.name == "security:dangerous_eval").unwrap();
        assert!(!de.passed);

        let sql = check_security(r#"let q = "SELECT * FROM t WHERE id=" + id;"#);
        let si = sql.iter().find(|c| c.name == "security:sql_injection").unwrap();
        assert!(!si.passed);

        let sec = check_security("password = \"hunter2\"");
        let hs = sec.iter().find(|c| c.name == "security:hardcoded_secrets").unwrap();
        assert!(!hs.passed);
    }
}
