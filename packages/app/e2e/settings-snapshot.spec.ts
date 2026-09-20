import { test, expect } from "@playwright/test"
import { gotoProject, openSettings } from "./helpers/page"

/**
 * E2E scenario f: snapshot settings round-trip.
 *
 * Settings → Snapshot tab → change the retention days → Save → success toast
 * → the component re-reads the effective config (PATCH /config disposes and
 * reloads the instance) and the input reflects the saved value.
 */
test.describe("Snapshot settings round-trip", () => {
  test("saving retention shows a success toast and re-reads the effective value", async ({
    page,
  }) => {
    await gotoProject(page)
    await openSettings(page)

    const dialog = page.locator("[role='dialog']").first()
    const snapshotTab = dialog.locator("[role='tab'][data-value='snapshot']").first()
    await expect(snapshotTab).toBeVisible({ timeout: 5_000 })
    await snapshotTab.click({ force: true })

    // The retention input prefills from the snapshot stats once loaded.
    const retentionInput = dialog.locator("[type='number']").first()
    await expect(retentionInput).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(async () => retentionInput.inputValue(), { timeout: 15_000 })
      .not.toBe("")

    // Change the retention and save.
    await retentionInput.fill("30")
    const saveButton = dialog.getByRole("button", { name: /^save$/i }).first()
    await expect(saveButton).toBeVisible({ timeout: 5_000 })
    await saveButton.click()

    // Success toast (i18n en: "Snapshot retention saved").
    const toast = page.locator('[data-component="toast"]').filter({
      hasText: /snapshot retention saved|快照保留期已保存/i,
    })
    await expect(toast.first()).toBeVisible({ timeout: 15_000 })

    // The component re-fetches the stats after the instance reload — the
    // effective retention echoes back as 30.
    await expect
      .poll(async () => retentionInput.inputValue(), { timeout: 30_000 })
      .toBe("30")
  })
})
