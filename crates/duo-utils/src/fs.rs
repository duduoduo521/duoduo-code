//! Cross-platform filesystem helpers.

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Monotonic counter making each temporary sibling unique within the process.
/// Several worker threads may call [`atomic_write`] concurrently, so a process
/// id alone cannot separate two in-flight writes.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Atomically replace the contents of `path`.
///
/// Writes to a temporary sibling and renames it over the target, so a
/// concurrent reader — or a crash part-way through — never observes a
/// truncated or half-written file. `std::fs::write` truncates the target first,
/// so a reader landing in that window sees an empty or invalid file.
///
/// The temporary file lives in the same directory as `path` because `rename`
/// only works within a single filesystem.
///
/// Platform behaviour:
/// - Unix: `rename(2)` replaces the target atomically.
/// - Windows: maps to `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`, which
///   also replaces an existing target. It fails if another process holds the
///   target open without `FILE_SHARE_DELETE`; the error is returned to the
///   caller rather than silently corrupting the file.
pub fn atomic_write(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let tmp = temp_sibling(path);

    // Flush to stable storage *before* the rename so the data survives a crash
    // even if the rename itself is lost.
    let mut file = std::fs::File::create(&tmp)?;
    file.write_all(content)?;
    file.sync_all()?;
    drop(file);

    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            // Never leave stale temp files behind: they pollute the config
            // directory and mislead anyone debugging a failed write.
            let _ = std::fs::remove_file(&tmp);
            Err(err)
        }
    }
}

/// Build a unique sibling path for `path`: `config.toml` →
/// `config.toml.<pid>.<seq>.tmp`.
fn temp_sibling(path: &Path) -> PathBuf {
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);

    let mut name = path
        .file_name()
        .map(OsString::from)
        .unwrap_or_else(|| OsString::from("file"));
    name.push(format!(".{}.{}.tmp", std::process::id(), seq));

    let mut tmp = path.to_path_buf();
    tmp.set_file_name(name);
    tmp
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "duo-utils-fs-{}-{}-{}",
            tag,
            std::process::id(),
            TMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .expect("read_dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn creates_file_when_absent() {
        let dir = tmpdir("create");
        let path = dir.join("config.toml");

        atomic_write(&path, b"[a]\nb = 1\n").expect("write");

        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            "[a]\nb = 1\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn overwrites_existing_content() {
        let dir = tmpdir("overwrite");
        let path = dir.join("config.toml");
        std::fs::write(&path, "stale content that is much longer").expect("seed");

        atomic_write(&path, b"fresh").expect("write");

        assert_eq!(std::fs::read_to_string(&path).expect("read"), "fresh");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A successful write must not leave temp files behind, or the config
    /// directory slowly fills with garbage.
    #[test]
    fn leaves_no_temp_files_behind() {
        let dir = tmpdir("noleftover");
        let path = dir.join("config.toml");

        for i in 0..5 {
            atomic_write(&path, format!("v{}", i).as_bytes()).expect("write");
        }

        assert_eq!(entries(&dir), vec!["config.toml".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Concurrent writers must never interleave: whatever the final content is,
    /// it must be one writer's *complete* payload, not a torn mix of two.
    #[test]
    fn concurrent_writers_never_interleave() {
        let dir = tmpdir("concurrent");
        let shared = Arc::new(dir.join("config.toml"));

        let mut handles = Vec::new();
        for t in 0..8u8 {
            let path = Arc::clone(&shared);
            handles.push(std::thread::spawn(move || {
                for i in 0..50usize {
                    // Length varies per iteration, so a torn write shows up as
                    // a truncated or mixed-up string.
                    let payload = format!("t={} i={} pad={}", t, i, "x".repeat((i % 17) + 1));
                    atomic_write(&path, payload.as_bytes()).expect("write");
                }
            }));
        }
        for h in handles {
            h.join().expect("writer thread");
        }

        let content = std::fs::read_to_string(&*shared).expect("read");
        let parts: Vec<&str> = content.splitn(3, ' ').collect();
        assert_eq!(parts.len(), 3, "torn content: {:?}", content);

        let t: u8 = parts[0].strip_prefix("t=").unwrap().parse().unwrap();
        let i: usize = parts[1].strip_prefix("i=").unwrap().parse().unwrap();
        let pad = parts[2].strip_prefix("pad=").unwrap();

        assert!(t < 8, "payload must come from a real writer");
        // A complete payload's padding length is fully determined by `i`;
        // anything else means two writes were interleaved.
        assert_eq!(
            pad,
            "x".repeat((i % 17) + 1),
            "interleaved content: {:?}",
            content
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
