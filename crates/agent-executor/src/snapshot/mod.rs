pub mod git_ops;
pub(crate) mod lock;
pub mod patch;
pub mod track;

#[cfg(test)]
mod fs_edge_tests;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

/// Process-wide registry of per-gitdir locks (P1-30).
///
/// This is only the IN-PROCESS half of the serialization. The shadow repo is
/// also shared with the TS sidecar process, so every mutating operation takes
/// [`SnapshotService::cross_process_lock`] on top of it (see `lock.rs`).
/// Mirrors TS `GITDIR_LOCKS` (`snapshot/index.ts`).
fn gitdir_locks() -> &'static Mutex<HashMap<PathBuf, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Snapshot service — mirrors the TS `Snapshot.Service` using git CLI.
///
/// Uses a bare git repository (separate `--git-dir`) to track worktree state
/// without interfering with the user's own git repo. The snapshot repo never
/// commits; it uses `git write-tree` to capture tree hashes and `git checkout`
/// to restore files.
pub struct SnapshotService {
    /// Path to the bare snapshot git directory
    /// (typically `<data>/snapshot/<project_id>/<hash(worktree)>`)
    pub gitdir: PathBuf,
    /// Path to the project worktree being snapshotted
    pub worktree: PathBuf,
    /// Dirty flag — set to true when files change, reset after `add()`
    pub dirty: Arc<Mutex<bool>>,
}

impl SnapshotService {
    /// Create a new SnapshotService for the given worktree.
    ///
    /// `gitdir` is the path to the bare snapshot git directory. It MUST be
    /// computed identically on the TS side
    /// (`path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree))`)
    /// so that Rust-written tree hashes are valid when TS `Snapshot.Service`
    /// later consumes them (revert/restore/diff/diffFull) in the same repo.
    /// Passing the resolved gitdir from TS avoids fragile cross-process
    /// re-derivation of `Global.Path.data` / `project.id` / the SHA-1 hash.
    /// `worktree` is the root of the project worktree being snapshotted.
    pub fn new(gitdir: PathBuf, worktree: PathBuf) -> Self {
        Self {
            gitdir,
            worktree: worktree.to_path_buf(),
            dirty: Arc::new(Mutex::new(true)), // Start dirty — first track() will init + add
        }
    }

    /// Track the current worktree state and return a tree hash.
    ///
    /// Mirrors TS `track()`: `git add` + `git write-tree` → hash.
    /// Initializes the snapshot repo on first call if it doesn't exist.
    pub fn track(&self) -> Result<String, String> {
        track::track(self)
    }

    /// Compute the patch (list of changed files) between a previous hash and now.
    ///
    /// Mirrors TS `patch()`: `git add` + `git diff --cached --name-only <hash>` → file list.
    pub fn patch(&self, prev_hash: &str) -> Result<patch::PatchResult, String> {
        patch::patch(self, prev_hash)
    }

    // NOTE: Rust-side revert/restore were removed (P3-04 cleanup) — no production
    // caller ever routed through them (TS owns restore/revert end-to-end, see the
    // P3-10 decision in 机制缺陷.md). Rollback flows: snapshot/index.ts restore().

    /// Per-gitdir lock (one shared `Arc<Mutex<()>>` per gitdir path).
    ///
    /// Callers MUST bind the returned Arc to a local that outlives the guard:
    /// `let lock = self.gitdir_lock(); let _g = lock.lock()...;` — the guard
    /// borrows from the Mutex inside the Arc, so a single
    /// `let _g = self.gitdir_lock().lock()` would drop the Arc mid-statement.
    ///
    /// This is the in-process half only. Follow it with
    /// [`Self::cross_process_lock`] — in that order (see below).
    pub(crate) fn gitdir_lock(&self) -> Arc<Mutex<()>> {
        let mut map = gitdir_locks().lock().unwrap_or_else(|e| e.into_inner());
        map.entry(self.gitdir.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Cross-process half of the gitdir lock (P1-30).
    ///
    /// MUST be acquired AFTER [`Self::gitdir_lock`]: the in-process mutex is
    /// shared by every thread of this process, so a thread that held the file
    /// lock while waiting for the mutex could deadlock against a sibling thread
    /// that holds the mutex and waits for the file lock.
    ///
    /// Note this creates `gitdir` when it does not exist yet; callers that
    /// branch on the repo already existing must sample that first.
    pub(crate) fn cross_process_lock(&self) -> Result<lock::GitdirFileLock, String> {
        lock::GitdirFileLock::acquire(&self.gitdir)
            .map_err(|e| format!("snapshot gitdir lock error: {e}"))
    }
}
