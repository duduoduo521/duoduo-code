import { describe, expect, test } from "bun:test"
import { computeWordDiff, wordDiffForSide } from "./word-diff"

describe("word-diff", () => {
  describe("computeWordDiff", () => {
    test("returns a single unchanged segment for identical lines", () => {
      const parts = computeWordDiff("hello world", "hello world")
      expect(parts).toHaveLength(1)
      expect(parts[0].value).toBe("hello world")
      // `diffWords` marks unchanged segments with added/removed = false (not
      // undefined). Neither flag should be truthy for an unchanged segment.
      expect(Boolean(parts[0].added)).toBe(false)
      expect(Boolean(parts[0].removed)).toBe(false)
    })

    test("marks replaced words as removed then added", () => {
      const parts = computeWordDiff("const x = 1", "const y = 1")
      // "const " unchanged, "x" removed, "y" added, " = 1" unchanged
      const removed = parts.filter((p) => p.removed).map((p) => p.value)
      const added = parts.filter((p) => p.added).map((p) => p.value)
      expect(removed).toContain("x")
      expect(added).toContain("y")
    })

    test("marks fully added line as a single added segment", () => {
      const parts = computeWordDiff("", "new line")
      expect(parts.some((p) => p.added && p.value.includes("new line"))).toBe(true)
    })

    test("marks fully removed line as a single removed segment", () => {
      const parts = computeWordDiff("old line", "")
      expect(parts.some((p) => p.removed && p.value.includes("old line"))).toBe(true)
    })
  })

  describe("wordDiffForSide", () => {
    test("deletions side keeps removed and context segments, drops added", () => {
      const parts = wordDiffForSide("const x = 1", "const y = 1", "deletions")
      // No segment on the deletions side should be marked `added`.
      expect(parts.every((p) => !p.added)).toBe(true)
      // The removed word "x" must be present.
      expect(parts.some((p) => p.removed && p.value.includes("x"))).toBe(true)
      // The added word "y" must NOT leak onto the deletions side.
      expect(parts.every((p) => !p.value.includes("y"))).toBe(true)
    })

    test("additions side keeps added and context segments, drops removed", () => {
      const parts = wordDiffForSide("const x = 1", "const y = 1", "additions")
      expect(parts.every((p) => !p.removed)).toBe(true)
      expect(parts.some((p) => p.added && p.value.includes("y"))).toBe(true)
      expect(parts.every((p) => !p.value.includes("x"))).toBe(true)
    })

    test("returns the full unchanged line for both sides when there is no diff", () => {
      const del = wordDiffForSide("same", "same", "deletions")
      const add = wordDiffForSide("same", "same", "additions")
      expect(del.map((p) => p.value).join("")).toBe("same")
      expect(add.map((p) => p.value).join("")).toBe("same")
      expect(del.every((p) => !p.added && !p.removed)).toBe(true)
      expect(add.every((p) => !p.added && !p.removed)).toBe(true)
    })
  })
})
