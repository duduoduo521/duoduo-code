import { describe, expect, test } from "bun:test"

describe("cli.cmd.debug.snapshot", () => {
  test("SnapshotCommand module loads without error", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/snapshot")
    expect(mod.SnapshotCommand).toBeDefined()
    expect(mod.SnapshotCommand.command).toBe("snapshot")
    expect(mod.SnapshotCommand.describe).toContain("snapshot")
    expect(typeof mod.SnapshotCommand.builder).toBe("function")
    expect(typeof mod.SnapshotCommand.handler).toBe("function")
  })

  test("SnapshotCommand builder registers track, patch, diff subcommands", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/snapshot")
    const commands: any[] = []
    const yargs = {
      command: (cmd: any) => {
        commands.push(cmd)
        return yargs
      },
      demandCommand: () => yargs,
    }
    mod.SnapshotCommand.builder(yargs)
    const names = commands.map((c) => c.command)
    expect(names).toContain("track")
    expect(names).toContain("patch <hash>")
    expect(names).toContain("diff <hash>")
    expect(commands.length).toBe(3)
  })

  test("patch subcommand requires hash positional", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/snapshot")
    const commands: any[] = []
    const yargs = {
      command: (cmd: any) => {
        commands.push(cmd)
        return yargs
      },
      demandCommand: () => yargs,
    }
    mod.SnapshotCommand.builder(yargs)
    const patchCmd = commands.find((c) => c.command.startsWith("patch"))
    expect(patchCmd).toBeDefined()

    let found = false
    patchCmd.builder({
      positional: (name: string, opts: any) => {
        if (name === "hash" && opts.demandOption) {
          found = true
        }
        return { positional: () => ({}) }
      },
    })
    expect(found).toBe(true)
  })

  test("diff subcommand requires hash positional", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/snapshot")
    const commands: any[] = []
    const yargs = {
      command: (cmd: any) => {
        commands.push(cmd)
        return yargs
      },
      demandCommand: () => yargs,
    }
    mod.SnapshotCommand.builder(yargs)
    const diffCmd = commands.find((c) => c.command.startsWith("diff"))
    expect(diffCmd).toBeDefined()

    let found = false
    diffCmd.builder({
      positional: (name: string, opts: any) => {
        if (name === "hash" && opts.demandOption) {
          found = true
        }
        return { positional: () => ({}) }
      },
    })
    expect(found).toBe(true)
  })

  test("track subcommand has no builder args", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/snapshot")
    const commands: any[] = []
    const yargs = {
      command: (cmd: any) => {
        commands.push(cmd)
        return yargs
      },
      demandCommand: () => yargs,
    }
    mod.SnapshotCommand.builder(yargs)
    const trackCmd = commands.find((c) => c.command === "track")
    expect(trackCmd).toBeDefined()
    // track has no builder, so it's undefined
    expect(trackCmd.builder).toBeUndefined()
    expect(typeof trackCmd.handler).toBe("function")
  })
})
