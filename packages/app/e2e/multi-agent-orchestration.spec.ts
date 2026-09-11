import { test, expect } from "@playwright/test"
import { createSessionAndNavigate } from "./helpers/page"
import { getMessages, sendPrompt } from "./helpers/sdk"

test.describe("Multi-agent orchestration", () => {
  test("code-writing prompt creates orchestration subtask parts", async ({ page }) => {
    const sessionId = await createSessionAndNavigate(page, "multi-agent orchestration")
    await sendPrompt(
      sessionId,
      "修改 README 文案，把标题改得更清楚",
      { providerID: "mock", modelID: "success-text-short" },
      { promptID: `prompt-${Date.now()}`, noReply: true },
    )

    const messages = await getMessages(sessionId)
    const serialized = JSON.stringify(messages)
    expect(serialized).toContain("multi-agent-planner")
    expect(serialized).toContain("Plan implementation")
  })
})
