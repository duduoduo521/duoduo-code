import { describe, expect, test } from "bun:test"
import * as Heap from "../../src/cli/heap"

describe("cli.heap", () => {
  test("Heap module exports start function", () => {
    expect(typeof Heap.start).toBe("function")
  })

  test("Heap.start does not throw when called without flag", () => {
    // Flag.DUODUO_AUTO_HEAP_SNAPSHOT is likely false, so start should be a no-op
    expect(() => Heap.start()).not.toThrow()
  })

  test("Heap.start is idempotent — calling twice does not throw", () => {
    Heap.start()
    expect(() => Heap.start()).not.toThrow()
  })
})
