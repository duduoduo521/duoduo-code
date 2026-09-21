import { test, expect } from "@playwright/test"
import { rmSync, readFileSync, existsSync } from "fs"
import {
  createSessionAndNavigate,
  typeInPrompt,
  submitPrompt,
  getLastAssistantMessage,
  switchModel,
} from "./helpers/page"
import { deleteTestSession, getRuntimeInfo, getMessages } from "./helpers/sdk"

/**
 * Bash hard-block self-heal (E2E scenario c):
 *
 *   round 1: model writes via heredoc (`cat <<'EOF' > /tmp/...`) — the
 *            bash_safety classifier HARD-BLOCKS heredoc payloads; the tool
 *            returns a Blocked error to the model (the capability boundary
 *            is not askable).
 *   round 2: the model self-heals with an explicit-write form
 *            (`printf ... > /tmp/...`) — the 批6 L2 gate treats the write
 *            form with the SAME permission ("edit") as the write tools:
 *            under the default ruleset it proceeds exactly like an edit
 *            would (no extra popup), lands on disk, and enters the ledger.
 *   round 3: plain text wrap-up.
 *
 * End state: the self-healed rewrite exists on disk with the printf content.
 */
test.describe("Bash hard-block self-heal (full UI stack)", () => {
  test.setTimeout(240_000)

  const sessionIds: string[] = []
  const target = "/tmp/duoduo-e2e-heal.txt"

  test.afterEach(async () => {
    for (const id of sessionIds) {
      await deleteTestSession(id).catch(() => {})
    }
    sessionIds.length = 0
    rmSync(target, { force: true })
  })

  test("heredoc is hard-blocked, the printf rewrite lands like a write tool", async ({ page }) => {
    // The bash tool intentionally runs PowerShell on Windows
    // (agent-executor agentic_loop.rs shell_note), where the POSIX fixture
    // commands do not exist: `printf` is not a PowerShell builtin, and
    // PowerShell 5.1 `>` writes UTF-16 — the round-2 disk assertion can
    // never hold. The classifier/L2 semantics themselves are covered by the
    // bash_safety Rust unit tests, so skip the full-UI round-trip here.
    test.skip(process.platform === "win32", "bash tool runs PowerShell on Windows; fixtures are POSIX")
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    rmSync(target, { force: true })
    const sessionId = await createSessionAndNavigate(page, "bash-heal")
    sessionIds.push(sessionId)

    await switchModel(page, "success-tool-bash-heal")
    await typeInPrompt(page, "Write the file")
    await submitPrompt(page)

    await expect(getLastAssistantMessage(page)).toBeVisible({ timeout: 120_000 })

    // Round 1's heredoc write was hard-blocked (capability boundary) — the
    // bash tool result carries the Blocked verdict, not file content.
    const messages = await getMessages(sessionId)
    const raw = JSON.stringify(messages)
    expect(raw).toContain("Blocked")

    // Round 2's printf rewrite landed on disk — same treatment an edit tool
    // gets under the default ruleset (permission "edit", no extra popup).
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, "utf8")).toContain("hello from printf")
  })
})
