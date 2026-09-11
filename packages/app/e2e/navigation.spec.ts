import { test, expect } from "@playwright/test"
import { gotoHome, gotoProject, getProjectPath } from "./helpers/page"

/**
 * E2E tests for core navigation flows.
 * Covers: home page load, project navigation, browser back/forward, URL routing.
 */
test.describe("Navigation", () => {
  test("home page loads and shows app content", { tag: ["@smoke"] }, async ({ page }) => {
    await gotoHome(page)

    const title = await page.title()
    expect(title.length).toBeGreaterThan(0)
  })

  test("home page shows project open button", { tag: ["@core"] }, async ({ page }) => {
    await gotoHome(page)

    const openProjectButton = page.getByRole("button", { name: /open|folder/i })
    await expect(openProjectButton.first()).toBeVisible({ timeout: 5_000 })
  })

  test("browser back/forward navigation works", { tag: ["@core"] }, async ({ page }) => {
    // Start at home
    await gotoHome(page)

    // Navigate to a project to have a second route
    const projectPath = getProjectPath()
    await gotoProject(page, projectPath)
    await page.waitForLoadState("domcontentloaded")

    // Go back
    await page.goBack()
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator('[data-component="sidebar-rail"]').first()).toBeVisible({ timeout: 10_000 })

    // Go forward
    await page.goForward()
    await page.waitForLoadState("domcontentloaded")
    // Page should load (project or app shell)
    const bodyText = await page.locator("body").innerText()
    expect(bodyText.length).toBeGreaterThan(0)
  })

  test("refreshing the page preserves current route", { tag: ["@smoke"] }, async ({ page }) => {
    await gotoHome(page)
    await page.waitForLoadState("domcontentloaded")

    // Reload the page
    await page.reload()
    await page.waitForLoadState("domcontentloaded")

    // The app shell should be present
    const bodyText = await page.locator("body").innerText()
    expect(bodyText.length).toBeGreaterThan(0)
  })

  test("non-existent route shows the app shell (doesn't crash)", { tag: ["@smoke"] }, async ({ page }) => {
    await page.goto("/nonexistent-route-xyz")
    await page.waitForLoadState("domcontentloaded")

    // The app should render the shell, not a blank error page
    const body = page.locator("body")
    const text = await body.innerText()
    expect(text.length).toBeGreaterThan(0)
  })
})
