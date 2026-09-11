import { test, expect } from "@playwright/test"
import { gotoHome } from "./helpers/page"
import { createSharedSession, navigateToSharedSession, cleanupSharedSession } from "./helpers/session-fixture"

/**
 * E2E tests for the SessionContextUsage component.
 * Covers: visibility on home vs session, progress circle SVG, click behavior.
 *
 * Key: the context usage indicator only appears on session pages.
 * It renders as a Button with an SVG circle inside.
 * Clicking opens the review panel (#review-panel) via Ctrl+Shift+R or button.
 */
test.describe("Session Context Usage", () => {
  let sessionId: string

  test.beforeAll(async () => {
    sessionId = await createSharedSession("Session Context Usage")
  })
  test.beforeEach(async ({ page }) => {
    await navigateToSharedSession(page, sessionId)
  })
  test.afterAll(async () => {
    await cleanupSharedSession(sessionId)
  })

  test("not visible on home page", { tag: ["@core"] }, async ({ page }) => {
    await gotoHome(page)

    // The context usage indicator only renders inside a session
    const contextButton = page.locator("button[aria-label*='context' i]")
    await expect(contextButton).not.toBeVisible({ timeout: 3_000 })
  })

  test("appears in session", { tag: ["@core"] }, async ({ page }) => {
    // The context usage indicator should be visible in a session
    const contextButton = page.locator("button[aria-label*='context' i]")
    await expect(contextButton.first()).toBeVisible({ timeout: 5_000 })
  })

  test("progress circle SVG renders", { tag: ["@core"] }, async ({ page }) => {
    const contextButton = page.locator("button[aria-label*='context' i]")
    await expect(contextButton.first()).toBeVisible({ timeout: 5_000 })

    // The button contains a ProgressCircle (SVG)
    const svg = contextButton.first().locator("svg")
    await expect(svg).toBeVisible({ timeout: 3_000 })
  })

  test("click opens context tab in review panel", { tag: ["@core"] }, async ({ page }) => {
    const contextButton = page.locator("button[aria-label*='context' i]")
    await expect(contextButton.first()).toBeVisible({ timeout: 5_000 })
    await contextButton.first().click({ force: true })

    // After clicking, the review panel should be visible
    const panel = page.locator("#review-panel")
    await expect(panel).toBeVisible({ timeout: 3_000 })

    // The context tab should be active in the review panel
    const contextTab = page.locator("[role='tab']").filter({ hasText: /context/i })
    await expect(contextTab).toBeVisible({ timeout: 3_000 })

    const ariaSelected = await contextTab.getAttribute("aria-selected")
    expect(ariaSelected).toBe("true")
  })
})
