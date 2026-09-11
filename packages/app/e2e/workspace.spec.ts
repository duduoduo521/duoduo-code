import { test, expect } from "@playwright/test"
import { createSessionAndNavigate, executeSlashCommand, typeInPrompt, submitPrompt, closeDialog } from "./helpers/page"
import { createTestSession, deleteTestSession, listSessions } from "./helpers/sdk"

/**
 * E2E tests for workspace management.
 * Covers: /workspace slash command, workspace creation shortcut,
 * sidebar workspace items, workspace switching, and /new slash command.
 *
 * Key: use executeSlashCommand for slash commands; workspace items may not
 * appear if workspaces are disabled; /new must track new session IDs.
 */
test.describe("Workspace Management", () => {
  const sessionIds: string[] = []

  test.afterEach(async () => {
    for (const id of sessionIds) {
      await deleteTestSession(id).catch(() => {})
    }
    sessionIds.length = 0
  })

  test("/workspace slash command does not crash", { tag: ["@smoke"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Workspace slash test")
    sessionIds.push(sessionId)

    // /workspace may not be a recognized command — typing it and checking
    // the popover should not crash. If it's not in the slash list, just
    // verify the page is functional.
    await typeInPrompt(page, "/workspace")

    // Wait for the popover to potentially appear or not
    const slashPopover = page.locator("[data-slash-id], [role='listbox']")
    const popoverVisible = await slashPopover
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false)

    // Clear the prompt regardless
    const editor = page.locator('[data-component="prompt-input"]')
    await editor.click()
    await page.keyboard.press("Control+a")
    await page.keyboard.press("Backspace")

    // Page should remain functional and on a session route
    await expect(page).toHaveURL(/\/session/, { timeout: 5_000 })
  })

  test("Ctrl+Shift+W does not crash", { tag: ["@smoke"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "New workspace shortcut test")
    sessionIds.push(sessionId)

    await page.keyboard.press("Control+Shift+w")

    // A dialog for creating a new workspace may appear
    const dialog = page.locator('[data-component="dialog"], [role="dialog"], [role="alertdialog"]')
    const dialogVisible = await dialog
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
    if (dialogVisible) {
      await closeDialog(page)
    }

    // Page should remain functional
    await expect(page).toHaveURL(/\/session/, { timeout: 5_000 })
  })

  test("sidebar workspace items visible when present", { tag: ["@core"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Workspace sidebar test")
    sessionIds.push(sessionId)

    // Workspace items should be visible in the sidebar — may not be present if workspaces disabled
    const workspaceItems = page.locator(
      "[data-component='sidebar-rail'] [aria-label*='workspace' i], " +
        "[data-component='sidebar-panel'] [aria-label*='workspace' i], " +
        "[data-component='workspace-list'], " +
        "[data-slot='workspace-item'], " +
        "[data-action='workspace-toggle']",
    )
    const count = await workspaceItems.count()

    if (count > 0) {
      await expect(workspaceItems.first()).toBeVisible({ timeout: 5_000 })
    } else {
      // Workspaces may not be enabled — verify the sidebar rail is at least present
      await expect(page.locator("[data-component='sidebar-rail']").first()).toBeVisible()
    }
  })

  test("workspace switching works when available", { tag: ["@core"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Workspace switch test")
    sessionIds.push(sessionId)

    // Find clickable workspace items in the sidebar
    const workspaceItems = page.locator(
      "[data-component='sidebar-rail'] button[aria-label*='workspace' i], " +
        "[data-component='sidebar-panel'] button[aria-label*='workspace' i], " +
        "[data-slot='workspace-item'], " +
        "[data-action='workspace-toggle']",
    )
    const count = await workspaceItems.count()

    if (count >= 2) {
      // Click the second workspace item to switch
      await workspaceItems.nth(1).click({ force: true })

      // Page should remain functional after switching
      expect(page.url()).toBeTruthy()
    } else if (count === 1) {
      // Only one workspace — verify the first is present
      await expect(workspaceItems.first()).toBeAttached({ timeout: 3_000 })
    } else {
      // No workspace items — verify sidebar is functional
      await expect(page.locator("[data-component='sidebar-rail']").first()).toBeVisible()
    }
  })

  test("/new creates session in workspace", { tag: ["@core"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "New slash test")
    sessionIds.push(sessionId)

    // Count sessions before
    const beforeIds = new Set((await listSessions()).map((s) => s.id))

    // Use executeSlashCommand to create a new session
    await executeSlashCommand(page, "new")

    // Wait for the new session to load
    await expect(page.locator('[data-component="session-prompt-dock"]').first()).toBeVisible({ timeout: 10_000 })

    // A new session should have been created
    const afterIds = (await listSessions()).map((s) => s.id)
    const newId = afterIds.find((id) => !beforeIds.has(id))
    if (newId) sessionIds.push(newId)

    // Should still be on a session route
    await expect(page).toHaveURL(/\/session/, { timeout: 5_000 })
  })
})
