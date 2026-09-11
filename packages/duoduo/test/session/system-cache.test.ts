import { describe, expect, test, beforeEach } from "bun:test"
import {
  buildStructuredCtxCacheKey,
  getStructuredCtxCacheStats,
  hashCacheComponent,
} from "../../src/session/system"

describe("structuredContext cache", () => {
  beforeEach(() => {
    // Note: We can't directly reset the cache between tests since it's module-scoped.
    // Instead, we test the stats function and cache behavior patterns.
  })

  test("getStructuredCtxCacheStats returns expected shape", () => {
    const stats = getStructuredCtxCacheStats()
    expect(stats).toHaveProperty("size")
    expect(stats).toHaveProperty("maxSize")
    expect(stats).toHaveProperty("hits")
    expect(stats).toHaveProperty("misses")
    expect(stats).toHaveProperty("hitRate")
    expect(typeof stats.size).toBe("number")
    expect(typeof stats.maxSize).toBe("number")
    expect(typeof stats.hits).toBe("number")
    expect(typeof stats.misses).toBe("number")
    expect(typeof stats.hitRate).toBe("number")
    expect(stats.maxSize).toBe(64)
    expect(stats.hitRate).toBeGreaterThanOrEqual(0)
    expect(stats.hitRate).toBeLessThanOrEqual(1)
  })

  test("cache stats are non-negative", () => {
    const stats = getStructuredCtxCacheStats()
    expect(stats.size).toBeGreaterThanOrEqual(0)
    expect(stats.hits).toBeGreaterThanOrEqual(0)
    expect(stats.misses).toBeGreaterThanOrEqual(0)
  })

  test("hitRate is 0 when no hits or misses", () => {
    // Fresh module load — stats may already have values from other tests,
    // but the calculation should always be valid
    const stats = getStructuredCtxCacheStats()
    if (stats.hits === 0 && stats.misses === 0) {
      expect(stats.hitRate).toBe(0)
    }
    // If there are hits/misses, hitRate should be hits/(hits+misses)
    if (stats.hits + stats.misses > 0) {
      expect(stats.hitRate).toBeCloseTo(stats.hits / (stats.hits + stats.misses))
    }
  })
})

describe("structuredContext cache key", () => {
  // The Rust /context/structured endpoint assembles context from
  // (sessionID, phase, userMessage, tokenBudget, projectPath). Keying the cache
  // on sessionID alone returned a context built for a DIFFERENT user message,
  // phase, budget or project — a correctness bug, not a staleness trade-off.
  const base = {
    sessionID: "sess-1",
    phase: "execute",
    userMessage: "implement the parser",
    tokenBudget: 4000,
    projectPath: "/tmp/project-a",
  }

  test("identical inputs produce an identical key", () => {
    expect(buildStructuredCtxCacheKey(base)).toBe(buildStructuredCtxCacheKey({ ...base }))
  })

  test("every retrieval input changes the key", () => {
    const baseline = buildStructuredCtxCacheKey(base)
    const variants: Array<[string, Parameters<typeof buildStructuredCtxCacheKey>[0]]> = [
      ["sessionID", { ...base, sessionID: "sess-2" }],
      ["phase", { ...base, phase: "plan" }],
      ["userMessage", { ...base, userMessage: "fix the renderer" }],
      ["tokenBudget", { ...base, tokenBudget: 8000 }],
      ["projectPath", { ...base, projectPath: "/tmp/project-b" }],
    ]
    for (const [field, args] of variants) {
      expect(buildStructuredCtxCacheKey(args), `${field} must affect the key`).not.toBe(baseline)
    }
  })

  test("a same-length different message still changes the key", () => {
    // Length alone is not enough to discriminate; the hash must contribute.
    const a = buildStructuredCtxCacheKey({ ...base, userMessage: "aaaa" })
    const b = buildStructuredCtxCacheKey({ ...base, userMessage: "bbbb" })
    expect(a).not.toBe(b)
  })

  test("undefined and empty user messages agree", () => {
    // Both mean "no user message" on the Rust side, so they must share a key.
    const undef = buildStructuredCtxCacheKey({ ...base, userMessage: undefined })
    const empty = buildStructuredCtxCacheKey({ ...base, userMessage: "" })
    expect(undef).toBe(empty)
  })

  test("the raw user message is not embedded in the key", () => {
    // Keeping the raw prompt would let a 64-entry cache retain a large amount
    // of conversation text.
    const secret = "a-very-distinctive-user-prompt-string"
    const key = buildStructuredCtxCacheKey({ ...base, userMessage: secret })
    expect(key).not.toContain(secret)
  })

  test("key length stays bounded regardless of message size", () => {
    const short = buildStructuredCtxCacheKey({ ...base, userMessage: "hi" })
    const huge = buildStructuredCtxCacheKey({ ...base, userMessage: "x".repeat(500_000) })
    // Only the decimal length differs in magnitude; no linear growth.
    expect(huge.length).toBeLessThan(short.length + 20)
  })

  test("keys remain distinct across a realistic turn sequence", () => {
    const keys = new Set<string>()
    for (const phase of ["plan", "execute", "review"]) {
      for (let turn = 0; turn < 25; turn++) {
        keys.add(
          buildStructuredCtxCacheKey({
            ...base,
            phase,
            userMessage: `turn ${turn} message`,
          }),
        )
      }
    }
    expect(keys.size).toBe(75)
  })
})

describe("hashCacheComponent", () => {
  test("is deterministic", () => {
    expect(hashCacheComponent("hello")).toBe(hashCacheComponent("hello"))
  })

  test("discriminates similar inputs", () => {
    expect(hashCacheComponent("hello")).not.toBe(hashCacheComponent("hellp"))
    expect(hashCacheComponent("ab")).not.toBe(hashCacheComponent("ba"))
  })

  test("handles empty and unicode input", () => {
    expect(typeof hashCacheComponent("")).toBe("string")
    expect(hashCacheComponent("中文路径")).not.toBe(hashCacheComponent("中文路徑"))
  })

  test("output is a compact token", () => {
    const h = hashCacheComponent("x".repeat(10_000))
    expect(h).toMatch(/^[0-9a-z]+$/)
    expect(h.length).toBeLessThanOrEqual(7)
  })
})
