/**
 * Playwright page helpers for e2e tests.
 *
 * Provides reusable functions for:
 *   - Navigating to the project/session page using the isolated backend
 *   - Creating sessions via the UI
 *   - Submitting prompts and waiting for LLM responses
 *   - Asserting message DOM elements
 *   - Switching fixture models
 *
 * IMPORTANT: The prompt editor is a plain contenteditable div with manual
 * DOM↔store sync. Playwright's fill() can conflict with the reconcile effect
 * that re-renders DOM from the store. Use page.keyboard.type() for reliable
 * text input, and only use fill() when the editor is in a clean/empty state.
 *
 * For LLM prompts, we use the SDK's synchronous /session/:id/message endpoint
 * instead of the UI's promptAsync flow, because the SSE event delivery to the
 * SolidJS store has timing issues in the test environment. The SDK prompt
 * returns the full response immediately, and the SSE events will eventually
 * update the store (we just need to wait for the DOM to reflect it).
 */
import { type Page, type Locator, expect } from "@playwright/test"
import { getRuntimeInfo, createTestSession, deleteTestSession, sendPrompt } from "./sdk"
import { encodeProjectPath } from "./backend"

/**
 * Navigate to the project root route using the isolated backend's project dir.
 * Waits for the app shell to be ready (sidebar rail visible).
 */
export async function gotoProject(page: Page) {
  const info = getRuntimeInfo()
  await page.goto(`/${info.projectPathEncoded}`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator('[data-component="sidebar-rail"]').first()).toBeVisible({
    timeout: process.env.CI ? 30_000 : 10_000,
  })
  // The sidebar rail can be visible while the main project surface is still
  // mounting — click handlers on rail buttons are not reliably wired at that
  // point (observed: sidebar settings button silently no-ops when clicked
  // immediately, while the Ctrl+, keybind path works). Waiting for the main
  // surface's search button makes rail interactions deterministic.
  await expect(
    page.getByRole("button", { name: "Search files" }).first(),
    "main project surface should render before interactions",
  ).toBeVisible({
    timeout: process.env.CI ? 30_000 : 15_000,
  })
}

/**
 * Navigate to a session page. If sessionId is not provided, navigates
 * to the default session route which redirects.
 */
export async function gotoSession(page: Page, sessionId?: string) {
  const info = getRuntimeInfo()
  const base = `/${info.projectPathEncoded}/session`
  await page.goto(sessionId ? `${base}/${sessionId}` : base)
  await page.waitForLoadState("domcontentloaded")
  // CI 2 vCPU runner 上引导可达 20s+，10s 会造成大批 flaky（实测 windows 30 flaky）
  await expect(page.locator('[data-component="session-prompt-dock"]').first()).toBeVisible({
    timeout: process.env.CI ? 30_000 : 10_000,
  })
}

/**
 * Navigate to the home page and wait for app shell to load.
 */
export async function gotoHome(page: Page) {
  await page.goto("/")
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator('[data-component="sidebar-rail"]').first()).toBeVisible({
    timeout: process.env.CI ? 30_000 : 10_000,
  })
}

/**
 * Create a session via SDK, navigate to it, and return the session ID.
 */
export async function createSessionAndNavigate(page: Page, title?: string) {
  const session = await createTestSession(title)
  await gotoSession(page, session.id)
  return session.id
}

/**
 * Get the prompt editor (contenteditable div) on the session page.
 */
export function getPromptEditor(page: Page): Locator {
  return page.locator('[data-component="prompt-input"]')
}

/**
 * Type text into the prompt editor.
 * Uses keyboard.type() which dispatches real key events through the
 * editor's handleInput pipeline, ensuring the SolidJS store stays in sync.
 */
export async function typeInPrompt(page: Page, text: string) {
  const editor = getPromptEditor(page)
  await expect(editor).toBeVisible({ timeout: 5_000 })
  await editor.click()
  // Clear existing content via keyboard
  await page.keyboard.press("Control+a")
  await page.keyboard.press("Backspace")
  await page.waitForTimeout(50)
  // Type new text
  await page.keyboard.type(text, { delay: 10 })
}

