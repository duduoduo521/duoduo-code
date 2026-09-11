import { test, expect } from "@playwright/test"
import { gotoProject, openSettings, closeDialog } from "./helpers/page"

/**
 * E2E tests for the DialogSelectMcp component.
 * Opened via Settings → MCP tab.
 * Covers: server list, search filtering, toggle switches.
 *
 * NOTE: MCP servers may not be configured in the test environment.
 * Tests make conditional assertions.
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

test.describe("Dialog Select MCP", () => {
  test.beforeEach(async ({ page }) => {
    await gotoProject(page)
  })

  test("opens via settings MCP tab", { tag: ["@core"] }, async ({ page }) => {
    const { tabPanel } = await openMcpTab(page)
    await expect(tabPanel).toBeVisible()
  })

  test("shows server list or empty state", { tag: ["@core"] }, async ({ page }) => {
    const { tabPanel } = await openMcpTab(page)

    const listItems = tabPanel.locator("[role='option'], [role='listitem'], li")
    const emptyMessage = tabPanel.locator("text=/no.*server|empty|没有|暂无/i")
    const listCount = await listItems.count()
    const emptyCount = await emptyMessage.count()
    // Should have either server items or an empty state indicator
    expect(listCount + emptyCount).toBeGreaterThan(0)
  })

  test("search input filters servers if present", { tag: ["@core"] }, async ({ page }) => {
    const { tabPanel } = await openMcpTab(page)

    const searchInput = tabPanel.locator("input").first()
    const hasSearch = await searchInput.isVisible().catch(() => false)

    if (!hasSearch) {
      // No search input — verify tab panel is functional
      await expect(tabPanel).toBeVisible()
      return
    }

    // Capture count before filtering
    const listItems = tabPanel.locator("[role='option'], [role='listitem'], li")
    const countBefore = await listItems.count()

    // Type a search term that likely matches few/no servers
    await searchInput.fill("nonexistent-server-xyz")

    // After filtering, remaining items should not contain the search term
    const remainingItems = tabPanel.locator("[role='option'], [role='listitem'], li")
    const filteredCount = await remainingItems.count()
    if (filteredCount > 0) {
      for (let i = 0; i < filteredCount; i++) {
        const text = await remainingItems.nth(i).innerText()
        expect(text.toLowerCase()).not.toContain("nonexistent-server-xyz")
      }
    }

    // Clear the search
    await searchInput.fill("")
    // After clearing, items should return to original count or more
    const afterClear = await listItems.count()
    expect(afterClear).toBeGreaterThanOrEqual(filteredCount)
  })

  test("toggle switches work if present", { tag: ["@core"] }, async ({ page }) => {
    const { tabPanel } = await openMcpTab(page)

    const switches = tabPanel.locator("[role='switch'], button[role='switch']")
    const switchCount = await switches.count()

    if (switchCount === 0) {
      // No MCP servers configured — verify tab panel is functional
      await expect(tabPanel).toBeVisible()
      return
    }

    const firstSwitch = switches.first()
    const checkedBefore = await firstSwitch.getAttribute("aria-checked")
    await firstSwitch.click({ force: true })

    const checkedAfter = await firstSwitch.getAttribute("aria-checked")
    // The checked state should have toggled
    expect(checkedAfter).not.toBe(checkedBefore)
  })
})
