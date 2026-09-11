import { describe, expect, test } from "bun:test"

describe("cli.cmd.debug.ripgrep", () => {
  test("RipgrepCommand module loads without error", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/ripgrep")
    expect(mod.RipgrepCommand).toBeDefined()
    expect(mod.RipgrepCommand.command).toBe("rg")
    expect(mod.RipgrepCommand.describe).toContain("ripgrep")
    expect(typeof mod.RipgrepCommand.builder).toBe("function")
    expect(typeof mod.RipgrepCommand.handler).toBe("function")
  })

  test("RipgrepCommand builder registers tree, files, search subcommands", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/ripgrep")
    const commands: any[] = []
    const yargs = {
      command: (cmd: any) => {
        commands.push(cmd)
        return yargs
      },
      demandCommand: () => yargs,
    }
    mod.RipgrepCommand.builder(yargs)
    const names = commands.map((c) => c.command)
    expect(names).toContain("tree")
    expect(names).toContain("files")
    expect(names).toContain("search <pattern>")
    expect(commands.length).toBe(3)
  })

  test("tree subcommand has optional limit option", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/ripgrep")
    const commands: any[] = []
    const yargs = {
      command: (cmd: any) => {
        commands.push(cmd)
        return yargs
      },
      demandCommand: () => yargs,
    }
    mod.RipgrepCommand.builder(yargs)
    const treeCmd = commands.find((c) => c.command === "tree")
    expect(treeCmd).toBeDefined()
    expect(typeof treeCmd.builder).toBe("function")

    let foundLimit = false
    treeCmd.builder({
      option: (name: string, opts: any) => {
        if (name === "limit" && opts.type === "number") {
          foundLimit = true
        }
        return { option: () => ({}) }
      },
    })
    expect(foundLimit).toBe(true)
  })

  test("files subcommand has query, glob, limit options", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/ripgrep")
    const commands: any[] = []
    const yargs = {
      command: (cmd: any) => {
        commands.push(cmd)
        return yargs
      },
      demandCommand: () => yargs,
    }
    mod.RipgrepCommand.builder(yargs)
    const filesCmd = commands.find((c) => c.command === "files")
    expect(filesCmd).toBeDefined()

    const found: string[] = []
    const mockYargs = {
      option: (name: string, _opts: any) => {
        found.push(name)
        return mockYargs
      },
    }
    filesCmd.builder(mockYargs)
    expect(found).toContain("query")
    expect(found).toContain("glob")
    expect(found).toContain("limit")
  })

  test("search subcommand has required pattern positional and glob/limit options", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/ripgrep")
    const commands: any[] = []
    const yargs = {
      command: (cmd: any) => {
        commands.push(cmd)
        return yargs
      },
      demandCommand: () => yargs,
    }
    mod.RipgrepCommand.builder(yargs)
    const searchCmd = commands.find((c) => c.command.startsWith("search"))
    expect(searchCmd).toBeDefined()

    let foundPattern = false
    const foundOptions: string[] = []
    const mockYargs = {
      positional: (name: string, opts: any) => {
        if (name === "pattern" && opts.demandOption) {
          foundPattern = true
        }
        return mockYargs
      },
      option: (name: string, _opts: any) => {
        foundOptions.push(name)
        return mockYargs
      },
    }
    searchCmd.builder(mockYargs)
    expect(foundPattern).toBe(true)
    expect(foundOptions).toContain("glob")
    expect(foundOptions).toContain("limit")
  })
})
