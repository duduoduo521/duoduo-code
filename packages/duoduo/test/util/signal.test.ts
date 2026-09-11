import { describe, expect, test } from "bun:test"
import { signal } from "../../src/util/signal"

describe("util.signal", () => {
  test("wait blocks until trigger is called", async () => {
    const s = signal()
    let resolved = false
    const p = s.wait().then(() => {
      resolved = true
    })
    expect(resolved).toBe(false)
    s.trigger()
    await p
    expect(resolved).toBe(true)
  })

  test("trigger before wait makes wait resolve immediately", async () => {
    const s = signal()
    s.trigger()
    // If `wait()` did not already settle this await never returns and the test
    // fails on the runner's timeout, which is exactly the assertion we want.
    const value = await s.wait()
    expect(value).toBeUndefined()
  })

  test("multiple wait calls all resolve on trigger", async () => {
    const s = signal()
    const results: string[] = []
    const p1 = s.wait().then(() => results.push("one"))
    const p2 = s.wait().then(() => results.push("two"))
    s.trigger()
    await Promise.all([p1, p2])
    expect(results.sort()).toEqual(["one", "two"])
  })

  test("wait resolves only once per trigger cycle for the same promise", async () => {
    const s = signal()
    let calls = 0
    const p = s.wait().then(() => {
      calls++
    })
    s.trigger()
    s.trigger()
    await p
    expect(calls).toBe(1)
  })
})
