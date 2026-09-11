import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { PtyID } from "../../src/pty/schema"

// ---------------------------------------------------------------------------
// PtyID — newtype schema with ascending ID generation
// ---------------------------------------------------------------------------

describe("PtyID", () => {
  describe("ascending generation", () => {
    test("ascending generates an ID starting with pty_", () => {
      const id = PtyID.ascending()
      expect(id.startsWith("pty_")).toBe(true)
    })

    test("ascending generates unique IDs on successive calls", () => {
      const a = PtyID.ascending()
      const b = PtyID.ascending()
      expect(a).not.toBe(b)
    })

    test("ascending IDs have consistent length (> 20 chars)", () => {
      const id = PtyID.ascending()
      // prefix "pty_" = 4 chars + 26 chars payload = ~30 total
      expect(id.length).toBeGreaterThan(20)
      expect(id.length).toBeLessThan(50)
    })

    test("ascending IDs are lexicographically ascending over time", () => {
      const a = PtyID.ascending()
      const b = PtyID.ascending()
      // With counter increment in same millisecond, b should be > a
      expect(b > a).toBe(true)
    })
  })

  describe("ascending with given ID", () => {
    test("ascending accepts a valid pty_-prefixed ID", () => {
      const id = PtyID.ascending("pty_test123")
      expect(id).toBe("pty_test123" as any)
    })

    test("ascending accepts any pty_-prefixed string", () => {
      const id = PtyID.ascending("pty_")
      expect(id).toBe("pty_" as any)
    })

    test("ascending throws for invalid prefix", () => {
      expect(() => PtyID.ascending("wrong_prefix")).toThrow()
    })

    test("ascending treats empty string as no given ID (falsy) and generates a new ID", () => {
      const id = PtyID.ascending("")
      expect(id.startsWith("pty_")).toBe(true)
      expect(id.length).toBeGreaterThan(4)
    })

    test("ascending throws for non-pty prefix", () => {
      expect(() => PtyID.ascending("ses_other")).toThrow()
    })
  })

  describe("make", () => {
    test("make wraps a plain string into PtyID", () => {
      const id = PtyID.make("pty_custom_id")
      expect(id).toBe("pty_custom_id" as any)
    })

    test("make accepts any string without prefix validation", () => {
      const id = PtyID.make("anything")
      expect(id).toBe("anything" as any)
    })

    test("make preserves empty string", () => {
      const id = PtyID.make("")
      expect(id).toBe("" as any)
    })
  })

  describe("zod schema", () => {
    test("zod accepts valid pty_-prefixed string", () => {
      const result = PtyID.zod.safeParse("pty_test")
      expect(result.success).toBe(true)
    })

    test("zod rejects string without pty_ prefix", () => {
      const result = PtyID.zod.safeParse("xxx_test")
      expect(result.success).toBe(false)
    })

    test("zod rejects empty string", () => {
      const result = PtyID.zod.safeParse("")
      expect(result.success).toBe(false)
    })

    test("zod rejects non-string input (number)", () => {
      const result = PtyID.zod.safeParse(42)
      expect(result.success).toBe(false)
    })

    test("zod rejects non-string input (null)", () => {
      const result = PtyID.zod.safeParse(null)
      expect(result.success).toBe(false)
    })

    test("zod rejects non-string input (undefined)", () => {
      const result = PtyID.zod.safeParse(undefined)
      expect(result.success).toBe(false)
    })
  })

  describe("Effect schema", () => {
    test("Schema.decodeUnknownSync decodes via effect schema", () => {
      const decoded = Schema.decodeUnknownSync(PtyID)("pty_decode_test")
      expect(decoded).toBe("pty_decode_test" as any)
    })

    test("Schema.decodeUnknownSync rejects non-string", () => {
      expect(() => Schema.decodeUnknownSync(PtyID)(123)).toThrow()
    })

    test("Schema.decodeUnknownSync accepts all strings (no prefix check at Effect level)", () => {
      // PtyID's Effect schema is Schema.String (accepts all strings);
      // the ZodOverride prefix check is only active via PtyID.zod
      const decoded = Schema.decodeUnknownSync(PtyID)("bad_prefix")
      expect(decoded).toBe("bad_prefix" as any)
    })
  })

  describe("brand", () => {
    test("PtyID is opaque — brand property is present", () => {
      const id = PtyID.make("pty_branded")
      expect(typeof id).toBe("string")
      expect(id).toBe("pty_branded" as any)
    })
  })
})
