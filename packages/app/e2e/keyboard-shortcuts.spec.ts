import { test, expect } from "@playwright/test"
import {
  gotoSession,
  openSettings,
  openCommandPalette,
  closeDialog,
  toggleSidebar,
  isSidebarVisible,
} from "./helpers/page"

/**
 * E2E tests for keyboard shortcuts.
 * Covers: Ctrl+K, Ctrl+B, Ctrl+P, Escape, Ctrl+,, Ctrl+Shift+P, Ctrl+L, post-reload.
 *
 * Key: Ctrl+K / Ctrl+P / Ctrl+Shift+P all open file search (DialogSelectFile),
 * NOT a command list. Ctrl+B toggles sidebar. Ctrl+, opens settings.
 * The sidebar panel uses inert/aria-hidden when collapsed, not display:none.
 */

test.describe("Keyboard Shortcuts", () => {
  test.beforeEach(async ({ page }) => {
    await gotoSession(page)
  })

  test("Ctrl+K opens file search dialog", { tag: ["@core"] }, async ({ page }) => {
    await page.keyboard.press("Control+k")

    const dialog = page.locator('[data-component="dialog"]')
    await expect(dialog.first()).toBeVisible({ timeout: 5_000 })
  })

  test("Ctrl+B toggles sidebar", { tag: ["@core"] }, async ({ page }) => {
    // Sidebar is closed by default (layout.sidebar.opened defaults to false)
    const initiallyVisible = await isSidebarVisible(page)

    // Toggle sidebar — should flip the state
    const afterFirstToggle = await toggleSidebar(page)
    expect(afterFirstToggle).toBe(!initiallyVisible)

    // Toggle again — should flip back
    const afterSecondToggle = await toggleSidebar(page)
    expect(afterSecondToggle).toBe(initiallyVisible)
  })

  test("Ctrl+P opens file search", { tag: ["@core"] }, async ({ page }) => {
    await page.keyboard.press("Control+p")

    const dialog = page.locator('[data-component="dialog"]')
    await expect(dialog.first()).toBeVisible({ timeout: 5_000 })

    // Should contain a search input
    const searchInput = dialog.first().locator("input, [contenteditable]").first()
    await expect(searchInput).toBeVisible({ timeout: 3_000 })
  })

  test("Escape closes dialogs", { tag: ["@core"] }, async ({ page }) => {
    await openSettings(page)
    const dialog = page.locator('[data-component="dialog"]')
    await expect(dialog.first()).toBeVisible({ timeout: 5_000 })

    await closeDialog(page)
    await expect(dialog.first()).not.toBeVisible()
  })

  test("Ctrl+, opens settings", { tag: ["@core"] }, async ({ page }) => {
    await openSettings(page)

    const dialog = page.locator('[data-component="dialog"]')
    await expect(dialog.first()).toBeVisible({ timeout: 5_000 })

    // Settings dialog should have tabs
    const tabs = dialog.first().locator("[role='tab']")
    const tabCount = await tabs.count()
    expect(tabCount).toBeGreaterThan(0)
  })

  test("Ctrl+Shift+P opens file search dialog", { tag: ["@smoke"] }, async ({ page }) => {
    await openCommandPalette(page)

    const dialog = page.locator('[data-component="dialog"]')
    await expect(dialog.first()).toBeVisible({ timeout: 5_000 })
  })

  test("Ctrl+L focuses prompt", { tag: ["@core"] }, async ({ page }) => {
    await page.keyboard.press("Control+l")

    const promptEditor = page.locator("[data-component='prompt-input'], [contenteditable='true']").first()
    await expect(promptEditor).toBeVisible({ timeout: 5_000 })
    // The prompt editor or a child should be focused
    const isFocused = await promptEditor.evaluate(
      (el) => el === document.activeElement || el.contains(document.activeElement),
    )
    expect(isFocused).toBe(true)
  })

  test("shortcuts work after page reload", { tag: ["@core"] }, async ({ page }) => {
    await page.reload()
    await page.waitForLoadState("domcontentloaded")
    // Wait for the session shell to fully render
    const promptDock = page.locator("[data-component='session-prompt-dock']")
    await expect(promptDock.first()).toBeVisible({ timeout: 10_000 })

    // Verify Ctrl+K still works after reload
    await page.keyboard.press("Control+k")
    const dialog = page.locator('[data-component="dialog"]')
    await expect(dialog.first()).toBeVisible({ timeout: 5_000 })
  })
})
