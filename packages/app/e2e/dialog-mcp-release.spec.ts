import { test, expect } from "@playwright/test"
import { gotoProject, openSettings, closeDialog } from "./helpers/page"

/**
 * E2E tests for the MCP dialog.
 * Opened via Settings → MCP tab.
 * (Release Notes are tested separately in dialog-release-notes.spec.ts)
 */

async function openMcpTab(page: import("@playwright/test").Page) {
  await openSettings(page)

  const dialog = page.locator("[role='dialog']").first()
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  const mcpTab = dialog.locator("[role='tab']").filter({ hasText: /mcp/i }).first()
  await expect(mcpTab).toBeVisible({ timeout: 3_000 })
  await mcpTab.click({ force: true })

  const tabPanel = dialog.locator("[role='tabpanel']").first()
  await expect(tabPanel).toBeVisible({ timeout: 3_000 })

  return { dialog, tabPanel }
}

test.describe("MCP Dialog", () => {
  test.beforeEach(async ({ page }) => {
    await gotoProject(page)
  })

  test("opens via settings MCP tab", { tag: ["@smoke"] }, async ({ page }) => {
    const { tabPanel } = await openMcpTab(page)
    await expect(tabPanel).toBeVisible()
  })

  test("MCP tab shows server list or empty", { tag: ["@core"] }, async ({ page }) => {
    const { tabPanel } = await openMcpTab(page)

    const serverItems = tabPanel.locator("[role='option'], [role='listitem'], [data-server], [data-component*='mcp' i]")
    const toggleItems = tabPanel.locator(
      "[role='switch'], button[aria-label*='toggle' i], button[aria-label*='enable' i], button[aria-label*='server' i]",
    )
    const emptyMessage = tabPanel.locator("text=/no.*server|empty|没有|暂无/i")

    const serverCount = await serverItems.count()
    const toggleCount = await toggleItems.count()
    const emptyCount = await emptyMessage.count()
    // Should have at least server items, toggle items, or an empty state
    expect(serverCount + toggleCount + emptyCount).toBeGreaterThan(0)
  })

  test("Escape closes MCP settings", { tag: ["@core"] }, async ({ page }) => {
    const { dialog } = await openMcpTab(page)
    await expect(dialog).toBeVisible()

    await closeDialog(page)
    await expect(dialog).not.toBeVisible()
  })
})
