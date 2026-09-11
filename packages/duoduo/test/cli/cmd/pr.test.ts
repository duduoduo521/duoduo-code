import { describe, expect, test } from "bun:test"

describe("cli.cmd.pr", () => {
  test("PrCommand module loads without error", async () => {
    const mod = await import("../../../src/cli/cmd/pr")
    expect(mod.PrCommand).toBeDefined()
    expect(mod.PrCommand.command).toBe("pr <number>")
    expect(mod.PrCommand.describe).toContain("PR")
  })
})
