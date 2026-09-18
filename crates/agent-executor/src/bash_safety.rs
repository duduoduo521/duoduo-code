//! Bash command hard-block classification shared with the TS side.
//!
//! Mirrors `packages/duoduo/src/tool/bash.ts` (`classifyCommand`). Both
//! implementations are pinned to the SAME vector file:
//! `packages/duoduo/test/fixture/bash-safety.vectors.json` — update the
//! vectors together with any rule change on either side.
//!
//! Layering inside `execute_bash` (agentic_loop.rs) — three INDEPENDENT
//! gates, all of which must pass before the child is spawned:
//!   1. `SecurityPolicy::check_command_allowed` (unchanged)
//!   2. [`blocked`] = legacy regex list + semantic overlay ([`classify`]) —
//!      the *capability* boundary: is this command something an AI may ever
//!      run, in any directory?
//!   3. [`out_of_bounds_paths`] — the *spatial* boundary: does the command
//!      touch anything outside the allowed directories?
//!
//! `auto_accept` (the user's unattended/auto-accept switch) governs ONLY the
//! permission gate, which sits above all three. It is a request for "do not
//! ask me", not for "ignore the safety boundary", so it never reaches layers
//! 1–3.

use regex::Regex;
use std::sync::LazyLock;

/// Legacy regex list — preserved verbatim from `execute_bash` (only moved).
static DANGEROUS_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"sudo\s",
        r"chown\s",
        r"mkfs",
        r"dd\s+if=",
        r">\s*/dev/(sd|hd|nvme|vda|loop|fd|hda)",  // raw block devices only; /dev/null|stdout|tty|zero stay allowed (TS parity)
        r">\s*/etc/",
        r">>\s*/etc/",
        r"\|\s*sh",
        r"\|\s*bash",
        r"\|sh",
        r"\|bash",
        r":\(\)",           // fork bomb
        r"<\(",             // process substitution
        r"exec\s",          // exec replacement
        r"find\s+.*-exec",  // find -exec execution
        r"xargs\s",         // xargs execution
        r"perl\s+-e",       // perl code execution
        r"ruby\s+-e",       // ruby code execution
    ]
    .iter()
    .map(|p| Regex::new(&format!("(?i){}", p)).expect("invariant: static regex pattern is valid"))
    .collect()
});

/// Combined hard-block verdict: legacy regexes first (behavior-compatible
/// message), then the semantic overlay. `None` = not hard-blocked.
pub fn blocked(command: &str) -> Option<String> {
    for pat in DANGEROUS_PATTERNS.iter() {
        if pat.is_match(command) {
            return Some("matches dangerous pattern".to_string());
        }
    }
    classify(command)
}

// ─── Rule tables (keep in sync with bash.ts) ────────────────────────────────

const ALWAYS_BLOCK: &[&str] = &["sudo", "shutdown", "reboot", "halt", "poweroff"];
const DESTRUCTIVE: &[&str] = &[
    "rm", "chmod", "chown", "dd", "mkfs", "shutdown", "reboot", "halt", "poweroff", "sudo",
];
const INTERPRETERS: &[&str] = &[
    "python", "python2", "python3", "perl", "ruby", "node", "bun", "deno", "php", "lua", "tclsh",
    "awk", "sh", "bash", "zsh", "dash", "ksh",
];
const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh"];
const CODE_FLAGS: &[&str] = &["-c", "-e", "-E", "--eval", "--expression"];
const WRAPPERS: &[&str] = &["env", "nohup", "nice", "time", "timeout", "command", "builtin", "doas"];
const SAFE_DEV_TARGETS: &[&str] = &["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero"];
/// Network download commands. Piping downloaded content into an interpreter
/// executes remote code — same risk class as decoder→interpreter.
const DOWNLOADERS: &[&str] = &["curl", "wget", "fetch", "aria2c", "httpie", "http"];
/// Flags that make a downloader write to a file instead of stdout. Writing to
/// a file is the first half of a "download then execute" chain; the second
/// half is a separate command and therefore invisible to any single-command
/// scan — so the first half is blocked instead.
const OUTPUT_FLAGS: &[&str] = &["-o", "-O", "--output", "--output-document"];

