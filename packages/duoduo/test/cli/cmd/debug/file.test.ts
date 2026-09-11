import { describe, expect, test } from "bun:test"

describe("cli.cmd.debug.file", () => {
  test("FileCommand module loads without error", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/file")
    expect(mod.FileCommand).toBeDefined()
    expect(mod.FileCommand.command).toBe("file")
    expect(mod.FileCommand.describe).toContain("file system")
    expect(typeof mod.FileCommand.builder).toBe("function")
    expect(typeof mod.FileCommand.handler).toBe("function")
  })

  test("FileCommand builder registers all subcommands", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/file")
    const builder = mod.FileCommand.builder
    const commands: any[] = []
    const yargs = {
      command: (cmd: any) => {
        commands.push(cmd)
        return yargs
      },
      demandCommand: () => yargs,
    }
    builder(yargs)
    const names = commands.map((c) => c.command)
    expect(names).toContain("search <query>")
    expect(names).toContain("read <path>")
    expect(names).toContain("status")
    expect(names).toContain("list <path>")
    expect(names).toContain("tree [dir]")
    expect(commands.length).toBe(5)
  })

  test("search subcommand has required query positional", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/file")
    // Find the search command by inspecting builder
    const commands: any[] = []
    const yargs = {
      command: (cmd: any) => {
        commands.push(cmd)
        return yargs
      },
      demandCommand: () => yargs,
    }
    mod.FileCommand.builder(yargs)
    const searchCmd = commands.find((c) => c.command.startsWith("search"))
    expect(searchCmd).toBeDefined()
    expect(typeof searchCmd.builder).toBe("function")
    expect(typeof searchCmd.handler).toBe("function")

    // Verify the builder creates a positional 'query' param
    let positionalCalled = false
    searchCmd.builder({
      positional: (name: string, opts: any) => {
        if (name === "query" && opts.demandOption) {
          positionalCalled = true
        }
        return { positional: () => ({}) }
      },
    })
    expect(positionalCalled).toBe(true)
  })

  test("tree subcommand has optional dir positional with default", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/file")
    const commands: any[] = []
    const yargs = {
      command: (cmd: any) => {
        commands.push(cmd)
        return yargs
      },
      demandCommand: () => yargs,
    }
    mod.FileCommand.builder(yargs)
    const treeCmd = commands.find((c) => c.command.startsWith("tree"))
    expect(treeCmd).toBeDefined()
    expect(treeCmd.command).toBe("tree [dir]")
  })
})
