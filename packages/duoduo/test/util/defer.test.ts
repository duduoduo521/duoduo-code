import { describe, expect, test } from "bun:test"
import { defer } from "../../src/util/defer"

describe("util.defer", () => {
  test("returns object with Symbol.dispose and Symbol.asyncDispose", () => {
    let called = false
    const d = defer(() => { called = true })
    expect(typeof d[Symbol.dispose]).toBe("function")
    expect(typeof d[Symbol.asyncDispose]).toBe("function")
  })

  test("Symbol.dispose calls the function", () => {
    let called = false
    const d = defer(() => { called = true })
    d[Symbol.dispose]()
    expect(called).toBe(true)
  })

  test("Symbol.asyncDispose calls the function and returns a promise", async () => {
    let called = false
    const d = defer(() => { called = true })
    const result = await d[Symbol.asyncDispose]()
    expect(called).toBe(true)
  })

  test("works with async functions via Symbol.asyncDispose", async () => {
    let called = false
    const d = defer(async () => { called = true })
    await d[Symbol.asyncDispose]()
    expect(called).toBe(true)
  })

  test("works with using syntax (sync)", () => {
    const log: string[] = []
    function example() {
      using d = defer(() => { log.push("cleaned") })
      log.push("body")
    }
    example()
    expect(log).toEqual(["body", "cleaned"])
  })
})
