import { test, expect } from "@playwright/test"
import { gotoSession, gotoProject, openCommandPalette, closeDialog } from "./helpers/page"
import { createSharedSession, navigateToSharedSession, cleanupSharedSession } from "./helpers/session-fixture"

/**
 * E2E tests for the Titlebar component.
 * Covers: sidebar toggle, new session, search, command palette, open project,
 * status, terminal, consistency across navigation, and button clickability.
 *
 * Key: titlebar buttons may use aria-labels from i18n; always use .first().
 * Search files button doubles as the command palette trigger.
 */
test.describe("Titlebar", () => {
  let sessionId: string

  test.beforeAll(async () => {
    sessionId = await createSharedSession("Titlebar")
  })
  test.beforeEach(async ({ page }) => {
    await navigateToSharedSession(page, sessionId)
  })
  test.afterAll(async () => {
    await cleanupSharedSession(sessionId)
  })

  test("sidebar toggle button exists", { tag: ["@smoke"] }, async ({ page }) => {
    const toggleBtn = page.locator("button[aria-label*='Toggle sidebar' i], button[aria-label*='侧边栏']")
    await expect(toggleBtn.first()).toBeVisible({ timeout: 5_000 })
  })

  test("new session button exists", { tag: ["@core"] }, async ({ page }) => {
    const newSessionBtn = page.locator(
      "button[aria-label*='New session' i], button[aria-label*='新建会话'], [data-action='workspace-new-session']",
    )
    await expect(newSessionBtn.first()).toBeVisible({ timeout: 5_000 })
  })

  test("search files button exists", { tag: ["@core"] }, async ({ page }) => {
    const searchBtn = page.locator("button[aria-label*='Search files' i], button[aria-label*='搜索文件']")
    await expect(searchBtn.first()).toBeVisible({ timeout: 5_000 })
  })

  test("command palette trigger exists", { tag: ["@core"] }, async ({ page }) => {
    // The search files button doubles as the command palette trigger
    const searchBtn = page.locator("button[aria-label*='Search files' i], button[aria-label*='搜索文件']")
    await expect(searchBtn.first()).toBeVisible({ timeout: 5_000 })
  })

  test("open project button exists", { tag: ["@core"] }, async ({ page }) => {
    const openProjectBtn = page.locator(
      "button[aria-label*='Open project' i], button[aria-label*='打开项目'], [data-action='project-switch']",
    )
    await expect(openProjectBtn.first()).toBeVisible({ timeout: 5_000 })
  })

  test("status button exists", { tag: ["@core"] }, async ({ page }) => {
    const statusBtn = page.locator("button[aria-label*='status' i]")
    await expect(statusBtn.first()).toBeVisible({ timeout: 5_000 })
  })

  test("terminal toggle button exists", { tag: ["@core"] }, async ({ page }) => {
    const termBtn = page.locator("button[aria-label*='terminal' i], button[aria-label*='终端']")
    await expect(termBtn.first()).toBeVisible({ timeout: 5_000 })
  })

  test("titlebar is consistent across navigation", { tag: ["@core"] }, async ({ page }) => {
    // Verify titlebar buttons exist on session page
    const searchBtn = page.locator("button[aria-label*='Search files' i], button[aria-label*='搜索文件']")
    await expect(searchBtn.first()).toBeVisible({ timeout: 5_000 })

    // Navigate to project root
    await gotoProject(page)

    // Titlebar should still be present with the same buttons
    const searchBtnAfterNav = page.locator("button[aria-label*='Search files' i], button[aria-label*='搜索文件']")
    await expect(searchBtnAfterNav.first()).toBeVisible({ timeout: 5_000 })

    // Navigate back to session
    await gotoSession(page, sessionId)

    // Titlebar should still be consistent
    const searchBtnAfterReturn = page.locator("button[aria-label*='Search files' i], button[aria-label*='搜索文件']")
    await expect(searchBtnAfterReturn.first()).toBeVisible({ timeout: 5_000 })
  })

  test("titlebar buttons are clickable", { tag: ["@smoke"] }, async ({ page }) => {
    // Click the sidebar toggle — should not crash
    const toggleBtn = page.locator("button[aria-label*='Toggle sidebar' i], button[aria-label*='侧边栏']")
    await expect(toggleBtn.first()).toBeVisible({ timeout: 5_000 })
    await toggleBtn.first().click({ force: true })
    // Toggle back
    await toggleBtn.first().click({ force: true })

    // Click the search button — should open file search dialog
    const searchBtn = page.locator("button[aria-label*='Search files' i], button[aria-label*='搜索文件']")
    await expect(searchBtn.first()).toBeVisible({ timeout: 5_000 })
    await searchBtn.first().click()

    // Close the dialog
    await closeDialog(page)

    // Click the status button — should not crash
    const statusBtn = page.locator("button[aria-label*='status' i]")
    await expect(statusBtn.first()).toBeVisible({ timeout: 5_000 })
    await statusBtn.first().click({ force: true })
    await page.keyboard.press("Escape")

    // Page should remain functional after all clicks
    await expect(page.locator("[data-component='session-prompt-dock']").first()).toBeVisible()
  })
})
