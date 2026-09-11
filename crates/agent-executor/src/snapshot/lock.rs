//! Cross-process lock for a shadow snapshot repository (P1-30).
//!
//! The shadow gitdir is shared by the TS sidecar AND this Rust process, so an
//! in-process mutex alone cannot exclude them: interleaved `git add -A` +
//! `write-tree` from the two processes produce a corrupt tree hash that is then
//! persisted.
//!
//! Both sides implement the same protocol — an atomically created lock file
//! (`O_EXCL` / `create_new`) containing `<pid>\n<unix_millis>`, released by
//! deleting the file. A lock whose owner is gone, or that is older than
//! [`STALE_AFTER`], is taken over. Mirrors `acquireGitdirFileLock` in
//! `packages/duoduo/src/snapshot/index.ts`; the two MUST stay in sync (same file
//! name, same timestamp unit, same staleness rule).

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Lock file name inside the gitdir. Must match the TS constant.
pub(crate) const LOCK_FILE_NAME: &str = "duoduo.lock";

/// A lock held for longer than this is considered abandoned: no single git
/// sequence (`add -A` + `write-tree` + `update-ref`) takes 30 seconds, so the
/// holder almost certainly died without deleting the file.
const STALE_AFTER: Duration = Duration::from_secs(30);

/// How often to re-check a lock held by someone else.
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// RAII handle for the on-disk lock. Dropping it releases the lock.
pub(crate) struct GitdirFileLock {
    path: PathBuf,
}

impl GitdirFileLock {
    /// Acquire the cross-process lock for `gitdir`.
    ///
    /// Creates `gitdir` when it does not exist yet — the lock must be held
    /// across `git init` on the first track. Callers that branch on the repo's
    /// existence must therefore sample that BEFORE calling this.
    ///
    /// Waits (rather than failing) while another live owner holds the lock, so
    /// the serialization guarantee of the previous in-process-only lock is
    /// preserved; only a stale lock is taken over.
    pub(crate) fn acquire(gitdir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(gitdir)?;
        let path = gitdir.join(LOCK_FILE_NAME);
        loop {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut file) => {
                    use std::io::Write;
                    let _ = writeln!(file, "{}", std::process::id());
                    let _ = writeln!(file, "{}", now_millis());
                    return Ok(Self { path });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if is_stale(&path) {
                        // A crashed holder (dead pid) or an abandoned one: take
                        // the lock over instead of waiting forever.
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    std::thread::sleep(POLL_INTERVAL);
                }
                Err(e) => return Err(e),
            }
        }
    }
}

impl Drop for GitdirFileLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// True when the lock file names a dead process, is older than [`STALE_AFTER`],
/// or is unreadable (vanished between the failed create and this read) — all of
/// which mean the caller should retry the create immediately.
fn is_stale(path: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return true;
    };
    let mut lines = raw.lines();
    let pid = lines.next().and_then(|l| l.trim().parse::<u32>().ok());
    let ts = lines.next().and_then(|l| l.trim().parse::<u128>().ok());

    if let Some(ts) = ts
        && now_millis().saturating_sub(ts) > STALE_AFTER.as_millis()
    {
        return true;
    }
    match pid {
        Some(pid) => !process_alive(pid),
        // Unparseable content: stale rather than a permanent deadlock.
        None => true,
    }
}

/// Whether `pid` is still running.
///
/// Unix uses the classic `kill(pid, 0)` probe.
#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // SAFETY: signal 0 performs an existence/permission check only.
    unsafe {
        if libc::kill(pid as i32, 0) == 0 {
            return true;
        }
        // EPERM means the process exists but belongs to another user.
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

/// Windows: ask the process for its exit code.
///
/// Reporting `true` unconditionally here (the previous behaviour) meant a lock
/// left by a crashed process could only be reclaimed after [`STALE_AFTER`],
/// stalling every snapshot in between. `OpenProcess` + `GetExitCodeProcess` is
/// the same idea as `kill(pid, 0)`: no dependency beyond `windows-sys`, which
/// the desktop already pulls in.
#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE, ERROR_ACCESS_DENIED},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    /// `GetExitCodeProcess` reports this while the process is still running.
    const STILL_ACTIVE: u32 = 259;

    // SAFETY: `pid` comes from a text file, so it can be any value —
    // `OpenProcess` simply fails for a pid that does not exist.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            // Access denied still proves the process exists (another user, or a
            // protected process), so it must not be reported as dead.
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "duo-gitdir-lock-{tag}-{}-{}",
            std::process::id(),
            now_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn acquire_creates_the_file_and_release_removes_it() {
        let dir = temp_dir("basic");
        let lock_path = dir.join(LOCK_FILE_NAME);
        {
            let _lock = GitdirFileLock::acquire(&dir).unwrap();
            let raw = std::fs::read_to_string(&lock_path).unwrap();
            let pid: u32 = raw.lines().next().unwrap().trim().parse().unwrap();
            assert_eq!(pid, std::process::id(), "the lock must name its owner");
        }
        assert!(!lock_path.exists(), "dropping the guard must release the lock");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn acquire_creates_a_missing_gitdir() {
        let dir = temp_dir("missing").join("nested");
        let _lock = GitdirFileLock::acquire(&dir).unwrap();
        assert!(dir.join(LOCK_FILE_NAME).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A lock left behind by a crashed process must not wedge the repo forever.
    #[test]
    fn stale_lock_from_a_dead_pid_is_taken_over() {
        let dir = temp_dir("stale-pid");
        let lock_path = dir.join(LOCK_FILE_NAME);
        // 4294967294 is not a valid live pid on any supported platform.
        std::fs::write(&lock_path, format!("{}\n{}\n", u32::MAX - 1, now_millis())).unwrap();

        let _lock = GitdirFileLock::acquire(&dir).unwrap();
        let raw = std::fs::read_to_string(&lock_path).unwrap();
        let pid: u32 = raw.lines().next().unwrap().trim().parse().unwrap();
        assert_eq!(pid, std::process::id(), "the lock must have been taken over");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A lock older than the staleness window is taken over even though its
    /// recorded pid happens to be alive (this process).
    #[test]
    fn ancient_lock_is_taken_over() {
        let dir = temp_dir("ancient");
        let lock_path = dir.join(LOCK_FILE_NAME);
        let ancient = now_millis() - (STALE_AFTER.as_millis() * 4);
        std::fs::write(&lock_path, format!("{}\n{}\n", std::process::id(), ancient)).unwrap();

        let _lock = GitdirFileLock::acquire(&dir).unwrap();
        let raw = std::fs::read_to_string(&lock_path).unwrap();
        let ts: u128 = raw.lines().nth(1).unwrap().trim().parse().unwrap();
        assert!(ts > ancient, "the lock must have been refreshed on takeover");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A well-formed, fresh lock owned by THIS process must NOT be stolen: that
    /// is what keeps concurrent callers serialized.
    #[test]
    fn fresh_lock_owned_by_a_live_process_is_not_stale() {
        let dir = temp_dir("fresh");
        let lock_path = dir.join(LOCK_FILE_NAME);
        std::fs::write(
            &lock_path,
            format!("{}\n{}\n", std::process::id(), now_millis()),
        )
        .unwrap();
        assert!(!is_stale(&lock_path));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
