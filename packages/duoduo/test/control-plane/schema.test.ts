import { describe, expect, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"

describe("control-plane/schema – WorkspaceID", () => {
  // ── Schema structure ──────────────────────────────────────────
  test("WorkspaceID is a string schema with WorkspaceID brand", () => {
    expect(typeof WorkspaceID.ascending).toBe("function")
    expect(typeof WorkspaceID.zod).toBe("object")
  })

  // ── WorkspaceID.ascending() — generated IDs ─────────────────
  test("ascending() generates ID starting with wrk_", () => {
    const id = WorkspaceID.ascending()
    expect(id).toBeString()
    expect(id.startsWith("wrk_")).toBeTrue()
  })

  test("ascending() generates IDs with sufficient length", () => {
    const id = WorkspaceID.ascending()
    expect(id.length).toBeGreaterThanOrEqual(30)
  })

  test("ascending() generates unique IDs on subsequent calls", () => {
    const a = WorkspaceID.ascending()
    const b = WorkspaceID.ascending()
    expect(a).not.toBe(b)
  })

  test("ascending(id) returns the given ID when it has correct prefix", () => {
    const given = "wrk_someWorkspace123"
    const result = WorkspaceID.ascending(given)
    expect(result).toBe(given as any)
  })

  test("ascending(id) throws when given ID has wrong prefix", () => {
    expect(() => WorkspaceID.ascending("evt_bad")).toThrow(/does not start/)
  })

  test("ascending(id) throws on non-workspace prefix", () => {
    expect(() => WorkspaceID.ascending("ses_wrong")).toThrow(/does not start/)
  })

  test("ascending() with empty string generates new ID", () => {
    // Empty string is falsy, so create() generates a fresh ID
    const id = WorkspaceID.ascending("")
    expect(id).toBeString()
    expect(id.startsWith("wrk_")).toBeTrue()
    expect(id.length).toBeGreaterThanOrEqual(30)
  })

  // ── WorkspaceID.zod — Zod schema derivation ────────────────
  test("zod schema accepts valid workspace IDs", () => {
    const parsed = WorkspaceID.zod.safeParse("wrk_abc123")
    expect(parsed.success).toBeTrue()
  })

  test("zod schema rejects string without wrk_ prefix", () => {
    const parsed = WorkspaceID.zod.safeParse("evt_abc123")
    expect(parsed.success).toBeFalse()
  })

  test("zod schema rejects empty string", () => {
    const parsed = WorkspaceID.zod.safeParse("")
    expect(parsed.success).toBeFalse()
  })

  test("zod schema rejects non-string values", () => {
    const parsed = WorkspaceID.zod.safeParse(42)
    expect(parsed.success).toBeFalse()
  })

  test("zod schema rejects null", () => {
    const parsed = WorkspaceID.zod.safeParse(null)
    expect(parsed.success).toBeFalse()
  })

  test("zod schema rejects undefined", () => {
    const parsed = WorkspaceID.zod.safeParse(undefined)
    expect(parsed.success).toBeFalse()
  })
})
