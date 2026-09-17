//! Git CLI wrapper for the snapshot service.
//!
//! Encapsulates all `git` command execution with proper `--git-dir`/`--work-tree`
//! arguments and Windows-specific configuration (autocrlf, longpaths, quotepath).
//!
//! The staging algorithm here mirrors the TS `Snapshot.Service` `add()`
//! (packages/duoduo/src/snapshot/index.ts) so both entry points produce the
//! same tree in the shared shadow repo: candidate listing → source-repo ignore
//! filtering → large-file threshold → pathspec-file staging. Diverging here is
//! what produced P1-28/P2-39, so any change must be applied to both sides.

use std::io::Write as _;
use std::path::Path;
use std::process::Command;

/// Files larger than this are never staged into the shadow repo (P2-39).
/// Same constant as TS `limit` in snapshot/index.ts.
pub const MAX_STAGED_FILE_SIZE: u64 = 2 * 1024 * 1024;

/// Result of a git command execution.
pub struct GitResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl GitResult {
    pub fn success(&self) -> bool {
        self.code == 0
    }
}

/// Null device path: Windows has no `/dev/null`.
fn null_device() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

/// Configure a command to run git hermetically (no user/system config).
fn hermetic(cmd: &mut Command) {
    cmd.env("GIT_CONFIG_NOSYSTEM", "1");
    cmd.env("GIT_CONFIG_GLOBAL", null_device());
}

/// Build a git command with `--git-dir` and `--work-tree` prefix args.
fn git_cmd(gitdir: &Path, worktree: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("--git-dir")
        .arg(gitdir)
        .arg("--work-tree")
        .arg(worktree);
    // Hide the console window on Windows — snapshot git commands run at the
    // start/end of every runLoop turn, so without this a cmd window flashes
    // on each LLM dialogue boundary.
    duo_utils::platform::apply_no_window(&mut cmd);
    cmd
}

/// Execute a git command with the snapshot repo's `--git-dir`/`--work-tree` prefix.
///
/// `args` should NOT include `--git-dir`/`--work-tree` — those are prepended automatically.
/// `cwd` overrides the working directory (defaults to `worktree`).
pub fn run_git(gitdir: &Path, worktree: &Path, args: &[&str], cwd: Option<&Path>) -> GitResult {
    run_git_stdin(gitdir, worktree, args, cwd, None)
}

/// `run_git` with an optional NUL-terminated payload written to stdin.
///
/// This is how pathspec lists are fed (`--pathspec-from-file=-`), which keeps
/// spaces, special characters and non-ASCII filenames intact.
pub fn run_git_stdin(
    gitdir: &Path,
    worktree: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    stdin_nul: Option<&[String]>,
) -> GitResult {
    let mut cmd = git_cmd(gitdir, worktree);
    for arg in args {
        cmd.arg(arg);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    hermetic(&mut cmd);

    let output = match stdin_nul {
        // No payload: buffer the whole output in one call.
        None => cmd.output(),
        // Payload: feed the NUL-terminated list through stdin, then collect.
        Some(paths) => (|| -> std::io::Result<std::process::Output> {
            let mut child = cmd
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()?;
            if let Some(mut stdin) = child.stdin.take() {
                for path in paths {
                    let _ = stdin.write_all(path.as_bytes());
                    let _ = stdin.write_all(b"\0");
                }
            }
            child.wait_with_output()
        })(),
    };

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            return GitResult {
                code: -1,
                stdout: String::new(),
                stderr: format!("Failed to execute git: {}", e),
            };
        }
    };

    GitResult {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    }
}

/// Run git against the user's own repo (used for `check-ignore`).
/// Empty result when the project is not a git repo.
fn run_git_source_repo_stdin(worktree: &Path, args: &[&str], stdin_nul: &[String]) -> GitResult {
    if !worktree.join(".git").exists() {
        return GitResult {
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        };
    }
    let mut cmd = Command::new("git");
    cmd.arg("-c").arg("core.quotepath=false");
    cmd.arg("--git-dir").arg(worktree.join(".git"));
    cmd.arg("--work-tree").arg(worktree);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.current_dir(worktree);
    duo_utils::platform::apply_no_window(&mut cmd);
    hermetic(&mut cmd);

    let output = (|| -> std::io::Result<std::process::Output> {
        let mut child = cmd
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;
        if let Some(mut stdin) = child.stdin.take() {
            for path in stdin_nul {
                let _ = stdin.write_all(path.as_bytes());
                let _ = stdin.write_all(b"\0");
            }
        }
        child.wait_with_output()
    })();

    match output {
        Ok(o) => GitResult {
            code: o.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&o.stdout).to_string(),
            stderr: String::from_utf8_lossy(&o.stderr).to_string(),
        },
        Err(e) => GitResult {
            code: -1,
            stdout: String::new(),
            stderr: format!("Failed to execute git: {}", e),
        },
    }
}