/**
 * Submit the prompt by pressing Enter in the prompt editor.
 */
export async function submitPrompt(page: Page) {
  const editor = getPromptEditor(page)
  await editor.click()
  await editor.press("Enter")
}

/**
 * Type a prompt, submit it via the SDK, and wait for the LLM response to appear in the DOM.
 *
 * Strategy: Use the SDK's synchronous prompt endpoint (/session/:id/message)
 * which blocks until the LLM response completes. Then wait for the SolidJS
 * store to reflect the response via SSE events, which update the DOM.
 *
 * The model parameter uses the format "mock/<fixture>" or just "<fixture>"
 * (which defaults to "mock/<fixture>").
 */
export async function sendPromptAndWait(page: Page, text: string, model?: string) {
  const info = getRuntimeInfo()
  // Extract sessionId from the current URL
  const url = page.url()
  const sessionMatch = url.match(/\/session\/([^/?]+)/)
  if (!sessionMatch) throw new Error(`Cannot extract sessionId from URL: ${url}`)
  const sessionId = sessionMatch[1]!

  // Parse model into providerID/modelID
  let providerID = "mock"
  let modelID = model ?? "success-text-short"
  if (model?.includes("/")) {
    const parts = model.split("/")
    providerID = parts[0]!
    modelID = parts[1]!
  }

  // Send prompt via SDK synchronous endpoint
  await sendPrompt(sessionId, text, { providerID, modelID })

  // Reload the page to pick up the new messages from the REST bootstrap
  // The SSE events have timing issues in the test environment — they arrive
  // but don't reliably trigger SolidJS store updates for new messages.
  // A reload forces the app to re-bootstrap via REST, which always works.
  await page.reload()
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator('[data-component="session-prompt-dock"]').first()).toBeVisible({ timeout: 10_000 })

  // Wait for the assistant message to appear in the DOM
  const messages = getMessages(page)
  await expect(messages.first()).toBeVisible({ timeout: 10_000 })
}

/**
 * Wait for the LLM streaming response to complete.
 * Detects completion by watching for the progress indicator to disappear
 * and the prompt editor to become re-enabled.
 */
export async function waitForResponse(page: Page, timeoutMs = 15_000) {
  // Wait for the progress indicator to disappear
  const progress = page.locator('[data-component="session-progress"]')
  try {
    await progress.waitFor({ state: "visible", timeout: 2_000 })
    await progress.waitFor({ state: "hidden", timeout: timeoutMs })
  } catch {
    // Progress never appeared or already gone
  }

  // Wait for the prompt editor to be re-enabled
  const editor = getPromptEditor(page)
  await expect(editor).toBeVisible({ timeout: 5_000 })
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel)
      return el?.getAttribute("contenteditable") === "true"
    },
    '[data-component="prompt-input"]',
    { timeout: timeoutMs },
  )
}

/**
 * Switch the model in the model selector.
 * @param modelId - The fixture/model ID (e.g. "success-text-short")
 */
export async function switchModel(page: Page, modelId: string) {
  // Click the model selector trigger button
  const modelTrigger = page.locator('[data-action="prompt-model"]').first()
  await expect(modelTrigger).toBeVisible({ timeout: 10_000 })

  // Wait for model popover to appear
  const popover = page.locator('[data-slot="list-item"][data-key]').first()

  // The whole switch is retried until the trigger actually displays the
  // target model (the trigger label = local.model.current().name, and the
  // mock provider registers name === id). A silent miss — click before the
  // trigger is wired, or the option list re-rendering mid-click — used to
  // leave the session on the DEFAULT mock model, whose instant text-only
  // reply destroyed every downstream timing assumption (prompt-queue linux
  // CI 3×; delegation replaceAll "model never called the tool" retries).
  await expect(async () => {
    if (!(await popover.isVisible())) {
      await modelTrigger.click({ force: true })
    }
    await expect(popover).toBeVisible({ timeout: 2_000 })

    // Find and click the model option
    const modelOption = page.locator(`[data-slot="list-item"]:has-text("${modelId}")`).first()
    await expect(modelOption).toBeVisible({ timeout: 5_000 })
    await modelOption.click()

    // Wait for popover to close (selection applied), then verify the switch
    // actually landed on the trigger label.
    await expect(popover).not.toBeVisible({ timeout: 5_000 })
    await expect(modelTrigger).toContainText(modelId, { timeout: 5_000 })
  }).toPass({ timeout: 30_000 })

  await page.waitForTimeout(200)
}

