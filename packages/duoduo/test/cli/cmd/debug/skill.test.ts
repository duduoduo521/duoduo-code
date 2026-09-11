import { describe, expect, test } from "bun:test"

describe("cli.cmd.debug.skill", () => {
  test("SkillCommand module loads without error", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/skill")
    expect(mod.SkillCommand).toBeDefined()
    expect(mod.SkillCommand.command).toBe("skill")
    expect(mod.SkillCommand.describe).toContain("skill")
    expect(typeof mod.SkillCommand.builder).toBe("function")
    expect(typeof mod.SkillCommand.handler).toBe("function")
  })

  test("SkillCommand builder is a passthrough", async () => {
    const mod = await import("../../../../src/cli/cmd/debug/skill")
    const builder = mod.SkillCommand.builder
    const yargs = { someFlag: true }
    expect(builder(yargs)).toBe(yargs)
  })
})
