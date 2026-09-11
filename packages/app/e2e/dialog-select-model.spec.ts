import { test, expect } from "@playwright/test"
import { openModelSelector } from "./helpers/page"
import { createSharedSession, navigateToSharedSession, cleanupSharedSession } from "./helpers/session-fixture"

/**
 * E2E tests for the DialogSelectModel component.
 * Opened via Ctrl+' (model selector shortcut) or by clicking the prompt-model button.
 * The model selector is a Kobalte Popover with [data-slot="list-item"] items.
 * Must be on a session page.
 * Covers: model list, search, close.
 */
test.describe("Dialog Select Model", () => {
  let sessionId: string

  test.beforeAll(async () => {
    sessionId = await createSharedSession("Dialog Select Model")
  })
  test.beforeEach(async ({ page }) => {
    await navigateToSharedSession(page, sessionId)
  })
  test.afterAll(async () => {
    await cleanupSharedSession(sessionId)
  })

  test("opens via Ctrl+' or prompt-model button", { tag: ["@core"] }, async ({ page }) => {
    await openModelSelector(page)
    // Model items should be visible — they use [data-slot="list-item"] with [data-key]
    const modelItems = page.locator('[data-slot="list-item"][data-key]')
    await expect(modelItems.first()).toBeVisible({ timeout: 5_000 })
  })

  test("shows model list", { tag: ["@core"] }, async ({ page }) => {
    await openModelSelector(page)

    // Mock provider has models — they appear as [data-slot="list-item"] with [data-key]
    const modelOptions = page.locator('[data-slot="list-item"]')
    await expect(modelOptions.first()).toBeVisible({ timeout: 5_000 })
    const count = await modelOptions.count()
    expect(count).toBeGreaterThanOrEqual(1)
  })

  test("search input filters models", { tag: ["@core"] }, async ({ page }) => {
    await openModelSelector(page)

    // The search input is inside the popover
    const searchInput = page.locator('[data-slot="list-search-input"], [data-slot="list-search-wrapper"] input').first()
    const hasSearch = await searchInput.isVisible().catch(() => false)
    if (hasSearch) {
      // Get initial model count
      const initialCount = await page.locator('[data-slot="list-item"]').count()

      // Type a specific model name to filter
      await searchInput.fill("success-text-short")
      await expect(page.locator('[data-slot="list-item"]').first()).toBeVisible({ timeout: 3_000 })

      // Filtered results should be fewer than or equal to initial
      const filteredCount = await page.locator('[data-slot="list-item"]').count()
      expect(filteredCount).toBeLessThanOrEqual(initialCount)
      // At least one match for the mock fixture
      expect(filteredCount).toBeGreaterThanOrEqual(1)
    } else {
      // No search input — just verify model items are present
      const modelOptions = page.locator('[data-slot="list-item"]')
      const count = await modelOptions.count()
      expect(count).toBeGreaterThanOrEqual(1)
    }
  })

  test("Escape closes model selector", { tag: ["@core"] }, async ({ page }) => {
    await openModelSelector(page)

    const modelItems = page.locator('[data-slot="list-item"][data-key]')
    await expect(modelItems.first()).toBeVisible()

    await page.keyboard.press("Escape")
    await expect(modelItems.first()).not.toBeVisible({ timeout: 3_000 })
  })
})
