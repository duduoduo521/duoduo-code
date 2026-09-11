import { describe, expect, test } from "bun:test"
import { cmd } from "../../../src/cli/cmd/cmd"

describe("cli.cmd.cmd", () => {
  test("cmd returns the input command module unchanged", () => {
    const input = {
      command: "test",
      describe: "test command",
      builder: (yargs: any) => yargs,
      handler: async () => {},
    }
    const result = cmd(input)
    expect(result).toBe(input)
    expect(result.command).toBe("test")
    expect(result.describe).toBe("test command")
  })

  test("cmd preserves handler function", () => {
    const handler = async () => {}
    const result = cmd({
      command: "test",
      handler,
    })
    expect(result.handler).toBe(handler)
  })

  test("cmd works with command modules that have -- double-dash option type", () => {
    const result = cmd({
      command: "test",
      handler: async (args) => {
        // args should allow "--" property
      },
    })
    expect(result.command).toBe("test")
  })
})
