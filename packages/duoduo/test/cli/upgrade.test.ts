import { describe, expect, test } from "bun:test"
import { upgrade } from "../../src/cli/upgrade"

describe("cli.upgrade", () => {
  test("upgrade is a function", () => {
    expect(typeof upgrade).toBe("function")
  })
})
