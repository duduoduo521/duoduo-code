import { describe, expect, test } from "bun:test"

describe("cli.cmd.db", () => {
  test("DbCommand module loads without error", async () => {
    const mod = await import("../../../src/cli/cmd/db")
    expect(mod.DbCommand).toBeDefined()
    expect(mod.DbCommand.command).toBe("db")
    expect(mod.DbCommand.describe).toContain("database")
  })
})
