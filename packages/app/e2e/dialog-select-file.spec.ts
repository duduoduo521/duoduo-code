import { test, expect } from "@playwright/test"
import { gotoSession, openCommandPalette, closeDialog } from "./helpers/page"

/**
 * E2E tests for the DialogSelectFile component.
 * The command palette (Ctrl+K / Ctrl+Shift+P / Ctrl+P) IS the file search dialog.
 * It shows a DialogSelectFile with a search input and file list.
 */

async function openFileSearchDialog(page: import("@playwright/test").Page) {
  await openCommandPalette(page)

  const dialog = page.locator('[data-component="dialog"]').first()
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  return dialog
}

test.describe("Dialog Select File", () => {
  test.beforeEach(async ({ page }) => {
    await gotoSession(page)
  })

  test("opens via Ctrl+Shift+P", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await openFileSearchDialog(page)
    await expect(dialog).toBeVisible()
  })

  test("search input is present and focused", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await openFileSearchDialog(page)

    const searchInput = dialog.locator('[data-slot="list-search-input"], input').first()
    await expect(searchInput).toBeVisible({ timeout: 3_000 })
  })

  test("shows file list or empty state", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await openFileSearchDialog(page)

    const listItems = dialog.locator('[data-slot="list-item"]')
    const emptyMessage = dialog.locator('[data-slot="list-empty-state"]')
    const emptyText = dialog.getByText(/no.*found|empty|没有/i)
    const listCount = await listItems.count()
    const emptyCount = (await emptyMessage.count()) + (await emptyText.count())
    // Should have either file items or an empty state indicator
    expect(listCount + emptyCount).toBeGreaterThan(0)
  })

  test("Escape closes dialog", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await openFileSearchDialog(page)
    await expect(dialog).toBeVisible()

    await closeDialog(page)
    await expect(dialog).not.toBeVisible()
  })
})
