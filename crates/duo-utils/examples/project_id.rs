//! Prints the `duo_utils::path::project_id` of the path given as the first
//! argument.
//!
//! Dev/CI-only helper (not used by any production binary). Exists so the TS
//! sidecar can assert cross-language consistency of the project_id algorithm —
//! see `packages/duoduo/test/storage/project-id-cross-language.test.ts`. The
//! algorithm MUST stay byte-identical with
//! TS `projectId()` (`packages/duoduo/src/storage/project-dir.ts`).

use std::path::PathBuf;

fn main() {
    let arg = std::env::args()
        .nth(1)
        .expect("usage: project_id <absolute-or-relative-path>");
    println!("{}", duo_utils::path::project_id(&PathBuf::from(arg)));
}
