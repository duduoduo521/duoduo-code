import { describe, expect, test } from "bun:test"

// formatNumber is a pure function but not exported. We test the module
// structure and command definition.

describe("cli.cmd.stats", () => {
  test("StatsCommand module loads without error", async () => {
    const mod = await import("../../../src/cli/cmd/stats")
    expect(mod.StatsCommand).toBeDefined()
    expect(mod.StatsCommand.command).toBe("stats")
    expect(mod.StatsCommand.describe).toBeDefined()
  })

  test("StatsCommand has builder and handler", () => {
    const mod = require("../../../src/cli/cmd/stats")
    expect(typeof mod.StatsCommand.builder).toBe("function")
    expect(typeof mod.StatsCommand.handler).toBe("function")
  })
})
