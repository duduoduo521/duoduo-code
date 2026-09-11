import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

// ---------------------------------------------------------------------------
// SessionID — descending ID ("ses_" prefix) newtype
// MessageID — ascending ID ("msg_" prefix) newtype
// PartID — ascending ID ("prt_" prefix) newtype
// ---------------------------------------------------------------------------

describe("session/schema", () => {
  describe("SessionID", () => {
    test("make creates a branded string", () => {
      const id = SessionID.make("ses_123")
      expect(id).toBe("ses_123" as any)
    })

    test("descending creates a descending-order ID", () => {
      const id = SessionID.descending()
      expect(typeof id).toBe("string")
      expect(id).toMatch(/^ses_/)
      expect(id.length).toBeGreaterThan(0)
    })

    test("descending with valid prefixed id passes through", () => {
      const id = SessionID.descending("ses_custom123")
      expect(id).toBe("ses_custom123" as any)
    })

    test("descending rejects id without ses_ prefix", () => {
      expect(() => SessionID.descending("custom")).toThrow(/does not start with ses/)
    })

    describe("zod schema", () => {
      test("zod accepts valid ses_-prefixed string", () => {
        const result = SessionID.zod.safeParse("ses_123")
        expect(result.success).toBe(true)
      })

      test("zod rejects string without ses_ prefix", () => {
        const result = SessionID.zod.safeParse("xxx_test")
        expect(result.success).toBe(false)
      })

      test("zod rejects empty string", () => {
        const result = SessionID.zod.safeParse("")
        expect(result.success).toBe(false)
      })

      test("zod rejects non-string input (number)", () => {
        const result = SessionID.zod.safeParse(42)
        expect(result.success).toBe(false)
      })

      test("zod rejects non-string input (null)", () => {
        const result = SessionID.zod.safeParse(null)
        expect(result.success).toBe(false)
      })
    })

    describe("Effect schema", () => {
      test("Schema.decodeUnknownSync decodes any string", () => {
        const decoded = Schema.decodeUnknownSync(SessionID)("ses_decode_test")
        expect(decoded).toBe("ses_decode_test" as any)
      })

      test("Schema.decodeUnknownSync rejects non-string", () => {
        expect(() => Schema.decodeUnknownSync(SessionID)(123)).toThrow()
      })

      test("Schema.decodeUnknownSync accepts all strings (no prefix check at Effect level)", () => {
        const decoded = Schema.decodeUnknownSync(SessionID)("bad_prefix")
        expect(decoded).toBe("bad_prefix" as any)
      })
    })
  })

  describe("MessageID", () => {
    test("make creates a branded string", () => {
      const id = MessageID.make("msg_test")
      expect(id).toBe("msg_test" as any)
    })

    test("ascending creates an ascending-order ID", () => {
      const id = MessageID.ascending()
      expect(typeof id).toBe("string")
      expect(id).toMatch(/^msg_/)
      expect(id.length).toBeGreaterThan(0)
    })

    test("ascending with valid prefixed id passes through", () => {
      const id = MessageID.ascending("msg_custom123")
      expect(id).toBe("msg_custom123" as any)
    })

    test("ascending rejects id without msg_ prefix", () => {
      expect(() => MessageID.ascending("custom")).toThrow(/does not start with msg/)
    })

    describe("zod schema", () => {
      test("zod accepts valid msg_-prefixed string", () => {
        const result = MessageID.zod.safeParse("msg_456")
        expect(result.success).toBe(true)
      })

      test("zod rejects string without msg_ prefix", () => {
        const result = MessageID.zod.safeParse("xxx_test")
        expect(result.success).toBe(false)
      })

      test("zod rejects empty string", () => {
        const result = MessageID.zod.safeParse("")
        expect(result.success).toBe(false)
      })

      test("zod rejects non-string input (number)", () => {
        const result = MessageID.zod.safeParse(42)
        expect(result.success).toBe(false)
      })

      test("zod rejects non-string input (null)", () => {
        const result = MessageID.zod.safeParse(null)
        expect(result.success).toBe(false)
      })
    })

    describe("Effect schema", () => {
      test("Schema.decodeUnknownSync decodes any string", () => {
        const decoded = Schema.decodeUnknownSync(MessageID)("msg_decode_test")
        expect(decoded).toBe("msg_decode_test" as any)
      })

      test("Schema.decodeUnknownSync rejects non-string", () => {
        expect(() => Schema.decodeUnknownSync(MessageID)(123)).toThrow()
      })

      test("Schema.decodeUnknownSync accepts all strings (no prefix check at Effect level)", () => {
        const decoded = Schema.decodeUnknownSync(MessageID)("bad_prefix")
        expect(decoded).toBe("bad_prefix" as any)
      })
    })
  })

  describe("PartID", () => {
    test("make creates a branded string", () => {
      const id = PartID.make("prt_test")
      expect(id).toBe("prt_test" as any)
    })

    test("ascending creates an ascending-order ID", () => {
      const id = PartID.ascending()
      expect(typeof id).toBe("string")
      expect(id).toMatch(/^prt_/)
      expect(id.length).toBeGreaterThan(0)
    })

    test("ascending with valid prefixed id passes through", () => {
      const id = PartID.ascending("prt_custom123")
      expect(id).toBe("prt_custom123" as any)
    })

    test("ascending rejects id without prt_ prefix", () => {
      expect(() => PartID.ascending("custom")).toThrow(/does not start with prt/)
    })

    describe("zod schema", () => {
      test("zod accepts valid prt_-prefixed string", () => {
        const result = PartID.zod.safeParse("prt_789")
        expect(result.success).toBe(true)
      })

      test("zod rejects string without prt_ prefix", () => {
        const result = PartID.zod.safeParse("xxx_test")
        expect(result.success).toBe(false)
      })

      test("zod rejects empty string", () => {
        const result = PartID.zod.safeParse("")
        expect(result.success).toBe(false)
      })

      test("zod rejects non-string input (number)", () => {
        const result = PartID.zod.safeParse(42)
        expect(result.success).toBe(false)
      })

      test("zod rejects non-string input (null)", () => {
        const result = PartID.zod.safeParse(null)
        expect(result.success).toBe(false)
      })
    })

    describe("Effect schema", () => {
      test("Schema.decodeUnknownSync decodes any string", () => {
        const decoded = Schema.decodeUnknownSync(PartID)("prt_decode_test")
        expect(decoded).toBe("prt_decode_test" as any)
      })

      test("Schema.decodeUnknownSync rejects non-string", () => {
        expect(() => Schema.decodeUnknownSync(PartID)(123)).toThrow()
      })

      test("Schema.decodeUnknownSync accepts all strings (no prefix check at Effect level)", () => {
        const decoded = Schema.decodeUnknownSync(PartID)("bad_prefix")
        expect(decoded).toBe("bad_prefix" as any)
      })
    })
  })

  describe("ID ordering", () => {
    test("SessionID.descending creates unique IDs", () => {
      const id1 = SessionID.descending()
      const id2 = SessionID.descending()
      expect(id1).not.toBe(id2)
    })

    test("MessageID.ascending creates unique IDs", () => {
      const id1 = MessageID.ascending()
      const id2 = MessageID.ascending()
      expect(id1).not.toBe(id2)
    })

    test("PartID.ascending creates unique IDs", () => {
      const id1 = PartID.ascending()
      const id2 = PartID.ascending()
      expect(id1).not.toBe(id2)
    })

    test("ascending IDs increase lexicographically over time", () => {
      const a = MessageID.ascending()
      const b = MessageID.ascending()
      expect(b > a).toBe(true)
    })

    test("descending IDs decrease lexicographically over time", () => {
      const a = SessionID.descending()
      const b = SessionID.descending()
      // Descending uses ~now, so later IDs should be smaller
      expect(b < a).toBe(true)
    })

    test("ascending IDs have consistent length", () => {
      const id = MessageID.ascending()
      expect(id.length).toBeGreaterThan(20)
      expect(id.length).toBeLessThan(50)
    })

    test("descending IDs have consistent length", () => {
      const id = SessionID.descending()
      expect(id.length).toBeGreaterThan(20)
      expect(id.length).toBeLessThan(50)
    })
  })
})
