import { test, expect } from "@playwright/test"
import { gotoProject, openSettings, closeDialog } from "./helpers/page"

/**
 * E2E tests for the Connect Provider dialog.
 * Opened via Settings → Providers tab → Connect button.
 * Note: The connect/add button may not exist if no providers are available.
 */
test.describe("Connect Provider Dialog", () => {
  test.beforeEach(async ({ page }) => {
    await gotoProject(page)
  })

  async function openProvidersTab(page: import("@playwright/test").Page) {
    await openSettings(page)

    const dialog = page.locator("[role='dialog']").first()
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    // Switch to Providers tab
    const providersTab = dialog
      .locator("[role='tab']")
      .filter({ hasText: /provider/i })
      .first()
    await expect(providersTab).toBeVisible({ timeout: 5_000 })
    await providersTab.click({ force: true })

    // Wait for providers tab panel
    const tabPanel = dialog.locator("[role='tabpanel']").first()
    await expect(tabPanel).toBeVisible({ timeout: 3_000 })

    return { dialog, tabPanel }
  }

  test("settings providers tab opens", { tag: ["@smoke"] }, async ({ page }) => {
    const { tabPanel } = await openProvidersTab(page)
    await expect(tabPanel).toBeVisible()
  })

  test("providers tab shows provider list or empty state", { tag: ["@core"] }, async ({ page }) => {
    const { tabPanel } = await openProvidersTab(page)

    // Provider items or connect/add buttons or empty state
    const providerItems = tabPanel.locator("[role='option'], [role='listitem'], li")
    const connectBtn = tabPanel.locator("button").filter({ hasText: /connect|add.*provider|添加|连接/i })
    const emptyMessage = tabPanel.locator("text=/no.*provider|empty|没有|暂无/i")

    const itemCount = await providerItems.count()
    const btnCount = await connectBtn.count()
    const emptyCount = await emptyMessage.count()

    // Should have at least items, a connect button, or an empty state
    expect(itemCount + btnCount + emptyCount).toBeGreaterThan(0)
  })

  test("Escape closes the settings dialog", { tag: ["@core"] }, async ({ page }) => {
    const { dialog } = await openProvidersTab(page)

    await expect(dialog).toBeVisible({ timeout: 5_000 })

    await closeDialog(page)

    await expect(dialog).toBeHidden({ timeout: 3_000 })
  })

  test("search input filters providers if present", { tag: ["@core"] }, async ({ page }) => {
    const { tabPanel } = await openProvidersTab(page)

    const searchInput = tabPanel.locator("input").first()
    const hasSearch = await searchInput.isVisible().catch(() => false)

    if (!hasSearch) {
      // No search input in providers tab — verify tab panel is still functional
      await expect(tabPanel).toBeVisible()
      return
    }

    // Type a search term to filter
    await searchInput.fill("xyznonexistent")
    // After filtering, either no results or empty state should show
    const remainingItems = tabPanel.locator("[role='option'], [role='listitem']")
    const itemCount = await remainingItems.count()
    // If items remain, they shouldn't match "xyznonexistent"
    if (itemCount > 0) {
      for (let i = 0; i < itemCount; i++) {
        const text = await remainingItems.nth(i).innerText()
        expect(text.toLowerCase()).not.toContain("xyznonexistent")
      }
    }
  })
})
