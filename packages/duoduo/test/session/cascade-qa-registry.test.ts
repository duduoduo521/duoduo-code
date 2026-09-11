import { describe, expect, test } from "bun:test"
import {
  onSessionDeleted,
  triggerOnDelete,
  setCascadeQA,
  setCascadeQAGlobal,
  deleteCascadeQA,
  getCascadeQA,
} from "../../src/session/cascade-qa-registry"

describe("cascade-qa-registry", () => {
  test("getCascadeQA returns false by default", () => {
    expect(getCascadeQA("nonexistent-session")).toBe(false)
  })

  test("setCascadeQA sets value for a session", () => {
    setCascadeQA("test-session-1", true)
    expect(getCascadeQA("test-session-1")).toBe(true)

    // Cleanup
    deleteCascadeQA("test-session-1")
  })

  test("setCascadeQA can set false explicitly", () => {
    setCascadeQA("test-session-2", true)
    expect(getCascadeQA("test-session-2")).toBe(true)
    setCascadeQA("test-session-2", false)
    expect(getCascadeQA("test-session-2")).toBe(false)

    // Cleanup
    deleteCascadeQA("test-session-2")
  })

  test("deleteCascadeQA removes a session entry", () => {
    setCascadeQA("test-session-3", true)
    expect(getCascadeQA("test-session-3")).toBe(true)
    deleteCascadeQA("test-session-3")
    expect(getCascadeQA("test-session-3")).toBe(false)
  })

  test("setCascadeQAGlobal sets default without overriding existing entries", () => {
    setCascadeQA("global-test-1", false)
    setCascadeQAGlobal(true)
    // Existing per-session entry is preserved (fixes §1.1 #8 global-pollution side effect)
    expect(getCascadeQA("global-test-1")).toBe(false)
    // New sessions fall back to the updated default
    expect(getCascadeQA("any-new-session")).toBe(true)

    // Reset
    setCascadeQAGlobal(false)
    deleteCascadeQA("global-test-1")
  })

  test("setCascadeQAGlobal sets default to false", () => {
    setCascadeQAGlobal(true)
    expect(getCascadeQA("any-session")).toBe(true)

    setCascadeQAGlobal(false)
    expect(getCascadeQA("any-session")).toBe(false)
  })

  test("onSessionDeleted registers callback and triggerOnDelete invokes it", () => {
    const calls: string[] = []
    const cb = (sessionID: string) => calls.push(sessionID)

    onSessionDeleted(cb)
    triggerOnDelete("deleted-session-1")
    triggerOnDelete("deleted-session-2")

    expect(calls).toEqual(["deleted-session-1", "deleted-session-2"])

    // Note: onSessionDeleted adds to a Set, so re-adding same callback is a no-op
    // We can't easily unregister, but the test verifies the mechanism works
  })

  test("multiple callbacks are all invoked", () => {
    const calls1: string[] = []
    const calls2: string[] = []
    const cb1 = (id: string) => calls1.push(id)
    const cb2 = (id: string) => calls2.push(id)

    onSessionDeleted(cb1)
    onSessionDeleted(cb2)
    triggerOnDelete("multi-callback-session")

    expect(calls1).toContain("multi-callback-session")
    expect(calls2).toContain("multi-callback-session")
  })

  test("same callback is not added twice (Set behavior)", () => {
    const calls: string[] = []
    const cb = (id: string) => calls.push(id)

    onSessionDeleted(cb)
    onSessionDeleted(cb) // Adding again — Set deduplicates
    triggerOnDelete("dedup-session")

    // Should only be called once since Set deduplicates the callback reference
    expect(calls.filter((id) => id === "dedup-session").length).toBe(1)
  })
})
