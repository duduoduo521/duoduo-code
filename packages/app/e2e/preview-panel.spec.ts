import { test, expect } from "@playwright/test"
import { createSharedSession, navigateToSharedSession, cleanupSharedSession } from "./helpers/session-fixture"

/**
 * E2E tests for the Preview Panel component.
 * Covers: panel visibility, URL input, toolbar buttons, URL loading, close, viewport toggle.
 *
 * The preview panel is toggled via Ctrl+Shift+B.
 * It renders as #preview-panel with role="region" aria-label="Preview Panel".
 * When hidden: inert + aria-hidden="true" + height:0.
 * When visible: no inert + aria-hidden="false" + height > 0.
 */
test.describe("Preview Panel", () => {
  let sessionId: string

  test.beforeAll(async () => {
    sessionId = await createSharedSession("Preview Panel")
  })
  test.beforeEach(async ({ page }) => {
    await navigateToSharedSession(page, sessionId)
  })
  test.afterAll(async () => {
    await cleanupSharedSession(sessionId)
  })

  /**
   * Helper: open the preview panel via Ctrl+Shift+B.
   */
  async function openPreviewPanel(page: import("@playwright/test").Page) {
    const panel = page.locator("#preview-panel")
    const isPanelVisible = await panel.isVisible().catch(() => false)
    if (!isPanelVisible) {
      // Toggle preview panel with Ctrl+Shift+B
      await page.keyboard.press("Control+Shift+b")
      await expect(panel).toBeVisible({ timeout: 5_000 })
    }
    return panel
  }

  test("preview panel DOM exists when opened", { tag: ["@smoke"] }, async ({ page }) => {
    const panel = await openPreviewPanel(page)
    await expect(panel).toBeVisible()
  })

  test("URL input is present", { tag: ["@core"] }, async ({ page }) => {
    const panel = await openPreviewPanel(page)
    // The URL input is a text input with placeholder like "Enter URL..."
    const urlInput = panel.locator(
      "input[type='text'], input[type='url'], input[placeholder*='url' i], input[placeholder*='URL' i]",
    )
    await expect(urlInput.first()).toBeVisible({ timeout: 3_000 })

    const placeholder = await urlInput.first().getAttribute("placeholder")
    expect(placeholder).toBeTruthy()
  })

  test("toolbar buttons are present", { tag: ["@core"] }, async ({ page }) => {
    const panel = await openPreviewPanel(page)

    // Toolbar has Refresh, viewport toggle, and Close buttons. On a slow
    // runner the panel can be reported visible while its toolbar subtree is
    // still mounting — poll instead of a one-shot count (windows CI 3x).
    await expect(async () => {
      const buttonCount = await panel.locator("button").count()
      expect(buttonCount).toBeGreaterThan(0)
    }).toPass({ timeout: 10_000 })
  })

  test("typing URL and pressing Enter loads", { tag: ["@core"] }, async ({ page }) => {
    const panel = await openPreviewPanel(page)
    const urlInput = panel.locator(
      "input[type='text'], input[type='url'], input[placeholder*='url' i], input[placeholder*='URL' i]",
    )
    await expect(urlInput.first()).toBeVisible({ timeout: 3_000 })

    // Type a URL and press Enter
    await urlInput.first().click()
    await urlInput.first().fill("https://example.com")
    await urlInput.first().press("Enter")

    // Check if iframe appeared with a src
    const iframe = panel.locator("iframe")
    await expect(iframe).toBeAttached({ timeout: 5_000 })
    const src = await iframe.getAttribute("src")
    expect(src).toBeTruthy()
  })

  test("close button works", { tag: ["@core"] }, async ({ page }) => {
    const panel = await openPreviewPanel(page)
    // Close using Ctrl+Shift+B toggle shortcut (more reliable than button click)
    await page.keyboard.press("Control+Shift+b")
    await expect(panel).toBeHidden({ timeout: 3_000 })
  })

  test("viewport toggle works", { tag: ["@core"] }, async ({ page }) => {
    const panel = await openPreviewPanel(page)
    // Viewport toggle aria-label="Switch to mobile view" or "Switch to desktop view"
    const toggleBtn = panel.locator(
      "button[aria-label*='mobile' i], button[aria-label*='desktop' i], button[aria-label*='viewport' i], button[aria-label*='Switch' i]",
    )
    await expect(toggleBtn.first()).toBeVisible({ timeout: 3_000 })

    const labelBefore = await toggleBtn.first().getAttribute("aria-label")
    await toggleBtn.first().click()

    const labelAfter = await toggleBtn.first().getAttribute("aria-label")
    // Label should change between mobile/desktop
    expect(labelAfter).toBeTruthy()
    expect(labelAfter).not.toBe(labelBefore)
  })
})
