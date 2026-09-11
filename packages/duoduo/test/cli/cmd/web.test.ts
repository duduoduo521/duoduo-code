import { describe, expect, test } from "bun:test"

describe("cli.cmd.web", () => {
  test("WebCommand module loads without error", async () => {
    const mod = await import("../../../src/cli/cmd/web")
    expect(mod.WebCommand).toBeDefined()
    expect(mod.WebCommand.command).toBe("web")
    expect(mod.WebCommand.describe).toContain("web")
  })
})
