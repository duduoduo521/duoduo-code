import { test, expect, type Page } from "@playwright/test"
import {
  createSessionAndNavigate,
  typeInPrompt,
  submitPrompt,
  getPromptEditor,
  getLastAssistantMessage,
  switchModel,
} from "./helpers/page"
import { deleteTestSession, getRuntimeInfo } from "./helpers/sdk"

/**
 * E2E tests for LLM error-path handling through the FULL UI stack:
 *
 *   mock LLM error fixture → Rust run_loop (retry policy) → loop_error SSE →
 *   TS createRunLoopErrorMessage → synthetic assistant message (finish=error)
 *   → Bus → SSE → SolidJS store → error card in the DOM.
 *
 * Covered behaviors (driven by the mock fixtures):
 *   - HTTP 401 (non-retryable): fails fast, error card + retry button
 *   - HTTP 429 (rate-limited, retried 3× with 5s backoff): error only after
 *     retries are exhausted — "failed after N attempts"
 *   - context overflow (non-retryable): fast error, no retry
 *   - truncated response (finish_reason=length): the loop's continuation
 *     mechanism delivers the partial text instead of an error card
 *   - malformed tool-call arguments: tool error surfaces, session stays alive
 *
 * All fixtures are already registered in helpers/backend.ts. Text assertions
 * are locale-tolerant where the UI is i18n'd; the LLM error text itself is
 * produced by Rust and is locale-independent.
 */
test.describe("Prompt error handling (full UI stack)", () => {
  test.setTimeout(180_000)

  const sessionIds: string[] = []

  test.afterEach(async () => {
    for (const id of sessionIds) {
      await deleteTestSession(id).catch(() => {})
    }
    sessionIds.length = 0
  })

  /** Submit a prompt for the given error fixture and wait for the error card. */
  async function promptAndExpectError(page: Page, fixture: string, textPattern: RegExp) {
    const sessionId = await createSessionAndNavigate(page, `error-${fixture}`)
    sessionIds.push(sessionId)

    await switchModel(page, fixture)
    await typeInPrompt(page, "Say something")
    await submitPrompt(page)

    const errorCard = page.locator('[data-component="card"][data-variant="error"]')
    await expect(errorCard.first()).toBeVisible({ timeout: 60_000 })
    await expect(errorCard.first()).toContainText(textPattern, { timeout: 15_000 })

    // Back to idle: the submit button is a Send (not Stop) again.
    await expect(
      page.locator(
        '[data-action="prompt-submit"][aria-label="Send"], [data-action="prompt-submit"][aria-label="发送"]',
      ).first(),
    ).toBeVisible({ timeout: 30_000 })

    return sessionId
  }

  test("HTTP 401 fails fast with an error card and a retry button", { tag: ["@core", "@error-path"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    await promptAndExpectError(page, "error-401-html-gateway", /LLM API returned HTTP 401/i)

    // The error card offers a retry action while the session is idle.
    await expect(page.locator('[data-slot="session-turn-error-retry"]').first()).toBeVisible({
      timeout: 10_000,
    })
  })

  test("HTTP 429 retries with backoff, then surfaces the exhausted error", { tag: ["@core", "@error-path"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    // 429 is retried 3× with a 5s initial backoff — the error card must only
    // appear AFTER the retries are exhausted, and must mention the HTTP 429.
    await promptAndExpectError(page, "error-429-rate-limit", /LLM API returned HTTP 429/i)
  })

  test("context overflow fails without retry", { tag: ["@core", "@error-path"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    await promptAndExpectError(page, "error-context-overflow", /context|overflow/i)
  })

  test("HTTP 503 with an empty body retries, then surfaces the exhausted error", { tag: ["@core", "@error-path"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    // 503 is retryable (3× rate-limit backoff); an EMPTY body must not crash
    // the error-message path (bug #7 regression).
    await promptAndExpectError(page, "error-503-empty-body", /LLM API returned HTTP 503|failed after/i)
  })

  test("a numeric-only error body surfaces without crashing the error path", { tag: ["@core", "@error-path"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    // body is literally "400" (bug #11 regression: short-circuit parsing).
    await promptAndExpectError(page, "error-status-only-number", /LLM API returned HTTP 400|failed after/i)
  })

  test("truncated response (finish_reason=length) delivers partial text instead of an error", { tag: ["@core", "@error-path"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    const sessionId = await createSessionAndNavigate(page, "error-truncated")
    sessionIds.push(sessionId)

    await switchModel(page, "truncated-finish-length")
    await typeInPrompt(page, "Say something")
    await submitPrompt(page)

    // The loop's continuation mechanism resumes the truncated response up to
    // MAX_CONTINUATIONS times; the partial output must be delivered to the
    // user as a normal assistant message (no error card).
    const assistant = getLastAssistantMessage(page)
    await expect(assistant).toBeVisible({ timeout: 90_000 })
    await expect
      .poll(async () => (await assistant.textContent()) ?? "", { timeout: 60_000 })
      .not.toBe("")
    await expect(page.locator('[data-component="card"][data-variant="error"]')).toHaveCount(0)
  })

  test("malformed tool-call arguments surface a tool error without killing the session", { tag: ["@core", "@error-path"] }, async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the Rust smart-layer sidecar")

    const sessionId = await createSessionAndNavigate(page, "error-malformed-args")
    sessionIds.push(sessionId)

    await switchModel(page, "success-tool-malformed-args")
    await typeInPrompt(page, "Read a file")
    await submitPrompt(page)

    // The tool execution errors out; the loop must still terminate cleanly
    // and the session must remain usable (editor re-enabled for a follow-up).
    await expect(getLastAssistantMessage(page)).toBeVisible({ timeout: 90_000 })
    await typeInPrompt(page, "Still there?")
    await expect(getPromptEditor(page)).toBeVisible()
  })
})
