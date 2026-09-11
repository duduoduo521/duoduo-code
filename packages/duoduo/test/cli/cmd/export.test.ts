import { describe, expect, test } from "bun:test"

// The sanitize/redact functions are not exported, but we can test the
// export command's structure and the redact logic by importing the module
// and testing what's available. Since the pure functions are file-scoped,
// we test the command structure and the overall module shape.

describe("cli.cmd.export", () => {
  test("ExportCommand module loads without error", async () => {
    const mod = await import("../../../src/cli/cmd/export")
    expect(mod.ExportCommand).toBeDefined()
    expect(mod.ExportCommand.command).toBe("export [sessionID]")
    expect(mod.ExportCommand.describe).toContain("export session")
  })

  test("ExportCommand has builder and handler", () => {
    // Re-import is cached, so this is safe
    const mod = require("../../../src/cli/cmd/export")
    expect(typeof mod.ExportCommand.builder).toBe("function")
    expect(typeof mod.ExportCommand.handler).toBe("function")
  })
})
