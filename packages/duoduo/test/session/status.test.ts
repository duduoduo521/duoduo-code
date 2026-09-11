import { describe, expect, test } from "bun:test"
import { Info, Event } from "../../src/session/status"
import { SessionID } from "../../src/session/schema"

describe("SessionStatus.Info schema", () => {
  test("validates idle status", () => {
    const result = Info.safeParse({ type: "idle" })
    expect(result.success).toBe(true)
  })

  test("validates busy status", () => {
    const result = Info.safeParse({ type: "busy" })
    expect(result.success).toBe(true)
  })

  test("validates retry status with all fields", () => {
    const result = Info.safeParse({
      type: "retry",
      attempt: 2,
      message: "Rate limited",
      next: 5000,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      const data = result.data as any
      expect(data.type).toBe("retry")
      expect(data.attempt).toBe(2)
      expect(data.message).toBe("Rate limited")
      expect(data.next).toBe(5000)
    }
  })

  test("rejects invalid status type", () => {
    const result = Info.safeParse({ type: "unknown" })
    expect(result.success).toBe(false)
  })

  test("rejects retry without required fields", () => {
    const result = Info.safeParse({ type: "retry" })
    expect(result.success).toBe(false)
  })
})

describe("SessionStatus.Event", () => {
  test("Status event has correct type", () => {
    expect(Event.Status.type).toBe("session.status")
  })

  test("Idle event has correct type", () => {
    expect(Event.Idle.type).toBe("session.idle")
  })

  test("Status event schema validates correct data", () => {
    const result = Event.Status.properties.safeParse({
      sessionID: "sess_123",
      status: { type: "idle" },
    })
    expect(result.success).toBe(true)
  })

  test("Idle event schema validates correct data", () => {
    const result = Event.Idle.properties.safeParse({
      sessionID: "sess_123",
    })
    expect(result.success).toBe(true)
  })
})
