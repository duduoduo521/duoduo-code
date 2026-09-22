//! P4 filesystem edge-case verification (机制缺陷.md §1.5 P4-01/03/04).
//!
//! These tests exercise the REAL track/restore plumbing (git CLI against a
//! shadow gitdir) on the real filesystem, so their value comes from actually
//! running on NTFS / APFS / ext4 — which is what the `p4-fs.yml` workflow
//! (three-platform matrix) provides.
//!
//! - P4-01: non-ASCII / spaces / emoji filenames survive track → rename →
//!   restore byte-exactly (all platforms).
//! - P4-03: read-only files and exclusively-locked files (Windows only).
//! - P4-04: >260-char paths and reserved device names `CON` / `NUL` (Windows).
//!
//! Rust no longer owns restore (P3-04: TS `Snapshot.restore` owns rollback),
//! so the restore leg of these tests re-issues the exact same git plumbing
//! TS shells out (`read-tree` + `checkout-index -a -f` + E1 cleanup) — same
//! commands, same flags, same env-var trick for the throwaway index.
#![cfg(test)]

use super::SnapshotService;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

// ─── helpers ────────────────────────────────────────────────────────────────

/// A worktree + shadow gitdir pair, both backed by real temp dirs.
struct Fixture {
    service: SnapshotService,
    worktree: PathBuf,
    gitdir: PathBuf,
    _worktree_dir: tempfile::TempDir,
    _gitdir_dir: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let worktree_dir = tempfile::tempdir().expect("worktree tempdir");
    let gitdir_parent = tempfile::tempdir().expect("gitdir tempdir");
    // The gitdir itself must NOT pre-exist: production `track()` samples
    // `gitdir.exists()` and skips `init_repo` when it does, so an empty
    // pre-created dir would make every git call fail with "not a git
    // repository". Let `init_repo` create it on first track, like production.
    let gitdir = gitdir_parent.path().join("snapshot-gitdir");
    let worktree = worktree_dir.path().to_path_buf();
    let service = SnapshotService::new(gitdir.clone(), worktree.clone());
    Fixture {
        service,
        worktree,
        gitdir,
        _worktree_dir: worktree_dir,
        _gitdir_dir: gitdir_parent,
    }
}

/// Raw `git` invocation with the shadow-repo prefix, mirroring
/// `git_ops::run_git` but with env support (needed for `GIT_INDEX_FILE`).
/// Returns `(exit code, stdout, stderr)`.
fn run_git_raw(gitdir: &Path, worktree: &Path, args: &[&str], envs: &[(&str, &str)]) -> (i32, String, String) {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-c").arg("core.quotepath=false");
    cmd.arg("--git-dir").arg(gitdir);
    cmd.arg("--work-tree").arg(worktree);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.current_dir(worktree);
    for (key, value) in envs {
        cmd.env(key, value);
    }
    duo_utils::platform::apply_no_window(&mut cmd);
    match cmd.output() {
        Ok(out) => (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).to_string(),
            String::from_utf8_lossy(&out.stderr).to_string(),
        ),
        Err(e) => (-1, String::new(), format!("failed to spawn git: {e}")),
    }
}

/// `git ls-tree -r -z --name-only <hash>` — the file list of a snapshot tree.
/// `-z` keeps paths as raw bytes (no octal escaping), which is exactly how the
/// non-ASCII names below survive the assertion.
fn ls_tree_names(gitdir: &Path, worktree: &Path, hash: &str) -> Vec<String> {
    let (code, stdout, stderr) = run_git_raw(gitdir, worktree, &["ls-tree", "-r", "-z", "--name-only", hash], &[]);
    assert_eq!(code, 0, "ls-tree failed: {stderr}");
    stdout.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect()
}

