import { test, expect } from "@playwright/test"
import { gotoHome, openSettings, closeDialog } from "./helpers/page"

/**
 * E2E tests for internationalization (i18n) functionality.
 * Covers: default language, language control in settings, Chinese switch, persistence, restore.
 *
 * Key: language selector uses [data-action='settings-language'] with a Select component
 * (not a native <select>). Locale values may be "en", "zh-CN", "zh-TW", etc.
 * The settings dialog uses [data-component="dialog"] (custom Dialog component).
 */

async function openSettingsOnGeneralTab(page: import("@playwright/test").Page) {
  await openSettings(page)

  const dialog = page.locator('[data-component="dialog"]')
  await expect(dialog.first()).toBeVisible({ timeout: 5_000 })

  // Navigate to the General tab (first tab) which contains language settings
  const generalTab = dialog.locator("[role='tab']").first()
  await expect(generalTab).toBeVisible({ timeout: 3_000 })
  await generalTab.click({ force: true })

  return dialog
}

async function selectLanguage(
  page: import("@playwright/test").Page,
  dialog: import("@playwright/test").Locator,
  lang: "en" | "zh",
) {
  // Try native <select> first
  const nativeSelect = dialog.locator("[data-action='settings-language'] select")
  const isNativeVisible = await nativeSelect.isVisible({ timeout: 2_000 }).catch(() => false)

  if (isNativeVisible) {
    await nativeSelect.selectOption(lang, { force: true })
    return
  }

  // Fallback: custom Select component — click the trigger button
  const selectTrigger = dialog.locator(
    "[data-action='settings-language'] button, [data-action='settings-language'] [role='combobox']",
  )
  await expect(selectTrigger.first()).toBeVisible({ timeout: 3_000 })
  await selectTrigger.first().click({ force: true })

  // Select the option matching the target language
  // Kobalte Select uses [data-slot="list-item"] for options
  const optionLabel = lang === "zh" ? "中文" : "English"
  const option = page
    .locator(
      `[role='option'][data-value='${lang}'], [role='option'][data-value='zh-CN'], [role='option']:has-text('${optionLabel}'), [data-slot='list-item']:has-text('${optionLabel}')`,
    )
    .first()
  await expect(option).toBeVisible({ timeout: 3_000 })
  await option.click({ force: true })
}

async function getCurrentLanguage(dialog: import("@playwright/test").Locator): Promise<string | null> {
  const nativeSelect = dialog.locator("[data-action='settings-language'] select")
  const isNativeVisible = await nativeSelect.isVisible({ timeout: 2_000 }).catch(() => false)

  if (isNativeVisible) {
    const value = await nativeSelect.inputValue()
    // Normalize locale values like "zh-CN" to "zh"
    if (value.startsWith("zh")) return "zh"
    return value
  }

  // Fallback: read from Select trigger text or aria attributes
  const selectTrigger = dialog.locator(
    "[data-action='settings-language'] button, [data-action='settings-language'] [role='combobox']",
  )
  const isComboboxVisible = await selectTrigger
    .first()
    .isVisible({ timeout: 2_000 })
    .catch(() => false)

  if (isComboboxVisible) {
    const text = (await selectTrigger.first().textContent()) ?? ""
    if (text.includes("中文") || text.includes("zh")) return "zh"
    if (text.includes("English") || text.includes("en")) return "en"
  }

  return null
}

test.describe("Internationalization", () => {
  test.beforeEach(async ({ page }) => {
    await gotoHome(page)
  })

  test("default language renders correctly", { tag: ["@smoke"] }, async ({ page }) => {
    // The app should render with text content in some language
    const bodyText = await page.locator("body").textContent()
    expect(bodyText!.trim().length).toBeGreaterThan(0)

    // Verify that some UI text is visible — could be English or Chinese depending on default
    const hasUIText = /Settings|General|Shortcuts|Search|设置|通用|快捷键|搜索|项目|Project/i.test(bodyText!)
    expect(hasUIText).toBe(true)
  })

  test("settings language control exists", { tag: ["@smoke"] }, async ({ page }) => {
    const dialog = await openSettingsOnGeneralTab(page)

    const languageControl = dialog.locator("[data-action='settings-language']")
    await expect(languageControl).toBeVisible({ timeout: 3_000 })
  })

  test("switching to Chinese works", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await openSettingsOnGeneralTab(page)

    const languageControl = dialog.locator("[data-action='settings-language']")
    await expect(languageControl).toBeVisible({ timeout: 3_000 })

    const langBefore = await getCurrentLanguage(dialog)

    // Switch to Chinese
    await selectLanguage(page, dialog, "zh")

    // After switching, the settings dialog should contain Chinese characters
    const dialogText = (await dialog.first().textContent()) ?? ""
    const hasChineseText = /[设置通用快捷键]/.test(dialogText)
    expect(hasChineseText).toBe(true)

    // Restore original language if it was English
    if (langBefore === "en") {
      await selectLanguage(page, dialog, "en")
    }
  })

  test("language persists after reload", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await openSettingsOnGeneralTab(page)

    const languageControl = dialog.locator("[data-action='settings-language']")
    await expect(languageControl).toBeVisible({ timeout: 3_000 })

    const langBefore = await getCurrentLanguage(dialog)

    // Switch to Chinese
    await selectLanguage(page, dialog, "zh")

    // Close settings dialog
    await closeDialog(page)

    // Reload the page
    await page.reload()
    await page.waitForLoadState("domcontentloaded")
    // Wait for the app shell to render after reload
    await expect(page.locator('[data-component="sidebar-rail"]').first()).toBeVisible({ timeout: 10_000 })

    // Re-open settings and verify language is still Chinese
    const dialogAfterReload = await openSettingsOnGeneralTab(page)
    const langAfterReload = await getCurrentLanguage(dialogAfterReload)
    expect(langAfterReload).toBe("zh")

    // Restore original language
    if (langBefore !== "zh") {
      await selectLanguage(page, dialogAfterReload, (langBefore as "en" | "zh") ?? "en")
    }
  })

  test("restore English", { tag: ["@core"] }, async ({ page }) => {
    const dialog = await openSettingsOnGeneralTab(page)

    const languageControl = dialog.locator("[data-action='settings-language']")
    await expect(languageControl).toBeVisible({ timeout: 3_000 })

    // First switch to Chinese
    await selectLanguage(page, dialog, "zh")

    // Verify Chinese text is present
    const textInChinese = (await dialog.first().textContent()) ?? ""
    const hasChineseBefore = /[设置通用快捷键]/.test(textInChinese)
    expect(hasChineseBefore).toBe(true)

    // Switch back to English
    await selectLanguage(page, dialog, "en")

    // Verify English text is restored
    const textInEnglish = (await dialog.first().textContent()) ?? ""
    const hasChineseAfter = /[设置通用快捷键]/.test(textInEnglish)
    expect(hasChineseAfter).toBe(false)

    const hasEnglishText = /Settings|General|Shortcuts/i.test(textInEnglish)
    expect(hasEnglishText).toBe(true)
  })
})
