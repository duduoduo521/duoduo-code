import { test, expect, type Page } from "@playwright/test"
import {
  createSessionAndNavigate,
  typeInPrompt,
  submitPrompt,
  getLastAssistantMessage,
  switchModel,
} from "./helpers/page"
import { deleteTestSession, getRuntimeInfo } from "./helpers/sdk"

/**
 * Mid-stream provider truncation (E2E scenario a — the `truncated-mid-text`
 * fixture was registered with no consumer):
 *
 *   mock LLM fixture → SSE stream delivers 2 chunks then ends WITHOUT [DONE]
 *   and WITHOUT finish_reason → Rust run_loop treats the stream as truncated
 *   (LlmStreamChunk::Error, 截断防护) → the partial text already streamed is
 *   persisted as an assistant message carrying a NamedError partial (M1) →
 *   the TS poll returns the Rust partial INSTEAD of synthesizing a second
 *   error card → UI shows partial text + exactly one error card.
 */
test.describe("Mid-stream provider truncation (full UI stack)", () => {
  test.setTimeout(180_000)

  const sessionIds: string[] = []

  test.afterEach(async () => {
    for (const id of sessionIds) {
      await deleteTestSession(id).catch(() => {})
    }
    sessionIds.length = 0
  })

  test("delivers the partial text with exactly one error card", async ({ page }: { page: Page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    const sessionId = await createSessionAndNavigate(page, "mid-stream-drop")
    sessionIds.push(sessionId)

    await switchModel(page, "truncated-mid-text")
    await typeInPrompt(page, "Say something")
    await submitPrompt(page)

    // The partial text that made it through before the truncation must be
    // visible — the stream's received prefix is persisted, not discarded.
    const assistant = getLastAssistantMessage(page)
    await expect(assistant).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(async () => (await assistant.textContent()) ?? "", { timeout: 60_000 })
      .toContain("Partial response that gets cut o")

    // M1: exactly ONE error card. The Rust partial already carries the error;
    // the TS poll loop must not synthesize a second one on top of it.
    const errorCard = page.locator('[data-component="card"][data-variant="error"]')
    await expect(errorCard.first()).toBeVisible({ timeout: 60_000 })
    await expect(errorCard).toHaveCount(1)

    // Back to idle: the loop is over, submit is a Send again.
    await expect(
      page
        .locator(
          '[data-action="prompt-submit"][aria-label="Send"], [data-action="prompt-submit"][aria-label="发送"]',
        )
        .first(),
    ).toBeVisible({ timeout: 30_000 })
  })
})
