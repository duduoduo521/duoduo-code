import { describe, expect, test } from "bun:test"
import { foo, bar, dummyFunction, randomHelper } from "../../src/util/scrap"

describe("util.scrap", () => {
  test("foo is '42'", () => {
    expect(foo).toBe("42")
  })

  test("bar is 123", () => {
    expect(bar).toBe(123)
  })

  test("dummyFunction is callable", () => {
    expect(typeof dummyFunction).toBe("function")
    // Should not throw
    dummyFunction()
  })

  test("randomHelper returns boolean", () => {
    const result = randomHelper()
    expect(typeof result).toBe("boolean")
  })
})
