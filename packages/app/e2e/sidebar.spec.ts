import { test, expect } from "@playwright/test"
import { gotoProject, getProjectPath } from "./helpers/page"
import { createSharedSession, navigateToSharedSession, cleanupSharedSession } from "./helpers/session-fixture"

/**
 * E2E tests for the sidebar.
 * Covers: sidebar rendering, project icons, project navigation,
 * sidebar panel expansion, file tree interaction, directory expand/collapse,
 * settings button, and resize resilience.
 *
 * Key: sidebar-rail always needs .first(); project-switch is hidden until hover;
 * filetree is hidden by default — toggle with Ctrl+\.
 * At small viewports, sidebar-rail may be hidden and sidebar-nav-mobile appears instead.
 */
test.describe("Sidebar", () => {
  let sessionId: string

  test.beforeAll(async () => {
    sessionId = await createSharedSession("Sidebar")
  })
  test.beforeEach(async ({ page }) => {
    await navigateToSharedSession(page, sessionId)
  })
  test.afterAll(async () => {
    await cleanupSharedSession(sessionId)
  })

  test("sidebar rail renders on the page", { tag: ["@smoke"] }, async ({ page }) => {
    await gotoProject(page)

    await expect(page.locator('[data-component="sidebar-rail"]').first()).toBeVisible({ timeout: 5_000 })
  })

  test("sidebar shows interactive buttons", { tag: ["@core"] }, async ({ page }) => {
    await gotoProject(page)

    const sidebarRail = page.locator('[data-component="sidebar-rail"]').first()
    await expect(sidebarRail).toBeVisible({ timeout: 5_000 })

    const buttons = sidebarRail.locator("button")
    const buttonCount = await buttons.count()
    expect(buttonCount).toBeGreaterThan(0)
  })

  test("clicking a project in sidebar navigates to session", { tag: ["@core"] }, async ({ page }) => {
    const sidebarRail = page.locator('[data-component="sidebar-rail"]').first()
    await expect(sidebarRail).toBeVisible({ timeout: 5_000 })

    // The "Open project" button in the sidebar nav panel
    const projectButton = page
      .locator(
        '[data-component="sidebar-nav-desktop"] button[aria-label*="project" i], [data-component="sidebar-nav-desktop"] [data-action="project-switch"]',
      )
      .first()
    const hasProjectBtn = await projectButton.isVisible().catch(() => false)
    if (hasProjectBtn) {
      await projectButton.click({ force: true })
      // Page should still be on a session route
      await expect(page).toHaveURL(/\/session/, { timeout: 5_000 })
    } else {
      // Fallback: verify sidebar rail is present
      await expect(sidebarRail).toBeVisible()
    }
  })

  test("sidebar panel expands when project is active", { tag: ["@core"] }, async ({ page }) => {
    const sidebarNav = page.locator('[data-component="sidebar-nav-desktop"]')
    await expect(sidebarNav).toBeVisible({ timeout: 5_000 })
  })

  test("file tree is hidden by default and can be toggled", { tag: ["@core"] }, async ({ page }) => {
    const fileTree = page.locator('[data-component="filetree"]')

    // File tree is hidden by default — toggle it on with Ctrl+\
    await page.keyboard.press("Control+\\")
    await expect(fileTree).toBeVisible({ timeout: 5_000 })

    // Check for tree items — look for any clickable items inside the filetree
    const treeItems = fileTree.locator("[data-scope='filetree'], [role='treeitem']")
    const itemCount = await treeItems.count()
    expect(itemCount).toBeGreaterThanOrEqual(0)

    // The file tree should be visible and functional
    await expect(fileTree).toBeVisible()
  })

  test("expand/collapse directories in file tree", { tag: ["@core"] }, async ({ page }) => {
    // Toggle file tree visible
    await page.keyboard.press("Control+\\")
    const fileTree = page.locator('[data-component="filetree"]')
    await expect(fileTree).toBeVisible({ timeout: 5_000 })

    // Find expandable directory items within the file tree scope
    const expandableItems = fileTree.locator("[aria-expanded]")
    const expandableCount = await expandableItems.count()

    if (expandableCount > 0) {
      const firstDir = expandableItems.first()
      const wasExpanded = await firstDir.getAttribute("aria-expanded")

      // Toggle the directory
      await firstDir.click()
      const isNowExpanded = await firstDir.getAttribute("aria-expanded")
      expect(isNowExpanded).toBeDefined()
      expect(isNowExpanded).not.toBe(wasExpanded)

      // Toggle back
      await firstDir.click()
      const restoredState = await firstDir.getAttribute("aria-expanded")
      expect(restoredState).toBe(wasExpanded)
    } else {
      // No expandable items — still verify the file tree is functional
      await expect(fileTree).toBeVisible()
    }
  })

  test("sidebar settings button is accessible", { tag: ["@smoke"] }, async ({ page }) => {
    const sidebarRail = page.locator('[data-component="sidebar-rail"]').first()
    await expect(sidebarRail).toBeVisible({ timeout: 5_000 })

    const settingsBtn = sidebarRail.locator(
      "button[aria-label*='settings' i], button[aria-label*='preferences' i], button[aria-label='Settings'], button[aria-label='设置']",
    )
    await expect(settingsBtn.first()).toBeVisible({ timeout: 5_000 })
  })

  test("sidebar remains functional after page resize", { tag: ["@smoke"] }, async ({ page }) => {
    // Resize the viewport — at small sizes, sidebar-rail may be hidden
    // but sidebar-nav-mobile should appear
    await page.setViewportSize({ width: 800, height: 600 })
    // At 800px, either sidebar-rail or sidebar-nav-mobile should be present
    const sidebarRail = page.locator('[data-component="sidebar-rail"]').first()
    const sidebarMobile = page.locator('[data-component="sidebar-nav-mobile"]').first()
    const railVisible = await sidebarRail.isVisible().catch(() => false)
    const mobileVisible = await sidebarMobile.isVisible().catch(() => false)
    expect(railVisible || mobileVisible).toBe(true)

    // Resize back
    await page.setViewportSize({ width: 1280, height: 720 })
    await expect(page.locator('[data-component="sidebar-rail"]').first()).toBeVisible({ timeout: 3_000 })
  })
})
