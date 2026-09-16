import { test, expect } from "@playwright/test"
import { createSharedSession, navigateToSharedSession, cleanupSharedSession } from "./helpers/session-fixture"

/**
 * E2E tests for the status popover.
 * Covers: indicator visibility, popover open/close, content display, and click-outside dismiss.
 *
 * Key: status indicator is a button with aria-label*='status' i.
 * Clicking opens a Kobalte Popover with [data-component="popover-content"].
 */
test.describe("Status Popover", () => {
  let sessionId: string

  /** 点击 status 按钮并确保 popover 打开（Kobalte portal 渲染，偶发首击不响应则重试） */
  async function openPopover(page: import("@playwright/test").Page) {
    const statusButton = page.locator("button[aria-label*='status' i]")
    await expect(statusButton.first()).toBeVisible({ timeout: 5_000 })
    const popover = page.locator('[data-component="popover-content"]')
    for (let i = 0; i < 3 && !(await popover.isVisible().catch(() => false)); i++) {
      await statusButton.first().click({ force: true }).catch(() => {})
      await page.waitForTimeout(400)
    }
    await expect(popover.first()).toBeVisible({ timeout: 5_000 })
    return popover
  }

  test.beforeAll(async () => {
    sessionId = await createSharedSession("Status Popover")
  })
  test.beforeEach(async ({ page }) => {
    await navigateToSharedSession(page, sessionId)
  })
  test.afterAll(async () => {
    await cleanupSharedSession(sessionId)
  })

  test("status indicator exists", { tag: ["@smoke"] }, async ({ page }) => {
    // The status popover trigger is a button with aria-label containing "status"
    const statusButton = page.locator("button[aria-label*='status' i]")
    await expect(statusButton.first()).toBeVisible({ timeout: 5_000 })
  })

  test("clicking opens status popover", { tag: ["@core"] }, async ({ page }) => {
    await openPopover(page)
  })

  test("popover shows content", { tag: ["@core"] }, async ({ page }) => {
    const popover = await openPopover(page)

    // Wait for popover content to render — it may load asynchronously
    await page.waitForTimeout(500)

    // The popover body or any tab content should have some text
    const tabs = popover.locator('[data-slot="tab"]')
    const hasTabs = await tabs
      .first()
      .isVisible()
      .catch(() => false)
    if (hasTabs) {
      const tabCount = await tabs.count()
      expect(tabCount).toBeGreaterThanOrEqual(1)
    } else {
      // Fallback: check the popover itself for any text
      // Retry a few times as content may load asynchronously
      let popoverText = ""
      for (let i = 0; i < 3; i++) {
        popoverText = await popover.first().innerText()
        if (popoverText.length > 0) break
        await page.waitForTimeout(500)
      }
      expect(popoverText.length).toBeGreaterThan(0)
    }
  })

  test("clicking outside closes popover", { tag: ["@core"] }, async ({ page }) => {
    const popover = await openPopover(page)

    // Click outside to dismiss — click on the main content area
    const mainArea = page.locator("main, [data-slot='session-turn-list']")
    if ((await mainArea.count()) > 0) {
      await mainArea.first().click()
    } else {
      await page.keyboard.press("Escape")
    }

    await expect(popover.first()).toBeHidden({ timeout: 3_000 })
  })
})
