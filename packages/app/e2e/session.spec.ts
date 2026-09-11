import { test, expect } from "@playwright/test"
import { gotoSession, gotoProject, createSessionAndNavigate, getProjectPath } from "./helpers/page"
import { createTestSession, deleteTestSession, listSessions } from "./helpers/sdk"

/**
 * E2E tests for session management.
 * Covers: session page loading, route redirects, prompt input rendering,
 * session switching via URL, and invalid session ID handling.
 */
test.describe("Session Management", () => {
  const sessionIds: string[] = []

  test.afterEach(async () => {
    for (const id of sessionIds) {
      await deleteTestSession(id).catch(() => {})
    }
    sessionIds.length = 0
  })

  test("session page loads and shows session UI", { tag: ["@smoke"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Session UI test")
    sessionIds.push(sessionId)

    await expect(page.locator('[data-component="session-prompt-dock"]').first()).toBeVisible()
    await expect(page.locator('[data-slot="session-turn-list"]')).toBeAttached()
  })

  test("session route redirects to default session", { tag: ["@core"] }, async ({ page }) => {
    await gotoProject(page)

    expect(page.url()).toContain("/session")
  })

  test("session page renders prompt input", { tag: ["@core"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Prompt input test")
    sessionIds.push(sessionId)

    await expect(page.locator('[data-component="prompt-input"]').first()).toBeVisible()
  })

  test("switching between sessions via URL", { tag: ["@core"] }, async ({ page }) => {
    const session1 = await createTestSession("Session A")
    const session2 = await createTestSession("Session B")
    sessionIds.push(session1.id, session2.id)

    await gotoSession(page, session1.id)
    expect(page.url()).toContain(session1.id)

    await gotoSession(page, session2.id)
    expect(page.url()).toContain(session2.id)
  })

  test("session page handles invalid session ID gracefully", { tag: ["@smoke"] }, async ({ page }) => {
    const projectPath = getProjectPath()
    await page.goto(`/${projectPath}/session/nonexistent-session-id`)
    await page.waitForLoadState("domcontentloaded")

    // App should not crash — body must have rendered content
    const body = page.locator("body")
    const text = await body.innerText()
    expect(text.length).toBeGreaterThan(0)
  })
})
