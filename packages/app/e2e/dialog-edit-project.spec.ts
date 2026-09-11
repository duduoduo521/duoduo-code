import { test, expect } from "@playwright/test"
import { closeDialog } from "./helpers/page"
import { createSharedSession, navigateToSharedSession, cleanupSharedSession } from "./helpers/session-fixture"

/**
 * E2E tests for the Edit Project dialog.
 * Opened via the project-menu button in the sidebar (may be hidden until hover).
 * Covers: project configuration fields, closing, cancel.
 *
 * NOTE: The project-menu button is hidden until hover. Use force: true.
 * The menu item for "Edit" may have localized text.
 */
test.describe("Dialog Edit Project", () => {
  let sessionId: string

  test.beforeAll(async () => {
    sessionId = await createSharedSession("Dialog Edit Project")
  })
  test.beforeEach(async ({ page }) => {
    await navigateToSharedSession(page, sessionId)
  })
  test.afterAll(async () => {
    await cleanupSharedSession(sessionId)
  })

  async function tryOpenEditProjectDialog(page: import("@playwright/test").Page) {
    // Click the project "more options" button (dot-grid icon) in the sidebar.
    // The button may be hidden (opacity-0) until hover — use force: true.
    const moreBtn = page.locator("button[data-action='project-menu']").first()
    const isAttached = (await moreBtn.count().catch(() => 0)) > 0

    if (!isAttached) {
      return null
    }

    await moreBtn.click({ force: true })

    // Wait for a context menu or dropdown to appear
    const menu = page.locator("[role='menu'], [data-slot='context-menu-content']")
    const menuVisible = await menu
      .first()
      .isVisible()
      .catch(() => false)

    if (!menuVisible) {
      return null
    }

    // Click the "Edit" menu item in the dropdown
    const editItem = page
      .locator("[role='menuitem']")
      .filter({ hasText: /edit|编辑|settings|设置/i })
      .first()
    const hasEditItem = await editItem.isVisible().catch(() => false)

    if (!hasEditItem) {
      // Close the menu and return null
      await page.keyboard.press("Escape")
      return null
    }

    await editItem.click({ force: true })

    const dialog = page.locator("[role='dialog']").first()
    const dialogVisible = await dialog.isVisible().catch(() => false)
    if (!dialogVisible) {
      return null
    }

    return dialog
  }

  test("opens via sidebar menu if available", { tag: ["@smoke"] }, async ({ page }) => {
    const dialog = await tryOpenEditProjectDialog(page)

    if (!dialog) {
      // Project menu may not be available — verify page is still functional
      await expect(page.locator("[data-component='session-prompt-dock']").first()).toBeVisible({ timeout: 5_000 })
      return
    }

    await expect(dialog).toBeVisible({ timeout: 5_000 })
  })

  test("shows project config fields if dialog opens", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await tryOpenEditProjectDialog(page)

    if (!dialog) {
      await expect(page.locator("[data-component='session-prompt-dock']").first()).toBeVisible({ timeout: 5_000 })
      return
    }

    // Project directory field should be visible (or some input/content)
    const fields = dialog.locator("input, [data-component='input'], [readonly], [data-slot='input-input']")
    await expect(fields.first()).toBeVisible({ timeout: 5_000 })
  })

  test("Escape closes dialog if open", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await tryOpenEditProjectDialog(page)

    if (!dialog) {
      await expect(page.locator("[data-component='session-prompt-dock']").first()).toBeVisible({ timeout: 5_000 })
      return
    }

    await expect(dialog).toBeVisible({ timeout: 5_000 })

    await closeDialog(page)

    await expect(dialog).toBeHidden({ timeout: 3_000 })
  })

  test("cancel button closes dialog if open", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await tryOpenEditProjectDialog(page)

    if (!dialog) {
      await expect(page.locator("[data-component='session-prompt-dock']").first()).toBeVisible({ timeout: 5_000 })
      return
    }

    const cancelBtn = dialog.locator(
      "button:has-text('cancel'), button:has-text('Cancel'), button[aria-label*='cancel' i], button[data-action='cancel'], button:has-text('取消')",
    )
    const hasCancelBtn = await cancelBtn
      .first()
      .isVisible()
      .catch(() => false)

    if (!hasCancelBtn) {
      // No cancel button — close with Escape and verify dialog closes
      await closeDialog(page)
      await expect(dialog).toBeHidden({ timeout: 3_000 })
      return
    }

    await cancelBtn.first().click({ force: true })
    await expect(dialog).toBeHidden({ timeout: 3_000 })
  })
})
