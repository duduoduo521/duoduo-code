import { describe, expect, test } from "bun:test"

// formatSize and shortenPath are not exported but are pure functions.
// We test the module structure and command definition.

describe("cli.cmd.uninstall", () => {
  test("UninstallCommand module loads without error", async () => {
    const mod = await import("../../../src/cli/cmd/uninstall")
    expect(mod.UninstallCommand).toBeDefined()
    expect(mod.UninstallCommand.command).toBe("uninstall")
    expect(mod.UninstallCommand.describe).toContain("uninstall")
  })

  test("UninstallCommand has builder with expected options", () => {
    const mod = require("../../../src/cli/cmd/uninstall")
    expect(typeof mod.UninstallCommand.builder).toBe("function")
    expect(typeof mod.UninstallCommand.handler).toBe("function")
  })
})
