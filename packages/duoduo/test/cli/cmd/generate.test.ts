import { describe, expect, test } from "bun:test"

describe("cli.cmd.generate", () => {
  test("GenerateCommand module loads without error", async () => {
    const mod = await import("../../../src/cli/cmd/generate")
    expect(mod.GenerateCommand).toBeDefined()
    expect(mod.GenerateCommand.command).toBe("generate")
  })
})