/// Initialize a bare snapshot git repository.
///
/// Sets Windows-friendly config: core.autocrlf=false, core.longpaths=true,
/// core.symlinks=true, core.fsmonitor=false.
pub fn init_repo(gitdir: &Path, worktree: &Path) -> Result<(), String> {
    // Create gitdir if it doesn't exist
    std::fs::create_dir_all(gitdir)
        .map_err(|e| format!("Failed to create gitdir {:?}: {}", gitdir, e))?;

    let result = run_git(gitdir, worktree, &["init"], Some(worktree));
    if !result.success() {
        return Err(format!("git init failed: {}", result.stderr));
    }

    // Windows-friendly config (also safe on other platforms)
    let configs = [
        ("core.autocrlf", "false"),
        ("core.longpaths", "true"),
        ("core.symlinks", "true"),
        ("core.fsmonitor", "false"),
    ];
    for (key, value) in &configs {
        let result = run_git(gitdir, worktree, &["config", key, value], None);
        if !result.success() {
            return Err(format!(
                "git config {} {} failed: {}",
                key, value, result.stderr
            ));
        }
    }

    ensure_exclude_rules(gitdir);

    Ok(())
}

/// Default exclude patterns for snapshot repos.
///
/// These prevent staging build artifacts, dependency directories, and VCS
/// metadata that would make snapshot operations slow (especially on Windows
/// with NTFS + Defender) and bloat the snapshot repo.
const SNAPSHOT_EXCLUDE_RULES: &[&str] = &[
    "node_modules/",
    ".git/",
    "dist/",
    "build/",
    "target/",
    "__pycache__/",
    ".next/",
    ".nuxt/",
    ".cache/",
    "vendor/",
    "coverage/",
    "*.log",
];

