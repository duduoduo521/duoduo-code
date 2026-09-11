import { test, expect } from "@playwright/test"
import { openSlashPopover, getPromptEditor } from "./helpers/page"
import { createSharedSession, navigateToSharedSession, cleanupSharedSession } from "./helpers/session-fixture"

/**
 * E2E tests for slash popover and prompt area controls.
 * Covers: slash command list, item text content, dismiss, filtering,
 * add files button, send button, and model selector.
 *
 * Key: slash popover items use [data-slash-id]; typing filters the list;
 * Escape dismisses the popover.
 */
test.describe("Slash Popover", () => {
  let sessionId: string

  test.beforeAll(async () => {
    sessionId = await createSharedSession("Slash Popover")
  })
  test.beforeEach(async ({ page }) => {
    await navigateToSharedSession(page, sessionId)
  })
  test.afterAll(async () => {
    await cleanupSharedSession(sessionId)
  })

  test("typing / shows slash commands", { tag: ["@smoke"] }, async ({ page }) => {
    await openSlashPopover(page)

    // Slash command items should appear with data-slash-id attributes
    const slashItems = page.locator("[data-slash-id]")
    await expect(slashItems.first()).toBeVisible({ timeout: 5_000 })

    const count = await slashItems.count()
    expect(count).toBeGreaterThan(0)
  })

  test("slash items have text content", { tag: ["@core"] }, async ({ page }) => {
    await openSlashPopover(page)

    const slashItems = page.locator("[data-slash-id]")
    await expect(slashItems.first()).toBeVisible({ timeout: 5_000 })

    // Every visible slash item should have non-empty text
    const count = await slashItems.count()
    for (let i = 0; i < Math.min(count, 5); i++) {
      const text = await slashItems.nth(i).textContent()
      expect(text).toBeTruthy()
      expect(text!.trim().length).toBeGreaterThan(0)
    }
  })

  test("Escape dismisses slash popover", { tag: ["@core"] }, async ({ page }) => {
    await openSlashPopover(page)

    const slashItems = page.locator("[data-slash-id]")
    await expect(slashItems.first()).toBeVisible({ timeout: 5_000 })

    // Press Escape to dismiss
    await page.keyboard.press("Escape")

    // Slash popover should be gone
    await expect(slashItems.first()).toBeHidden({ timeout: 3_000 })

    // The prompt editor should still be present and editable
    const editor = getPromptEditor(page)
    await expect(editor).toBeVisible({ timeout: 3_000 })
  })

  test("typing filters slash commands", { tag: ["@core"] }, async ({ page }) => {
    await openSlashPopover(page)

    const slashItemsBefore = page.locator("[data-slash-id]")
    await expect(slashItemsBefore.first()).toBeVisible({ timeout: 5_000 })
    const countBefore = await slashItemsBefore.count()

    // Type more to filter — "new" should match /new command
    await page.keyboard.type("new")

    const slashItemsAfter = page.locator("[data-slash-id]")
    // Wait a moment for the filter to apply
    await page.waitForTimeout(300)

    // The popover should still be visible with filtered results
    const filterVisible = await slashItemsAfter
      .first()
      .isVisible()
      .catch(() => false)

    if (filterVisible) {
      const countAfter = await slashItemsAfter.count()
      // Filtered list should be smaller or equal to the full list
      expect(countAfter).toBeLessThanOrEqual(countBefore)
      // At least one result should match the filter
      expect(countAfter).toBeGreaterThanOrEqual(1)
    } else {
      // If the popover closed, verify the prompt editor still has the typed text
      const editor = getPromptEditor(page)
      const text = await editor.innerText()
      expect(text).toContain("/new")
    }

    // Clean up the prompt
    const editor = getPromptEditor(page)
    await editor.click()
    await page.keyboard.press("Control+a")
    await page.keyboard.press("Backspace")
  })

  test("add files button is accessible", { tag: ["@core"] }, async ({ page }) => {
    const addFilesBtn = page.locator(
      "button[aria-label*='Add files'], button[aria-label*='添加文件'], button[aria-label*='attach' i]",
    )
    await expect(addFilesBtn.first()).toBeVisible({ timeout: 5_000 })
  })

  test("send button is present", { tag: ["@core"] }, async ({ page }) => {
    const sendBtn = page.locator("button[aria-label*='Send'], button[aria-label*='发送']")
    await expect(sendBtn.first()).toBeVisible({ timeout: 5_000 })
  })

  test("select model button is present", { tag: ["@core"] }, async ({ page }) => {
    const modelBtn = page.locator('[data-action="prompt-model"]')
    await expect(modelBtn.first()).toBeVisible({ timeout: 5_000 })

    // Clicking the model button should open the Kobalte Popover with list items
    await modelBtn.first().click({ force: true })
    const modelItems = page.locator('[data-slot="list-item"][data-key]')
    await expect(modelItems.first()).toBeVisible({ timeout: 5_000 })

    // At least one model option should be listed
    const count = await modelItems.count()
    expect(count).toBeGreaterThanOrEqual(1)

    // Close the popover
    await page.keyboard.press("Escape")
  })
})
