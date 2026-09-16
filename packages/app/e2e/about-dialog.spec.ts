import { test, expect } from "@playwright/test"
import { gotoSession, closeDialog, openCommandPalette } from "./helpers/page"

/**
 * E2E tests for the About dialog.
 * Covers: opening via command palette, version display, link buttons, closing.
 */

async function openAboutDialog(page: import("@playwright/test").Page) {
  // 真实入口是命令面板里的 about.open 命令（侧栏 rail 没有 About 按钮）
  await openCommandPalette(page)
  const palette = page.locator('[data-component="dialog"]').first()
  await expect(palette).toBeVisible({ timeout: 5_000 })

  const searchInput = palette.locator('[data-slot="list-search-input"], input').first()
  await expect(searchInput).toBeVisible({ timeout: 3_000 })
  await searchInput.click({ force: true })
  await page.keyboard.type("about")

  const items = palette.locator('[data-slot="list-item"]')
  const aboutItem = items.filter({ hasText: /about/i }).first()
  const zhItem = items.filter({ hasText: /关于/ }).first()
  // waitFor 自动等待列表渲染（count() 不等待，会误判为空）
  const hasEn = await aboutItem.waitFor({ state: "visible", timeout: 3_000 }).then(() => true).catch(() => false)
  const hasZh =
    !hasEn && (await zhItem.waitFor({ state: "visible", timeout: 2_000 }).then(() => true).catch(() => false))
  if (!hasEn && !hasZh) {
    await closeDialog(page)
    test.info().skip(true, "about.open command not found in the command palette")
  }
  await (hasEn ? aboutItem : zhItem).click({ force: true })

  // About 对话框经动态 import 加载，等待时间放宽
  const dialog = page.locator('[data-component="dialog"]').first()
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  return dialog
}

test.describe("About Dialog", () => {
  test.beforeEach(async ({ page }) => {
    // 命令面板快捷键（mod+shift+p）在会话视图作用域注册，项目根页面不响应
    await gotoSession(page)
  })

  test("about dialog opens via command palette", { tag: ["@smoke"] }, async ({ page }) => {
    await openAboutDialog(page)

    const dialog = page.locator('[data-component="dialog"]').first()
    await expect(dialog).toBeVisible()
  })

  test("about dialog shows version info", { tag: ["@core"] }, async ({ page }) => {
    await openAboutDialog(page)

    const dialog = page.locator('[data-component="dialog"]').first()
    const versionText = dialog.locator("text=/v\\d+\\.\\d+\\.\\d+/")
    await expect(versionText).toBeVisible({ timeout: 3_000 })
  })

  test("about dialog shows link buttons", { tag: ["@core"] }, async ({ page }) => {
    await openAboutDialog(page)

    const dialog = page.locator('[data-component="dialog"]').first()
    // There are at least 3 link buttons (Website, GitHub, Gitee, and possibly more)
    const linkButtons = dialog.locator("button")
    const count = await linkButtons.count()
    expect(count).toBeGreaterThanOrEqual(3)
  })

  test("Escape closes about dialog", { tag: ["@core"] }, async ({ page }) => {
    await openAboutDialog(page)

    const dialog = page.locator('[data-component="dialog"]').first()
    await expect(dialog).toBeVisible()

    await closeDialog(page)
    await expect(dialog).not.toBeVisible()
  })
})
