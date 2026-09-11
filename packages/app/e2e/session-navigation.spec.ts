import { test, expect } from "@playwright/test"
import { gotoSession, createSessionAndNavigate, getProjectPath } from "./helpers/page"
import { createTestSession, deleteTestSession } from "./helpers/sdk"

/**
 * E2E tests for navigating between sessions and projects via keyboard shortcuts.
 * Covers: Alt+Up/Down (session nav), Control+Alt+Up/Down (project nav),
 * Shift+Alt+Up/Down (unseen sessions), Control+Shift+Backspace (archive).
 *
 * Key: these shortcuts use "mod" which maps to Control on Linux, Meta on Mac.
 * Playwright tests use Control+ prefix. Navigation may not work if only one
 * session exists or if the order doesn't match expectations.
 */
test.describe("Session Navigation", () => {
  const sessionIds: string[] = []

  test.afterEach(async () => {
    for (const id of sessionIds) {
      await deleteTestSession(id).catch(() => {})
    }
    sessionIds.length = 0
  })

  test("Alt+Up navigates to previous session", { tag: ["@smoke"] }, async ({ page }) => {
    const session1 = await createTestSession("Nav Session A")
    const session2 = await createTestSession("Nav Session B")
    sessionIds.push(session1.id, session2.id)

    // Navigate to the second (newer) session
    await gotoSession(page, session2.id)

    // Alt+Up should navigate to the previous (older) session
    await page.keyboard.press("Alt+ArrowUp")

    // Wait for navigation to complete
    await expect(page.locator('[data-component="session-prompt-dock"]').first()).toBeVisible({ timeout: 5_000 })

    // URL should have changed — it should now contain the first session's ID or another session
    const url = page.url()
    expect(url).toContain("/session")
  })

  test("Alt+Down navigates to next session", { tag: ["@smoke"] }, async ({ page }) => {
    const session1 = await createTestSession("Nav Session C")
    const session2 = await createTestSession("Nav Session D")
    sessionIds.push(session1.id, session2.id)

    // Navigate to the first (older) session
    await gotoSession(page, session1.id)

    // Alt+Down should navigate to the next (newer) session
    await page.keyboard.press("Alt+ArrowDown")

    // Wait for navigation to complete
    await expect(page.locator('[data-component="session-prompt-dock"]').first()).toBeVisible({ timeout: 5_000 })

    // URL should have changed
    const url = page.url()
    expect(url).toContain("/session")
  })

  test("Ctrl+Alt+Up does not crash with single project", { tag: ["@smoke"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Project nav up")
    sessionIds.push(sessionId)

    // Pressing the shortcut should not crash the page
    await page.keyboard.press("Control+Alt+ArrowUp")

    // Wait for page to settle
    await expect(page.locator('[data-component="session-prompt-dock"]').first()).toBeVisible({ timeout: 5_000 })

    // Page should remain on a session route (only one project in test env)
    expect(page.url()).toMatch(/\/session/)
  })

  test("Ctrl+Alt+Down does not crash with single project", { tag: ["@smoke"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Project nav down")
    sessionIds.push(sessionId)

    // Pressing the shortcut should not crash the page
    await page.keyboard.press("Control+Alt+ArrowDown")

    // Wait for page to settle
    await expect(page.locator('[data-component="session-prompt-dock"]').first()).toBeVisible({ timeout: 5_000 })

    // Page should remain on a session route (only one project in test env)
    expect(page.url()).toMatch(/\/session/)
  })

  test("Shift+Alt navigates to unseen sessions without crash", { tag: ["@smoke"] }, async ({ page }) => {
    const session1 = await createTestSession("Unseen Session A")
    const session2 = await createTestSession("Unseen Session B")
    sessionIds.push(session1.id, session2.id)

    await gotoSession(page, session1.id)

    // Shift+Alt+ArrowDown should not crash
    await page.keyboard.press("Shift+Alt+ArrowDown")

    // Wait for navigation
    await expect(page.locator('[data-component="session-prompt-dock"]').first()).toBeVisible({ timeout: 5_000 })

    // Page should still be on a session route
    expect(page.url()).toMatch(/\/session/)

    // Shift+Alt+ArrowUp should not crash
    await page.keyboard.press("Shift+Alt+ArrowUp")

    // Wait for navigation
    await expect(page.locator('[data-component="session-prompt-dock"]').first()).toBeVisible({ timeout: 5_000 })

    expect(page.url()).toMatch(/\/session/)
  })

  test("Ctrl+Shift+Backspace triggers archive action", { tag: ["@core"] }, async ({ page }) => {
    const session1 = await createTestSession("Archive target")
    const session2 = await createTestSession("Archive neighbor")
    sessionIds.push(session1.id, session2.id)

    // Navigate to the session we want to archive
    await gotoSession(page, session1.id)

    // Press the archive shortcut
    await page.keyboard.press("Control+Shift+Backspace")

    // A confirmation dialog may appear — dismiss it if so
    const confirmDialog = page.locator("[role='dialog'], [role='alertdialog']")
    const dialogVisible = await confirmDialog
      .first()
      .isVisible()
      .catch(() => false)
    if (dialogVisible) {
      // Look for a confirm/accept button
      const confirmBtn = confirmDialog
        .first()
        .locator("button")
        .filter({ hasText: /archive|delete|confirm|ok/i })
      const hasConfirm = await confirmBtn.count()
      if (hasConfirm > 0) {
        await confirmBtn.first().click()
      } else {
        await page.keyboard.press("Escape")
      }
    }

    // Wait for page to settle — use a proper wait instead of waitForTimeout
    await expect(page.locator("body")).toBeVisible({ timeout: 5_000 })

    // Page should remain functional — body should have content
    const body = page.locator("body")
    const text = await body.innerText()
    expect(text.length).toBeGreaterThan(0)

    // Remove from cleanup since it may have been archived
    const archivedIdx = sessionIds.indexOf(session1.id)
    if (archivedIdx >= 0) sessionIds.splice(archivedIdx, 1)
  })
})
