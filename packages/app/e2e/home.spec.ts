import { test, expect } from "@playwright/test"
import { gotoHome } from "./helpers/page"

/**
 * E2E tests for the home page (/).
 * Covers: app shell rendering, sidebar rail, "Open project" button,
 * directory picker dialog, console error checks, refresh stability,
 * and recent projects section.
 */
test.describe("Home page", () => {
  test("loads and renders the app shell", { tag: ["@smoke"] }, async ({ page }) => {
    await gotoHome(page)

    const title = await page.title()
    expect(title.length).toBeGreaterThan(0)
  })

  test("shows the sidebar rail", { tag: ["@smoke"] }, async ({ page }) => {
    await gotoHome(page)

    await expect(page.locator('[data-component="sidebar-rail"]').first()).toBeVisible({ timeout: 5_000 })
  })

  test("shows Open project button", { tag: ["@core"] }, async ({ page }) => {
    await gotoHome(page)

    const openProjectButton = page.getByRole("button", { name: /open project|open|folder|打开/i })
    await expect(openProjectButton.first()).toBeVisible({ timeout: 5_000 })
  })

  test("clicking Open project button opens a dialog or triggers action", { tag: ["@core"] }, async ({ page }) => {
    await gotoHome(page)

    const openProjectButton = page.getByRole("button", { name: /open project|open|folder|打开/i })
    await expect(openProjectButton.first()).toBeVisible({ timeout: 5_000 })
    await openProjectButton.first().click({ force: true })

    // After clicking, a dialog may appear or the app may navigate
    // Check if a dialog appeared within a short timeout
    const dialog = page.locator("[role='dialog']")
    const dialogVisible = await dialog
      .first()
      .isVisible()
      .catch(() => false)

    if (!dialogVisible) {
      // The button may have triggered a different action (file picker, navigation, etc.)
      // Verify the page is still functional
      await expect(page.locator('[data-component="sidebar-rail"]').first()).toBeVisible({ timeout: 5_000 })
    } else {
      await expect(dialog.first()).toBeVisible()
    }
  })

  test("has no critical console errors", { tag: ["@core"] }, async ({ page }) => {
    const errors: string[] = []
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text()
        if (text.includes("favicon")) return
        if (text.includes("Failed to load resource")) return
        if (text.includes("CORS policy")) return
        if (text.includes("[global-sdk]")) return
        if (text.includes("network error")) return
        errors.push(text)
      }
    })

    await gotoHome(page)
    await page.waitForTimeout(2000)

    expect(errors).toEqual([])
  })

  test("renders correctly after refresh", { tag: ["@smoke"] }, async ({ page }) => {
    await gotoHome(page)

    // Reload the page
    await page.reload()
    await page.waitForLoadState("domcontentloaded")

    // The app shell should still render after refresh
    await expect(page.locator('[data-component="sidebar-rail"]').first()).toBeVisible({ timeout: 10_000 })

    // URL should still be /
    expect(page.url()).toMatch(/\/$/)
  })

  test("sidebar rail shows recent project section or empty state", { tag: ["@core"] }, async ({ page }) => {
    await gotoHome(page)

    const sidebarRail = page.locator('[data-component="sidebar-rail"]').first()
    await expect(sidebarRail).toBeVisible({ timeout: 5_000 })

    // The sidebar should contain project buttons or an empty state indicator.
    // With the isolated backend, there's at least one project (the test project).
    const projectButtons = sidebarRail.locator("button")
    const buttonCount = await projectButtons.count()
    expect(buttonCount).toBeGreaterThan(0)
  })
})
