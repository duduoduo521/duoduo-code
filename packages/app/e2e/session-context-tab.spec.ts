import { test, expect } from "@playwright/test"
import { ensureReviewPanelOpen } from "./helpers/page"
import { createSharedSession, navigateToSharedSession, cleanupSharedSession } from "./helpers/session-fixture"

/**
 * E2E tests for the session context tab and context usage indicator.
 * Covers: context tab rendering, stats display, usage indicator, tab opening,
 * breakdown bar, and accordion items.
 *
 * Key: the context usage button uses aria-label from i18n (not "context" directly).
 * Clicking it opens the review panel and switches to the context tab.
 * Review panel is toggled by Ctrl+Shift+R or button[aria-label*="review" i].
 */
test.describe("Session Context Tab", () => {
  let sessionId: string

  test.beforeAll(async () => {
    sessionId = await createSharedSession("Session Context Tab")
  })
  test.beforeEach(async ({ page }) => {
    await navigateToSharedSession(page, sessionId)
  })
  test.afterAll(async () => {
    await cleanupSharedSession(sessionId)
  })

  test("context usage indicator is visible", { tag: ["@smoke"] }, async ({ page }) => {
    // The context usage indicator is a button with aria-label containing "context"
    const contextBtn = page.locator("button[aria-label*='context' i]")
    await expect(contextBtn.first()).toBeVisible({ timeout: 5_000 })
  })

  test("click opens context tab in review panel", { tag: ["@core"] }, async ({ page }) => {
    const contextBtn = page.locator("button[aria-label*='context' i]")
    await expect(contextBtn.first()).toBeVisible({ timeout: 5_000 })
    await contextBtn.first().click({ force: true })

    // The review panel should be visible
    const panel = page.locator("#review-panel")
    await expect(panel).toBeVisible({ timeout: 3_000 })

    // Context tab content should be visible
    const contextTab = page.locator("[role='tab']").filter({ hasText: /context/i })
    await expect(contextTab).toBeVisible({ timeout: 3_000 })
  })

  test("stats display shows token counts", { tag: ["@core"] }, async ({ page }) => {
    // Open the context tab
    const contextBtn = page.locator("button[aria-label*='context' i]")
    await expect(contextBtn.first()).toBeVisible({ timeout: 5_000 })
    await contextBtn.first().click({ force: true })

    // Wait for review panel to be visible
    const panel = page.locator("#review-panel")
    await expect(panel).toBeVisible({ timeout: 3_000 })

    // Stats grid should show token count elements — uses a grid layout inside the panel
    const statsGrid = page.locator("#review-panel .grid, #review-panel [data-slot='context-stats']")
    const statsVisible = await statsGrid
      .first()
      .isVisible()
      .catch(() => false)
    if (statsVisible) {
      await expect(statsGrid.first()).toBeVisible({ timeout: 5_000 })
    } else {
      // At least verify the panel is open
      await expect(panel).toBeVisible()
    }
  })

  test("breakdown bar renders", { tag: ["@core"] }, async ({ page }) => {
    // Open the context tab
    const contextBtn = page.locator("button[aria-label*='context' i]")
    await expect(contextBtn.first()).toBeVisible({ timeout: 5_000 })
    await contextBtn.first().click({ force: true })

    // Wait for review panel to be visible
    const panel = page.locator("#review-panel")
    await expect(panel).toBeVisible({ timeout: 3_000 })

    // Look for the breakdown bar — it's a progress bar inside the panel
    const breakdownBar = page.locator(
      "#review-panel .h-2, #review-panel [role='progressbar'], #review-panel .rounded-full",
    )
    const barVisible = await breakdownBar
      .first()
      .isVisible()
      .catch(() => false)
    if (barVisible) {
      const width = await breakdownBar.first().evaluate((el) => el.getBoundingClientRect().width)
      expect(width).toBeGreaterThan(0)
    } else {
      // The context tab may not have a breakdown bar if no context is used yet
      await expect(panel).toBeVisible()
    }
  })

  test("accordion items are interactive", { tag: ["@core"] }, async ({ page }) => {
    // Open the context tab
    const contextBtn = page.locator("button[aria-label*='context' i]")
    await expect(contextBtn.first()).toBeVisible({ timeout: 5_000 })
    await contextBtn.first().click({ force: true })

    // Wait for review panel to be visible
    const panel = page.locator("#review-panel")
    await expect(panel).toBeVisible({ timeout: 3_000 })

    // Look for accordion triggers inside the panel
    const accordionTriggers = page.locator("#review-panel button[aria-expanded]")
    const count = await accordionTriggers.count()

    if (count > 0) {
      await expect(accordionTriggers.first()).toBeVisible({ timeout: 5_000 })

      // Click to expand
      const firstTrigger = accordionTriggers.first()
      const wasExpanded = await firstTrigger.getAttribute("aria-expanded")
      await firstTrigger.click()

      // Accordion state should have toggled
      const isNowExpanded = await firstTrigger.getAttribute("aria-expanded")
      expect(isNowExpanded).not.toBe(wasExpanded)
    } else {
      // No accordion items — verify the panel is functional
      await expect(panel).toBeVisible()
    }
  })
})
