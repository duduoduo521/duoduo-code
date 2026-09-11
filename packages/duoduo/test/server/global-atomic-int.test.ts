import { describe, expect, test } from "bun:test"

// Replicate the AtomicInt class from src/server/routes/global.ts
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

describe("server/global AtomicInt", () => {
  test("starts at 0 by default", () => {
    const counter = new AtomicInt()
    expect(counter.get()).toBe(0)
  })

  test("starts at custom initial value", () => {
    const counter = new AtomicInt(10)
    expect(counter.get()).toBe(10)
  })

  test("increment increases value and returns new value", () => {
    const counter = new AtomicInt()
    expect(counter.increment()).toBe(1)
    expect(counter.increment()).toBe(2)
    expect(counter.increment()).toBe(3)
    expect(counter.get()).toBe(3)
  })

  test("decrement decreases value and returns new value", () => {
    const counter = new AtomicInt(5)
    expect(counter.decrement()).toBe(4)
    expect(counter.decrement()).toBe(3)
    expect(counter.get()).toBe(3)
  })

  test("can go negative", () => {
    const counter = new AtomicInt(0)
    expect(counter.decrement()).toBe(-1)
    expect(counter.decrement()).toBe(-2)
  })

  test("increment and decrement work together", () => {
    const counter = new AtomicInt()
    counter.increment()
    counter.increment()
    counter.increment()
    counter.decrement()
    expect(counter.get()).toBe(2)
  })

  test("simulates SSE connection counting", () => {
    const maxConnections = 3
    const connectionCount = new AtomicInt(0)

    // Connection 1
    expect(connectionCount.increment()).toBe(1)
    expect(connectionCount.get() <= maxConnections).toBe(true)

    // Connection 2
    expect(connectionCount.increment()).toBe(2)
    expect(connectionCount.get() <= maxConnections).toBe(true)

    // Connection 3
    expect(connectionCount.increment()).toBe(3)
    expect(connectionCount.get() <= maxConnections).toBe(true)

    // Connection 4 should be rejected
    const currentCount = connectionCount.increment()
    expect(currentCount > maxConnections).toBe(true)
    connectionCount.decrement() // Reject: undo the increment

    // Disconnect
    connectionCount.decrement()
    expect(connectionCount.get()).toBe(2)
  })
})
