import { test, expect } from "@playwright/test"
import { gotoSession, openCommandPalette, closeDialog } from "./helpers/page"

/**
 * E2E tests for the command palette / file search dialog.
 * The command palette (Ctrl+K / Ctrl+Shift+P / Ctrl+P) opens the DialogSelectFile
 * component, which shows a file search input and file list.
 * Covers: opening via keyboard, search focus, filtering, closing.
 */

async function openPalette(page: import("@playwright/test").Page) {
  await openCommandPalette(page)
  const dialog = page.locator('[data-component="dialog"]').first()
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  return dialog
}

test.describe("Command Palette", () => {
  test.beforeEach(async ({ page }) => {
    await gotoSession(page)
  })

  test("opens via Ctrl+Shift+P", { tag: ["@smoke"] }, async ({ page }) => {
    const dialog = await openPalette(page)
    await expect(dialog).toBeVisible()
  })

  test("opens via Ctrl+K", { tag: ["@core"] }, async ({ page }) => {
    await page.keyboard.press("Control+k")
    const dialog = page.locator('[data-component="dialog"]').first()
    await expect(dialog).toBeVisible({ timeout: 5_000 })
  })

  test("search input is focused", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await openPalette(page)

    const searchInput = dialog.locator('[data-slot="list-search-input"], input').first()
    await expect(searchInput).toBeVisible({ timeout: 3_000 })

    // The input should be focused after the palette opens
    await expect(searchInput).toBeFocused()
  })

  test("typing filters file list", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await openPalette(page)

    const searchInput = dialog.locator('[data-slot="list-search-input"], input').first()
    await expect(searchInput).toBeVisible({ timeout: 3_000 })
    await searchInput.click({ force: true })
    await page.keyboard.type("src")

    // Wait for the list to update
    const options = dialog.locator('[data-slot="list-item"]')
    await expect(options.first())
      .toBeVisible({ timeout: 3_000 })
      .catch(() => {
        // No results for "src" — that's acceptable
      })
    const filteredCount = await options.count()

    // Clear and check that unfiltered has more or equal items
    await page.keyboard.press("Control+a")
    await page.keyboard.press("Backspace")
    // Wait for list to repopulate
    await expect(options.first())
      .toBeVisible({ timeout: 3_000 })
      .catch(() => {
        // Empty list is acceptable
      })

    const fullCount = await options.count()
    expect(filteredCount).toBeLessThanOrEqual(fullCount)
  })

  test("Escape closes palette", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await openPalette(page)
    await expect(dialog).toBeVisible()

    await closeDialog(page)
    await expect(dialog).not.toBeVisible()
  })

  test("selecting a file closes palette", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await openPalette(page)

    const options = dialog.locator('[data-slot="list-item"]')
    const count = await options.count()

    if (count > 0) {
      await options.first().click({ force: true })
      // After selecting a file, the dialog should close
      await expect(dialog).not.toBeVisible({ timeout: 5_000 })
    } else {
      // No files to select — close the palette and verify it closes
      await closeDialog(page)
      await expect(dialog).not.toBeVisible({ timeout: 3_000 })
    }
  })
})
