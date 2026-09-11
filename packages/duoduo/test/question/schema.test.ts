import { describe, expect, test } from "bun:test"
import { QuestionID } from "../../src/question/schema"

describe("question/schema – QuestionID", () => {
  // ── Schema structure ──────────────────────────────────────────
  test("QuestionID is a branded schema with static methods", () => {
    expect(typeof QuestionID.ascending).toBe("function")
    expect(typeof QuestionID.zod).toBe("object")
    expect(typeof QuestionID.make).toBe("function")
  })

  // ── QuestionID.ascending() — generated IDs ─────────────────
  test("ascending() generates ID starting with que_", () => {
    const id = QuestionID.ascending()
    expect(id).toBeString()
    expect((id as unknown as string).startsWith("que_")).toBeTrue()
  })

  test("ascending() generates IDs with sufficient length", () => {
    const id = QuestionID.ascending()
    expect((id as unknown as string).length).toBeGreaterThanOrEqual(30)
  })

  test("ascending() generates unique IDs on subsequent calls", () => {
    const a = QuestionID.ascending()
    const b = QuestionID.ascending()
    expect(a).not.toBe(b)
  })

  test("ascending(id) returns the given ID when prefix matches", () => {
    const given = "que_myQuestion123"
    const result = QuestionID.ascending(given)
    expect(result).toBe(given as any)
  })

  test("ascending(id) throws when given ID has wrong prefix", () => {
    expect(() => QuestionID.ascending("evt_wrong")).toThrow(/does not start/)
  })

  test("ascending() with empty string generates new ID", () => {
    const id = QuestionID.ascending("")
    expect(id).toBeString()
    expect((id as unknown as string).startsWith("que_")).toBeTrue()
    expect((id as unknown as string).length).toBeGreaterThanOrEqual(30)
  })

  // ── QuestionID.zod — Zod schema derivation ─────────────────
  test("zod schema accepts valid question IDs", () => {
    const parsed = QuestionID.zod.safeParse("que_abc123")
    expect(parsed.success).toBeTrue()
  })

  test("zod schema rejects string without que_ prefix", () => {
    const parsed = QuestionID.zod.safeParse("wrk_abc123")
    expect(parsed.success).toBeFalse()
  })

  test("zod schema rejects empty string", () => {
    const parsed = QuestionID.zod.safeParse("")
    expect(parsed.success).toBeFalse()
  })

  test("zod schema rejects non-string values", () => {
    const parsed = QuestionID.zod.safeParse(99)
    expect(parsed.success).toBeFalse()
  })

  test("zod schema rejects null", () => {
    const parsed = QuestionID.zod.safeParse(null)
    expect(parsed.success).toBeFalse()
  })

  test("zod schema rejects undefined", () => {
    const parsed = QuestionID.zod.safeParse(undefined)
    expect(parsed.success).toBeFalse()
  })
})
