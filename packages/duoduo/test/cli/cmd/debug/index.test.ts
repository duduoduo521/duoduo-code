import { describe, expect, test } from "bun:test"

describe("cli.cmd.debug.index", () => {
  test("DebugCommand module loads without error", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/index")
    expect(mod.DebugCommand).toBeDefined()
    expect(mod.DebugCommand.command).toBe("debug")
    expect(mod.DebugCommand.describe).toContain("debug")
  })
})
