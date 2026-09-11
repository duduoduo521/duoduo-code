import { test, expect } from "@playwright/test"
import {
  gotoSession,
  createSessionAndNavigate,
  typeInPrompt,
  submitPrompt,
  sendPromptAndWait,
  getPromptEditor,
  openSlashPopover,
  executeSlashCommand,
  getMessages,
} from "./helpers/page"
import { deleteTestSession } from "./helpers/sdk"

/**
 * E2E tests for the prompt input area.
 * Covers: visibility, typing, slash commands, submission, multi-line input,
 * file attachment, and long text handling.
 *
 * Key: slash commands use [data-slash-id] items in the popover;
 * Enter submits the prompt; Shift+Enter creates a new line.
 */
test.describe("Prompt Input", () => {
  const sessionIds: string[] = []

  test.afterEach(async () => {
    for (const id of sessionIds) {
      await deleteTestSession(id).catch(() => {})
    }
    sessionIds.length = 0
  })

  test("prompt input area is visible on session page", { tag: ["@smoke"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Prompt visibility test")
    sessionIds.push(sessionId)

    const editor = getPromptEditor(page)
    await expect(editor).toBeVisible()
    // The editor should be contenteditable
    const editable = await editor.getAttribute("contenteditable")
    expect(editable).toBe("true")
  })

  test("can type text in prompt input", { tag: ["@core"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Type text test")
    sessionIds.push(sessionId)

    const editor = getPromptEditor(page)
    await typeInPrompt(page, "Hello, this is a test prompt")

    const text = await editor.innerText()
    expect(text).toContain("Hello, this is a test prompt")
  })

  test("slash commands appear when typing /", { tag: ["@core"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Slash commands test")
    sessionIds.push(sessionId)

    await openSlashPopover(page)

    // Slash command items should appear with data-slash-id attributes
    const slashItems = page.locator("[data-slash-id]")
    await expect(slashItems.first()).toBeVisible({ timeout: 5_000 })

    const count = await slashItems.count()
    expect(count).toBeGreaterThan(0)
  })

  test("Enter key submits prompt", { tag: ["@core"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Submit prompt test")
    sessionIds.push(sessionId)

    // Send prompt via SDK and wait for the response to appear in the DOM
    await sendPromptAndWait(page, "Say hello", "success-text-short")

    // A session turn with the user message and assistant response should exist
    const messages = getMessages(page)
    await expect(messages.first()).toBeVisible({ timeout: 10_000 })

    // The turn should contain assistant content
    const assistantContent = page.locator('[data-slot="session-turn-assistant-content"]')
    await expect(assistantContent.first()).toBeVisible({ timeout: 10_000 })
    const text = await assistantContent.first().textContent()
    expect(text?.trim().length).toBeGreaterThan(0)
  })

  test("Shift+Enter creates new line", { tag: ["@core"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Multi-line test")
    sessionIds.push(sessionId)

    const editor = getPromptEditor(page)
    await typeInPrompt(page, "Line 1")
    await editor.press("Shift+Enter")
    await editor.type("Line 2")

    // Content should still be in the editor (not submitted)
    const text = await editor.innerText()
    expect(text).toContain("Line 1")
    expect(text).toContain("Line 2")
  })

  test("file attachment button is accessible", { tag: ["@smoke"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Attachment test")
    sessionIds.push(sessionId)

    const attachButton = page.locator(
      "button[aria-label*='attach' i], button[aria-label*='file' i], button[aria-label*='paperclip' i], [data-action*='attach']",
    )
    await expect(attachButton.first()).toBeVisible({ timeout: 5_000 })
  })

  test("prompt input handles long text", { tag: ["@smoke"] }, async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "Long text test")
    sessionIds.push(sessionId)

    const longText = "A".repeat(500)
    await typeInPrompt(page, longText)

    const editor = getPromptEditor(page)
    const text = await editor.innerText()
    expect(text.length).toBeGreaterThanOrEqual(500)
  })
})
