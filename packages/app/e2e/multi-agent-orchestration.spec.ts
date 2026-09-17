import { test, expect } from "@playwright/test"
import { createSessionAndNavigate } from "./helpers/page"
import { getMessages, sendPrompt, getRuntimeInfo } from "./helpers/sdk"

/**
 * E2E tests for multi-agent orchestration subtask injection.
 *
 * `autoSubtasksForPrompt` (packages/duoduo/src/session/prompt.ts) performs a
 * deterministic keyword-route: code-writing prompts get a `subtask` part with
 * agent "plan" / command "multi-agent-planner" injected into the message.
 * This is a pure TS path (no Rust sidecar needed), but it rides on the
 * session prompt flow which does require the sidecar — hence the skip guard.
 */
test.describe("Multi-agent orchestration", () => {
  test("code-writing prompt injects a plan subtask part", async ({ page }) => {
    test.skip(!getRuntimeInfo().smartLayerAvailable, "Requires the agent backend (Rust smart-layer sidecar)")

    const sessionId = await createSessionAndNavigate(page, "multi-agent orchestration")
    await sendPrompt(
      sessionId,
      "修改 README 文案，把标题改得更清楚",
      { providerID: "mock", modelID: "success-text-short" },
      { promptID: `prompt-${Date.now()}`, noReply: true },
    )

    const messages = await getMessages(sessionId)
    const parts: Array<Record<string, unknown>> = messages.flatMap((m) => {
      const rec = m as { parts?: unknown[]; info?: { parts?: unknown[] } }
      return (rec.parts ?? rec.info?.parts ?? []) as Array<Record<string, unknown>>
    })
    expect(parts.length).toBeGreaterThan(0)

    // Locate the injected plan subtask structurally, not via whole-conversation
    // string matching — the assertion must fail if the part shape changes.
    const planner = parts.find((p) => {
      if (p?.type !== "subtask") return false
      const command = p.command ?? p.stage ?? ""
      return String(command).includes("multi-agent-planner")
    })
    expect(planner, `expected a subtask part with command "multi-agent-planner", got: ${JSON.stringify(parts)}`).toBeTruthy()

    // The planner subtask carries the deterministic plan description.
    const plannerJson = JSON.stringify(planner)
    expect(plannerJson).toContain("Plan implementation")
    const agent = planner!.agent ?? planner!.stage
    if (agent !== undefined) expect(String(agent)).toBe("plan")
  })
})
