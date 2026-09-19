//! Patch — compute the list of changed files between a previous hash and now.
//!
//! Mirrors TS `Snapshot.patch()`: `git add --all` + `git diff --cached --name-only <hash>`.

use super::SnapshotService;
use super::git_ops;

/// Result of a patch computation: the hash and list of changed file paths.
#[derive(Debug, Clone)]
pub struct PatchResult {
    pub hash: String,
    pub files: Vec<String>,
}

/// Compute the patch between a previous tree hash and the current worktree state.
///
/// Returns a `PatchResult` with the hash and a list of file paths (relative to worktree,
/// with forward slashes) that have changed since `prev_hash`.
pub fn patch(svc: &SnapshotService, prev_hash: &str) -> Result<PatchResult, String> {
    // Serialize against other services sharing this gitdir (P1-30): in-process
    // mutex first, then the cross-process file lock.
    let gitdir_lock = svc.gitdir_lock();
    let _gitdir_guard = gitdir_lock.lock().unwrap_or_else(|e| e.into_inner());
    let _file_guard = svc.cross_process_lock()?;
    let gitdir = &svc.gitdir;
    let worktree = &svc.worktree;

    // Stage current state
    git_ops::add_all(gitdir, worktree, svc.max_staged_file_size)?;
    // Mark as clean after add
    *svc.dirty.lock().map_err(|e| format!("lock error: {}", e))? = false;

    // Get the list of changed files. `-z` (not `--name-only` alone) is the
    // P1-28 fix: plain `--name-only` octal-escapes non-ASCII paths, so the
    // escaped names never matched the real files and `revert` deleted them.
    let result = git_ops::run_git(
        gitdir,
        worktree,
        &[
            "-c",
            "core.quotepath=false",
            "diff",
            "--cached",
            "--no-ext-diff",
            "--name-only",
            "-z",
            prev_hash,
            "--",
            ".",
        ],
        Some(worktree),
    );

    if !result.success() {
        tracing::warn!(hash = prev_hash, code = result.code, "failed to get diff");
        return Ok(PatchResult {
            hash: prev_hash.to_string(),
            files: vec![],
        });
    }

    let files: Vec<String> = result
        .stdout
        .split('\0')
        .map(|x| x.trim())
        .filter(|x| !x.is_empty())
        .map(|rel| {
            // Convert to absolute path with forward slashes (mirrors TS behavior)
            let abs = worktree.join(rel);
            abs.to_string_lossy().replace('\\', "/")
        })
        .collect();

    tracing::info!(hash = prev_hash, files = files.len(), "patch computed");
    Ok(PatchResult {
        hash: prev_hash.to_string(),
        files,
    })
}