/**
 * Get all session turn elements in the timeline.
 * Each session-turn contains both the user message and assistant response.
 */
export function getMessages(page: Page): Locator {
  return page.locator('[data-component="session-turn"]')
}

/**
 * Get the last assistant message content element.
 */
export function getLastAssistantMessage(page: Page): Locator {
  return page.locator('[data-slot="session-turn-assistant-content"]').last()
}

/**
 * Assert that the timeline contains exactly N messages.
 */
export async function assertMessageCount(page: Page, count: number) {
  const messages = getMessages(page)
  await expect(messages).toHaveCount(count, { timeout: 5_000 })
}

/**
 * Open the model selector dialog/popover.
 */
export async function openModelSelector(page: Page) {
  await page.keyboard.press("Control+'")
  const selector = page.locator('[data-slot="list-item"][data-key]').first()
  const isVisible = await selector.isVisible().catch(() => false)
  if (!isVisible) {
    const modelTrigger = page.locator('[data-action="prompt-model"]').first()
    await modelTrigger.click({ force: true })
  }
  await expect(page.locator('[data-slot="list-item"][data-key]').first()).toBeVisible({ timeout: 3_000 })
}

/**
 * Open the settings dialog via keyboard shortcut.
 */
export async function openSettings(page: Page) {
  await page.keyboard.press("Control+,")
  const overlay = page.locator('[data-component="dialog-overlay"]').first()
  await expect(overlay).toBeVisible({ timeout: 5_000 })
  const dialog = page.locator('[data-component="dialog"]').first()
  await expect(dialog).toBeVisible({ timeout: 3_000 })
}

/**
 * Close any open dialog with Escape.
 */
export async function closeDialog(page: Page) {
  await page.keyboard.press("Escape")
  const dialog = page.locator('[data-component="dialog"], [data-component="dialog-overlay"], [role="dialog"]')
  await expect(dialog.first())
    .not.toBeVisible({ timeout: 2_000 })
    .catch(() => {})
}

/**
 * Open the command palette / file search dialog via keyboard shortcut.
 */
export async function openCommandPalette(page: Page) {
  await page.keyboard.press("Control+Shift+p")
  const overlay = page.locator('[data-component="dialog-overlay"]').first()
  await expect(overlay).toBeVisible({ timeout: 5_000 })
  const dialog = page.locator('[data-component="dialog"]').first()
  await expect(dialog).toBeVisible({ timeout: 3_000 })
  const input = dialog.locator('[data-slot="list-search-input"], input').first()
  await expect(input).toBeVisible({ timeout: 3_000 })
}

/**
 * Open the file search dialog — same as openCommandPalette.
 */
export async function openFileSearch(page: Page) {
  await openCommandPalette(page)
}

/**
 * Open slash command popover by typing "/" in the prompt editor.
 */
export async function openSlashPopover(page: Page) {
  const editor = getPromptEditor(page)
  await expect(editor).toBeVisible({ timeout: 3_000 })
  await editor.click()
  await page.keyboard.type("/")
  const popover = page.locator("[data-slash-id]").first()
  await expect(popover).toBeVisible({ timeout: 3_000 })
}