/// Merge `lines` into the snapshot repo's `info/exclude` without dropping what
/// is already there (P2-41: overwriting this file silently discarded the
/// default rules and made `git add` stage node_modules).
pub fn merge_exclude_rules(gitdir: &Path, lines: &[String]) {
    let info_dir = gitdir.join("info");
    let exclude_path = info_dir.join("exclude");
    let existing = std::fs::read_to_string(&exclude_path).unwrap_or_default();
    let mut kept: Vec<String> = existing
        .lines()
        .map(|l| l.trim_end().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    for line in lines {
        if !kept.iter().any(|k| k == line) {
            kept.push(line.clone());
        }
    }
    if std::fs::create_dir_all(&info_dir).is_err() {
        return;
    }
    let mut out = kept.join("\n");
    out.push('\n');
    let _ = std::fs::write(&exclude_path, out);
}

/// Write `info/exclude` into the snapshot gitdir if it does not already exist.
///
/// This is idempotent — existing files are left untouched so that the TS
/// Snapshot.Service `sync()` can add the project's own rules on top.
pub fn ensure_exclude_rules(gitdir: &Path) {
    let exclude_path = gitdir.join("info").join("exclude");
    if exclude_path.exists() {
        return;
    }
    let defaults: Vec<String> = SNAPSHOT_EXCLUDE_RULES.iter().map(|s| s.to_string()).collect();
    merge_exclude_rules(gitdir, &defaults);
}

/// Split a NUL-delimited git listing into paths.
///
/// `-z` output is never quoted, so non-ASCII and special-character filenames
/// survive intact (P1-28: without it git octal-escapes non-ASCII names, the
/// escaped form never matches the real path, and `revert` then treats the file
/// as "did not exist in the snapshot" and DELETES it).
fn split_nul(output: &str) -> Vec<String> {
    output
        .split('\0')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// True for Windows shell redirection artifact paths (`$null`, `nul` as the
/// file name in any directory, case-insensitive). Produced by a PowerShell-style
/// `> $null` run under cmd.exe — never user content, excluded from staging.
fn is_shell_artifact(path: &str) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name.eq_ignore_ascii_case("$null") || name.eq_ignore_ascii_case("nul")
}

/// List the staging candidates: worktree-vs-index modifications plus untracked
/// files (P2-39: the TS `add()` candidate set).
fn candidates(gitdir: &Path, worktree: &Path) -> Result<Vec<String>, String> {
    let diff = run_git(
        gitdir,
        worktree,
        &[
            "-c",
            "core.quotepath=false",
            "diff-files",
            "--name-only",
            "-z",
            "--",
            ".",
        ],
        Some(worktree),
    );
    if !diff.success() {
        return Err(format!("git diff-files failed: {}", diff.stderr));
    }
    let other = run_git(
        gitdir,
        worktree,
        &[
            "-c",
            "core.quotepath=false",
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ".",
        ],
        Some(worktree),
    );
    if !other.success() {
        return Err(format!("git ls-files --others failed: {}", other.stderr));
    }

    let mut all: Vec<String> = Vec::new();
    for p in split_nul(&diff.stdout)
        .into_iter()
        .chain(split_nul(&other.stdout))
    {
        if is_shell_artifact(&p) {
            continue;
        }
        if !all.contains(&p) {
            all.push(p);
        }
    }
    Ok(all)
}

/// Stage the current worktree state the same way TS `Snapshot.add()` does.
///
/// Steps: candidates → drop source-repo-ignored paths (and unstage them) →
/// drop files above the size threshold (excluding untracked ones permanently)
/// → `git add` the remainder via a NUL pathspec file.
///
/// Returns `Err` only when staging itself fails: a partially-staged index would
/// make `write_tree` produce a baseline that does NOT represent the worktree,
/// and downstream `revert` would then treat unstaged user files as
/// "post-snapshot additions" and DELETE them (P2-40).
pub fn add_all(gitdir: &Path, worktree: &Path) -> Result<(), String> {
    let all = candidates(gitdir, worktree)?;
    if all.is_empty() {
        return Ok(());
    }

    // Source-repo ignore rules, resolved against the exact candidate set.
    // `--no-index` keeps this pattern-based even for already-tracked paths.
    let ignored = run_git_source_repo_stdin(worktree, &["check-ignore", "--no-index", "--stdin", "-z"], &all);
    let ignored: Vec<String> = if ignored.code == 0 || ignored.code == 1 {
        split_nul(&ignored.stdout)
    } else {
        Vec::new()
    };
    if !ignored.is_empty() {
        // Remove newly-ignored files from the snapshot index so they are not
        // re-added later (mirrors TS `drop()`).
        run_git_stdin(
            gitdir,
            worktree,
            &[
                "-c",
                "core.quotepath=false",
                "rm",
                "--cached",
                "-f",
                "--ignore-unmatch",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            Some(worktree),
            Some(&ignored),
        );
    }

    let allow: Vec<String> = all
        .iter()
        .filter(|p| !ignored.contains(p))
        .cloned()
        .collect();
    if allow.is_empty() {
        return Ok(());
    }

    // Large-file threshold: stat every candidate. Mirrors TS `add()`
    // (`block = untracked ∩ large`): only *untracked* oversized files are
    // excluded — they get a permanent exclude rule and are not staged.
    // Tracked oversized files stay stageable so their changes are captured by
    // the snapshot (otherwise `restore` would roll them back to stale content).
    let oversized: Vec<String> = allow
        .iter()
        .filter(|rel| {
            let abs = worktree.join(rel.as_str());
            std::fs::metadata(&abs)
                .ok()
                .map(|m| m.is_file() && m.len() > MAX_STAGED_FILE_SIZE)
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    let stageable: Vec<String> = if oversized.is_empty() {
        allow.clone()
    } else {
        let untracked = run_git(
            gitdir,
            worktree,
            &[
                "-c",
                "core.quotepath=false",
                "ls-files",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
                ".",
            ],
            Some(worktree),
        );
        let untracked: Vec<String> = if untracked.success() {
            split_nul(&untracked.stdout)
        } else {
            Vec::new()
        };
        let blocked: Vec<String> = oversized
            .iter()
            .filter(|p| untracked.contains(p))
            .cloned()
            .collect();
        let rules: Vec<String> = blocked
            .iter()
            .map(|p| format!("/{}", p.replace('\\', "/")))
            .collect();
        if !rules.is_empty() {
            merge_exclude_rules(gitdir, &rules);
        }
        allow
            .iter()
            .filter(|p| !blocked.contains(p))
            .cloned()
            .collect()
    };
    if stageable.is_empty() {
        return Ok(());
    }

    // Stage exactly the allow-listed paths (never the whole tree).
    let result = run_git_stdin(
        gitdir,
        worktree,
        &[
            "-c",
            "core.quotepath=false",
            "add",
            "--all",
            "--sparse",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ],
        Some(worktree),
        Some(&stageable),
    );
    if !result.success() {
        return Err(format!("git add --all failed: {}", result.stderr));
    }

    Ok(())
}

/// Write the current index as a tree and return the tree hash.
///
/// Equivalent to `git write-tree`.
pub fn write_tree(gitdir: &Path, worktree: &Path) -> Result<String, String> {
    let result = run_git(gitdir, worktree, &["write-tree"], Some(worktree));
    if !result.success() {
        return Err(format!("git write-tree failed: {}", result.stderr));
    }
    Ok(result.stdout.trim().to_string())
}

/// Pin a snapshot tree so `git gc` cannot prune it while it is still the
/// reference point of an active session (P2-38: trees produced by `write-tree`
/// are unreachable, so `gc --prune` deleted snapshots that sessions still
/// referenced). Older pins age out of reachability once the ref moves on,
/// which is exactly the intended retention semantics.
pub fn pin_tree(gitdir: &Path, worktree: &Path, hash: &str) {
    let result = run_git(
        gitdir,
        worktree,
        &["update-ref", "refs/duoduo/snapshot-last", hash],
        Some(worktree),
    );
    if !result.success() {
        tracing::warn!(hash = %hash, stderr = %result.stderr, "failed to pin snapshot tree (best-effort)");
    }
}

/// Check if the worktree has drifted from the index (diff-files).
///
/// Returns true if there are unstaged changes.
pub fn has_drift(gitdir: &Path, worktree: &Path) -> bool {
    let result = run_git(gitdir, worktree, &["diff-files", "--quiet"], Some(worktree));
    result.code != 0
}

/// Check if there are untracked files not in the index.
pub fn has_untracked(gitdir: &Path, worktree: &Path) -> bool {
    let result = run_git(
        gitdir,
        worktree,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ".",
        ],
        Some(worktree),
    );
    result.success() && result.stdout.split('\0').any(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_exclude_rules_preserves_existing_and_dedupes() {
        // P2-41: the exclude file must be merged, never overwritten — the
        // defaults (node_modules/ …) keep dependency trees out of snapshots.
        let dir = tempfile::tempdir().unwrap();
        let gitdir = dir.path().join("gitdir");
        std::fs::create_dir_all(gitdir.join("info")).unwrap();
        std::fs::write(gitdir.join("info").join("exclude"), "node_modules/\ndist/\n").unwrap();

        merge_exclude_rules(&gitdir, &["node_modules/".to_string(), "/tmp/oversized.bin".to_string()]);

        let out = std::fs::read_to_string(gitdir.join("info").join("exclude")).unwrap();
        assert!(out.contains("node_modules/"), "existing rule must survive, got: {out}");
        assert!(out.contains("dist/"), "existing rule must survive, got: {out}");
        assert!(out.contains("/tmp/oversized.bin"), "new rule must be added, got: {out}");
        assert_eq!(
            out.lines().filter(|l| *l == "node_modules/").count(),
            1,
            "duplicate rules must be collapsed, got: {out}"
        );
    }

    #[test]
    fn ensure_exclude_rules_seeds_defaults_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let gitdir = dir.path().join("gitdir");
        ensure_exclude_rules(&gitdir);
        let out = std::fs::read_to_string(gitdir.join("info").join("exclude")).unwrap();
        assert!(out.contains("node_modules/"), "got: {out}");
        // Idempotent: a second call must not duplicate anything.
        ensure_exclude_rules(&gitdir);
        let out2 = std::fs::read_to_string(gitdir.join("info").join("exclude")).unwrap();
        assert_eq!(out, out2);
    }
}
