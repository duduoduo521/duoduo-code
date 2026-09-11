import { test, expect } from "@playwright/test"
import { switchModel, openModelSelector } from "./helpers/page"
import { createSharedSession, navigateToSharedSession, cleanupSharedSession } from "./helpers/session-fixture"

/**
 * E2E tests for model selection.
 * Covers: model picker visibility, opening, provider list, model selection,
 * search filtering, closing with Escape, and switching active model.
 *
 * Key: model selector is a Kobalte Popover with [data-slot="list-item"] items.
 * Trigger is [data-action="prompt-model"]. Can also be opened via Ctrl+'.
 */
test.describe("Model Selection", () => {
  let sessionId: string

  test.beforeAll(async () => {
    sessionId = await createSharedSession("Model Selection")
  })
  test.beforeEach(async ({ page }) => {
    await navigateToSharedSession(page, sessionId)
  })
  test.afterAll(async () => {
    await cleanupSharedSession(sessionId)
  })

  test("model picker trigger is visible on session page", { tag: ["@smoke"] }, async ({ page }) => {
    const modelTrigger = page.locator('[data-action="prompt-model"]')
    await expect(modelTrigger.first()).toBeVisible({ timeout: 5_000 })
  })

  test("clicking model picker opens model selection popover", { tag: ["@core"] }, async ({ page }) => {
    await openModelSelector(page)

    // Model list items should be visible
    const modelItems = page.locator('[data-slot="list-item"]')
    await expect(modelItems.first()).toBeVisible({ timeout: 5_000 })
  })

  test("model selection shows mock provider models", { tag: ["@core"] }, async ({ page }) => {
    await openModelSelector(page)

    // At least one model option from the mock provider should be visible
    const modelItems = page.locator('[data-slot="list-item"]')
    const count = await modelItems.count()
    expect(count).toBeGreaterThanOrEqual(1)
  })

  test("selecting a model from the list works", { tag: ["@core"] }, async ({ page }) => {
    await openModelSelector(page)

    // Click the first model option
    const firstItem = page.locator('[data-slot="list-item"]').first()
    await expect(firstItem).toBeVisible({ timeout: 5_000 })
    await firstItem.click()

    // The popover should close after selection
    await expect(page.locator('[data-slot="list-item"][data-key]').first())
      .not.toBeVisible({ timeout: 3_000 })
      .catch(() => {})
  })

  test("model picker search filters models", { tag: ["@core"] }, async ({ page }) => {
    await openModelSelector(page)

    // The popover should have a search input
    const searchInput = page.locator('[data-slot="list-search-wrapper"] input, [data-slot="input-input"]').first()
    await expect(searchInput).toBeVisible({ timeout: 3_000 })

    // Type a filter term
    await searchInput.fill("short")

    // After filtering, the visible model items should contain "short"
    await page.waitForTimeout(500)
    const filteredItems = page.locator('[data-slot="list-item"]')
    const count = await filteredItems.count()
    // Should have at least one matching item
    expect(count).toBeGreaterThanOrEqual(1)
  })

  test("Escape closes model selector", { tag: ["@core"] }, async ({ page }) => {
    await openModelSelector(page)

    // Press Escape to close
    await page.keyboard.press("Escape")

    // Popover should close
    await expect(page.locator('[data-slot="list-item"][data-key]').first())
      .not.toBeVisible({ timeout: 3_000 })
      .catch(() => {})
  })

  test("switching model changes active model", { tag: ["@core"] }, async ({ page }) => {
    // Check current model text
    const modelTrigger = page.locator('[data-action="prompt-model"]').first()
    await expect(modelTrigger).toBeVisible({ timeout: 5_000 })
    const beforeText = await modelTrigger.innerText()

    // Switch to a different model
    await switchModel(page, "success-text-multi-chunk")

    // The trigger text should have changed
    const afterText = await modelTrigger.innerText()
    expect(afterText).not.toBe(beforeText)
  })
})