/// File-touching commands whose path arguments are worth checking against the
/// sandbox. Mirrors the `FILES` set in `packages/duoduo/src/tool/bash.ts` and
/// additionally covers the PowerShell cmdlets + built-in aliases the Windows
/// bash tool can now emit (the Windows sub-agent shell is PowerShell, so
/// `Remove-Item D:\elsewhere` must hit the same spatial check as `rm`).
/// All lowercase — `base_name` lowercases before lookup.
const FILES: &[&str] = &[
    "cat", "less", "more", "head", "tail", "nl", "od", "strings", "file", "stat", "wc", "cp", "mv",
    "ln", "install", "touch", "mkdir", "rmdir", "rm", "chmod", "chown", "truncate", "tee", "dd",
    "ls", "find", "du", "df", "readlink", "realpath", "basename", "dirname", "diff", "cmp",
    "patch", "grep", "egrep", "fgrep", "rg", "ag", "sed", "awk", "sort", "uniq", "cut", "paste",
    "tar", "zip", "unzip", "gzip", "gunzip", "bzip2", "xz", "open", "code", "vim", "nano", "emacs",
    // ── PowerShell cmdlets ──
    "remove-item", "copy-item", "move-item", "rename-item", "new-item", "set-item", "get-item",
    "get-content", "set-content", "add-content", "clear-content", "get-childitem",
    "out-file", "tee-object", "select-string", "compress-archive", "expand-archive",
    "export-csv", "import-csv", "invoke-item", "split-path", "join-path", "test-path",
    "set-location", "push-location", "pop-location",
    // ── PowerShell built-in aliases (not already covered above) ──
    "del", "erase", "ri", "rd", "md", "mi", "dir", "gci", "gi", "gc", "type",
    "cd", "chdir", "pushd", "popd", "ren",
];

