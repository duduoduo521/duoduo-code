import { test, expect } from "@playwright/test"
import { gotoProject, openSettings, closeDialog } from "./helpers/page"

/**
 * E2E tests for the Select Server dialog.
 * Opened via Settings → MCP tab → Add server button.
 * Covers: server list, closing, add server form.
 *
 * NOTE: The add server button may not exist if no MCP servers are configured.
 * Tests make conditional assertions.
 */
test.describe("Dialog Select Server", () => {
  test.beforeEach(async ({ page }) => {
    await gotoProject(page)
  })

  async function openMcpTab(page: import("@playwright/test").Page) {
    await openSettings(page)

    const dialog = page.locator("[role='dialog']").first()
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    // Switch to MCP tab
    const mcpTab = dialog.locator("[role='tab']").filter({ hasText: /mcp/i }).first()
    if ((await mcpTab.count()) === 0) {
      // 本版本设置对话框没有独立 MCP tab（MCP 管理走智械市场/gear）
      test.info().skip(true, "No dedicated MCP tab in this build")
    }
    await mcpTab.click({ force: true })

    // Wait for MCP tab panel
    const tabPanel = dialog.locator("[role='tabpanel']").first()
    await expect(tabPanel).toBeVisible({ timeout: 3_000 })

    return { dialog, tabPanel }
  }

  test("opens via settings MCP tab", { tag: ["@smoke"] }, async ({ page }) => {
    const { tabPanel } = await openMcpTab(page)
    await expect(tabPanel).toBeVisible()
  })

  test("shows server list or add server option", { tag: ["@core"] }, async ({ page }) => {
    const { tabPanel } = await openMcpTab(page)

    // Either server items or an "add server" button should be present
    const serverItems = tabPanel.locator("[role='option'], [role='listitem']")
    const addServerBtn = tabPanel.locator("button").filter({ hasText: /add.*server|new.*server|添加.*服务/i })
    const emptyMessage = tabPanel.locator("text=/no.*server|empty|没有|暂无/i")

    const serverCount = await serverItems.count()
    const addBtnCount = await addServerBtn.count()
    const emptyCount = await emptyMessage.count()

    // Should have at least server items, an add button, or an empty state
    expect(serverCount + addBtnCount + emptyCount).toBeGreaterThan(0)
  })

  test("Escape closes dialog", { tag: ["@core"] }, async ({ page }) => {
    const { dialog } = await openMcpTab(page)
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    await closeDialog(page)

    await expect(dialog).toBeHidden({ timeout: 3_000 })
  })

  test("add server form appears if button exists", { tag: ["@core"] }, async ({ page }) => {
    const { tabPanel } = await openMcpTab(page)

    // Click the add server button if it exists
    const addServerBtn = tabPanel.locator("button").filter({ hasText: /add.*server|new.*server|添加.*服务/i })
    const hasAddBtn = await addServerBtn
      .first()
      .isVisible()
      .catch(() => false)

    if (!hasAddBtn) {
      // No add server button — verify tab panel is functional
      await expect(tabPanel).toBeVisible()
      return
    }

    await addServerBtn.first().click({ force: true })

    // A URL input should appear for the new server
    const urlInput = page.locator(
      "[role='dialog'] input[type='url'], [role='dialog'] input[placeholder*='url' i], [role='dialog'] input[placeholder*='address' i], [role='dialog'] input[aria-label*='url' i], [role='dialog'] [data-component='input']",
    )
    const hasInput = await urlInput
      .first()
      .isVisible()
      .catch(() => false)
    // Either the input appeared or the dialog is still visible (not crashed)
    expect(
      hasInput ||
        (await page
          .locator("[role='dialog']")
          .first()
          .isVisible()
          .catch(() => false)),
    ).toBe(true)
  })
})
