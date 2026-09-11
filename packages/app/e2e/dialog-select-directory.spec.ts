import { test, expect } from "@playwright/test"
import { gotoSession, openCommandPalette, closeDialog } from "./helpers/page"

/**
 * E2E tests for the DialogSelectDirectory component.
 * Opened via Ctrl+K / Ctrl+Shift+P (file search / command palette).
 * Must be on a session page for the command to be registered.
 */

async function openDirectoryDialog(page: import("@playwright/test").Page) {
  await openCommandPalette(page)

  const dialog = page.locator('[data-component="dialog"]').first()
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  return dialog
}

test.describe("Dialog Select Directory", () => {
  test.beforeEach(async ({ page }) => {
    await gotoSession(page)
  })

  test("opens via Ctrl+Shift+P", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await openDirectoryDialog(page)
    await expect(dialog).toBeVisible()
  })

  test("search input is present", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await openDirectoryDialog(page)

    const searchInput = dialog.locator('[data-slot="list-search-input"], input').first()
    await expect(searchInput).toBeVisible({ timeout: 3_000 })
  })

  test("shows list or empty state", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await openDirectoryDialog(page)

    // The List component renders items or an empty message
    const listItems = dialog.locator('[data-slot="list-item"]')
    const emptyMessage = dialog.locator('[data-slot="list-empty-state"]')
    // Also check for text patterns that indicate empty state
    const emptyText = dialog.getByText(/no.*found|empty|没有/i)
    const listCount = await listItems.count()
    const emptyCount = (await emptyMessage.count()) + (await emptyText.count())
    // Should have either items or an empty state indicator
    expect(listCount + emptyCount).toBeGreaterThan(0)
  })

  test("Escape closes dialog", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await openDirectoryDialog(page)
    await expect(dialog).toBeVisible()

    await closeDialog(page)
    await expect(dialog).not.toBeVisible()
  })
})
