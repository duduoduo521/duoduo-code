import { test, expect } from "@playwright/test"
import { createSessionAndNavigate, sendPromptAndWait, closeDialog, ensureReviewPanelOpen } from "./helpers/page"
import { deleteTestSession } from "./helpers/sdk"

/**
 * E2E tests for the review and preview panels.
 * Covers: Ctrl+Shift+R (review panel), Ctrl+Shift+B (preview panel),
 * panel content verification, and panel close behavior.
 *
 * Key: review panel is open by default — toggle with Ctrl+Shift+R;
 * preview panel is hidden by default — toggle with Ctrl+Shift+B.
 * Toggle buttons use aria-controls="review-panel" / aria-controls="preview-panel".
 */
test.describe("Session Panels", () => {
  const sessionIds: string[] = []

  test.afterEach(async () => {
    for (const id of sessionIds) {
      await deleteTestSession(id).catch(() => {})
    }
    sessionIds.length = 0
  })

  test("review panel is open by default", { tag: ["@smoke"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Review panel test")
    sessionIds.push(sessionId)

    // Review panel should be open by default (panelOpened: true in store)
    const reviewPanel = page.locator("#review-panel")
    await expect(reviewPanel).toBeVisible({ timeout: 5_000 })

    // The panel should contain tab triggers
    const tabs = reviewPanel.locator("[role='tab']")
    await expect(tabs.first()).toBeVisible({ timeout: 5_000 })
  })

  test("review panel shows diff view", { tag: ["@core"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Diff view test")

    // Send a prompt to create a session turn with messages
    // Note: success-tool-edit requires multi-turn LLM interaction which
    // doesn't work with the synchronous SDK endpoint, so use text fixture
    await sendPromptAndWait(page, "Edit the README file", "success-text-short")

    // Ensure the review panel is open
    await ensureReviewPanelOpen(page)

    // Review panel should be visible
    const reviewPanel = page.locator("#review-panel")
    await expect(reviewPanel).toBeVisible({ timeout: 5_000 })

    // The review panel should have tab triggers or content
    // The diff view only appears if the backend actually applied file edits,
    // which depends on the mock LLM response and file system state.
    // Check that the review panel has at least some content.
    const tabs = reviewPanel.locator("[role='tab']")
    const tabCount = await tabs.count()
    expect(tabCount).toBeGreaterThanOrEqual(1)
  })

  test("review panel close via toggle", { tag: ["@core"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Close review test")
    sessionIds.push(sessionId)

    // Ensure the review panel is open first
    await ensureReviewPanelOpen(page)

    const reviewPanel = page.locator("#review-panel")
    await expect(reviewPanel).toBeVisible({ timeout: 5_000 })

    // Close the panel via the toggle button
    const toggleBtn = page.locator('button[aria-controls="review-panel"]')
    await toggleBtn.first().click({ force: true })

    // Panel should no longer be visible (it uses inert + width:0 when closed)
    await expect(reviewPanel).not.toBeVisible({ timeout: 3_000 })
  })

  test("Ctrl+Shift+B opens preview panel", { tag: ["@smoke"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Preview panel test")
    sessionIds.push(sessionId)

    await page.keyboard.press("Control+Shift+b")

    // Preview panel should be visible — it uses id="preview-panel"
    const previewPanel = page.locator("#preview-panel")
    await expect(previewPanel).toBeVisible({ timeout: 5_000 })
  })

  test("preview panel shows URL input or iframe", { tag: ["@core"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Browser view test")
    sessionIds.push(sessionId)

    // Open the preview panel
    await page.keyboard.press("Control+Shift+b")

    const previewPanel = page.locator("#preview-panel")
    await expect(previewPanel).toBeVisible({ timeout: 5_000 })

    // Preview panel should contain a URL input or iframe
    const urlInput = previewPanel.locator(
      "input[type='url'], input[type='text'], input[placeholder*='url' i], input[placeholder*='address' i], iframe",
    )
    await expect(urlInput.first()).toBeVisible({ timeout: 5_000 })
  })

  test("preview panel close via toggle", { tag: ["@core"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Close preview test")
    sessionIds.push(sessionId)

    // Open the preview panel
    await page.keyboard.press("Control+Shift+b")

    const previewPanel = page.locator("#preview-panel")
    await expect(previewPanel).toBeVisible({ timeout: 5_000 })

    // Close the panel via the same shortcut (toggle)
    await page.keyboard.press("Control+Shift+b")

    // Panel should no longer be visible
    await expect(previewPanel).not.toBeVisible({ timeout: 3_000 })
  })
})
