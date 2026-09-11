import { test, expect } from "@playwright/test"
import { gotoProject, openSettings, closeDialog } from "./helpers/page"

/**
 * E2E tests for the settings dialog.
 * Covers: opening settings, toggling settings, settings persistence, font size controls.
 *
 * Key: settings opens with Ctrl+, or sidebar settings button.
 * The dialog uses [data-component="dialog"] (custom Dialog component).
 * Color scheme uses Select (not switch); line wrapping uses Switch.
 */
test.describe("Settings", () => {
  test.beforeEach(async ({ page }) => {
    await gotoProject(page)
  })

  test("settings dialog opens via keyboard shortcut", { tag: ["@smoke"] }, async ({ page }) => {
    await openSettings(page)

    const dialog = page.locator('[data-component="dialog"]')
    await expect(dialog.first()).toBeVisible()
  })

  test("settings dialog opens via sidebar button", { tag: ["@core"] }, async ({ page }) => {
    const sidebarRail = page.locator('[data-component="sidebar-rail"]').first()
    await expect(sidebarRail).toBeVisible({ timeout: 5_000 })

    const settingsButton = sidebarRail.locator(
      "button[aria-label*='settings' i], button[aria-label*='设置' i], button[aria-label*='preferences' i]",
    )
    await expect(settingsButton.first()).toBeVisible({ timeout: 5_000 })
    await settingsButton.first().click({ force: true })

    const dialog = page.locator('[data-component="dialog"]')
    await expect(dialog.first()).toBeVisible({ timeout: 5_000 })
  })

  test("settings dialog contains general settings", { tag: ["@core"] }, async ({ page }) => {
    await openSettings(page)

    const dialog = page.locator('[data-component="dialog"]')
    const colorScheme = dialog.locator("[data-action='settings-color-scheme']").first()
    const lineWrapping = dialog.locator("[data-action='settings-line-wrapping']").first()
    // At least one general setting control must be present
    const hasColorScheme = await colorScheme.isVisible().catch(() => false)
    const hasLineWrapping = await lineWrapping.isVisible().catch(() => false)
    expect(hasColorScheme || hasLineWrapping).toBe(true)
  })

  test("toggling line wrapping setting works", { tag: ["@core"] }, async ({ page }) => {
    await openSettings(page)

    const dialog = page.locator('[data-component="dialog"]')
    const switchEl = dialog
      .locator("[data-action='settings-line-wrapping'] button, [data-action='settings-line-wrapping'] [role='switch']")
      .first()
    await expect(switchEl).toBeVisible({ timeout: 5_000 })

    const initialState = (await switchEl.getAttribute("aria-checked")) ?? "false"
    await switchEl.click({ force: true })
    await expect(switchEl).not.toHaveAttribute("aria-checked", initialState, { timeout: 2_000 })

    const newState = await switchEl.getAttribute("aria-checked")
    expect(newState).not.toBe(initialState)

    // Toggle back to restore original state
    await switchEl.click({ force: true })
    await expect(switchEl).toHaveAttribute("aria-checked", initialState, { timeout: 2_000 })
  })

  test("settings persist after page reload", { tag: ["@smoke"] }, async ({ page }) => {
    await openSettings(page)

    const dialog = page.locator('[data-component="dialog"]')
    const switchEl = dialog
      .locator("[data-action='settings-line-wrapping'] button, [data-action='settings-line-wrapping'] [role='switch']")
      .first()
    await expect(switchEl).toBeVisible({ timeout: 5_000 })

    const initialState = (await switchEl.getAttribute("aria-checked")) ?? "false"
    await switchEl.click({ force: true })
    await expect(switchEl).not.toHaveAttribute("aria-checked", initialState, { timeout: 2_000 })
    const changedState = await switchEl.getAttribute("aria-checked")

    // Close dialog and reload
    await closeDialog(page)
    await page.reload()
    await gotoProject(page)

    // Re-open settings and verify persistence
    await openSettings(page)
    const dialogAfterReload = page.locator('[data-component="dialog"]')
    const switchAfterReload = dialogAfterReload
      .locator("[data-action='settings-line-wrapping'] button, [data-action='settings-line-wrapping'] [role='switch']")
      .first()
    await expect(switchAfterReload).toBeVisible({ timeout: 5_000 })

    const persistedState = await switchAfterReload.getAttribute("aria-checked")
    expect(persistedState).toBe(changedState)

    // Restore original state
    if (persistedState !== initialState) {
      await switchAfterReload.click({ force: true })
    }
  })

  test("closing settings dialog with Escape", { tag: ["@core"] }, async ({ page }) => {
    await openSettings(page)

    const dialog = page.locator('[data-component="dialog"]')
    await expect(dialog.first()).toBeVisible()

    await closeDialog(page)

    await expect(dialog.first()).toBeHidden({ timeout: 3_000 })
  })

  test("font size controls work", { tag: ["@core"] }, async ({ page }) => {
    await openSettings(page)

    const dialog = page.locator('[data-component="dialog"]')
    const decreaseBtn = dialog.locator("[data-action='settings-font-size-decrease']")
    const increaseBtn = dialog.locator("[data-action='settings-font-size-increase']")
    await expect(decreaseBtn).toBeVisible({ timeout: 5_000 })
    await expect(increaseBtn).toBeVisible({ timeout: 5_000 })

    // Click increase then decrease — both should succeed without error
    await increaseBtn.click()
    await expect(dialog.first()).toBeVisible()
    await decreaseBtn.click()
    await expect(dialog.first()).toBeVisible()

    // Dialog should still be visible and functional
    await expect(dialog.first()).toBeVisible()
  })
})
