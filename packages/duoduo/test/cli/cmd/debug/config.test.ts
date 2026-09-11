import { describe, expect, test } from "bun:test"

describe("cli.cmd.debug.config", () => {
  test("ConfigCommand module loads without error", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/config")
    expect(mod.ConfigCommand).toBeDefined()
    expect(mod.ConfigCommand.command).toBe("config")
    expect(mod.ConfigCommand.describe).toContain("configuration")
    expect(typeof mod.ConfigCommand.builder).toBe("function")
    expect(typeof mod.ConfigCommand.handler).toBe("function")
  })

  test("ConfigCommand builder is a passthrough", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/config")
    const builder = mod.ConfigCommand.builder
    const yargs = { someFlag: true }
    expect(builder(yargs)).toBe(yargs)
  })
})