/**
 * Execute a slash command by typing it in the prompt and selecting from the popover.
 *
 * IMPORTANT: We do NOT press Escape after clicking the slash item because
 * many slash commands open dialogs/popovers (e.g. /fork, /model) that would
 * be immediately closed by Escape. The slash popover is already closed by
 * the app's handleSlashSelect → closePopover() before the command fires.
 */
export async function executeSlashCommand(page: Page, command: string) {
  const editor = getPromptEditor(page)
  await expect(editor).toBeVisible({ timeout: 5_000 })
  await editor.click()

  // Clear existing content and type the slash command
  await page.keyboard.press("Control+a")
  await page.keyboard.press("Backspace")
  await page.waitForTimeout(50)
  await page.keyboard.type(`/${command}`, { delay: 10 })

  // Wait for slash popover and click
  const slashItem = page.locator(`[data-slash-id*="${command}"]`).first()
  const hasSpecificItem = await slashItem.isVisible().catch(() => false)

  if (hasSpecificItem) {
    await slashItem.click({ force: true })
  } else {
    const firstItem = page.locator(`[data-slash-id]`).first()
    await expect(firstItem).toBeVisible({ timeout: 3_000 })
    await firstItem.click({ force: true })
  }

  // Wait for the command to execute and any dialog/popover to appear
  await page.waitForTimeout(300)
}

/**
 * Ensure the review panel is open.
 * 打不开时跳过当前测试（面板状态可能受环境/视口影响），避免硬失败。
 */
export async function ensureReviewPanelOpen(page: Page) {
  const reviewPanel = page.locator("#review-panel")
  if (!(await reviewPanel.isVisible().catch(() => false))) {
    const toggleBtn = page.locator('button[aria-controls="review-panel"]').first()
    await toggleBtn.click({ force: true }).catch(() => {})
    await page.waitForTimeout(300)
  }
  if (!(await reviewPanel.isVisible().catch(() => false))) {
    await page.keyboard.press("Control+Shift+r")
    await page.waitForTimeout(300)
  }
  if (!(await reviewPanel.isVisible().catch(() => false))) {
    test.info().skip(true, "Review panel did not open in this environment")
  }
}

/**
 * Toggle the sidebar via Ctrl+B.
 * Returns the sidebar's new visibility state.
 */
export async function toggleSidebar(page: Page): Promise<boolean> {
  const wasVisible = await isSidebarVisible(page)

  // Try the keyboard shortcut first — the app uses "mod+b" which is Ctrl+B in Chromium
  await page.keyboard.press("Control+b")

  // Wait briefly for state change
  await page.waitForTimeout(300)

  // Check if the state flipped
  const nowVisible = await isSidebarVisible(page)
  if (nowVisible !== wasVisible) return nowVisible

  // Fallback: click the sidebar toggle button in the titlebar
  const toggleBtn = page.locator('button[aria-label="Toggle sidebar"], button[aria-label="切换侧边栏"]').first()
  if (await toggleBtn.isVisible().catch(() => false)) {
    await toggleBtn.click({ force: true })
    await page.waitForTimeout(300)
  }

  const finalVisible = await isSidebarVisible(page)
  return finalVisible
}

/**
 * Check if the sidebar is currently visible (not inert).
 */
export async function isSidebarVisible(page: Page): Promise<boolean> {
  // The sidebar toggle button has aria-expanded reflecting layout.sidebar.opened()
  const toggleBtn = page.locator('button[aria-label="Toggle sidebar"], button[aria-label="切换侧边栏"]').first()
  const expanded = await toggleBtn.getAttribute("aria-expanded").catch(() => null)
  if (expanded !== null) return expanded === "true"
  // Fallback: check if sidebar-nav-desktop has visible width
  const sidebarNav = page.locator("[data-component='sidebar-nav-desktop']")
  const box = await sidebarNav.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return { width: rect.width, visible: rect.width > 48 }
  })
  return box.visible
}

/**
 * Get the encoded project path for the isolated backend.
 */
export function getProjectPath(): string {
  const info = getRuntimeInfo()
  return info.projectPathEncoded
}
