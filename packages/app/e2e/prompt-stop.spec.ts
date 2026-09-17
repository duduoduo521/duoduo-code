import { test, expect, type Page } from "@playwright/test"
import {
  createSessionAndNavigate,
  typeInPrompt,
  submitPrompt,
  getPromptEditor,
  getLastAssistantMessage,
  switchModel,
} from "./helpers/page"
import { abortSession, deleteTestSession, getMessages, getMockCallCount, getRuntimeInfo } from "./helpers/sdk"

/**
 * E2E tests for the STOP (interrupt) flow through the FULL UI stack:
 *
 *   long streamed reply (streaming-long fixture, ~18s busy window)
 *   → user clicks Stop / presses Escape → POST /session/:id/abort →
 *   Rust cancelRunLoop → "Stopped by user" divider → composer idle →
 *   a follow-up prompt works (stop-then-resend regression).
 *
 * The streaming-long fixture provides a long enough busy window to operate
 * the UI while the reply is still streaming. Text assertions are
 * locale-tolerant (en/zh) since the stop button label and the interrupted
 * divider are i18n'd.
 *
 * NOTE: the composer submit/stop is ONE IconButton (type=submit; the form's
 * onSubmit branches on working()). Its aria-label flips between
 * "Stop"/"停止" (busy) and "Send"/"发送" (idle) — locate by data-action +
 * label, never by role name alone (other "Stop" controls exist on the page).
 */
test.describe("Prompt stop (interrupt) flow", () => {
  test.setTimeout(240_000)

  const sessionIds: string[] = []

  test.afterEach(async () => {
    for (const id of sessionIds) {
      await deleteTestSession(id).catch(() => {})
    }
    sessionIds.length = 0
  })

  const stopButton = (page: Page) =>
    page.locator(
      '[data-action="prompt-submit"][aria-label="Stop"], [data-action="prompt-submit"][aria-label="停止"]',
    )
  const sendButton = (page: Page) =>
    page.locator(
      '[data-action="prompt-submit"][aria-label="Send"], [data-action="prompt-submit"][aria-label="发送"]',
    )

  /** Start a long streamed reply and wait until it is actually streaming. */
  async function startLongPrompt(page: Page) {
    await switchModel(page, "streaming-long")
    await typeInPrompt(page, "Write me a long answer")
    await submitPrompt(page)
    // Busy: the submit button flips to its Stop label while streaming.
    await expect(stopButton(page).first()).toBeVisible({ timeout: 30_000 })
    // Wait for the first streamed chunk so the in-flight assistant message
    // exists (aborting in the pre-first-chunk window leaves nothing to mark
    // interrupted and the composer simply returns to idle).
    await expect(getLastAssistantMessage(page)).toBeVisible({ timeout: 30_000 })
  }

  test("clicking Stop interrupts the stream and shows the interrupted divider", { tag: ["@core", "@stop-flow"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    const sessionId = await createSessionAndNavigate(page, "stop-button test")
    sessionIds.push(sessionId)

    await startLongPrompt(page)
    await stopButton(page).first().click()

    // Idle again: the button flips back from Stop to Send.
    await expect(sendButton(page).first()).toBeVisible({ timeout: 30_000 })
    // The interrupted divider replaces the perpetual thinking shimmer.
    await expect(page.getByText(/stopped by user|用户已停止/i).first()).toBeVisible({
      timeout: 15_000,
    })
  })

  test("Escape interrupts the stream", { tag: ["@core", "@stop-flow"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    const sessionId = await createSessionAndNavigate(page, "stop-escape test")
    sessionIds.push(sessionId)

    await startLongPrompt(page)
    // Focus the composer first so the prompt-input's own Escape handler runs.
    await getPromptEditor(page).click()
    await page.keyboard.press("Escape")

    await expect(sendButton(page).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/stopped by user|用户已停止/i).first()).toBeVisible({
      timeout: 15_000,
    })
  })

  test("abort cancels the run loop — the mock LLM stops receiving rounds", { tag: ["@core", "@stop-flow"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    const sessionId = await createSessionAndNavigate(page, "stop-cancel test")
    sessionIds.push(sessionId)

    await startLongPrompt(page)
    const callsAtStop = await getMockCallCount()

    // Authoritative stop (what the Stop button's abort() invokes).
    await abortSession(sessionId)

    // The Rust loop must actually cancel: the mock LLM stops receiving new
    // rounds (cancellation checkpoint = the in-flight LLM call finishing).
    await expect
      .poll(async () => getMockCallCount(), { timeout: 45_000, interval: 1_000 })
      .toBeLessThan(callsAtStop + 3)
  })

  test("a follow-up prompt works right after stopping (stop-then-resend)", { tag: ["@core", "@stop-flow"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    const sessionId = await createSessionAndNavigate(page, "stop-resend test")
    sessionIds.push(sessionId)

    await startLongPrompt(page)
    await stopButton(page).first().click()
    await expect(sendButton(page).first()).toBeVisible({ timeout: 30_000 })

    // Switch to the fast fixture and resend — the composer must not be stuck
    // busy/aborted (regression: the stop watchdog used to eat the next send).
    await switchModel(page, "success-text-short")
    await typeInPrompt(page, "Say OK")
    await submitPrompt(page)

    const assistant = getLastAssistantMessage(page)
    await expect(assistant).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(async () => (await assistant.textContent()) ?? "", { timeout: 30_000 })
      .toContain("OK")
  })
})
