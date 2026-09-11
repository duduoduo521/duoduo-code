import { describe, expect, test } from "bun:test"

describe("cli.cmd.debug.lsp", () => {
  test("LSPCommand module loads without error", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/lsp")
    expect(mod.LSPCommand).toBeDefined()
    expect(mod.LSPCommand.command).toBe("lsp")
    expect(mod.LSPCommand.describe).toContain("LSP")
    expect(typeof mod.LSPCommand.builder).toBe("function")
    expect(typeof mod.LSPCommand.handler).toBe("function")
  })

  test("exports SymbolsCommand and DocumentSymbolsCommand", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/lsp")
    expect(mod.SymbolsCommand).toBeDefined()
    expect(mod.SymbolsCommand.command).toBe("symbols <query>")
    expect(mod.SymbolsCommand.describe).toContain("symbols")
    expect(typeof mod.SymbolsCommand.builder).toBe("function")
    expect(typeof mod.SymbolsCommand.handler).toBe("function")

    expect(mod.DocumentSymbolsCommand).toBeDefined()
    expect(mod.DocumentSymbolsCommand.command).toBe("document-symbols <uri>")
    expect(mod.DocumentSymbolsCommand.describe).toContain("symbols")
    expect(typeof mod.DocumentSymbolsCommand.builder).toBe("function")
    expect(typeof mod.DocumentSymbolsCommand.handler).toBe("function")
  })

  test("LSPCommand builder registers diagnostics, symbols, document-symbols subcommands", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/lsp")
    const commands: any[] = []
    const yargs = {
      command: (cmd: any) => {
        commands.push(cmd)
        return yargs
      },
      demandCommand: () => yargs,
    }
    mod.LSPCommand.builder(yargs)
    const names = commands.map((c) => c.command)
    expect(names).toContain("diagnostics <file>")
    expect(names).toContain("symbols <query>")
    expect(names).toContain("document-symbols <uri>")
    expect(commands.length).toBe(3)
  })

  test("diagnostics subcommand requires file positional", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/lsp")
    const commands: any[] = []
    const yargs = {
      command: (cmd: any) => {
        commands.push(cmd)
        return yargs
      },
      demandCommand: () => yargs,
    }
    mod.LSPCommand.builder(yargs)
    const diagCmd = commands.find((c) => c.command.startsWith("diagnostics"))
    expect(diagCmd).toBeDefined()

    let found = false
    diagCmd.builder({
      positional: (name: string, opts: any) => {
        if (name === "file" && opts.demandOption) {
          found = true
        }
        return { positional: () => ({}) }
      },
    })
    expect(found).toBe(true)
  })
})
