import { test, expect } from "@playwright/test"
import { writeFileSync, rmSync } from "fs"
import { join } from "path"
import { getRuntimeInfo } from "./helpers/sdk"

/**
 * E2E scenario e: KG incremental indexing of the OPT-17 extension set.
 *
 * Both tests drive the FULL watcher delivery chain, not just the endpoint:
 *   file write → @parcel/watcher event → flushEvents → scheduleKGUpdate →
 *   flushKGUpdatesFor → POST /graph/update-file → entity in the graph.
 *
 * The file watcher only exists once the project's Instance has been
 * bootstrapped (InstanceBootstrap forks FileWatcher.init). Opening any
 * instance-scoped route (e.g. GET /session?directory=…) with the project
 * directory triggers that bootstrap. Empirically (isolated-process probe):
 * a file written BEFORE such a request is never indexed (no observer), and
 * a file written AFTER it is indexed and queryable — hence the explicit
 * open step below; without it this spec silently tested nothing.
 *
 * Empirical entity shapes (probe-verified against the sidecar):
 *   - .css selector  → node `function:<selector>@<file>` (regex fallback)
 *   - .sql CREATE TABLE → extracted as a Function-shaped entity
 *     (`function:<table>@<file>`) via the SQL_FN_RE regex extractor
 *     (tree-sitter-sequel AST matchers have no sql cases, so extraction
 *     falls back to the regex path).
 */

/** Open the project in the backend so the watcher chain gets bootstrapped. */
async function openProject(backendUrl: string, projectDir: string) {
  const url = new URL("/session", backendUrl)
  url.searchParams.set("directory", projectDir)
  const res = await fetch(url, { headers: { "x-duoduo-directory": encodeURIComponent(projectDir) } })
  if (!res.ok) throw new Error(`project open failed: ${res.status}`)
  await res.text().catch(() => "")
  // InstanceBootstrap returns before the detached watcher fiber finishes
  // subscribing — give it a moment before writing probe files.
  await new Promise((r) => setTimeout(r, 3_000))
}

/**
 * Wait until the sidecar's initial full index for the project has settled.
 * While it reports `indexing`, the watcher's flush defers every update
 * (2s retry loop) — writing probe files before this settles just pushes
 * their incremental updates past the test's poll window.
 */
async function waitIndexSettled(sidecar: string, projectDir: string, timeoutMs = 90_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(
        `${sidecar}/graph/index-status?project_path=${encodeURIComponent(projectDir)}`,
      )
      if (res.ok) {
        const status = (await res.json()) as { status?: string }
        if (status?.status !== "indexing") return
      }
    } catch {
      // transient — keep waiting
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
}

test.describe("KG incremental indexing (css/sql)", () => {
  test.setTimeout(240_000)

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

  test("a written css file flows through the watcher into the graph", async () => {
    const info = getRuntimeInfo()
    test.skip(!info.smartLayerAvailable, "Requires the Rust smart-layer sidecar")
    const sidecar = info.smartLayerUrl!

    const health = await fetch(`${sidecar}/health`).catch(() => null)
    test.skip(!health || !health.ok, "sidecar not reachable")

    // Bootstrap the project instance — without this the file watcher does
    // not exist and the write below would have no observer.
    await openProject(info.backendUrl, info.projectDir)
    await waitIndexSettled(sidecar, info.projectDir)

    const rel = "e2e-kg-incremental.css"
    const abs = join(info.projectDir, rel)
    rmSync(abs, { force: true })
    writeFileSync(abs, ".kg-e2e-marker-btn { color: red; }\n")
    try {
      // The polled value doubles as diagnostics: until the entity lands we
      // surface the live index-status so a timeout shows WHERE it stalled.
      let lastStatus = ""
      await expect
        .poll(async () => {
          const hit = await probe(sidecar, info.projectDir, "kg-e2e-marker-btn")
          if (hit) return "kg-e2e-marker-btn"
          try {
            lastStatus = await (
              await fetch(`${sidecar}/graph/index-status?project_path=${encodeURIComponent(info.projectDir)}`)
            ).text()
          } catch {}
          return `pending; index-status=${lastStatus}`
        }, {
          timeout: 60_000,
          intervals: [1_000, 2_000],
        })
        .toContain("kg-e2e-marker-btn")
    } finally {
      rmSync(abs, { force: true })
    }
  })

  test("a written sql CREATE TABLE flows through the watcher into the graph", async () => {
    const info = getRuntimeInfo()
    test.skip(!info.smartLayerAvailable, "Requires the Rust smart-layer sidecar")
    const sidecar = info.smartLayerUrl!

    const health = await fetch(`${sidecar}/health`).catch(() => null)
    test.skip(!health || !health.ok, "sidecar not reachable")

    await openProject(info.backendUrl, info.projectDir)
    await waitIndexSettled(sidecar, info.projectDir)

    const rel = "e2e-kg-incremental.sql"
    const abs = join(info.projectDir, rel)
    rmSync(abs, { force: true })
    writeFileSync(abs, "CREATE TABLE kg_e2e_marker_users (id INT);\n")
    try {
      // The regex fallback maps CREATE TABLE / VIEW to graph entities.
      await expect
        .poll(async () => probe(sidecar, info.projectDir, "kg_e2e_marker_users"), {
          timeout: 60_000,
          intervals: [1_000, 2_000],
        })
        .toContain("kg_e2e_marker_users")
    } finally {
      rmSync(abs, { force: true })
    }
  })
})
