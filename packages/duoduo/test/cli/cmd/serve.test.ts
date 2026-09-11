import { describe, expect, test } from "bun:test"

describe("cli.cmd.serve", () => {
  test("ServeCommand module loads without error", async () => {
    const mod = await import("../../../src/cli/cmd/serve")
    expect(mod.ServeCommand).toBeDefined()
    expect(mod.ServeCommand.command).toBe("serve")
    expect(mod.ServeCommand.describe).toContain("headless")
  })
})
