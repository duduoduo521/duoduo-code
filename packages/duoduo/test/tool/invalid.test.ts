import { describe, expect, test } from "bun:test"
import { InvalidTool } from "../../src/tool/invalid"
import { Effect } from "effect"

describe("InvalidTool", () => {
  test("has id 'invalid'", () => {
    expect(InvalidTool.id).toBe("invalid")
  })

  test("is an Effect", () => {
    expect(Effect.isEffect(InvalidTool)).toBe(true)
  })
})