/// A shell word plus whether its runtime value is statically invisible
/// (contains an unescaped `$` or backtick outside single quotes).
#[derive(Debug)]
struct Tok {
    text: String,
    dynamic: bool,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn unquote(t: &str) -> String {
    let b = t.as_bytes();
    if b.len() >= 2 {
        let (f, l) = (b[0], b[b.len() - 1]);
        if (f == b'"' || f == b'\'') && f == l {
            return t[1..t.len() - 1].to_string();
        }
    }
    t.to_string()
}

fn base_name(t: &str) -> String {
    let clean = unquote(t).replace('\\', "");
    clean
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_assignment(t: &str) -> bool {
    let Some(eq) = t.find('=') else { return false };
    if eq == 0 {
        return false;
    }
    t[..eq]
        .chars()
        .enumerate()
        .all(|(i, c)| c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
}

/// Split a command into pipelines; each pipeline is a list of `|`-separated
/// stages. `;`, `&&`, `||`, `&` and newlines end the current pipeline.
/// Quote- and backslash-aware so `\;` (find) and quoted separators survive.
fn pipelines(command: &str) -> Vec<Vec<String>> {
    let mut all: Vec<Vec<String>> = Vec::new();
    let mut stages: Vec<String> = Vec::new();
    let mut cur = String::new();
    let (mut sq, mut dq) = (false, false);
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' if !dq => {
                sq = !sq;
                cur.push(c);
            }
            '"' if !sq => {
                dq = !dq;
                cur.push(c);
            }
            '\\' if !sq => {
                cur.push(c);
                if let Some(n) = chars.next() {
                    cur.push(n);
                }
            }
            '|' if !sq && !dq => {
                stages.push(std::mem::take(&mut cur));
                if chars.peek() == Some(&'|') {
                    chars.next(); // `||` ends the pipeline
                    all.push(std::mem::take(&mut stages));
                }
            }
            ';' | '\n' if !sq && !dq => {
                stages.push(std::mem::take(&mut cur));
                all.push(std::mem::take(&mut stages));
            }
            '&' if !sq && !dq => {
                if chars.peek() == Some(&'&') {
                    chars.next();
                }
                stages.push(std::mem::take(&mut cur));
                all.push(std::mem::take(&mut stages));
            }
            _ => cur.push(c),
        }
    }
    stages.push(cur);
    all.push(stages);
    all.into_iter()
        .map(|p| {
            p.into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|p| !p.is_empty())
        .collect()
}

/// Whitespace-split a stage into words; a word is `dynamic` when it contains
/// `$` or a backtick outside single quotes (mirrors bash.ts `dynamic()` +
/// expansion node detection).
fn tokenize(stage: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut dynamic = false;
    let (mut sq, mut dq) = (false, false);
    let mut chars = stage.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' if !dq => {
                sq = !sq;
                cur.push(c);
            }
            '"' if !sq => {
                dq = !dq;
                cur.push(c);
            }
            '\\' if !sq => {
                cur.push(c);
                if let Some(n) = chars.next() {
                    cur.push(n);
                }
            }
            '$' | '`' if !sq => {
                dynamic = true;
                cur.push(c);
            }
            c if c.is_whitespace() && !sq && !dq => {
                if !cur.is_empty() {
                    out.push(Tok {
                        text: std::mem::take(&mut cur),
                        dynamic,
                    });
                    dynamic = false;
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(Tok { text: cur, dynamic });
    }
    out
}

/// Result of [`resolve_name`].
enum NameResolution {
    /// Statically resolved command name and index of its first argument.
    Resolved(String, usize),
    /// The command name contains an expansion (`$V`, `${V}` …) and cannot be
    /// statically verified.
    Dynamic,
    /// No command word at all (e.g. an assignment-only statement `FOO=bar`).
    Missing,
}

/// Resolve the effective command name: skip leading `VAR=…` assignments,
/// unwrap benign wrappers (env/nohup/…), and re-join whitespace-split
/// fragments so `r m -rf /` normalizes to `rm`.
fn resolve_name(toks: &[Tok]) -> NameResolution {
    let mut idx = 0;
    while idx < toks.len() && is_assignment(&toks[idx].text) {
        idx += 1;
    }
    let mut name = String::new();
    while idx < toks.len() {
        let tok = &toks[idx];
        if tok.dynamic {
            return NameResolution::Dynamic;
        }
        let n = base_name(&tok.text);
        if WRAPPERS.contains(&n.as_str()) {
            let wrapper = n;
            idx += 1;
            while idx < toks.len() {
                let t = &toks[idx].text;
                let numeric = wrapper == "timeout"
                    && t.chars().next().is_some_and(|c| c.is_ascii_digit());
                if t.starts_with('-') || is_assignment(t) || numeric {
                    idx += 1;
                } else {
                    break;
                }
            }
            continue;
        }
        name = n;
        idx += 1;
        break;
    }
    if name.is_empty() {
        return NameResolution::Missing;
    }
    // Merge short lowercase fragments toward a destructive name (`r m` → `rm`).
    let mut merged = name.clone();
    let mut j = idx;
    while j < toks.len() && merged.len() < 10 {
        let frag = base_name(&toks[j].text);
        let short = !frag.is_empty() && frag.len() <= 3 && frag.chars().all(|c| c.is_ascii_lowercase());
        if !short {
            break;
        }
        merged.push_str(&frag);
        j += 1;
        if DESTRUCTIVE.contains(&merged.as_str()) || merged.starts_with("mkfs") {
            name = merged.clone();
            idx = j;
            break;
        }
    }
    NameResolution::Resolved(name, idx)
}

/// Destructive primitives are hard-blocked only with a dangerous argument
/// signature; bare usage still goes through the permission gate.
///
/// `rm` deliberately has NO rule here: whether deleting something is safe
/// depends on *where* it is, not on the flags used. It is bounded by the
/// spatial layer ([`out_of_bounds_paths`]) instead, which also closes the
/// `find X -delete` equivalent that a flag-based rule could never cover.
fn dangerous_args(name: &str, args: &[Tok]) -> Option<String> {
    static CHOWN_R: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^-[a-z]*r[a-z]*$").expect("invariant: static regex pattern is valid"));
    let texts: Vec<String> = args.iter().map(|a| unquote(&a.text)).collect();
    match name {
        "chmod" => {
            if texts.iter().any(|t| t.contains("777") || t.contains("666")) {
                return Some("chmod with world-writable mode".to_string());
            }
        }
        "chown" => {
            if texts.iter().any(|t| CHOWN_R.is_match(t) || t == "--recursive") {
                return Some("recursive chown".to_string());
            }
        }
        "dd"
            if texts
                .iter()
                .any(|t| t.starts_with("if=") || t.starts_with("of="))
            => {
                return Some("dd with raw device/file target".to_string());
            }
        _ => {}
    }
    None
}

fn is_decoder(name: &str, args: &[Tok]) -> bool {
    static B64_D: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^-[a-z]*d[a-z]*$").expect("invariant: static regex pattern is valid"));
    let texts: Vec<String> = args.iter().map(|a| unquote(&a.text)).collect();
    match name {
        "base64" => texts.iter().any(|t| t == "--decode" || B64_D.is_match(t)),
        "xxd" => texts.iter().any(|t| t == "-r"),
        "openssl" => texts.iter().any(|t| t == "enc") && texts.iter().any(|t| t == "-d"),
        _ => false,
    }
}

/// Semantic overlay mirroring TS `classifyCommand`. `None` = not blocked.
pub fn classify(command: &str) -> Option<String> {
    // ── Raw-text rules (grammar-independent) ──
    let squeezed: String = command.chars().filter(|c| !c.is_whitespace()).collect();
    if squeezed.contains(":(){:|:&};:") {
        return Some("fork bomb".to_string());
    }
    // P0-3: a heredoc body is invisible to the stage scanner (its lines are
    // plain text tokens, not commands) — feeding it to a shell executes
    // unreviewed lines. Detect the operator shape: `<<`/`<<-` followed by a
    // delimiter word (optionally quoted) that ends the line. An arithmetic
    // left shift never matches (the line continues after the shifted value),
    // and `<<<` (here-string) cannot match because of the `[^<]` guard.
    static HEREDOC: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?m)(?:^|[^<])<<-?[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*|'[^']*'|"[^"]*")[ \t]*(?:#.*)?\r?$"#)
            .expect("invariant: static regex pattern is valid")
    });
    if HEREDOC.is_match(command) {
        return Some(
            "heredoc body cannot be scanned — write the payload to a temp file and run it instead"
                .to_string(),
        );
    }
    static REDIRECT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r">{1,2}\s*([^\s;|&<>]+)").expect("invariant: static regex pattern is valid"));
    for cap in REDIRECT.captures_iter(command) {
        let target = unquote(&cap[1]);
        if target.starts_with("/dev/") && !SAFE_DEV_TARGETS.contains(&target.as_str()) {
            return Some(format!("redirect to raw device {target}"));
        }
        if target.starts_with("/etc/") {
            return Some(format!("redirect into {target}"));
        }
    }

    // ── Stage-level rules ──
    for pipeline in pipelines(command) {
        let mut decoder_at: Option<usize> = None;
        let mut downloader_at: Option<usize> = None;
        for (i, stage) in pipeline.iter().enumerate() {
            let toks = tokenize(stage);
            if toks.is_empty() {
                continue;
            }
            let (name, args_start) = match resolve_name(&toks) {
                NameResolution::Resolved(name, args_start) => (name, args_start),
                // Fail-closed: a dynamic command name (`$V …`, `a=rm; $a …`)
                // cannot be statically verified — block it outright instead
                // of falling through to the permission gate, which
                // auto-accept modes would silently bypass.
                NameResolution::Dynamic => {
                    return Some(
                        "dynamic command name cannot be statically verified".to_string(),
                    )
                }
                // Assignment-only statement (`FOO=bar`) has no command word.
                NameResolution::Missing => continue,
            };
            let args = &toks[args_start.min(toks.len())..];

            if ALWAYS_BLOCK.contains(&name.as_str()) || name.starts_with("mkfs") {
                return Some(format!("{name} is not allowed"));
            }
            if let Some(sig) = dangerous_args(&name, args) {
                return Some(sig);
            }

            // P0-5: a DESTRUCTIVE command with an expanded (hidden) argument
            // bypasses the spatial bound — the runtime path is invisible to
            // the scan. Hard-block (unattended hard-deny, no ask), with the
            // fix in the message.
            if DESTRUCTIVE.contains(&name.as_str()) && args.iter().any(|a| a.dynamic) {
                return Some(format!(
                    "{name} with expanded (hidden) argument — expand the variable to a concrete path and re-run"
                ));
            }

            // Downloading to a file: see [`OUTPUT_FLAGS`].
            if DOWNLOADERS.contains(&name.as_str())
                && args
                    .iter()
                    .any(|a| OUTPUT_FLAGS.contains(&unquote(&a.text).as_str()))
            {
                return Some(format!("{name} writing to a file"));
            }

            if name == "find"
                && let Some(p) = args
                    .iter()
                    .position(|a| a.text == "-exec" || a.text == "-execdir" || a.text == "-ok")
                    && let Some(sub) = args.get(p + 1) {
                        let sub_name = base_name(&sub.text);
                        if DESTRUCTIVE.contains(&sub_name.as_str()) {
                            return Some(format!("find -exec {sub_name}"));
                        }
                    }
            if name == "xargs"
                && let Some(first) = args.iter().find(|a| !a.text.starts_with('-')) {
                    let sub = base_name(&first.text);
                    if DESTRUCTIVE.contains(&sub.as_str()) {
                        return Some(format!("xargs {sub}"));
                    }
                }

            // eval/exec with expanded payload = statically invisible code.
            if (name == "eval" || name == "exec") && args.iter().any(|a| a.dynamic) {
                return Some(format!("{name} with expanded (hidden) payload"));
            }

            if is_decoder(&name, args) && decoder_at.is_none() {
                decoder_at = Some(i);
            }
            if DOWNLOADERS.contains(&name.as_str()) && downloader_at.is_none() {
                downloader_at = Some(i);
            }

            // decode stage → interpreter stage in the SAME pipeline.
            if INTERPRETERS.contains(&name.as_str()) {
                if let Some(d) = decoder_at
                    && d < i {
                        return Some("decoded payload piped into interpreter".to_string());
                    }
                // download stage → interpreter stage = remote code execution.
                if let Some(d) = downloader_at
                    && d < i {
                        return Some("downloaded payload piped into interpreter".to_string());
                    }
            }
            // piping anything into a shell executes hidden input.
            if SHELLS.contains(&name.as_str()) && i > 0 {
                return Some(format!("piping into {name}"));
            }
            // interpreter code flag with expanded (or missing) payload.
            if INTERPRETERS.contains(&name.as_str())
                && let Some(fi) = args.iter().position(|a| CODE_FLAGS.contains(&a.text.as_str())) {
                    let payload = args.get(fi + 1);
                    if payload.is_none() || payload.is_some_and(|p| p.dynamic) {
                        return Some(format!(
                            "{name} {} with expanded (hidden) payload",
                            args[fi].text
                        ));
                    }
                }
        }
    }
    None
}

