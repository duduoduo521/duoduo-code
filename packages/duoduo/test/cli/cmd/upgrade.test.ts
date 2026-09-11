import { describe, expect, test } from "bun:test"

describe("cli.cmd.upgrade", () => {
  test("UpgradeCommand module loads without error", async () => {
    const mod = await import("../../../src/cli/cmd/upgrade")
    expect(mod.UpgradeCommand).toBeDefined()
    expect(mod.UpgradeCommand.command).toBe("upgrade [target]")
    expect(mod.UpgradeCommand.describe).toContain("upgrade")
  })
})
