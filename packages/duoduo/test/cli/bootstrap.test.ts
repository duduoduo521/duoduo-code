import { describe, expect, test } from "bun:test"
import { bootstrap } from "../../src/cli/bootstrap"

describe("cli.bootstrap", () => {
  test("bootstrap is a function", () => {
    expect(typeof bootstrap).toBe("function")
  })

  test("bootstrap accepts directory and callback parameters", () => {
    // We can't easily test the full bootstrap flow without mocking
    // Instance.provide, but we can verify the function signature
    expect(bootstrap.length).toBe(2) // directory, cb
  })
})