/// Collect absolute path arguments of file-touching commands that fall outside
/// `allowed` — the bash counterpart of the file tools' `check_path_access`.
///
/// Scope, stated plainly: this is a *misfire guard*, not an adversarial
/// boundary. It reuses the quote/`$`-aware tokenizer above, so quoting and
/// obvious expansions are handled, but a shell can always reach a path this
/// cannot see statically — via a variable, `cd` plus a relative path, command
/// substitution, or a symlink. Those cases fall through to the existing
/// hard-block list and the permission gate. Enforcing them properly requires
/// OS-level confinement, not string analysis; pretending otherwise would be
/// worse than being explicit about the limit.
///
/// Relative paths are resolved against `cwd` (the directory the child runs
/// in) and normalized lexically, so `../..` cannot escape by staying relative.
/// Dynamic tokens are skipped rather than blocked, because `classify` already
/// fails closed on dynamic *command names*, and blocking every `$VAR` argument
/// would break ordinary commands like `ls "$HOME/x"` inside the project.
pub fn out_of_bounds_paths(
    command: &str,
    cwd: &std::path::Path,
    allowed: &[std::path::PathBuf],
) -> Vec<String> {
    let roots: Vec<std::path::PathBuf> = allowed.iter().map(|p| normalize(p)).collect();
    let mut found = Vec::new();
    for pipeline in pipelines(command) {
        for stage in pipeline {
            let toks = tokenize(&stage);
            if toks.is_empty() {
                continue;
            }
            let NameResolution::Resolved(name, args_start) = resolve_name(&toks) else {
                continue;
            };
            if !FILES.contains(&name.as_str()) {
                continue;
            }
            for tok in &toks[args_start.min(toks.len())..] {
                if tok.dynamic {
                    continue;
                }
                // Trailing shell punctuation survives whitespace splitting
                // (e.g. the `)` in `$(echo /etc/passwd)`); strip it so the
                // reported path is the real one rather than `/etc/passwd)`.
                let text = unquote(&tok.text)
                    .trim_end_matches([')', ';', ',', '"', '\''])
                    .to_string();
                // Skip flags.
                if text.starts_with('-') {
                    continue;
                }
                let path = normalize(&resolve_against(cwd, &text));
                if roots.iter().any(|root| path.starts_with(root)) {
                    continue;
                }
                if !found.contains(&text) {
                    found.push(text);
                }
            }
        }
    }
    found
}

