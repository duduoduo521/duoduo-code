import { describe, expect, test } from "bun:test"

// Replicate the AtomicInt class from routes/global.ts for unit testing.
// This class provides thread-safe-like integer operations for SSE connection counting.

class AtomicInt {
  private value = 0
  constructor(initial = 0) {
    this.value = initial
  }
  get() {
    return this.value
  }
  increment() {
    return ++this.value
  }
  decrement() {
    return --this.value
  }
}

describe("AtomicInt", () => {
  test("initializes to 0 by default", () => {
    const counter = new AtomicInt()
    expect(counter.get()).toBe(0)
  })

  test("initializes to custom value", () => {
    const counter = new AtomicInt(5)
    expect(counter.get()).toBe(5)
  })

  test("increment returns new value", () => {
    const counter = new AtomicInt()
    expect(counter.increment()).toBe(1)
    expect(counter.increment()).toBe(2)
    expect(counter.increment()).toBe(3)
  })

  test("decrement returns new value", () => {
    const counter = new AtomicInt(3)
    expect(counter.decrement()).toBe(2)
    expect(counter.decrement()).toBe(1)
    expect(counter.decrement()).toBe(0)
  })

  test("decrement goes negative", () => {
    const counter = new AtomicInt(0)
    expect(counter.decrement()).toBe(-1)
  })

  test("get returns current value after operations", () => {
    const counter = new AtomicInt(10)
    counter.increment()
    counter.increment()
    expect(counter.get()).toBe(12)
    counter.decrement()
    expect(counter.get()).toBe(11)
  })

  test("increment and decrement are consistent", () => {
    const counter = new AtomicInt()
    counter.increment()
    counter.increment()
    counter.increment()
    counter.decrement()
    expect(counter.get()).toBe(2)
  })

  test("simulates SSE connection counting", () => {
    const counter = new AtomicInt(0)
    const MAX = 3

    // Accept 3 connections
    expect(counter.increment()).toBe(1)
    expect(counter.increment()).toBe(2)
    expect(counter.increment()).toBe(3)

    // 4th connection should be rejected
    const current = counter.increment()
    expect(current).toBe(4)
    expect(current > MAX).toBe(true)

    // Rollback the rejected connection
    counter.decrement()
    expect(counter.get()).toBe(3)

    // Disconnect one
    counter.decrement()
    expect(counter.get()).toBe(2)
  })
})
