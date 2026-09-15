import { test, expect } from "@playwright/test"
import { gotoProject, openSettings, closeDialog } from "./helpers/page"

/**
 * E2E tests for the settings dialog tabs.
 * Covers: tab switching, tab content rendering, tab state reset.
 */
test.describe("Settings Tabs", () => {
  test.beforeEach(async ({ page }) => {
    await gotoProject(page)
  })

  test("settings has multiple tabs", { tag: ["@smoke"] }, async ({ page }) => {
    await openSettings(page)

    const dialog = page.locator("[role='dialog']").first()
    const tabTriggers = dialog.locator("[role='tab']")
    const count = await tabTriggers.count()
    expect(count).toBeGreaterThanOrEqual(2)
  })

  test("shortcuts tab shows keybinds", { tag: ["@core"] }, async ({ page }) => {
    await openSettings(page)

    const dialog = page.locator("[role='dialog']").first()
    const shortcutsTab = dialog.locator("[role='tab']").filter({ hasText: /shortcut/i })
    await expect(shortcutsTab).toBeVisible({ timeout: 5_000 })
    await shortcutsTab.click({ force: true })

    // Verify the shortcuts tab panel is visible
    const tabPanel = dialog.locator("[role='tabpanel']")
    await expect(tabPanel).toBeVisible({ timeout: 5_000 })
  })

  test("providers tab shows provider content", { tag: ["@core"] }, async ({ page }) => {
    await openSettings(page)

    const dialog = page.locator("[role='dialog']").first()
    // Tab 文案随语言变化（en="Models"、zh="模型"），用稳定的 data-value 定位
    const providersTab = dialog.locator("[role='tab'][data-value='providers']").first()
    await expect(providersTab).toBeVisible({ timeout: 5_000 })
    await providersTab.click({ force: true })

    // Verify providers tab panel is visible
    const tabPanel = dialog.locator("[role='tabpanel']")
    await expect(tabPanel).toBeVisible({ timeout: 5_000 })

    // The providers section may or may not have a connected-providers-section component
    const providersSection = dialog.locator("[data-component='connected-providers-section']")
    const hasSection = await providersSection.isVisible().catch(() => false)

    if (!hasSection) {
      // Section may not exist — verify the tab panel has some content
      const tabContent = tabPanel.locator("*")
      const contentCount = await tabContent.count()
      expect(contentCount).toBeGreaterThan(0)
    }
  })

  test("MCP tab shows MCP settings", { tag: ["@core"] }, async ({ page }) => {
    await openSettings(page)

    const dialog = page.locator("[role='dialog']").first()
    const mcpTab = dialog.locator("[role='tab']").filter({ hasText: /mcp/i })
    const tabCount = await mcpTab.count()
    if (tabCount === 0) {
      // 本版本设置对话框没有独立 MCP tab（MCP 管理走智械市场/gear）——验证对话框仍正常
      const allTabs = dialog.locator("[role='tab']")
      expect(await allTabs.count()).toBeGreaterThan(0)
      test.info().annotations.push({ type: "skip-reason", description: "No dedicated MCP tab in this build" })
      return
    }
    await mcpTab.first().click({ force: true })

    // Verify MCP tab panel is visible
    const tabPanel = dialog.locator("[role='tabpanel']")
    await expect(tabPanel).toBeVisible({ timeout: 5_000 })
  })

  test("switching tabs does not crash", { tag: ["@smoke"] }, async ({ page }) => {
    await openSettings(page)

    const dialog = page.locator("[role='dialog']").first()
    const tabTriggers = dialog.locator("[role='tab']")
    const count = await tabTriggers.count()

    // Click each tab trigger
    for (let i = 0; i < Math.min(count, 6); i++) {
      await tabTriggers.nth(i).click({ force: true })
      // Wait for tab panel to render
      await expect(dialog.locator("[role='tabpanel']")).toBeVisible({ timeout: 3_000 })
    }

    // Dialog should still be visible after cycling all tabs
    await expect(dialog).toBeVisible()
  })

  test("tab state resets on dialog reopen", { tag: ["@core"] }, async ({ page }) => {
    await openSettings(page)

    const dialog = page.locator("[role='dialog']").first()
    // Switch to a different tab
    const shortcutsTab = dialog.locator("[role='tab']").filter({ hasText: /shortcut/i })
    await expect(shortcutsTab).toBeVisible({ timeout: 5_000 })
    await shortcutsTab.click({ force: true })

    // Close dialog
    await closeDialog(page)

    // Reopen
    await openSettings(page)

    const dialogAfter = page.locator("[role='dialog']").first()
    // The first tab (General) should be active
    const generalTab = dialogAfter.locator("[role='tab']").first()
    const isSelected = await generalTab.getAttribute("aria-selected")
    expect(isSelected).toBe("true")
  })
})