// ─── P0-4: nested command payloads ─────────────────────────────────────────
//
// A shell `-c` literal payload or a `find -exec`/`xargs` sub-command is a full
// command in its own right; the top-level scan must see it. Each nesting level
// runs BOTH gates — [`blocked`] (capability) and [`out_of_bounds_paths`]
// (spatial) — mirroring the TS `scanNestedCommands` in bash.ts. Depth-capped
// (`bash -c "bash -c \"bash -c …\""` nesting must not recurse unbounded).

/// Direct (level-1) payloads of `command`: shell `-c` literals, `find`
/// `-exec`/`-execdir`/`-ok` sub-commands, `xargs` sub-commands.
fn direct_payloads(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    for pipeline in pipelines(command) {
        for stage in pipeline {
            let toks = tokenize(&stage);
            if toks.is_empty() {
                continue;
            }
            let (name, args_start) = match resolve_name(&toks) {
                NameResolution::Resolved(name, args_start) => (name, args_start),
                _ => continue,
            };
            let args = &toks[args_start.min(toks.len())..];
            let payload: Option<String> = if SHELLS.contains(&name.as_str()) {
                args.iter()
                    .position(|a| a.text == "-c")
                    .and_then(|i| args.get(i + 1))
                    .filter(|p| !p.dynamic)
                    .map(|p| unquote(&p.text))
            } else if name == "find" {
                args.iter()
                    .position(|a| a.text == "-exec" || a.text == "-execdir" || a.text == "-ok")
                    .and_then(|i| {
                        let rest = &args[i + 1..];
                        // The sub-command ends at the terminating `;` / `\;`.
                        let end = rest
                            .iter()
                            .position(|a| a.text == ";" || a.text == "\\;")
                            .unwrap_or(rest.len());
                        let joined = rest[..end]
                            .iter()
                            .map(|a| a.text.clone())
                            .collect::<Vec<_>>()
                            .join(" ");
                        if joined.is_empty() { None } else { Some(joined) }
                    })
            } else if name == "xargs" {
                let joined = args
                    .iter()
                    .filter(|a| !a.text.starts_with('-'))
                    .map(|a| a.text.clone())
                    .collect::<Vec<_>>()
                    .join(" ");
                if joined.is_empty() { None } else { Some(joined) }
            } else {
                None
            };
            if let Some(inner) = payload {
                let inner = inner.trim().to_string();
                if !inner.is_empty() {
                    out.push(inner);
                }
            }
        }
    }
    out
}

