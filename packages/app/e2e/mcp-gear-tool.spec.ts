import { test, expect } from "@playwright/test"
import { writeFileSync, mkdirSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import {
  createSessionAndNavigate,
  typeInPrompt,
  submitPrompt,
  getLastAssistantMessage,
  switchModel,
} from "./helpers/page"
import { deleteTestSession, getRuntimeInfo, getMessages } from "./helpers/sdk"

/**
 * E2E scenario g: 智械 gear MCP tool round-trip (full UI stack).
 *
 * Architecture note: on the Rust run-loop path MCP servers declared by gear
 * packs (`<DUODUO_GEARS_DIR>/<gear>/tools/mcp.json`) are connected by
 * `ensure_gear_mcp` (Rust), their tools merged into the LLM tool list, and
 * calls dispatched Rust-side over stdio JSON-RPC. Permission: the Ask variant
 * is intentionally treated as Allow for MCP tools (desktop has no interactive
 * channel) — Deny rules are still enforced. The dock-popup "MCP ask" flow the
 * backlog described belongs to the legacy TS run-loop path and is NOT
 * reachable here.
 *
 * Round-trip asserted: prompt → model calls `mcp__e2emcp__echo` → Rust MCP
 * dispatch (stdio JSON-RPC to e2e/mock-mcp/server.ts) → `echo:<text>` result
 * → conversation messages.
 */
test.describe("Gear MCP tool round-trip (full UI stack)", () => {
  test.setTimeout(240_000)

  const sessionIds: string[] = []

  test.afterEach(async () => {
    for (const id of sessionIds) {
      await deleteTestSession(id).catch(() => {})
    }
    sessionIds.length = 0
  })

  test("gear MCP tool is advertised, called, and its result lands in the conversation", async ({ page }) => {
    const info = getRuntimeInfo()
    test.skip(!info.smartLayerAvailable, "Requires the Rust smart-layer sidecar")
    test.skip(!info.gearsDir, "backend was started without DUODUO_GEARS_DIR")
    const gearsDir = info.gearsDir!
    const sidecar = info.smartLayerUrl!

    // Install the e2e gear pack: an MCP stdio server exposing `echo`.
    const gearDir = join(gearsDir, "e2emcp")
    mkdirSync(join(gearDir, "tools"), { recursive: true })
    writeFileSync(
      join(gearDir, "manifest.toml"),
      '[meta]\nname = "e2emcp"\nversion = "1.0.0"\ndescription = "E2E echo gear"\n',
    )
    writeFileSync(
      join(gearDir, "tools", "mcp.json"),
      JSON.stringify({
        kind: "stdio",
        command: "bun",
        args: [join(dirname(fileURLToPath(import.meta.url)), "mock-mcp", "server.ts")],
      }),
    )
    // No fixture/config cleanup needed: the gears dir is per-run temp state.

    // Warmup round: boots the instance AND triggers ensure_gear_mcp — the
    // MCP connection is established asynchronously "for subsequent runs",
    // so this first prompt exists to make the tool available to round 2.
    const sessionId = await createSessionAndNavigate(page, "mcp-gear")
    sessionIds.push(sessionId)
    await switchModel(page, "success-text-short")
    await typeInPrompt(page, "warmup")
    await submitPrompt(page)
    await expect(getLastAssistantMessage(page)).toBeVisible({ timeout: 90_000 })

    // Small settle time so the background ensure task finished the handshake.
    await page.waitForTimeout(2_000)

    // The MCP round-trip.
    await switchModel(page, "success-tool-mcp-echo")
    await typeInPrompt(page, "Call the echo tool")
    await submitPrompt(page)
    await expect(getLastAssistantMessage(page)).toBeVisible({ timeout: 120_000 })

    // Poll the persisted messages until the MCP round-trip completed.
    await expect
      .poll(
        async () => {
          const messages = await getMessages(sessionId)
          return JSON.stringify(messages)
        },
        { timeout: 120_000, intervals: [2_000, 5_000] },
      )
      .toContain("echo:from gear mcp")
    const raw = JSON.stringify(await getMessages(sessionId))
    expect(raw).toContain("mcp__e2emcp__echo")
  })
})
