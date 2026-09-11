import { describe, expect, test } from "bun:test"

describe("cli.cmd.agent", () => {
  test("AgentCommand module loads without error", async () => {
    const mod = await import("../../../src/cli/cmd/agent")
    expect(mod.AgentCommand).toBeDefined()
    expect(mod.AgentCommand.command).toBe("agent")
    expect(mod.AgentCommand.describe).toContain("agent")
    expect(typeof mod.AgentCommand.builder).toBe("function")
    expect(typeof mod.AgentCommand.handler).toBe("function")
  })

  test("AgentCommand builder registers create and list subcommands", () => {
    const mod = require("../../../src/cli/cmd/agent")
    const builder = mod.AgentCommand.builder
    let commandCount = 0
    const yargs = {
      command: (cmd: any) => {
        commandCount++
        // First subcommand should be "create"
        if (commandCount === 1) {
          expect(cmd.command).toBe("create")
          expect(cmd.describe).toContain("create")
          expect(typeof cmd.builder).toBe("function")
          expect(typeof cmd.handler).toBe("function")
        }
        // Second subcommand should be "list"
        if (commandCount === 2) {
          expect(cmd.command).toBe("list")
          expect(cmd.describe).toContain("list")
          expect(typeof cmd.handler).toBe("function")
        }
        return yargs
      },
      demandCommand: () => yargs,
    }
    builder(yargs)
    expect(commandCount).toBe(2)
  })
})
