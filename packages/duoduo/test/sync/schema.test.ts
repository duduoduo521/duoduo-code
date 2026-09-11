import { describe, expect, test } from "bun:test"
import { EventID } from "../../src/sync/schema"

describe("sync/schema – EventID", () => {
  // ── Schema structure ──────────────────────────────────────────
  test("EventID is a string schema with EventID brand", () => {
    // Branding creates a branded type — verify structure via static method
    expect(typeof EventID.ascending).toBe("function")
    expect(typeof EventID.zod).toBe("object")
  })

  // ── EventID.ascending() — generated IDs ─────────────────────
  test("ascending() generates ID starting with evt_", () => {
    const id = EventID.ascending()
    expect(id).toBeString()
    expect((id as unknown as string).startsWith("evt_")).toBeTrue()
  })

  test("ascending() generates IDs with sufficient length", () => {
    const id = EventID.ascending()
    // Prefix "evt_" = 4, plus 26 chars from Identifier.create = 30
    expect((id as unknown as string).length).toBeGreaterThanOrEqual(30)
  })

  test("ascending() generates unique IDs on subsequent calls", () => {
    const a = EventID.ascending()
    const b = EventID.ascending()
    expect(a).not.toBe(b)
  })

  test("ascending(id) returns the given ID when it has correct prefix", () => {
    const given = "evt_testABC123"
    const result = EventID.ascending(given)
    expect(result).toBe(given as any)
  })

  test("ascending(id) throws when given ID has wrong prefix", () => {
    expect(() => EventID.ascending("wrk_something")).toThrow(/does not start/)
  })

  test("ascending(id) throws on non-event prefix", () => {
    expect(() => EventID.ascending("ses_bad")).toThrow(/does not start/)
  })

  // ── EventID.zod — Zod schema derivation ──────────────────────
  test("zod schema accepts valid event IDs", () => {
    const parsed = EventID.zod.safeParse("evt_abc123")
    expect(parsed.success).toBeTrue()
  })

  test("zod schema rejects string without evt_ prefix", () => {
    const parsed = EventID.zod.safeParse("wrk_abc123")
    expect(parsed.success).toBeFalse()
  })

  test("zod schema rejects empty string", () => {
    const parsed = EventID.zod.safeParse("")
    expect(parsed.success).toBeFalse()
  })

  test("zod schema rejects non-string values", () => {
    const parsed = EventID.zod.safeParse(123)
    expect(parsed.success).toBeFalse()
  })

  test("zod schema rejects null", () => {
    const parsed = EventID.zod.safeParse(null)
    expect(parsed.success).toBeFalse()
  })

  test("zod schema rejects undefined", () => {
    const parsed = EventID.zod.safeParse(undefined)
    expect(parsed.success).toBeFalse()
  })
})
