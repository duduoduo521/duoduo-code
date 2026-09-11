import { describe, expect, test } from "bun:test"
import { todoState } from "./session-composer-state"

describe("todoState", () => {
  test("returns 'hide' when count is 0", () => {
    expect(todoState({ count: 0, done: false, live: false })).toBe("hide")
    expect(todoState({ count: 0, done: true, live: true })).toBe("hide")
  })

  test("returns 'clear' when not live (session idle)", () => {
    expect(todoState({ count: 3, done: false, live: false })).toBe("clear")
    expect(todoState({ count: 1, done: true, live: false })).toBe("clear")
  })

  test("returns 'open' when live and not done", () => {
    expect(todoState({ count: 3, done: false, live: true })).toBe("open")
    expect(todoState({ count: 1, done: false, live: true })).toBe("open")
  })

  test("returns 'close' when live and done", () => {
    expect(todoState({ count: 3, done: true, live: true })).toBe("close")
    expect(todoState({ count: 1, done: true, live: true })).toBe("close")
  })

  test("prioritizes 'hide' over other states", () => {
    // count=0 should always be 'hide' regardless of other flags
    expect(todoState({ count: 0, done: true, live: true })).toBe("hide")
    expect(todoState({ count: 0, done: false, live: true })).toBe("hide")
  })

  test("prioritizes 'clear' over 'open'/'close'", () => {
    // not live should always be 'clear' when count > 0
    expect(todoState({ count: 5, done: false, live: false })).toBe("clear")
    expect(todoState({ count: 5, done: true, live: false })).toBe("clear")
  })
})
