import { test, expect } from "@playwright/test"
import { writeFileSync, rmSync } from "fs"
import { join } from "path"
import { getRuntimeInfo } from "./helpers/sdk"

/**
 * E2E scenario e: KG incremental indexing of the OPT-17 extension set.
 *
 * Drives the SAME endpoint the watcher's flushKGUpdatesFor uses
 * (POST /graph/update-file) — i.e. the incremental path, as opposed to a
 * full re-index — and asserts the entities land in the graph.
 *
 * Empirical entity shapes (probe-verified against the sidecar):
 *   - .css selector  → node `function:<selector>@<file>` (regex fallback)
 *   - .sql CREATE TABLE → currently yields NO entity (tree-sitter sequel AST
 *     extractor does not map table definitions) — pinned as the known
 *     behavior; flagged as a suspected gap for the indexer backlog.
 *
 * KNOWN GAP (separate investigation): the watcher → GlobalBus →
 * flushKGUpdatesFor chain does not fire in the e2e environment (a file write
 * followed by a 90s poll finds nothing, while the direct endpoint call
 * works). Every link was code-verified; the silent break needs in-process
 * instrumentation. This spec therefore pins the incremental ENDPOINT, not
 * the watcher delivery.
 */
test.describe("KG incremental indexing (css/sql)", () => {
  test.setTimeout(120_000)

  const probe = async (sidecar: string, projectDir: string, query: string) => {
    const res = await fetch(`${sidecar}/graph/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queryType: "search",
        searchQuery: query,
        projectPath: projectDir,
        limit: 20,
      }),
    })
    if (!res.ok) return `http-${res.status}`
    return await res.text()
  }

  const updateFile = async (
    sidecar: string,
    projectDir: string,
    path: string,
    content: string,
    language: string,
  ) => {
    const res = await fetch(`${sidecar}/graph/update-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, content, language, projectPath: projectDir }),
    })
    return res
  }

  test("an incrementally indexed css selector lands in the graph", async () => {
    const info = getRuntimeInfo()
    test.skip(!info.smartLayerAvailable, "Requires the Rust smart-layer sidecar")
    const sidecar = info.smartLayerUrl!

    const health = await fetch(`${sidecar}/health`).catch(() => null)
    test.skip(!health || !health.ok, "sidecar not reachable")

    const rel = "e2e-kg-incremental.css"
    const abs = join(info.projectDir, rel)
    rmSync(abs, { force: true })
    writeFileSync(abs, ".kg-e2e-marker-btn { color: red; }\n")
    try {
      const res = await updateFile(sidecar, info.projectDir, rel, ".kg-e2e-marker-btn { color: red; }\n", "css")
      expect(res.ok).toBeTruthy()

      await expect
        .poll(async () => probe(sidecar, info.projectDir, "kg-e2e-marker-btn"), {
          timeout: 30_000,
          intervals: [1_000, 2_000],
        })
        .toContain("kg-e2e-marker-btn")
    } finally {
      rmSync(abs, { force: true })
    }
  })

  test("an incrementally indexed sql CREATE TABLE lands in the graph", async () => {
    const info = getRuntimeInfo()
    test.skip(!info.smartLayerAvailable, "Requires the Rust smart-layer sidecar")
    const sidecar = info.smartLayerUrl!

    const rel = "e2e-kg-incremental.sql"
    const abs = join(info.projectDir, rel)
    rmSync(abs, { force: true })
    writeFileSync(abs, "CREATE TABLE kg_e2e_marker_users (id INT);\n")
    try {
      const res = await updateFile(
        sidecar,
        info.projectDir,
        rel,
        "CREATE TABLE kg_e2e_marker_users (id INT);",
        "sql",
      )
      expect(res.ok).toBeTruthy()

      // The regex fallback now maps CREATE TABLE / VIEW to graph entities.
      await expect
        .poll(async () => probe(sidecar, info.projectDir, "kg_e2e_marker_users"), {
          timeout: 30_000,
          intervals: [1_000, 2_000],
        })
        .toContain("kg_e2e_marker_users")
    } finally {
      rmSync(abs, { force: true })
    }
  })
})
