import { describe, expect, test } from "bun:test"

describe("cli.cmd.debug.agent", () => {
  test("AgentCommand module loads without error", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/agent")
    expect(mod.AgentCommand).toBeDefined()
    expect(mod.AgentCommand.command).toBe("agent <name>")
    expect(mod.AgentCommand.describe).toContain("agent")
  })

  test("AgentCommand has builder and handler", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/agent")
    expect(typeof mod.AgentCommand.builder).toBe("function")
    expect(typeof mod.AgentCommand.handler).toBe("function")
  })
})