fn nested_walk(
    command: &str,
    depth: usize,
    cwd: &std::path::Path,
    allowed: &[std::path::PathBuf],
) -> Option<String> {
    if depth > 3 {
        return Some("nested command payload beyond depth 3".to_string());
    }
    for inner in direct_payloads(command) {
        if let Some(reason) = blocked(&inner) {
            return Some(format!("nested command: {reason}"));
        }
        if let Some(first) = out_of_bounds_paths(&inner, cwd, allowed).first() {
            return Some(format!(
                "nested command writes outside the allowed directories: {first}"
            ));
        }
        if let Some(v) = nested_walk(&inner, depth + 1, cwd, allowed) {
            return Some(v);
        }
    }
    None
}

/// P0-4: run the capability AND spatial gates over every nested payload of
/// `command`. Call this from `execute_bash` right after `blocked` and
/// P1-16: Explore mode is read-only. A `bash` call can still mutate the
/// worktree through redirections or in-place edits even though no write tool
/// was named. Returns a rejection reason when the command carries a write
/// form; ordinary read-only commands run normally.
pub fn explore_bash_write_reason(command: &str) -> Option<String> {
    // Reuse the full semantic classifier first (DESTRUCTIVE / heredoc / etc.).
    if let Some(reason) = classify(command) {
        return Some(reason);
    }
    // Explore runs non-interactive: bare DESTRUCTIVE / ALWAYS_BLOCK usage that
    // would normally land on the permission gate has no user to ask — deny.
    for seg in command.split(|c: char| c == ';' || c == '|' || c == '&' || c == '\n') {
        if let Some(tok) = seg.split_whitespace().next() {
            let name = base_name(tok);
            if ALWAYS_BLOCK.contains(&name.as_str()) || DESTRUCTIVE.contains(&name.as_str()) {
                return Some(format!(
                    "{name} is a destructive command — Explore mode is read-only and non-interactive"
                ));
            }
        }
    }
    static WRITE_FORM: LazyLock<Regex> = LazyLock::new(|| {
        // Write forms: `> file` / `>> file` (fd-prefixed `2> x` and `>&1`
        // excluded — those redirect stderr, not files), `sed -i`, tee/dd/
        // truncate/shred (write by nature). `(?:^|[^\w-])` anchors command
        // names at word starts, including the beginning of the line.
        Regex::new(
            r"(?:(?:^|[^\d>])>{1,2}\s*[^\s&]|(?:^|[^\w-])(?:sed[^\n]*\s-i(?:\s|$)|tee\s|dd\s|truncate\s|shred\s))",
        )
        .unwrap()
    });
    if WRITE_FORM.is_match(command) {
        return Some(
            "bash write form (redirection / in-place edit) — Explore mode is read-only; use a write tool outside Explore or drop the redirection".to_string(),
        );
    }
    None
}

/// `out_of_bounds_paths`, with the same `cwd`/`allowed` arguments.
pub fn nested_violation(
    command: &str,
    cwd: &std::path::Path,
    allowed: &[std::path::PathBuf],
) -> Option<String> {
    nested_walk(command, 0, cwd, allowed)
}

/// Are we looking at a path that does not need joining onto `cwd`?
///
/// `Path::is_absolute()` is false on Windows for a rooted-but-prefix-less
/// path like `/etc/passwd`, which the caller still means as absolute.
fn is_absoluteish(text: &str) -> bool {
    let path = std::path::Path::new(text);
    path.is_absolute() || text.starts_with('/') || text.starts_with('\\')
}

/// Join `text` onto `cwd` unless it is already absolute.
fn resolve_against(cwd: &std::path::Path, text: &str) -> std::path::PathBuf {
    let candidate = std::path::Path::new(text);
    if is_absoluteish(text) {
        candidate.to_path_buf()
    } else {
        cwd.join(candidate)
    }
}

