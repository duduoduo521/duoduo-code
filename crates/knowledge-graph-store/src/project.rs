//! Single source of truth for knowledge-graph project identity.
//!
//! ## Why this module exists
//!
//! "Which project does this node belong to" used to be answered in three
//! incompatible ways (see the audit's R3): the TypeScript side composed
//! `${gitRootHash}_${basename(dir)}` in two copy-pasted helpers, the HTTP
//! routes fell back to a bare `basename(dir)` in four more places, and the
//! Rust-only callers (`/context/structured`, `graph_query`) passed either the
//! raw directory or `None`. Because `matches_project` compares for strict
//! equality, every one of those mismatches silently degraded to "no results"
//! (KG context permanently empty) or "no filter" (cross-project leakage).
//!
//! ## The fix
//!
//! There is exactly one derivation, and it is the one the rest of the system
//! already uses: `duo_utils::path::project_id`. That function is mirrored by
//! `packages/duoduo/src/storage/project-dir.ts` and already names every other
//! per-project store (SQLite DB, memory, DNA rules, ...). Reusing it means the
//! graph, its snapshot cache and all sibling stores agree on what "this
//! project" means — no new algorithm, no second contract to keep in sync.
//!
//! Callers never compose a project key by hand; they pass a *directory* and
//! call [`project_key`].

use std::path::Path;

/// Canonical identity of a project directory.
///
/// This delegates to `duo_utils::path::project_id`, whose normalization is
/// deliberately narrow — it only:
/// - resolves a relative path against the current directory,
/// - rewrites `\` to `/` and strips trailing slashes (`D:\proj` and
///   `D:/proj/` become one key), and
/// - lowercases on Windows, where paths are case-insensitive.
///
/// It does NOT resolve `.`/`..` or symlinks. That is intentional: the same
/// function names every other per-project directory, so "improving" it here
/// alone would relocate the user's existing data. Callers pass the already
/// canonical project directory.
///
/// The encoding is injective: two distinct spellings that survive the above
/// still map to distinct keys, so two distinct directories never collide.
pub fn project_key(project_path: &Path) -> String {
    duo_utils::path::project_id(project_path)
}

/// Key used by entities that are deliberately shared across every project.
///
/// Kept as the empty string so existing snapshots and the `matches_project`
/// convention keep working.
pub const GLOBAL: &str = "";

/// FNV-1a 64 — a fixed algorithm, so the value is stable across Rust releases.
///
/// `std::collections::hash_map::DefaultHasher` carries no such guarantee and
/// must never be used for anything that reaches disk.
pub(crate) fn stable_hash(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Build a bounded, filesystem-safe file stem for a project's on-disk state.
///
/// A project key encodes an absolute path, so it easily exceeds the OS limits
/// (255 bytes per component on macOS/Linux, 260 characters for a whole Windows
/// path). Two different keys must also never collapse onto one file, which the
/// previous "replace the unsafe characters" approach did: it mapped `a/b.c` and
/// `a_b_c` onto the same name.
pub(crate) fn file_stem(project_key: &str) -> String {
    let readable: String = project_key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect();
    format!("{}-{:016x}", readable, stable_hash(project_key.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_directory_different_spelling_yields_one_key() {
        let a = project_key(Path::new("/work/proj"));
        let b = project_key(Path::new("/work/proj/"));
        assert_eq!(a, b, "trailing separators must not fork the identity");
    }

    #[test]
    fn different_directories_yield_different_keys() {
        // Regression guard for the "main project vs nested sub-project" case
        // that the old `${gitRoot}_${basename}` scheme existed to separate.
        let a = project_key(Path::new("/work/repo"));
        let b = project_key(Path::new("/work/repo/desktop"));
        assert_ne!(a, b);

        // Same basename, different parents — this is what a bare `basename()`
        // derivation got wrong.
        let c = project_key(Path::new("/work/one/duoduo"));
        let d = project_key(Path::new("/work/two/duoduo"));
        assert_ne!(c, d);
    }

    #[test]
    fn key_is_filesystem_safe() {
        let key = project_key(Path::new("/work/my project.v2"));
        assert!(
            key.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "key must survive being used as a path component: {key}"
        );
    }

    #[test]
    fn file_stem_is_bounded_and_collision_free() {
        // A deep project path must not produce a name near the 255-byte
        // per-component limit of macOS/Linux or the 260-char Windows path cap.
        let deep = project_key(Path::new(&format!("/work/{}", "nested/".repeat(60))));
        let stem = file_stem(&deep);
        assert!(stem.len() <= 49, "file stem grew unbounded: {stem}");
        assert!(stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));

        // Distinct keys must not collapse: this is what plain character
        // replacement got wrong (`a/b.c` vs `a_b_c`).
        assert_ne!(file_stem("/work/a/b.c"), file_stem("/work/a_b_c"));
        assert_ne!(file_stem("proj"), file_stem("proj2"));
    }

    #[test]
    fn windows_casing_collapses_to_one_key() {
        // Not asserted off-Windows: the lowercasing is `cfg!(windows)`-gated.
        // `\` is only a separator on Windows, so the comparison is meaningless
        // elsewhere (POSIX would treat it as part of the file name).
        if cfg!(windows) {
            let a = project_key(Path::new("D:\\Work\\Proj"));
            let b = project_key(Path::new("d:\\work\\proj"));
            assert_eq!(a, b);
            // Drive-letter spelling must also fold to the POSIX form.
            let c = project_key(Path::new("D:/Work/Proj"));
            assert_eq!(a, c);
        }
    }
}
