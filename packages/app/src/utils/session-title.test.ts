import { describe, expect, test } from "bun:test"
import { sessionTitle } from "./session-title"

describe("sessionTitle", () => {
  test('strips ISO timestamp from "New session" auto-generated title', () => {
    expect(sessionTitle("New session - 2024-01-01T00:00:00.000Z")).toBe("New session")
  })

  test('strips ISO timestamp from "Child session" auto-generated title', () => {
    expect(sessionTitle("Child session - 2025-06-18T12:34:56.789Z")).toBe("Child session")
  })

  test("returns regular title unchanged", () => {
    expect(sessionTitle("Regular title")).toBe("Regular title")
  })

  test("returns undefined for undefined input", () => {
    expect(sessionTitle(undefined)).toBeUndefined()
  })

  test("returns empty string for empty string input", () => {
    expect(sessionTitle("")).toBe("")
  })

  test("does not strip non-standard timestamp format", () => {
    expect(sessionTitle("New session - 2024-01-01")).toBe("New session - 2024-01-01")
  })

  test("does not strip timestamp from non-matching prefix", () => {
    expect(sessionTitle("My session - 2024-01-01T00:00:00.000Z")).toBe(
      "My session - 2024-01-01T00:00:00.000Z",
    )
  })

  test("handles title with extra content after timestamp pattern", () => {
    // The regex uses $ anchor, so extra content after the timestamp should prevent a match
    expect(sessionTitle("New session - 2024-01-01T00:00:00.000Z extra")).toBe(
      "New session - 2024-01-01T00:00:00.000Z extra",
    )
  })
})