/// Mirror of the TS `Snapshot.restore` pipeline (`snapshot/index.ts`):
/// `read-tree <hash>` → `checkout-index -a -f` → E1 cleanup (delete worktree
/// files absent from the restored tree, via a throwaway index). Returns
/// `Err` exactly where TS fails loudly.
fn emulate_ts_restore(gitdir: &Path, worktree: &Path, hash: &str) -> Result<(), String> {
    let (code, _, stderr) = run_git_raw(gitdir, worktree, &["read-tree", hash], &[]);
    if code != 0 {
        return Err(format!("read-tree failed: {stderr}"));
    }
    let (code, _, stderr) = run_git_raw(gitdir, worktree, &["checkout-index", "-a", "-f"], &[]);
    if code != 0 {
        return Err(format!("checkout-index failed: {stderr}"));
    }

    // E1 cleanup — same steps as TS: keep-set from the restored tree, current
    // set from a throwaway index (never the persistent shadow index).
    let keep: HashSet<String> = ls_tree_names(gitdir, worktree, hash).into_iter().collect();
    let tmp_index = gitdir.join("index.restore-cleanup.fs-edge-test");
    let tmp_str = tmp_index.to_string_lossy().into_owned();
    let envs = [("GIT_INDEX_FILE", tmp_str.as_str())];
    let (code, _, stderr) = run_git_raw(gitdir, worktree, &["add", "-A"], &envs);
    if code != 0 {
        let _ = fs::remove_file(&tmp_index);
        return Err(format!("throwaway add -A failed: {stderr}"));
    }
    let (code, stdout, stderr) = run_git_raw(gitdir, worktree, &["ls-files", "-z"], &envs);
    let _ = fs::remove_file(&tmp_index);
    if code != 0 {
        return Err(format!("throwaway ls-files failed: {stderr}"));
    }
    for name in stdout.split('\0').filter(|s| !s.is_empty()) {
        if !keep.contains(name) {
            let _ = fs::remove_file(worktree.join(name));
        }
    }
    Ok(())
}

// ─── Windows CI regression: a shell gitdir must self-heal on track ─────────
//
// On windows-latest CI every snapshot track failed with "not a git
// repository" (77x in one e2e run) while mac/linux never failed: something
// created the gitdir DIRECTORY before the first track, the old
// `gitdir.exists()` sample skipped `git init` forever, and every git call
// saw a structureless directory. Regression: a pre-created shell must be
// initialized (healed) by the first track, not poison it.

#[test]
fn track_self_heals_a_shell_gitdir_created_by_a_third_party() {
    let fx = fixture();
    // Simulate the CI failure: the gitdir exists but has no git structure.
    std::fs::create_dir_all(&fx.gitdir).expect("create shell gitdir");

    let hash = fx
        .service
        .track()
        .expect("first track must initialize the shell gitdir, not fail");
    assert!(!hash.is_empty(), "track must return a tree hash");

    // The healed repo stays usable for subsequent tracks.
    let hash2 = fx.service.track().expect("second track must succeed");
    assert!(!hash2.is_empty());
}

// ─── P4-01: non-ASCII filenames through the full track/rename/restore chain ─

#[test]
fn p4_01_non_ascii_rename_track_and_restore_roundtrip() {
    let fx = fixture();
    // (original name, content, renamed-to, new content)
    let cases: &[(&str, &str, &str, &str)] = &[
        ("中文文档.py", "print('中文内容')\n", "中文文档_重命名.py", "print('中文内容 v2')\n"),
        ("日本語のファイル.js", "const x = 'テスト';\n", "日本語_変更後.js", "const x = 'テスト2';\n"),
        ("emoji 🚀 test.ts", "export const e = '🚀';\n", "emoji 🌟 改名.ts", "export const e = '🌟';\n"),
        ("file with spaces.md", "# spaces\n", "renamed with spaces.md", "# spaces v2\n"),
    ];

    for (name, content, _, _) in cases {
        fs::write(fx.worktree.join(name), content).expect("seed file");
    }

    let h1 = fx.service.track().expect("first track");
    assert!(!h1.is_empty());

    // Rename (old name gone, new name appears) + edit content — the exact
    // mid-session shape a user rollback must survive.
    for (name, _, renamed, new_content) in cases {
        fs::rename(fx.worktree.join(name), fx.worktree.join(renamed)).expect("rename");
        fs::write(fx.worktree.join(renamed), new_content).expect("rewrite");
    }
    // Mirror the watcher marking the service dirty after external edits.
    *fx.service.dirty.lock().unwrap_or_else(|e| e.into_inner()) = true;
    let h2 = fx.service.track().expect("second track");
    assert_ne!(h1, h2, "rename + edit must produce a different tree");

    // Both trees must carry the exact Unicode names (no mojibake, no octal
    // escapes, no filesystem-dependent mangling).
    let names1 = ls_tree_names(&fx.gitdir, &fx.worktree, &h1);
    let names2 = ls_tree_names(&fx.gitdir, &fx.worktree, &h2);
    for (name, _, _, _) in cases {
        assert!(
            names1.iter().any(|n| n == name),
            "pre-rename tree must contain {name:?}, got {names1:?}"
        );
    }
    for (_, _, renamed, _) in cases {
        assert!(
            names2.iter().any(|n| n == renamed),
            "post-rename tree must contain {renamed:?}, got {names2:?}"
        );
    }

    // Restore h1 through the same plumbing TS restore uses: the original
    // names must come back byte-exactly with the original contents, and the
    // post-snapshot renames must be pruned by the E1 cleanup.
    emulate_ts_restore(&fx.gitdir, &fx.worktree, &h1).expect("restore to h1");
    for (name, content, renamed, _) in cases {
        let restored = fx.worktree.join(name);
        assert!(restored.exists(), "restored file {name:?} must exist");
        assert_eq!(
            fs::read_to_string(&restored).unwrap(),
            *content,
            "restored content of {name:?} must be byte-exact"
        );
        assert!(!fx.worktree.join(renamed).exists(), "post-snapshot file {renamed:?} must be pruned");
    }
}

