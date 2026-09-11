import { test, expect } from "@playwright/test"
import { gotoProject, closeDialog } from "./helpers/page"

/**
 * E2E tests for the About dialog.
 * Covers: opening via sidebar, version display, link buttons, closing.
 */

async function openAboutDialog(page: import("@playwright/test").Page) {
  const sidebarRail = page.locator("[data-component='sidebar-rail']").first()
  await expect(sidebarRail).toBeVisible({ timeout: 5_000 })

  // The help/about button uses aria-label from i18n: "About Us" (en) / "关于我们" (zh)
  const aboutBtn = sidebarRail.locator("button[aria-label='About Us'], button[aria-label='关于我们']")
  await expect(aboutBtn.first()).toBeVisible({ timeout: 5_000 })
  await aboutBtn.first().click({ force: true })

  // The about dialog is loaded via dynamic import — wait longer for it to render
  const dialog = page.locator('[data-component="dialog"]').first()
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  return dialog
}

test.describe("About Dialog", () => {
  test.beforeEach(async ({ page }) => {
    await gotoProject(page)
  })

  test("about dialog opens via sidebar", { tag: ["@smoke"] }, async ({ page }) => {
    await openAboutDialog(page)

    const dialog = page.locator('[data-component="dialog"]').first()
    await expect(dialog).toBeVisible()
  })

  test("about dialog shows version info", { tag: ["@core"] }, async ({ page }) => {
    await openAboutDialog(page)

    const dialog = page.locator('[data-component="dialog"]').first()
    const versionText = dialog.locator("text=/v\\d+\\.\\d+\\.\\d+/")
    await expect(versionText).toBeVisible({ timeout: 3_000 })
  })

  test("about dialog shows link buttons", { tag: ["@core"] }, async ({ page }) => {
    await openAboutDialog(page)

    const dialog = page.locator('[data-component="dialog"]').first()
    // There are at least 3 link buttons (Website, GitHub, Gitee, and possibly more)
    const linkButtons = dialog.locator("button")
    const count = await linkButtons.count()
    expect(count).toBeGreaterThanOrEqual(3)
  })

  test("Escape closes about dialog", { tag: ["@core"] }, async ({ page }) => {
    await openAboutDialog(page)

    const dialog = page.locator('[data-component="dialog"]').first()
    await expect(dialog).toBeVisible()

    await closeDialog(page)
    await expect(dialog).not.toBeVisible()
  })
})
