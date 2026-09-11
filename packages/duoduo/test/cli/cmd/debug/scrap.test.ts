import { describe, expect, test } from "bun:test"

describe("cli.cmd.debug.scrap", () => {
  test("ScrapCommand module loads without error", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/scrap")
    expect(mod.ScrapCommand).toBeDefined()
    expect(mod.ScrapCommand.command).toBe("scrap")
    expect(mod.ScrapCommand.describe).toContain("projects")
    expect(typeof mod.ScrapCommand.builder).toBe("function")
    expect(typeof mod.ScrapCommand.handler).toBe("function")
  })

  test("ScrapCommand builder is a passthrough", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/scrap")
    const builder = mod.ScrapCommand.builder
    const yargs = { someFlag: true }
    expect(builder(yargs)).toBe(yargs)
  })
})
