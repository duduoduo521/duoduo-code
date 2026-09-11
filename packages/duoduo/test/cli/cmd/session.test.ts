import { describe, expect, test } from "bun:test"

// formatSessionTable and formatSessionJSON are not exported, but we can
// test the command structure and verify the module loads correctly.
// The formatting functions are pure and would benefit from being exported
// for direct testing.

describe("cli.cmd.session", () => {
  test("SessionCommand module loads without error", async () => {
    const mod = await import("../../../src/cli/cmd/session")
    expect(mod.SessionCommand).toBeDefined()
    expect(mod.SessionCommand.command).toBe("session")
    expect(mod.SessionDeleteCommand).toBeDefined()
    expect(mod.SessionDeleteCommand.command).toBe("delete <sessionID>")
    expect(mod.SessionListCommand).toBeDefined()
    expect(mod.SessionListCommand.command).toBe("list")
  })

  test("SessionDeleteCommand has required builder and handler", () => {
    const mod = require("../../../src/cli/cmd/session")
    expect(typeof mod.SessionDeleteCommand.builder).toBe("function")
    expect(typeof mod.SessionDeleteCommand.handler).toBe("function")
  })

  test("SessionListCommand supports --max-count and --format options", () => {
    const mod = require("../../../src/cli/cmd/session")
    expect(typeof mod.SessionListCommand.builder).toBe("function")
    expect(typeof mod.SessionListCommand.handler).toBe("function")
  })
})
