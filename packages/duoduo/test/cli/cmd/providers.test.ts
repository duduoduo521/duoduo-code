import { describe, expect, test } from "bun:test"

describe("cli.cmd.providers", () => {
  test("ProvidersCommand module loads without error", async () => {
    const mod = await import("../../../src/cli/cmd/providers")
    expect(mod.ProvidersCommand).toBeDefined()
    expect(mod.ProvidersCommand.command).toBe("providers")
  })
})