/// Fold `.` and `..` without touching the filesystem.
///
/// Deliberately lexical: a symlink is NOT resolved, so a link pointing out of
/// the project is not caught here. Resolving it would need `canonicalize()`,
/// which fails for paths that do not exist yet — the normal case for a write
/// target. See SECURITY.md (known limitation: symlink escape).
fn normalize(path: &std::path::Path) -> std::path::PathBuf {
    let mut out = std::path::PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins Rust behavior to the shared vector file also consumed by the TS
    /// test (packages/duoduo/test/tool/bash-safety.test.ts). Any rule drift
    /// between the two implementations fails here or there.
    #[test]
    fn shared_vectors_parity() {
        let raw = include_str!("../../../packages/duoduo/test/fixture/bash-safety.vectors.json");
        let json: serde_json::Value = serde_json::from_str(raw).expect("valid vectors json");
        let vectors = json["vectors"].as_array().expect("vectors array");
        assert!(!vectors.is_empty());
        for v in vectors {
            let cmd = v["command"].as_str().expect("command");
            let expect_block = v["rust"].as_str().expect("rust verdict") == "block";
            let got = blocked(cmd);
            assert_eq!(
                got.is_some(),
                expect_block,
                "command {cmd:?}: expected {} but got {:?}",
                if expect_block { "block" } else { "allow" },
                got
            );
            // P5: true dual-side parity. The assertion above only pins Rust to
            // the `rust` column; it never compares `ts` vs `rust`. That let the 9
            // ts:allow / rust:block divergences sit green on both sides. Now the
            // two columns must be identical — any future drift fails here.
            let ts = v["ts"].as_str().expect("ts verdict");
            let rust = v["rust"].as_str().expect("rust verdict");
            assert_eq!(
                ts, rust,
                "command {cmd:?}: ts ({ts}) and rust ({rust}) must agree"
            );
        }
    }

    // ── P1-16: Explore bash write-form detection ──
    #[test]
    fn explore_bash_write_forms_are_blocked() {
        assert!(explore_bash_write_reason("echo hi > /tmp/leak").is_some());
        assert!(explore_bash_write_reason("echo hi >> /tmp/leak").is_some());
        assert!(explore_bash_write_reason("sed -i 's/a/b/' src/main.rs").is_some());
        assert!(explore_bash_write_reason("cat f | tee /tmp/out").is_some());
        assert!(explore_bash_write_reason("rm -rf /").is_some()); // via classify
    }

    #[test]
    fn explore_bash_read_forms_pass() {
        assert!(explore_bash_write_reason("ls -la").is_none());
        assert!(explore_bash_write_reason("grep -r TODO src").is_none());
        assert!(explore_bash_write_reason("cat big.log 2>/dev/null | head").is_none());
        assert!(explore_bash_write_reason("echo hi >&2").is_none());
        assert!(explore_bash_write_reason("git log --oneline").is_none());
    }

    // ── P0-3 / P0-4 / P0-5: heredoc, nested payloads, dynamic destructive ──

    #[test]
    fn heredoc_is_blocked_and_arithmetic_shift_is_not() {
        assert!(blocked("cat <<EOF\nline\nEOF").is_some());
        assert!(blocked("cat <<- 'EOF'\nrm -rf /\nEOF").is_some());
        assert!(blocked("echo $((1 << 2))").is_none());
    }

    #[test]
    fn destructive_with_expanded_argument_is_blocked() {
        assert!(blocked("rm -rf $TARGET").is_some());
        assert!(blocked("dd if=$A of=$B").is_some());
        // Non-destructive commands with expansions stay at the ask gate.
        assert!(blocked("echo $HOME").is_none());
        assert!(blocked("cat $SECRET").is_none());
    }

    mod nested {
        use super::*;

        fn roots() -> Vec<std::path::PathBuf> {
            vec![std::path::PathBuf::from("/work/project-a")]
        }

        fn cwd() -> std::path::PathBuf {
            std::path::PathBuf::from("/work/project-a")
        }

        #[test]
        fn nested_sudo_payload_is_blocked() {
            assert!(
                nested_violation(
                    "bash -c 'sudo apt-get install curl'",
                    &cwd(),
                    &roots()
                )
                .is_some()
            );
        }

        #[test]
        fn find_exec_nested_destructive_is_blocked() {
            assert!(
                nested_violation(
                    "find . -type f -exec sh -c 'sudo rm -rf /' \\;",
                    &cwd(),
                    &roots()
                )
                .is_some()
            );
        }

        #[test]
        fn nested_spatial_escape_is_blocked() {
            // The classifier allows `rm -rf /tmp/leak` (rm has no capability
            // rule); the nested SPATIAL gate must catch the out-of-bounds path.
            assert!(
                nested_violation("bash -c 'rm -rf /tmp/leak'", &cwd(), &roots()).is_some()
            );
        }

        #[test]
        fn benign_nested_payload_is_allowed() {
            assert!(nested_violation("bash -c 'echo hi'", &cwd(), &roots()).is_none());
            assert!(nested_violation("find . -exec grep TODO {} \\;", &cwd(), &roots()).is_none());
        }

        #[test]
        fn depth_cap_trips_at_four() {
            // The cap is keyed on payload nesting depth (each `-c`/`-exec`
            // level adds one). Verified directly: at depth 4 the walk refuses
            // to classify further and reports the cap, even for a benign
            // command.
            assert_eq!(
                nested_walk("echo x", 4, &cwd(), &roots()),
                Some("nested command payload beyond depth 3".to_string())
            );
            assert!(nested_walk("echo x", 3, &cwd(), &roots()).is_none());
        }
    }

    mod out_of_bounds {
        use super::*;
        use std::path::{Path, PathBuf};

        fn roots() -> Vec<PathBuf> {
            vec![PathBuf::from("/work/project-a")]
        }

        fn cwd() -> PathBuf {
            PathBuf::from("/work/project-a")
        }

        fn scan(command: &str) -> Vec<String> {
            out_of_bounds_paths(command, &cwd(), &roots())
        }

        #[test]
        fn flags_absolute_paths_outside_the_allow_list() {
            assert_eq!(scan("cat /etc/passwd"), vec!["/etc/passwd".to_string()]);
            assert_eq!(
                scan("cp /work/project-a/a.txt /tmp/leak"),
                vec!["/tmp/leak".to_string()]
            );
        }

        #[test]
        fn allows_paths_inside_any_allowed_root() {
            assert!(scan("cat /work/project-a/src/main.rs").is_empty());
            // A second root is what makes approved cross-project work possible.
            let multi = vec![
                PathBuf::from("/work/project-a"),
                PathBuf::from("/work/project-b"),
            ];
            assert!(
                out_of_bounds_paths("cat /work/project-b/src/lib.rs", &cwd(), &multi).is_empty()
            );
        }

        #[test]
        fn resolves_relative_paths_against_cwd() {
            // `../..` leaves the project even though it never looks absolute.
            assert_eq!(scan("rm -rf ../../"), vec!["../../".to_string()]);
            assert_eq!(
                scan("rm -rf ../../../etc/passwd"),
                vec!["../../../etc/passwd".to_string()]
            );
            // Inside the project a relative path is in-bounds by construction.
            assert!(scan("rm -rf node_modules").is_empty());
            assert!(scan("rm -rf ./build/../build").is_empty());
        }

        #[test]
        fn finds_delete_is_bounded_by_its_search_root() {
            // The flag that used to make `find` an unguarded `rm -rf`
            // equivalent is now subject to the same spatial bound.
            assert!(scan("find . -name '*.tmp' -delete").is_empty());
            assert_eq!(scan("find / -delete"), vec!["/".to_string()]);
            assert_eq!(
                scan("find /etc -name '*.conf' -delete"),
                vec!["/etc".to_string()]
            );
        }

        #[test]
        fn ignores_flags() {
            assert!(scan("ls -la src/").is_empty());
            assert!(scan("grep -rn foo .").is_empty());
            assert!(scan("chmod +x build.sh").is_empty());
        }

        #[test]
        fn only_inspects_file_touching_commands() {
            // `echo` does not read the path, so it is not a sandbox escape.
            assert!(scan("echo /etc/passwd").is_empty());
        }

        #[test]
        fn sees_through_quoting_and_pipeline_stages() {
            assert_eq!(scan("cat \"/etc/passwd\""), vec!["/etc/passwd".to_string()]);
            assert_eq!(scan("echo hi | tee /etc/motd"), vec!["/etc/motd".to_string()]);
            // `cd` is scanned too (TS FILES parity): both stages report.
            assert_eq!(
                scan("cd /tmp && cat /root/.ssh/id_rsa"),
                vec!["/tmp".to_string(), "/root/.ssh/id_rsa".to_string()]
            );
        }

        #[test]
        fn normalization_is_lexical_not_symlink_resolving() {
            // Documented: a symlink is not followed, so this is a known
            // limitation rather than an accidental hole.
            assert_eq!(
                normalize(Path::new("/work/project-a/link/../../etc")),
                PathBuf::from("/work/etc")
            );
            // Popping above the root is a no-op, exactly as `/..` == `/` in
            // POSIX — so an escape attempt can never normalize back inside.
            assert_eq!(normalize(Path::new("/../etc")), PathBuf::from("/etc"));
            assert_eq!(normalize(Path::new("/../../etc")), PathBuf::from("/etc"));
        }

        /// Documents the known blind spots. These are NOT accidental omissions:
        /// static analysis of a shell command cannot resolve runtime values, so
        /// this guard is scoped to mistakes and blunt overreach. Anything
        /// stronger needs OS-level confinement. Encoded as a test so the
        /// boundary is explicit and any future change to it is deliberate.
        #[test]
        fn known_bypasses_are_not_caught() {
            // Runtime-only value: invisible to any static scan.
            assert!(scan("cat $SECRET").is_empty());
            assert!(scan("rm -rf $TARGET").is_empty());
            // `cd` is scanned (TS FILES parity), so `cd /etc` itself reports.
            // The residual hole stands: the RELATIVE path after `cd` still
            // resolves against the child's cwd (the project), so `cat passwd`
            // is not caught — changing the resolution base per stage would
            // need real shell emulation.
            assert_eq!(scan("cd /etc && cat passwd"), vec!["/etc".to_string()]);

            // Command substitution is only caught incidentally: whitespace
            // splitting leaves `/etc/passwd)` as its own token, so a literal
            // path inside `$(…)` is still seen. Asserted as-is rather than
            // claimed as a guarantee — `cat $(printf /etc/pas;printf swd)`
            // would slip through.
            assert_eq!(
                scan("cat $(echo /etc/passwd)"),
                vec!["/etc/passwd".to_string()]
            );
        }

        #[test]
        fn empty_allow_list_means_unrestricted() {
            // Mirrors SecurityPolicy rule 3; the caller is responsible for
            // always supplying at least the project root.
            assert_eq!(
                out_of_bounds_paths("cat /etc/passwd", &cwd(), &[]),
                vec!["/etc/passwd".to_string()],
                "the function itself reports; suppression is the caller's job"
            );
        }
    }
}
