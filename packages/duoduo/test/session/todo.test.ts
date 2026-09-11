import { describe, expect, test } from "bun:test"
import { isValidTransition } from "../../src/session/todo"

describe("isValidTransition", () => {
  test("same state is always allowed (idempotent)", () => {
    expect(isValidTransition("pending", "pending")).toBe(true)
    expect(isValidTransition("in_progress", "in_progress")).toBe(true)
    expect(isValidTransition("completed", "completed")).toBe(true)
    expect(isValidTransition("cancelled", "cancelled")).toBe(true)
  })

  test("rejects unknown target status", () => {
    expect(isValidTransition("pending", "done")).toBe(false)
    expect(isValidTransition("in_progress", "foo")).toBe(false)
  })

  test("allows valid forward transitions", () => {
    expect(isValidTransition("pending", "in_progress")).toBe(true)
    expect(isValidTransition("in_progress", "completed")).toBe(true)
    expect(isValidTransition("pending", "completed")).toBe(true)
    expect(isValidTransition("pending", "cancelled")).toBe(true)
    expect(isValidTransition("in_progress", "cancelled")).toBe(true)
  })

  test("rejects transition out of terminal state (completed/cancelled cannot be left)", () => {
    expect(isValidTransition("completed", "in_progress")).toBe(false)
    expect(isValidTransition("completed", "pending")).toBe(false)
    expect(isValidTransition("completed", "cancelled")).toBe(false)
    expect(isValidTransition("cancelled", "pending")).toBe(false)
    expect(isValidTransition("cancelled", "in_progress")).toBe(false)
    expect(isValidTransition("cancelled", "completed")).toBe(false)
  })

  test("rejects transition back to pending", () => {
    expect(isValidTransition("in_progress", "pending")).toBe(false)
    expect(isValidTransition("completed", "pending")).toBe(false)
    expect(isValidTransition("cancelled", "pending")).toBe(false)
  })
})
