import { describe, expect, test } from "bun:test"

describe("cli.cmd.models", () => {
  test("ModelsCommand module loads without error", async () => {
    const mod = await import("../../../src/cli/cmd/models")
    expect(mod.ModelsCommand).toBeDefined()
    expect(mod.ModelsCommand.command).toBe("models [provider]")
    expect(mod.ModelsCommand.describe).toContain("model")
  })
})
