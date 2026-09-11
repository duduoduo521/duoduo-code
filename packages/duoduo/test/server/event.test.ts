import { describe, expect, test } from "bun:test"
import { Event } from "../../src/server/event"

describe("Event", () => {
  test("Event.Connected is defined with correct type", () => {
    expect(Event.Connected).toBeDefined()
    expect(Event.Connected.type).toBe("server.connected")
  })

  test("Event.Disposed is defined with correct type", () => {
    expect(Event.Disposed).toBeDefined()
    expect(Event.Disposed.type).toBe("global.disposed")
  })

  test("Event.Connected has properties schema (z.object({}))", () => {
    expect(Event.Connected.properties).toBeDefined()
    const result = Event.Connected.properties.safeParse({})
    expect(result.success).toBe(true)
  })

  test("Event.Disposed has properties schema (z.object({}))", () => {
    expect(Event.Disposed.properties).toBeDefined()
    const result = Event.Disposed.properties.safeParse({})
    expect(result.success).toBe(true)
  })

  test("Event types are distinct", () => {
    expect(Event.Connected.type).not.toBe(Event.Disposed.type)
  })
})
