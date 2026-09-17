import { test, expect, type Page } from "@playwright/test"
import {
  createSessionAndNavigate,
  typeInPrompt,
  submitPrompt,
  getMessages,
  switchModel,
} from "./helpers/page"
import { deleteTestSession, getRuntimeInfo } from "./helpers/sdk"

/**
 * E2E tests for the INPUT QUEUE through the FULL UI stack:
 *
 *   long streamed reply (streaming-long, ~17s busy) → user submits a second
 *   prompt while busy → it is enqueued ("session-queue-dock" + badge) →
 *   when the first reply finishes, the queue pumps automatically and the
 *   second reply renders. Also covers removing a queued item.
 *
 * Behavior under test (packages/app/src/components/prompt-input/queue.ts +
 * session-queue-dock.tsx + composer pump effect): busy-time Enter enqueues;
 * on session idle a 400ms-debounced pump sends the next queued prompt.
 */
test.describe("Prompt queue (busy-time enqueue)", () => {
  test.setTimeout(240_000)

  const sessionIds: string[] = []

  test.afterEach(async () => {
    for (const id of sessionIds) {
      await deleteTestSession(id).catch(() => {})
    }
    sessionIds.length = 0
  })

  const queueDock = (page: Page) => page.locator('[data-component="session-queue-dock"]')

  async function startLongPrompt(page: Page) {
    await switchModel(page, "streaming-long")
    await typeInPrompt(page, "First question")
    await submitPrompt(page)
    // Busy confirmed: the queue dock appears once the second prompt is
    // enqueued below; here we just wait for the first send to register.
    await expect(getMessages(page).first()).toBeVisible({ timeout: 30_000 })
  }

  test("a prompt submitted while busy is queued, then pumped automatically", { tag: ["@core", "@queue"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    const sessionId = await createSessionAndNavigate(page, "queue-pump test")
    sessionIds.push(sessionId)

    await startLongPrompt(page)

    // Submit the second prompt DURING the first reply's busy window.
    await typeInPrompt(page, "Second question")
    await submitPrompt(page)

    // The queue dock must appear with its badge.
    await expect(queueDock(page)).toBeVisible({ timeout: 15_000 })
    await expect(queueDock(page).getByText(/queued|排队中/i).first()).toBeVisible()

    // When the first reply finishes, the queue pumps: dock disappears and
    // BOTH replies end up in the timeline.
    await expect(queueDock(page)).toHaveCount(0, { timeout: 120_000 })
    await expect(getMessages(page)).toHaveCount(2, { timeout: 60_000 })
  })

  test("a queued prompt can be removed before it is pumped", { tag: ["@core", "@queue"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    const sessionId = await createSessionAndNavigate(page, "queue-remove test")
    sessionIds.push(sessionId)

    await startLongPrompt(page)
    await typeInPrompt(page, "Second question")
    await submitPrompt(page)
    await expect(queueDock(page)).toBeVisible({ timeout: 15_000 })

    // Remove the queued item via its dock control (aria-label is i18n'd).
    const removeButton = queueDock(page).getByRole("button", {
      name: /remove from queue|从队列移除/i,
    })
    await expect(removeButton.first()).toBeVisible({ timeout: 10_000 })
    await removeButton.first().click()

    // Dock disappears; only the FIRST reply ever lands in the timeline.
    await expect(queueDock(page)).toHaveCount(0, { timeout: 120_000 })
    await expect(getMessages(page)).toHaveCount(1, { timeout: 60_000 })
  })
})
