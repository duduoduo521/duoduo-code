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
    // Busy confirmed via the submit button's stop icon — the UI's own busy
    // signal (stopping() = input.working() && blank(), where working() is the
    // SERVER session status). submit.ts enqueues iff working() at submit
    // time, so waiting for this marker guarantees the second submit below
    // takes the enqueue path instead of racing the ~17s streaming window
    // (observed: linux CI 3× on both queue tests — the second prompt landed
    // after the reply finished and the queue dock never appeared).
    await expect(
      page.locator('[data-action="prompt-submit"][data-icon="stop"]').first(),
    ).toBeVisible({ timeout: 30_000 })
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
    // The dock re-renders while the first reply streams; a single click can
    // land on a detached element and silently no-op (observed: the dock then
    // stayed for the full 120s window). Retry the click until the dock is
    // actually gone.
    await expect(async () => {
      if (!(await queueDock(page).isVisible())) return
      const removeButton = queueDock(page).getByRole("button", {
        name: /remove from queue|从队列移除/i,
      })
      if (await removeButton.first().isVisible()) {
        await removeButton.first().click({ force: true })
      }
      await expect(queueDock(page)).toHaveCount(0, { timeout: 2_000 })
    }).toPass({ timeout: 60_000 })

    // Dock disappears; only the FIRST reply ever lands in the timeline.
    await expect(queueDock(page)).toHaveCount(0, { timeout: 120_000 })
    await expect(getMessages(page)).toHaveCount(1, { timeout: 60_000 })
  })
})
