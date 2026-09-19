import { test, expect, type Page } from "@playwright/test"
import { createSessionAndNavigate, typeInPrompt, submitPrompt, getLastAssistantMessage, switchModel } from "./helpers/page"
import { deleteTestSession, getMessages, getRuntimeInfo } from "./helpers/sdk"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * E2E tests for the TOOL DELEGATION round-trip (Rust → TS → Rust):
 *
 *   LLM (mock) emits a tool call the Rust loop does not execute itself →
 *   Rust writes a Pending tool part and suspends on wait_for_tool_result →
 *   the TS poll loop (rustRunLoopPoll) detects the pending part, executes it
 *   via the TS tool registry (permission-checked), and POSTs the result to
 *   /agent/tool_result → the Rust loop resumes and finishes.
 *
 * Covered delegation flavors:
 *   - todowrite: Rust has no handler ("not implemented — delegate to TS");
 *     TS execution persists todos (DB + Bus "todo.updated")
 *   - edit with replaceAll=true: Rust explicitly declines replaceAll;
 *     TS executes it and REALLY modifies the file on disk
 *   - read of a path OUTSIDE the project directory: Rust PermissionAsk →
 *     TS external_directory permission ask → the permission dock renders →
 *     "Allow once" → the tool proceeds
 *
 * The mock falls back to the plain-text fixture from the second round of any
 * success-tool-* scenario, so every delegated flow terminates cleanly.
 */
test.describe("Tool delegation round-trip (Rust → TS)", () => {
  test.setTimeout(240_000)

  const sessionIds: string[] = []

  test.afterEach(async () => {
    for (const id of sessionIds) {
      await deleteTestSession(id).catch(() => {})
    }
    sessionIds.length = 0
  })

  /** Submit a prompt for the given tool fixture and wait for the run to end. */
  async function runToolPrompt(page: Page, fixture: string, title: string) {
    const sessionId = await createSessionAndNavigate(page, title)
    sessionIds.push(sessionId)
    await switchModel(page, fixture)
    await typeInPrompt(page, "Do it")
    await submitPrompt(page)
    // The delegated round-trip takes several poll cycles; the composer
    // returning to Send means the loop finished (finish=stop or error card).
    await expect(getLastAssistantMessage(page)).toBeVisible({ timeout: 120_000 })
    return sessionId
  }

  test("todowrite is delegated to TS and persists the todo list", { tag: ["@core", "@delegation"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    const sessionId = await runToolPrompt(page, "success-tool-todowrite", "delegation todowrite")

    // Todos are persisted server-side (TodoTable) and served over REST.
    const info = getRuntimeInfo()
    const url = new URL(`/session/${sessionId}/todo`, info.backendUrl)
    url.searchParams.set("directory", info.projectDir)
    const res = await fetch(url.toString(), {
      headers: { "x-duoduo-directory": encodeURIComponent(info.projectDir) },
    })
    if (res.status === 404) test.skip(true, "no todo REST endpoint in this build")
    expect(res.ok).toBeTruthy()
    const todos = (await res.json()) as Array<{ id?: string; content?: string }>
    expect(JSON.stringify(todos)).toContain("Write the feature")
    // P2-6: every persisted todo carries its stable backend-assigned id —
    // the model must receive ids back (todowrite prompt requires passing
    // them on updates) and the UI reconciles on id, not content.
    for (const todo of todos) {
      expect(todo.id).toBeTruthy()
    }

    // The tool call is visible in the timeline as a completed part.
    const messages = await getMessages(sessionId)
    expect(JSON.stringify(messages)).toContain("todowrite")
  })

  test("edit with replaceAll is delegated to TS and really modifies the file", { tag: ["@core", "@delegation"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    const info = getRuntimeInfo()
    const readmePath = join(info.projectDir, "README.md")
    const before = readFileSync(readmePath, "utf8")
    expect(before).toContain("# E2E Test Project")

    await runToolPrompt(page, "success-tool-edit-replaceall", "delegation edit-replaceall")

    // The TS edit tool wrote the replacement to disk.
    const after = readFileSync(readmePath, "utf8")
    expect(after).toContain("# E2E Test Project (edited)")
  })

  test("reading outside the project triggers the permission dock; Allow once proceeds", { tag: ["@core", "@delegation", "@permission"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    await runToolPromptSetupOnly(page, "success-tool-read-external", "delegation external-read")

    // The permission dock renders with the external path ask.
    const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
    await expect(dock).toBeVisible({ timeout: 60_000 })

    // "Allow once" (primary action; i18n en/zh).
    const allowOnce = dock.getByRole("button", { name: /allow once|允许一次/i })
    await expect(allowOnce).toBeVisible({ timeout: 10_000 })
    await allowOnce.click()

    // The dock clears after the decision and the loop resumes to completion.
    await expect(dock).toHaveCount(0, { timeout: 60_000 })
    await expect(getLastAssistantMessage(page)).toBeVisible({ timeout: 90_000 })
  })

  /** Submit the tool prompt without waiting for completion (for mid-flight assertions). */
  async function runToolPromptSetupOnly(page: Page, fixture: string, title: string) {
    const sessionId = await createSessionAndNavigate(page, title)
    sessionIds.push(sessionId)
    await switchModel(page, fixture)
    await typeInPrompt(page, "Do it")
    await submitPrompt(page)
  }
})
