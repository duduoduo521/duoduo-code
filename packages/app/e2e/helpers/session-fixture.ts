/**
 * Shared session fixture for e2e tests.
 *
 * Instead of creating a new session per test (which costs ~2-3s each),
 * tests that just need a session page (no prompt submission) can share
 * a single session within a describe block.
 *
 * Usage:
 *   import { createSharedSession, navigateToSharedSession, cleanupSharedSession } from "../helpers/session-fixture"
 *
 *   let sessionId: string
 *   test.beforeAll(async () => { sessionId = await createSharedSession("Test context") })
 *   test.beforeEach(async ({ page }) => { await navigateToSharedSession(page, sessionId) })
 *   test.afterAll(async () => { await cleanupSharedSession(sessionId) })
 */
import { type Page } from "@playwright/test"
import { createTestSession, deleteTestSession } from "./sdk"
import { gotoSession } from "./page"

/**
 * Create a shared session for a describe block.
 * Call once in test.beforeAll.
 */
export async function createSharedSession(title = "Shared session"): Promise<string> {
  const session = await createTestSession(title)
  return session.id
}

/**
 * Navigate to a shared session in beforeEach.
 */
export async function navigateToSharedSession(page: Page, sessionId: string) {
  await gotoSession(page, sessionId)
}

/**
 * Clean up a shared session in afterAll.
 */
export async function cleanupSharedSession(sessionId: string) {
  await deleteTestSession(sessionId).catch(() => {})
}