// ─── P4-03/04: Windows-only filesystem semantics ────────────────────────────

#[cfg(windows)]
mod windows_only {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;

    /// dwShareMode 0 = FILE_SHARE_NONE: no other process can open the file for
    /// read/write/delete until the handle is closed. (Note: `share_mode`, not
    /// `custom_flags` — the latter feeds dwFlagsAndAttributes.)
    const FILE_SHARE_NONE: u32 = 0;

    /// `\\?\`-verbatim form of `path` — the only way to address reserved
    /// device names (`CON`, `NUL`, ...) as regular files.
    fn verbatim(path: &Path) -> PathBuf {
        let raw = path.as_os_str().to_string_lossy();
        if raw.starts_with("\\\\?\\") {
            path.to_path_buf()
        } else {
            PathBuf::from(format!("\\\\?\\{raw}"))
        }
    }

    // ── P4-03a: read-only attribute must not break track or restore ──

    #[test]
    fn p4_03_read_only_file_track_and_restore_succeed() {
        let fx = fixture();
        let file = fx.worktree.join("readonly.txt");
        fs::write(&file, "v1\n").unwrap();

        let h1 = fx.service.track().expect("track with a normal file");

        // Make it read-only and bump the content (temporarily clearing the
        // attribute just for the write, as editors do).
        let set_ro = |ro: bool| {
            let mut perm = fs::metadata(&file).unwrap().permissions();
            perm.set_readonly(ro);
            fs::set_permissions(&file, perm).unwrap();
        };
        set_ro(false);
        fs::write(&file, "v2\n").unwrap();
        set_ro(true);
        *fx.service.dirty.lock().unwrap_or_else(|e| e.into_inner()) = true;
        fx.service.track().expect("track must tolerate read-only files");

        // Restoring h1 must force-overwrite the read-only file back to v1.
        // (Git for Windows clears the attribute on unlink; POSIX unlink works
        // regardless of the file mode.) A failure here is a real P4 finding.
        let result = emulate_ts_restore(&fx.gitdir, &fx.worktree, &h1);
        assert!(
            result.is_ok(),
            "restore must survive read-only files, got: {:?}",
            result.err()
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1\n", "restore must win over the read-only file");
    }

    // ── P4-03b: exclusively-locked file must fail restore LOUDLY, not silently ──

    #[test]
    fn p4_03_locked_file_fails_restore_loudly_then_recovers() {
        let fx = fixture();
        let file = fx.worktree.join("locked.txt");
        fs::write(&file, "v1\n").unwrap();
        let h1 = fx.service.track().expect("baseline track");

        fs::write(&file, "v2\n").unwrap();
        *fx.service.dirty.lock().unwrap_or_else(|e| e.into_inner()) = true;
        fx.service.track().expect("track v2");

        // Hold an exclusive handle (no sharing) — the shape of a file locked
        // by a build tool / editor / AV scanner.
        let handle = std::fs::OpenOptions::new()
            .write(true)
            .share_mode(FILE_SHARE_NONE)
            .open(&file)
            .expect("open with FILE_SHARE_NONE");


        // Restore must REPORT failure (TS restore fails loudly since the
        // Windows checkout fix) — a silent "success" here would corrupt the
        // rollback UX.
        let result = emulate_ts_restore(&fx.gitdir, &fx.worktree, &h1);
        assert!(
            result.is_err(),
            "restore over an exclusively locked file must fail loudly, not report success"
        );

        // Releasing the lock makes the same restore succeed.
        drop(handle);
        emulate_ts_restore(&fx.gitdir, &fx.worktree, &h1).expect("restore after lock release");
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1\n");
    }

    // ── P4-04: >260-char paths and reserved device names ──

    #[test]
    fn p4_04_long_paths_and_reserved_names() {
        let fx = fixture();

        // Deep nesting whose total path exceeds MAX_PATH (260). CI enables
        // LongPathsEnabled; if THIS host cannot create it, skip loudly instead
        // of failing (the CI leg is the authoritative run).
        let mut deep = fx.worktree.clone();
        for i in 0..12 {
            deep.push(format!("seg_{:02}_{}", i, "d".repeat(24)));
        }
        if deep.as_os_str().to_string_lossy().chars().count() < 260 {
            panic!("test bug: nested path is not long enough ({})", deep.display());
        }
        if fs::create_dir_all(&deep).is_err() {
            eprintln!(
                "skipping P4-04 long-path leg: host cannot create >260-char paths \
                 (LongPathsEnabled registry flag off?) — CI covers this"
            );
            // Still exercise the reserved-name leg below on the same fixture.
        } else {
            fs::write(deep.join("deep.py"), "x = 1\n").expect("write deep file");
        }

        // Reserved device names are only creatable through \\?\ verbatim paths.
        for name in ["CON", "NUL"] {
            fs::write(verbatim(&fx.worktree.join(name)), format!("{name} content\n")).expect("create reserved-name file");
        }

        // Track must complete WITHOUT hanging or panicking, whatever git
        // decides to do with the reserved names.
        *fx.service.dirty.lock().unwrap_or_else(|e| e.into_inner()) = true;
        let track = fx.service.track();

        match track {
            Ok(hash) => {
                let names = ls_tree_names(&fx.gitdir, &fx.worktree, &hash);
                // If the reserved names made staging fail wholesale (track
                // would have returned Err), we would not be here. Whatever
                // git did with CON/NUL, the ordinary files MUST be captured.
                let deep_rel = deep
                    .join("deep.py")
                    .strip_prefix(&fx.worktree)
                    .expect("deep path under worktree")
                    .to_string_lossy()
                    .replace('\\', "/");
                if fs::metadata(&verbatim(&fx.worktree.join(&deep_rel.replace('/', "\\")))).is_ok() {
                    assert!(
                        names.iter().any(|n| *n == deep_rel),
                        "long-path file must be captured in the snapshot tree, got {names:?}"
                    );
                }
            }
            Err(err) => {
                // Loud failure is acceptable (better than a silently partial
                // tree) — but then the ordinary leg must recover once the
                // offending reserved names are gone.
                eprintln!("P4-04 finding: track failed with reserved names present: {err}");
                for name in ["CON", "NUL"] {
                    let _ = fs::remove_file(verbatim(&fx.worktree.join(name)));
                }
                *fx.service.dirty.lock().unwrap_or_else(|e| e.into_inner()) = true;
                let hash = fx.service.track().expect("track must recover without reserved names");
                let names = ls_tree_names(&fx.gitdir, &fx.worktree, &hash);
                assert!(
                    names.iter().any(|n| n.ends_with("deep.py")),
                    "long-path file must be captured once reserved names are gone, got {names:?}"
                );
            }
        }

        // Cleanup: reserved names are undeletable without the verbatim prefix,
        // which would leave the tempdir behind. Remove them explicitly.
        for name in ["CON", "NUL"] {
            let _ = fs::remove_file(verbatim(&fx.worktree.join(name)));
        }
    }
}
