import { describe, expect, test } from "bun:test"
import {
  pickDirectoriesToEvict,
  canDisposeDirectory,
} from "./eviction"
import type { DirState, DisposeCheck, EvictPlan } from "./types"

describe("pickDirectoriesToEvict", () => {
  test("evicts idle directories when over max", () => {
    const now = 1000000
    const plan: EvictPlan = {
      stores: ["/a", "/b", "/c"],
      state: new Map<string, DirState>([
        ["/a", { lastAccessAt: now - 1500000 }], // idle
        ["/b", { lastAccessAt: now - 1500000 }], // idle
        ["/c", { lastAccessAt: now - 100 }],     // recent
      ]),
      pins: new Set(),
      max: 1,
      ttl: 1000000,
      now,
    }
    const result = pickDirectoriesToEvict(plan)
    expect(result).toContain("/a")
    expect(result).toContain("/b")
  })

  test("does not evict pinned directories", () => {
    const now = 1000000
    const plan: EvictPlan = {
      stores: ["/a", "/b"],
      state: new Map<string, DirState>([
        ["/a", { lastAccessAt: 0 }], // very idle
        ["/b", { lastAccessAt: 0 }], // very idle
      ]),
      pins: new Set(["/a"]),
      max: 1,
      ttl: 1000,
      now,
    }
    const result = pickDirectoriesToEvict(plan)
    expect(result).not.toContain("/a")
    expect(result).toContain("/b")
  })

  test("evicts least recently accessed first", () => {
    const now = 1000000
    const plan: EvictPlan = {
      stores: ["/old", "/mid", "/recent"],
      state: new Map<string, DirState>([
        ["/old", { lastAccessAt: 100 }],    // oldest
        ["/mid", { lastAccessAt: 500000 }], // middle
        ["/recent", { lastAccessAt: 999999 }], // recent
      ]),
      pins: new Set(),
      max: 1,
      ttl: 500000,
      now,
    }
    const result = pickDirectoriesToEvict(plan)
    // /old is idle AND overflow, /mid is idle AND overflow, /recent is not idle
    expect(result[0]).toBe("/old")
    expect(result.includes("/recent")).toBe(false)
  })

  test("keeps recent directories when no overflow", () => {
    const now = 1000000
    const plan: EvictPlan = {
      stores: ["/a", "/b"],
      state: new Map<string, DirState>([
        ["/a", { lastAccessAt: now - 100 }], // recent
        ["/b", { lastAccessAt: now - 100 }], // recent
      ]),
      pins: new Set(),
      max: 5,
      ttl: 1000000,
      now,
    }
    const result = pickDirectoriesToEvict(plan)
    expect(result).toEqual([])
  })

  test("evicts overflow directories even if not idle", () => {
    const now = 1000000
    const plan: EvictPlan = {
      stores: ["/a", "/b", "/c"],
      state: new Map<string, DirState>([
        ["/a", { lastAccessAt: now - 100 }], // not idle
        ["/b", { lastAccessAt: now - 100 }], // not idle
        ["/c", { lastAccessAt: now - 100 }], // not idle
      ]),
      pins: new Set(),
      max: 1,
      ttl: 1000000,
      now,
    }
    const result = pickDirectoriesToEvict(plan)
    // Overflow = 2, so at least 2 directories must be evicted
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  test("handles directories without state entries", () => {
    const now = 1000000
    const plan: EvictPlan = {
      stores: ["/a"],
      state: new Map(), // no state for /a
      pins: new Set(),
      max: 0,
      ttl: 1000,
      now,
    }
    const result = pickDirectoriesToEvict(plan)
    // /a has no state, lastAccessAt defaults to 0, which is idle
    expect(result).toContain("/a")
  })

  test("returns empty when no stores", () => {
    const plan: EvictPlan = {
      stores: [],
      state: new Map(),
      pins: new Set(),
      max: 0,
      ttl: 1000,
      now: 1000,
    }
    expect(pickDirectoriesToEvict(plan)).toEqual([])
  })
})

describe("canDisposeDirectory", () => {
  test("returns true when all conditions are met", () => {
    const input: DisposeCheck = {
      directory: "/project",
      hasStore: true,
      pinned: false,
      booting: false,
      loadingSessions: false,
    }
    expect(canDisposeDirectory(input)).toBe(true)
  })

  test("returns false for empty directory", () => {
    const input: DisposeCheck = {
      directory: "",
      hasStore: true,
      pinned: false,
      booting: false,
      loadingSessions: false,
    }
    expect(canDisposeDirectory(input)).toBe(false)
  })

  test("returns false when hasStore is false", () => {
    const input: DisposeCheck = {
      directory: "/project",
      hasStore: false,
      pinned: false,
      booting: false,
      loadingSessions: false,
    }
    expect(canDisposeDirectory(input)).toBe(false)
  })

  test("returns false when pinned", () => {
    const input: DisposeCheck = {
      directory: "/project",
      hasStore: true,
      pinned: true,
      booting: false,
      loadingSessions: false,
    }
    expect(canDisposeDirectory(input)).toBe(false)
  })

  test("returns false when booting", () => {
    const input: DisposeCheck = {
      directory: "/project",
      hasStore: true,
      pinned: false,
      booting: true,
      loadingSessions: false,
    }
    expect(canDisposeDirectory(input)).toBe(false)
  })

  test("returns false when loadingSessions", () => {
    const input: DisposeCheck = {
      directory: "/project",
      hasStore: true,
      pinned: false,
      booting: false,
      loadingSessions: true,
    }
    expect(canDisposeDirectory(input)).toBe(false)
  })
})
