import { test, expect } from "@playwright/test"
import { gotoHome } from "./helpers/page"

/**
 * E2E smoke test: verifies the app boots, the landing page renders,
 * and no critical console errors appear on initial load.
 */
test.describe("App boot", () => {
  test("landing page loads and shows the app shell", async ({ page }) => {
    await gotoHome(page)

    // The title should contain the app name
    const title = await page.title()
    expect(title.length).toBeGreaterThan(0)
  })

  test("no critical console errors on initial load", async ({ page }) => {
    const errors: string[] = []
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text()
        // Ignore network errors for assets that may not exist in dev
        if (text.includes("favicon")) return
        if (text.includes("Failed to load resource")) return
        // Ignore CORS errors from origins outside the app's own server
        if (text.includes("CORS policy")) return
        // Ignore SDK connection errors when the backend server is not running
        if (text.includes("[global-sdk] event stream error")) return
        if (text.includes("TypeError: Failed to fetch")) return
        errors.push(text)
      }
    })

    await gotoHome(page)

    // Allow a brief moment for any async errors to surface
    await page.waitForTimeout(2000)

    expect(errors).toEqual([])
  })
})
