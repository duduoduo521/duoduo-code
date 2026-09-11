import { describe, expect, test } from "bun:test"
import { setSessionHandoff, getSessionHandoff, setTerminalHandoff, getTerminalHandoff } from "./handoff"

// The handoff module uses module-level state (Map), so we need to
// account for shared state across tests. We'll use unique keys per test
// and test eviction behavior by generating enough entries.

describe("setSessionHandoff / getSessionHandoff", () => {
  test("round-trip stores and retrieves handoff data", () => {
    const key = `test-session-rt-${Date.now()}`
    setSessionHandoff(key, { prompt: "hello", files: {} })
    const result = getSessionHandoff(key)
    expect(result).toEqual({ prompt: "hello", files: {} })
  })

  test("merges with previous value on partial update", () => {
    const key = `test-session-merge-${Date.now()}`
    setSessionHandoff(key, { prompt: "first", files: {} })
    setSessionHandoff(key, { prompt: "second" })
    const result = getSessionHandoff(key)
    expect(result?.prompt).toBe("second")
    expect(result?.files).toEqual({})
  })

  test("returns undefined for non-existent key", () => {
    expect(getSessionHandoff("non-existent-key")).toBeUndefined()
  })

  test("overwrites existing key", () => {
    const key = `test-session-overwrite-${Date.now()}`
    setSessionHandoff(key, { prompt: "v1", files: { "a.ts": null } })
    setSessionHandoff(key, { prompt: "v2", files: {} })
    const result = getSessionHandoff(key)
    expect(result?.prompt).toBe("v2")
    expect(result?.files).toEqual({})
  })

  test("preserves files when only prompt is updated", () => {
    const key = `test-session-files-${Date.now()}`
    setSessionHandoff(key, { prompt: "first", files: { "a.ts": null } })
    setSessionHandoff(key, { prompt: "second" })
    const result = getSessionHandoff(key)
    expect(result?.prompt).toBe("second")
    expect(result?.files).toEqual({ "a.ts": null })
  })

  test("adds new file to existing handoff", () => {
    const key = `test-session-addfile-${Date.now()}`
    setSessionHandoff(key, { prompt: "prompt", files: { "a.ts": null } })
    setSessionHandoff(key, { files: { "b.ts": { start: 1, end: 10 } } })
    const result = getSessionHandoff(key)
    expect(result?.files).toEqual({ "b.ts": { start: 1, end: 10 } })
  })
})

describe("setTerminalHandoff / getTerminalHandoff", () => {
  test("round-trip stores and retrieves terminal data", () => {
    const key = `test-terminal-rt-${Date.now()}`
    setTerminalHandoff(key, ["cmd1", "cmd2"])
    const result = getTerminalHandoff(key)
    expect(result).toEqual(["cmd1", "cmd2"])
  })

  test("returns undefined for non-existent key", () => {
    expect(getTerminalHandoff("non-existent-key")).toBeUndefined()
  })

  test("overwrites existing key", () => {
    const key = `test-terminal-overwrite-${Date.now()}`
    setTerminalHandoff(key, ["old"])
    setTerminalHandoff(key, ["new"])
    const result = getTerminalHandoff(key)
    expect(result).toEqual(["new"])
  })

  test("stores empty array", () => {
    const key = `test-terminal-empty-${Date.now()}`
    setTerminalHandoff(key, [])
    const result = getTerminalHandoff(key)
    expect(result).toEqual([])
  })
})

describe("LRU eviction at MAX=40", () => {
  test("evicts oldest entry when exceeding 40 entries for session", () => {
    const prefix = `evict-session-${Date.now()}-`
    const oldestKey = `${prefix}oldest`
    setSessionHandoff(oldestKey, { prompt: "oldest", files: {} })

    // Fill up to 40 entries total (1 already inserted + 39 more)
    for (let i = 1; i < 40; i++) {
      setSessionHandoff(`${prefix}${i}`, { prompt: `val-${i}`, files: {} })
    }
    // oldest should still exist (40 entries)
    expect(getSessionHandoff(oldestKey)).toBeDefined()

    // Add one more → should evict oldest
    setSessionHandoff(`${prefix}extra`, { prompt: "extra", files: {} })
    expect(getSessionHandoff(oldestKey)).toBeUndefined()
    expect(getSessionHandoff(`${prefix}extra`)).toBeDefined()
  })

  test("evicts oldest entry when exceeding 40 entries for terminal", () => {
    const prefix = `evict-terminal-${Date.now()}-`
    const oldestKey = `${prefix}oldest`
    setTerminalHandoff(oldestKey, ["oldest"])

    for (let i = 1; i < 40; i++) {
      setTerminalHandoff(`${prefix}${i}`, [`val-${i}`])
    }
    expect(getTerminalHandoff(oldestKey)).toBeDefined()

    setTerminalHandoff(`${prefix}extra`, ["extra"])
    expect(getTerminalHandoff(oldestKey)).toBeUndefined()
    expect(getTerminalHandoff(`${prefix}extra`)).toBeDefined()
  })

  test("touching existing key moves it to end (prevents eviction)", () => {
    const prefix = `evict-touch-${Date.now()}-`
    const surviveKey = `${prefix}survive`
    setTerminalHandoff(surviveKey, ["survive"])

    for (let i = 0; i < 39; i++) {
      setTerminalHandoff(`${prefix}${i}`, [`val-${i}`])
    }

    // Touch survive to move it to most-recent
    setTerminalHandoff(surviveKey, ["survive-updated"])

    // Add one more → evicts the true oldest (not survive)
    setTerminalHandoff(`${prefix}extra`, ["extra"])
    expect(getTerminalHandoff(surviveKey)).toEqual(["survive-updated"])
  })
})
