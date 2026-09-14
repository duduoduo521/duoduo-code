import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import { projectId } from "../../src/storage/project-dir"

/**
 * P4-02 cross-language consistency gate (真机测试.md §3 遗留缺口).
 *
 * The Rust sidecar and the TS sidecar both derive per-project data dirs from
 * the SAME algorithm (`duo_utils::path::project_id` vs `projectId()`). If the
 * two ever drift, the two processes silently split a project's data across
 * two `<data>/database/<id>/` directories. Both sides carry their own
 * adaptive tests, but only a same-directory comparison catches drift between
 * them. This test computes both on one real temp directory and requires a
 * byte-identical id.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..")

/** cargo is only present in Rust-capable environments; pure-TS runs skip. */
const hasCargo = Bun.which("cargo") !== null

describe("P4-02 cross-language project_id consistency", () => {
  test.skipIf(!hasCargo)(
    "TS projectId() matches Rust duo_utils::path::project_id byte-for-byte",
    // 300s: a cold `cargo run` (example + deps never built) must be allowed
    // to finish; the CI leg runs after the cargo test steps, so its cache is
    // already warm.
    () => {
      // realpathSync expands 8.3 short names so both sides receive the exact
      // same string (neither algorithm canonicalizes internally — that is
      // part of the contract under test).
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dd-p402-")))
      try {
        const tsId = projectId(dir)
        expect(tsId).toBeTruthy()
        const rustId = execFileSync(
          "cargo",
          ["run", "-q", "-p", "duo-utils", "--example", "project_id", "--", dir],
          { cwd: REPO_ROOT, encoding: "utf-8", timeout: 300_000 },
        ).trim()
        expect(rustId).toBe(tsId)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
    300_000,
  )
})
