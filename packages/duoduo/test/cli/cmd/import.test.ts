import { describe, expect, test } from "bun:test"

describe("cli.cmd.import", () => {
  test("ImportCommand module loads without error", async () => {
    const mod = await import("../../../src/cli/cmd/import")
    expect(mod.ImportCommand).toBeDefined()
    expect(mod.ImportCommand.command).toBe("import <file>")
    expect(mod.ImportCommand.describe).toContain("import session")
    expect(typeof mod.ImportCommand.builder).toBe("function")
    expect(typeof mod.ImportCommand.handler).toBe("function")
  })

  test("ImportCommand builder requires file positional", () => {
    const mod = require("../../../src/cli/cmd/import")
    const builder = mod.ImportCommand.builder
    const yargs = {
      positional: (name: string, opts: any) => {
        expect(name).toBe("file")
        expect(opts.describe).toBe("path to JSON file")
        expect(opts.type).toBe("string")
        expect(opts.demandOption).toBe(true)
        return yargs
      },
    }
    builder(yargs)
  })
})
