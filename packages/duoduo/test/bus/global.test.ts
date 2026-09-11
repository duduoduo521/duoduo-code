import { afterEach, describe, expect, test } from "bun:test"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"

describe("GlobalBus", () => {
  // GlobalBus is a singleton EventEmitter — clean up all listeners after each test
  afterEach(() => {
    GlobalBus.removeAllListeners()
  })

  test("emits an event that listeners receive", () => {
    const received: GlobalEvent[] = []

    GlobalBus.on("event", (evt) => {
      received.push(evt)
    })

    GlobalBus.emit("event", {
      directory: "/tmp/test",
      payload: { action: "test" },
    })

    expect(received).toHaveLength(1)
    expect(received[0].directory).toBe("/tmp/test")
    expect(received[0].payload).toEqual({ action: "test" })
  })

  test("delivers payload only events", () => {
    const received: GlobalEvent[] = []

    GlobalBus.on("event", (evt) => {
      received.push(evt)
    })

    GlobalBus.emit("event", {
      payload: 42,
    })

    expect(received).toHaveLength(1)
    expect(received[0].payload).toBe(42)
    expect(received[0].directory).toBeUndefined()
    expect(received[0].project).toBeUndefined()
    expect(received[0].workspace).toBeUndefined()
  })

  test("supports multiple listeners", () => {
    const results: number[] = []

    GlobalBus.on("event", (evt) => {
      results.push((evt.payload).a)
    })
    GlobalBus.on("event", (evt) => {
      results.push((evt.payload).b)
    })

    GlobalBus.emit("event", {
      payload: { a: 1, b: 2 },
    })

    expect(results).toEqual([1, 2])
  })

  test("supports once listeners", () => {
    const results: number[] = []

    GlobalBus.once("event", () => {
      results.push(1)
    })

    GlobalBus.emit("event", { payload: "first" })
    GlobalBus.emit("event", { payload: "second" })

    expect(results).toEqual([1])
  })

  test("supports removing listeners via off", () => {
    const results: number[] = []

    const handler = () => {
      results.push(1)
    }

    GlobalBus.on("event", handler)
    GlobalBus.emit("event", { payload: "first" })
    expect(results).toEqual([1])

    GlobalBus.off("event", handler)
    GlobalBus.emit("event", { payload: "second" })
    expect(results).toEqual([1]) // no additional calls
  })

  test("emitting with directory, project, and workspace", () => {
    const received: GlobalEvent[] = []

    GlobalBus.on("event", (evt) => {
      received.push(evt)
    })

    GlobalBus.emit("event", {
      directory: "/projects/my-app",
      project: "my-app",
      workspace: "frontend",
      payload: { type: "build" },
    })

    expect(received).toHaveLength(1)
    expect(received[0].directory).toBe("/projects/my-app")
    expect(received[0].project).toBe("my-app")
    expect(received[0].workspace).toBe("frontend")
    expect(received[0].payload).toEqual({ type: "build" })
  })

  test("emitting with no listeners does not throw", () => {
    expect(() => {
      GlobalBus.emit("event", { payload: "data" })
    }).not.toThrow()
  })

  test("emitting with error listener catches unhandled errors", () => {
    const errors: Error[] = []

    GlobalBus.on("error" as any, (err: any) => {
      errors.push(err)
    })

    GlobalBus.emit("error" as any, new Error("test error"))
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe("test error")
  })
})
