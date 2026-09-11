import { describe, test, expect } from "bun:test"
import { Identifier } from "../../src/id/id"
import { ascending, descending, create, timestamp, sortKey, schema } from "../../src/id/id"

// The id module has module-level mutable state (lastTimestamp, counter).
// We use explicit timestamps via create() to ensure deterministic ordering.

describe("Identifier", () => {
  // ==========================================================================
  // ID format validation
  // ==========================================================================

  describe("ID format", () => {
    test("ascending ID has format {prefix}_{12-hex}{14-base62} = 26 chars after prefix+underscore", () => {
      const id = create("evt", "ascending", 1000)
      // Format: prefix + "_" + 12 hex chars + 14 base62 chars = prefix_len + 1 + 26
      expect(id).toMatch(/^evt_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    })

    test("descending ID has same format", () => {
      const id = create("evt", "descending", 1000)
      expect(id).toMatch(/^evt_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    })

    test("ascending with session prefix uses 'ses'", () => {
      const id = ascending("session", undefined as unknown as string)
      // The prefix function maps "session" -> "ses"
      expect(id.startsWith("ses_")).toBe(true)
    })

    test("ID total length is prefix_length + 1 (underscore) + 26", () => {
      const id = ascending("event")
      const prefix = "evt"
      expect(id.length).toBe(prefix.length + 1 + 26)
    })

    test("hex portion is 12 characters", () => {
      const id = ascending("event")
      const hexPart = id.split("_")[1].slice(0, 12)
      expect(hexPart).toMatch(/^[0-9a-f]{12}$/)
      expect(hexPart.length).toBe(12)
    })

    test("base62 portion is 14 characters", () => {
      const id = ascending("event")
      const base62Part = id.split("_")[1].slice(12)
      expect(base62Part.length).toBe(14)
      expect(base62Part).toMatch(/^[0-9A-Za-z]{14}$/)
    })
  })

  // ==========================================================================
  // ascending — time-ascending IDs sort lexicographically larger
  // ==========================================================================

  describe("ascending", () => {
    test("later IDs sort lexicographically larger", () => {
      const id1 = create("evt", "ascending", 1000)
      const id2 = create("evt", "ascending", 2000)
      expect(id2 > id1).toBe(true)
    })

    test("IDs far apart in time maintain ascending order", () => {
      const ids = [
        create("evt", "ascending", 100),
        create("evt", "ascending", 1000),
        create("evt", "ascending", 10000),
        create("evt", "ascending", 100000),
      ]
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i] > ids[i - 1]).toBe(true)
      }
    })

    test("with given string matching prefix returns it unchanged", () => {
      const given = "evt_abc123def456xyzXYZ12AB"
      const result = ascending("event", given)
      expect(result).toBe(given)
    })

    test("with given string not matching prefix throws", () => {
      expect(() => ascending("event", "ses_something")).toThrow(/does not start with evt/)
    })

    test("ascending without given generates a new ID", () => {
      const id = ascending("event")
      expect(id).toMatch(/^evt_/)
      expect(id.length).toBe(3 + 1 + 26) // "evt" + "_" + 26
    })
  })

  // ==========================================================================
  // descending — time-descending IDs sort lexicographically smaller
  // ==========================================================================

  describe("descending", () => {
    test("later IDs sort lexicographically smaller", () => {
      const id1 = create("evt", "descending", 1000)
      const id2 = create("evt", "descending", 2000)
      expect(id2 < id1).toBe(true)
    })

    test("IDs far apart in time maintain descending order", () => {
      const ids = [
        create("evt", "descending", 100),
        create("evt", "descending", 1000),
        create("evt", "descending", 10000),
        create("evt", "descending", 100000),
      ]
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i] < ids[i - 1]).toBe(true)
      }
    })

    test("with given string matching prefix returns it unchanged", () => {
      const given = "evt_abc123def456xyzXYZ12AB"
      const result = descending("event", given)
      expect(result).toBe(given)
    })

    test("with given string not matching prefix throws", () => {
      expect(() => descending("event", "ses_something")).toThrow(/does not start with evt/)
    })

    test("descending without given generates a new ID", () => {
      const id = descending("event")
      expect(id).toMatch(/^evt_/)
    })
  })

  // ==========================================================================
  // create — core ID generator
  // ==========================================================================

  describe("create", () => {
    test("uses provided timestamp when given", () => {
      const id = create("evt", "ascending", 5000)
      const extracted = timestamp(id)
      expect(extracted).toBe(5000)
    })

    test("monotonic within same millisecond (counter increment)", () => {
      const sameMs = 1000
      const id1 = create("evt", "ascending", sameMs)
      const id2 = create("evt", "ascending", sameMs)
      // Counter increments: both same timestamp but id2 has higher counter
      expect(id2 > id1).toBe(true)
    })

    test("counter resets when timestamp changes", () => {
      const id1 = create("evt", "ascending", 1000)
      const id2 = create("evt", "ascending", 2000)
      // Different timestamps, id2 should be > id1 for ascending
      expect(id2 > id1).toBe(true)
    })

    test("ascending IDs at same ms are strictly monotonic", () => {
      const sameMs = 12345
      const ids = Array.from({ length: 10 }, () => create("evt", "ascending", sameMs))
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i] > ids[i - 1]).toBe(true)
      }
    })

    test("descending IDs at same ms are strictly monotonic (later = smaller)", () => {
      const sameMs = 12345
      const ids = Array.from({ length: 10 }, () => create("evt", "descending", sameMs))
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i] < ids[i - 1]).toBe(true)
      }
    })

    test("works with various valid prefixes", () => {
      const prefixes = [
        ["evt", "event"],
        ["ses", "session"],
        ["msg", "message"],
        ["per", "permission"],
        ["que", "question"],
        ["usr", "user"],
        ["prt", "part"],
        ["pty", "pty"],
        ["tool", "tool"],
        ["wrk", "workspace"],
        ["ent", "entry"],
      ] as const
      for (const [prefix, key] of prefixes) {
        const id = ascending(key)
        expect(id.startsWith(prefix + "_")).toBe(true)
      }
    })

    test("custom string prefix works with create", () => {
      const id = create("custom", "ascending", 1000)
      expect(id.startsWith("custom_")).toBe(true)
    })
  })

  // ==========================================================================
  // sortKey — extract hex-encoded sort key for comparison
  // ==========================================================================

  describe("sortKey", () => {
    test("returns 12-character hex string from ascending ID", () => {
      const id = create("evt", "ascending", 1000)
      expect(sortKey(id)).toMatch(/^[0-9a-f]{12}$/)
      expect(sortKey(id).length).toBe(12)
    })

    test("returns 12-character hex string from descending ID", () => {
      const id = create("evt", "descending", 1000)
      expect(sortKey(id)).toMatch(/^[0-9a-f]{12}$/)
      expect(sortKey(id).length).toBe(12)
    })

    test("ascending IDs: later sort keys are lexicographically larger", () => {
      const id1 = create("evt", "ascending", 1000)
      const id2 = create("evt", "ascending", 2000)
      expect(sortKey(id2) > sortKey(id1)).toBe(true)
    })

    test("descending IDs: later sort keys are lexicographically smaller", () => {
      const id1 = create("evt", "descending", 1000)
      const id2 = create("evt", "descending", 2000)
      expect(sortKey(id2) < sortKey(id1)).toBe(true)
    })

    test("sort keys from IDs at same ms are ordered correctly (ascending)", () => {
      const sameMs = 12345
      const id1 = create("evt", "ascending", sameMs)
      const id2 = create("evt", "ascending", sameMs)
      // counter increments, so sortKey(id2) > sortKey(id1) for ascending
      expect(sortKey(id2) >= sortKey(id1)).toBe(true)
    })

    test("sortKey works with realistic epoch-ms timestamps", () => {
      const now = Date.now()
      const idNow = create("tool", "ascending", now)
      const id7dAgo = create("tool", "ascending", now - 7 * 24 * 60 * 60 * 1000)
      // ascending: recent ID has larger sort key than old ID
      expect(sortKey(idNow) > sortKey(id7dAgo)).toBe(true)
    })

    test("sortKey comparison preserves relative time ordering for cleanup", () => {
      // This verifies the exact logic used in truncate.ts cleanup:
      //   Identifier.sortKey(entry) >= cutoffKey
      const cutoffTs = Date.now() - 7 * 24 * 60 * 60 * 1000 // 7 days ago
      const oldTs = Date.now() - 10 * 24 * 60 * 60 * 1000 // 10 days ago
      const recentTs = Date.now() - 3 * 24 * 60 * 60 * 1000 // 3 days ago
      const cutoffKey = sortKey(create("tool", "ascending", cutoffTs))
      const oldKey = sortKey(create("tool", "ascending", oldTs))
      const recentKey = sortKey(create("tool", "ascending", recentTs))
      // old file should be cleaned up (sortKey < cutoff)
      expect(oldKey < cutoffKey).toBe(true)
      // recent file should be kept (sortKey >= cutoff)
      expect(recentKey >= cutoffKey).toBe(true)
    })

    test("sortKey is consistent with same ID", () => {
      const id = create("evt", "ascending", 1000)
      expect(sortKey(id)).toBe(sortKey(id))
    })

    test("sortKey works with different prefixes", () => {
      for (const prefix of ["evt", "ses", "msg", "tool", "wrk"]) {
        const id = create(prefix, "ascending", 5000)
        const key = sortKey(id)
        expect(key.length).toBe(12)
        expect(key).toMatch(/^[0-9a-f]{12}$/)
      }
    })
  })

  // ==========================================================================
  // timestamp — DEPRECATED, returns inaccurate values for real timestamps
  // ==========================================================================

  describe("timestamp (deprecated)", () => {
    // NOTE: create() encodes timestamp * 0x1000 + counter into 6 bytes (48 bits).
    // 48-bit max is ~281 trillion. For realistic epoch-ms timestamps like
    // 1700000000000 (year 2023), the encoded value overflows 48 bits,
    // so timestamp() round-trip only works for small timestamps.
    // This is a known production bug (BUG-002 in 测试发现的问题-20260617.md).

    test("round-trips with ascending IDs (small timestamp)", () => {
      const ts = 1000
      const id = create("evt", "ascending", ts)
      expect(timestamp(id)).toBe(ts)
    })

    test("round-trips with small timestamps", () => {
      const ts = 50000
      const id = create("evt", "ascending", ts)
      expect(timestamp(id)).toBe(ts)
    })

    test("round-trips with zero timestamp", () => {
      const ts = 0
      const id = create("evt", "ascending", ts)
      expect(timestamp(id)).toBe(ts)
    })

    test("round-trips with medium timestamps (within 48-bit range)", () => {
      const ts = 10000000 // ~10 million ms from epoch
      const id = create("evt", "ascending", ts)
      expect(timestamp(id)).toBe(ts)
    })

    test("extracts correct timestamp for different prefixes", () => {
      const ts = 10000
      const id = create("ses", "ascending", ts)
      expect(timestamp(id)).toBe(ts)
    })

    test("does not return correct timestamp for descending IDs", () => {
      // The timestamp function explicitly says it does not work with descending IDs.
      const ts = 1000
      const id = create("evt", "descending", ts)
      expect(timestamp(id)).not.toBe(ts)
    })

    test("handles IDs with long prefix containing underscore", () => {
      const ts = 5000
      const id = create("workspace", "ascending", ts)
      expect(timestamp(id)).toBe(ts)
    })

    // BUG-002: timestamp() fails for realistic epoch-ms values due to 48-bit overflow
    test("KNOWN BUG: timestamp() returns wrong value for realistic epoch-ms", () => {
      const ts = 1700000000000 // ~2023
      const id = create("evt", "ascending", ts)
      // This should equal ts but doesn't due to 48-bit overflow in create()
      expect(timestamp(id)).not.toBe(ts)
      // The extracted value is a truncated/garbled result
      expect(typeof timestamp(id)).toBe("number")
    })
  })

  // ==========================================================================
  // schema — zod schema that validates prefix
  // ==========================================================================

  describe("schema", () => {
    test("validates IDs with correct prefix", () => {
      const s = schema("event")
      const id = ascending("event")
      const result = s.safeParse(id)
      expect(result.success).toBe(true)
    })

    test("rejects IDs with wrong prefix", () => {
      const s = schema("event")
      const id = ascending("session") // "ses_" prefix, not "evt_"
      const result = s.safeParse(id)
      expect(result.success).toBe(false)
    })

    test("validates for each registered prefix", () => {
      const keys = [
        "event",
        "session",
        "message",
        "permission",
        "question",
        "user",
        "part",
        "pty",
        "tool",
        "workspace",
        "entry",
      ] as const
      for (const key of keys) {
        const s = schema(key)
        const id = ascending(key)
        const result = s.safeParse(id)
        expect(result.success).toBe(true)
      }
    })

    test("returns a zod string schema with startsWith", () => {
      const s = schema("event")
      // The schema should be a z.string().startsWith("evt")
      expect(s.safeParse("evt_abc").success).toBe(true)
      expect(s.safeParse("ses_abc").success).toBe(false)
    })
  })

  // ==========================================================================
  // Namespace export
  // ==========================================================================

  describe("namespace export", () => {
    test("Identifier namespace exposes all public functions", () => {
      expect(typeof Identifier.ascending).toBe("function")
      expect(typeof Identifier.descending).toBe("function")
      expect(typeof Identifier.create).toBe("function")
      expect(typeof Identifier.timestamp).toBe("function")
      expect(typeof Identifier.sortKey).toBe("function")
      expect(typeof Identifier.schema).toBe("function")
    })

    test("Identifier namespace functions produce same results as named exports", () => {
      const ts1 = 1000
      const ts2 = 2000
      const id1 = create("evt", "ascending", ts1)
      const id2 = Identifier.create("evt", "ascending", ts2)
      // Different timestamps, so different sort keys (ascending: later = larger)
      expect(sortKey(id2) > sortKey(id1)).toBe(true)
    })
  })
})
