//! Track — capture current worktree state as a tree hash.
//!
//! Mirrors TS `Snapshot.track()`: `git add --all` + `git write-tree` → hash.
//! Initializes the repo on first call if needed.

use super::SnapshotService;
use super::git_ops;

/// Track the current worktree state and return a tree hash.
pub fn track(svc: &SnapshotService) -> Result<String, String> {
    // Sample repo existence BEFORE locking: acquiring the cross-process lock
    // creates the gitdir, which would otherwise make the check below skip
    // `init_repo` on the very first track of a project.
    //
    // "Exists" must mean "an initialized repo lives here", not "the directory
    // exists": on windows CI a shell gitdir (created by something else before
    // the first track) made this sample true, skipped `git init` forever, and
    // every snapshot operation failed with "not a git repository" (77x/run).
    // Probe for HEAD — the structure `git init` always writes. `git init` on
    // an already-initialized repo is idempotent, so re-initializing a shell is
    // safe and heals it in place.
    let repo_existed = svc.gitdir.join("HEAD").exists();
    // DIAG (windows-ci snapshot): on windows-latest every track failed with
    // "not a git repository" (77x in one run) while mac/linux never failed —
    // meaning `repo_existed` sampled true but the dir had no git structure.
    // Log the sampled state and the dir contents so the next CI run shows
    // WHO creates the shell directory before the first track.
    {
        let contents = std::fs::read_dir(&svc.gitdir).map(|rd| {
            let names: Vec<String> = rd
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            names.join(",")
        });
        tracing::info!(
            repo_existed,
            gitdir = %svc.gitdir.display(),
            contents = contents.unwrap_or_else(|e| format!("<unreadable: {e}>")),
            "snapshot track entry"
        );
    }

    // Serialize against other services sharing this gitdir (P1-30): in-process
    // mutex first, then the cross-process file lock.
    let gitdir_lock = svc.gitdir_lock();
    let _gitdir_guard = gitdir_lock.lock().unwrap_or_else(|e| e.into_inner());
    let _file_guard = svc.cross_process_lock()?;
    let gitdir = &svc.gitdir;
    let worktree = &svc.worktree;

    // Initialize if this is the first call
    if !repo_existed {
        git_ops::init_repo(gitdir, worktree)?;
        // Force dirty after init
        *svc.dirty.lock().map_err(|e| format!("lock error: {}", e))? = true;
    } else {
        // Repo already exists — make sure exclude rules are present (they may
        // have been created by an older version that didn't write them).
        git_ops::ensure_exclude_rules(gitdir);
    }

    let mut dirty = svc.dirty.lock().map_err(|e| format!("lock error: {}", e))?;

    if *dirty {
        git_ops::add_all(gitdir, worktree, svc.max_staged_file_size)?;
        *dirty = false;
    } else {
        // Safety net: check for drift even if dirty flag says clean
        if git_ops::has_drift(gitdir, worktree) || git_ops::has_untracked(gitdir, worktree) {
            git_ops::add_all(gitdir, worktree, svc.max_staged_file_size)?;
        }
    }

    // Release the lock before write_tree (no mutation needed)
    drop(dirty);

    let hash = git_ops::write_tree(gitdir, worktree)?;
    // P2-38: a bare tree is unreachable, so `git gc --prune` would delete
    // snapshots that active sessions still reference. Pin it; the ref moves
    // forward on every track, so old snapshots still age out naturally.
    git_ops::pin_tree(gitdir, worktree, &hash);
    tracing::info!(hash = %hash, "snapshot tracked");
    Ok(hash)
}
