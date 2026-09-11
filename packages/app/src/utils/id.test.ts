import { describe, expect, test } from "bun:test"
import { Identifier } from "./id"

describe("Identifier", () => {
  describe("ascending", () => {
    test("generates ID with correct prefix", () => {
      const id = Identifier.ascending("session")
      expect(id.startsWith("ses_")).toBe(true)
    })

    test("generates ID with correct length", () => {
      // prefix (3) + underscore (1) + hex time (12) + random base62 (14) = 30
      const id = Identifier.ascending("session")
      expect(id.length).toBe(30)
    })

    test("generates different IDs on successive calls", () => {
      const id1 = Identifier.ascending("session")
      const id2 = Identifier.ascending("session")
      expect(id1).not.toBe(id2)
    })

    test("returns given ID if it matches the prefix", () => {
      const given = "ses_abc123"
      const id = Identifier.ascending("session", given)
      expect(id).toBe(given)
    })

    test("throws if given ID does not match the prefix", () => {
      expect(() => Identifier.ascending("session", "msg_abc123")).toThrow("ID msg_abc123 does not start with ses")
    })

    test("all prefixes produce correct prefix in ID", () => {
      const cases: Array<["session" | "message" | "permission" | "user" | "part" | "pty", string]> = [
        ["session", "ses"],
        ["message", "msg"],
        ["permission", "per"],
        ["user", "usr"],
        ["part", "prt"],
        ["pty", "pty"],
      ]
      for (const [prefix, expected] of cases) {
        const id = Identifier.ascending(prefix)
        expect(id.startsWith(expected + "_"), `prefix ${prefix} should start with ${expected}_`).toBe(true)
      }
    })

    test("ascending IDs from same timestamp are ordered", () => {
      // Generate multiple IDs — they should be in ascending order
      // because counter increments within the same millisecond
      const ids = Array.from({ length: 10 }, () => Identifier.ascending("message"))
      for (let i = 1; i < ids.length; i++) {
        // The hex time portion should be >= previous (same or higher counter)
        const hex1 = ids[i - 1]!.slice(4, 16) // 12 hex chars after prefix_
        const hex2 = ids[i]!.slice(4, 16)
        expect(BigInt("0x" + hex2) >= BigInt("0x" + hex1)).toBe(true)
      }
    })
  })

  describe("descending", () => {
    test("generates ID with correct prefix", () => {
      const id = Identifier.descending("session")
      expect(id.startsWith("ses_")).toBe(true)
    })

    test("generates ID with correct length", () => {
      const id = Identifier.descending("session")
      expect(id.length).toBe(30)
    })

    test("descending IDs use bitwise NOT (verified by ordering)", () => {
      // We can't directly compare ascending vs descending hex values
      // because they're generated at different timestamps.
      // Instead, verify that descending IDs are ordered inversely to ascending IDs
      // (descending: higher counter → lower value due to bitwise NOT)
      const ascIds = Array.from({ length: 5 }, () => Identifier.ascending("message"))
      const descIds = Array.from({ length: 5 }, () => Identifier.descending("message"))

      // Ascending IDs should be in increasing order
      for (let i = 1; i < ascIds.length; i++) {
        const hex1 = ascIds[i - 1]!.slice(4, 16)
        const hex2 = ascIds[i]!.slice(4, 16)
        expect(BigInt("0x" + hex2) >= BigInt("0x" + hex1)).toBe(true)
      }

      // Descending IDs should be in decreasing order (bitwise NOT inverts ordering)
      for (let i = 1; i < descIds.length; i++) {
        const hex1 = descIds[i - 1]!.slice(4, 16)
        const hex2 = descIds[i]!.slice(4, 16)
        expect(BigInt("0x" + hex2) <= BigInt("0x" + hex1)).toBe(true)
      }
    })

    test("returns given ID if it matches the prefix", () => {
      const given = "ses_abc123"
      const id = Identifier.descending("session", given)
      expect(id).toBe(given)
    })

    test("throws if given ID does not match the prefix", () => {
      expect(() => Identifier.descending("session", "msg_abc123")).toThrow("ID msg_abc123 does not start with ses")
    })

    test("descending IDs from same timestamp are ordered (higher first)", () => {
      // With bitwise NOT, higher counter → lower value (inverted)
      const ids = Array.from({ length: 10 }, () => Identifier.descending("message"))
      for (let i = 1; i < ids.length; i++) {
        const hex1 = ids[i - 1]!.slice(4, 16)
        const hex2 = ids[i]!.slice(4, 16)
        // Descending: counter increases → ~now decreases
        expect(BigInt("0x" + hex2) <= BigInt("0x" + hex1)).toBe(true)
      }
    })
  })

  describe("schema", () => {
    test("validates ID with correct prefix", () => {
      const schema = Identifier.schema("session")
      expect(schema.safeParse("ses_abc123").success).toBe(true)
    })

    test("rejects ID with wrong prefix", () => {
      const schema = Identifier.schema("session")
      expect(schema.safeParse("msg_abc123").success).toBe(false)
    })

    test("rejects empty string", () => {
      const schema = Identifier.schema("session")
      expect(schema.safeParse("").success).toBe(false)
    })
  })

  describe("uniqueness", () => {
    test("generates unique IDs across 1000 calls", () => {
      const ids = new Set(Array.from({ length: 1000 }, () => Identifier.ascending("session")))
      expect(ids.size).toBe(1000)
    })

    test("generates unique IDs across different prefixes", () => {
      const ids = new Set([
        Identifier.ascending("session"),
        Identifier.ascending("message"),
        Identifier.ascending("permission"),
        Identifier.ascending("user"),
        Identifier.ascending("part"),
        Identifier.ascending("pty"),
      ])
      expect(ids.size).toBe(6)
    })
  })

  describe("ID format", () => {
    test("time portion is valid hex", () => {
      const id = Identifier.ascending("session")
      const hexPart = id.slice(4, 16) // 12 hex chars
      expect(/^[0-9a-f]{12}$/.test(hexPart)).toBe(true)
    })

    test("random portion uses base62 characters", () => {
      const id = Identifier.ascending("session")
      const randomPart = id.slice(16) // remaining after prefix_ + hex
      expect(/^[0-9A-Za-z]+$/.test(randomPart)).toBe(true)
    })
  })
})
