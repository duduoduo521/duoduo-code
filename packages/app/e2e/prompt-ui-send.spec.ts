import { test, expect } from "@playwright/test"
import {
  gotoSession,
  createSessionAndNavigate,
  typeInPrompt,
  submitPrompt,
  getPromptEditor,
  getMessages,
  getLastAssistantMessage,
  switchModel,
} from "./helpers/page"
import { deleteTestSession, getRuntimeInfo } from "./helpers/sdk"

/**
 * E2E tests for the FULL UI send path — no SDK shortcut, no reload.
 *
 * Covers the production prompt flow end to end:
 *   type in editor → press Enter → promptAsync → TS backend → Rust run-loop
 *   sidecar → mock LLM → SSE events → SolidJS store → DOM rendering.
 *
 * The older prompt.spec.ts submits via the SDK synchronous endpoint (with a
 * page reload) because SSE-driven store updates were flaky in the harness;
 * these tests assert the real-time SSE rendering path instead and therefore
 * require the Rust smart-layer sidecar (skipped when the binary is missing).
 */
test.describe("Prompt send via UI (real-time SSE path)", () => {
  // Under 2 workers the first prompt also pays the backend's lazy AppLayer
  // build (providers, session deps) — the 30s local default is too tight.
  test.setTimeout(120_000)

  const sessionIds: string[] = []

  test.afterEach(async () => {
    for (const id of sessionIds) {
      await deleteTestSession(id).catch(() => {})
    }
    sessionIds.length = 0
  })

  test("typing and pressing Enter streams the reply into the DOM without reload", { tag: ["@core", "@ui-send"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar (cargo build -p duo-smart-layer)")

    const sessionId = await createSessionAndNavigate(page, "UI send real-time test")
    sessionIds.push(sessionId)

    await typeInPrompt(page, "Say hello")
    await submitPrompt(page)

    // The reply must arrive through SSE → store → DOM: no reload, no SDK call.
    const messages = getMessages(page)
    await expect(messages.first()).toBeVisible({ timeout: 60_000 })
    const assistant = getLastAssistantMessage(page)
    await expect(assistant).toBeVisible({ timeout: 60_000 })
    const text = await assistant.textContent()
    expect(text?.trim().length).toBeGreaterThan(0)

    // The editor must have been cleared on submit (optimistic send), and the
    // session must be back to idle so the user can type again.
    await expect
      .poll(async () => (await getPromptEditor(page).innerText()).trim(), { timeout: 15_000 })
      .not.toContain("Say hello")
  })

  test("streamed multi-chunk reply assembles into the full assistant text", { tag: ["@core", "@ui-send"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar (cargo build -p duo-smart-layer)")

    const sessionId = await createSessionAndNavigate(page, "UI send streaming test")
    sessionIds.push(sessionId)

    // Switch model through the UI so the multi-chunk streaming fixture serves.
    await switchModel(page, "success-text-multi-chunk")

    await typeInPrompt(page, "Tell me something")
    await submitPrompt(page)

    // The 10-chunk fixture assembles to this exact sentence — proving every
    // delta traversed UI → backend → sidecar → mock LLM → SSE → DOM.
    const assistant = getLastAssistantMessage(page)
    await expect(assistant).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(async () => (await assistant.textContent()) ?? "", { timeout: 60_000 })
      .toContain("Hello, this is a mocked streaming reply.")
  })

  test("prompt remains usable for a follow-up after the first reply", { tag: ["@smoke", "@ui-send"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar (cargo build -p duo-smart-layer)")

    const sessionId = await createSessionAndNavigate(page, "UI send follow-up test")
    sessionIds.push(sessionId)

    await typeInPrompt(page, "First message")
    await submitPrompt(page)
    await expect(getMessages(page).first()).toBeVisible({ timeout: 60_000 })

    // Follow-up on the same session — the composer must not be stuck busy.
    await typeInPrompt(page, "Second message")
    await submitPrompt(page)
    await expect(page.locator('[data-slot="session-turn-assistant-content"]').nth(1)).toBeVisible({
      timeout: 60_000,
    })

    await gotoSession(page, sessionId)
    const turns = getMessages(page)
    await expect(turns).toHaveCount(2, { timeout: 15_000 })
  })
})
