import { describe, expect, test } from "bun:test"

describe("cli.cmd.acp", () => {
  test("AcpCommand module loads without error", async () => {
    const mod = await import("../../../src/cli/cmd/acp")
    expect(mod.AcpCommand).toBeDefined()
    expect(mod.AcpCommand.command).toBe("acp")
    expect(mod.AcpCommand.describe).toContain("ACP")
  })
})
