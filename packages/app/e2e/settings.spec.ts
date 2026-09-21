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
    // Click the visible Kobalte control (the hidden checkbox input sits
    // outside the viewport and force-clicking it fails with "outside of
    // viewport" once the dialog renders at full height); read the state from
    // the input's aria-checked.
    const switchControl = dialog
      .locator("[data-action='settings-line-wrapping'] [data-slot='switch-control']")
      .first()
    const switchInput = dialog
      .locator("[data-action='settings-line-wrapping'] input[role='switch']")
      .first()
    await expect(switchControl).toBeVisible({ timeout: 5_000 })

    const initialState = (await switchInput.getAttribute("aria-checked")) ?? "false"
    await switchControl.click()
    await expect(switchInput).not.toHaveAttribute("aria-checked", initialState, { timeout: 2_000 })

    const newState = await switchInput.getAttribute("aria-checked")
    expect(newState).not.toBe(initialState)

    // Toggle back to restore original state
    await switchControl.click()
    await expect(switchInput).toHaveAttribute("aria-checked", initialState, { timeout: 2_000 })
  })

  test("settings persist after page reload", { tag: ["@smoke"] }, async ({ page }) => {
    await openSettings(page)

    const dialog = page.locator('[data-component="dialog"]')
    const switchControl = dialog
      .locator("[data-action='settings-line-wrapping'] [data-slot='switch-control']")
      .first()
    const switchInput = dialog
      .locator("[data-action='settings-line-wrapping'] input[role='switch']")
      .first()
    await expect(switchControl).toBeVisible({ timeout: 5_000 })

    const initialState = (await switchInput.getAttribute("aria-checked")) ?? "false"
    await switchControl.click()
    await expect(switchInput).not.toHaveAttribute("aria-checked", initialState, { timeout: 2_000 })
    const changedState = await switchInput.getAttribute("aria-checked")

    // Close dialog and reload
    await closeDialog(page)
    await page.reload()
    await gotoProject(page)

    // Re-open settings and verify persistence
    await openSettings(page)
    const dialogAfterReload = page.locator('[data-component="dialog"]')
    const controlAfterReload = dialogAfterReload
      .locator("[data-action='settings-line-wrapping'] [data-slot='switch-control']")
      .first()
    const inputAfterReload = dialogAfterReload
      .locator("[data-action='settings-line-wrapping'] input[role='switch']")
      .first()
    await expect(controlAfterReload).toBeVisible({ timeout: 5_000 })

    const persistedState = await inputAfterReload.getAttribute("aria-checked")
    expect(persistedState).toBe(changedState)

    // Restore original state
    if (persistedState !== initialState) {
      await controlAfterReload.click()
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
