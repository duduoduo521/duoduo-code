import { test, expect } from "@playwright/test"
import { createSessionAndNavigate, sendPromptAndWait, executeSlashCommand, closeDialog } from "./helpers/page"
import { deleteTestSession } from "./helpers/sdk"

/**
 * E2E tests for the Fork dialog.
 * Opened via /fork slash command in a session with messages.
 * Covers: message selection, closing via Escape and cancel button.
 *
 * Key: use executeSlashCommand for /fork; the dialog opens as [data-component="dialog"]
 * with message selection UI inside using [data-slot="list-item"] items.
 */
test.describe("Fork Dialog", () => {
  const sessionIds: string[] = []

  test.afterEach(async () => {
    for (const id of sessionIds) {
      await deleteTestSession(id).catch(() => {})
    }
    sessionIds.length = 0
  })

  async function openForkDialog(page: import("@playwright/test").Page) {
    // Send a prompt first so there are messages to fork from
    await sendPromptAndWait(page, "Hello", "success-text-short")

    // Execute /fork slash command
    await executeSlashCommand(page, "fork")

    // The fork dialog should open — uses [data-component="dialog-overlay"] (rendered via Kobalte Portal)
    // The dialog uses a dynamic import which takes time to load
    const overlay = page.locator('[data-component="dialog-overlay"]')
    await expect(overlay.first()).toBeVisible({ timeout: 10_000 })
    return overlay.first()
  }

  test("/fork slash command opens fork dialog", { tag: ["@smoke"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Fork dialog test")
    sessionIds.push(sessionId)

    const overlay = await openForkDialog(page)
    await expect(overlay).toBeVisible()

    // URL should still be within the session route
    expect(page.url()).toMatch(/\/session/)
  })

  test("fork dialog shows message selection", { tag: ["@core"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Fork selection test")
    sessionIds.push(sessionId)

    const overlay = await openForkDialog(page)

    // The fork dialog is inside the overlay — find the dialog content
    const dialogContent = page.locator('[data-component="dialog"]')
    await expect(dialogContent.first()).toBeVisible({ timeout: 5_000 })

    // The fork dialog shows messages as [data-slot="list-item"] with [data-key]
    const messageItems = dialogContent.locator('[data-slot="list-item"]')
    const selectionUI = dialogContent.locator(
      "[role='listbox'], [role='radiogroup'], [role='checkbox'], input[type='checkbox']",
    )

    const hasMessageItems = (await messageItems.count()) > 0
    const hasSelectionUI = (await selectionUI.count()) > 0
    expect(hasMessageItems || hasSelectionUI).toBe(true)
  })

  test("Escape closes fork dialog", { tag: ["@core"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Fork escape test")
    sessionIds.push(sessionId)

    const overlay = await openForkDialog(page)
    await expect(overlay).toBeVisible({ timeout: 5_000 })

    // Press Escape to close
    await page.keyboard.press("Escape")

    // Dialog should no longer be visible
    await expect(overlay).not.toBeVisible({ timeout: 3_000 })

    // The prompt editor should be functional again
    const promptInput = page.locator('[data-component="prompt-input"]')
    await expect(promptInput).toBeVisible({ timeout: 3_000 })
  })

  test("cancel button closes fork dialog", { tag: ["@core"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Fork cancel test")
    sessionIds.push(sessionId)

    const overlay = await openForkDialog(page)

    // Find the dialog content
    const dialogContent = page.locator('[data-component="dialog"]')
    await expect(dialogContent.first()).toBeVisible({ timeout: 5_000 })

    // Find and click the close button — uses [data-slot="dialog-close-button"]
    const closeBtn = dialogContent.locator(
      "[data-slot='dialog-close-button'], button[aria-label*='close' i], button[aria-label*='cancel' i], button[data-action='cancel'], [aria-label='Close']",
    )
    await expect(closeBtn.first()).toBeVisible({ timeout: 3_000 })
    await closeBtn.first().click({ force: true })

    // Dialog should no longer be visible
    await expect(overlay).not.toBeVisible({ timeout: 3_000 })

    // The prompt editor should be functional again after closing
    const promptInput = page.locator('[data-component="prompt-input"]')
    await expect(promptInput).toBeVisible({ timeout: 3_000 })
  })
})
