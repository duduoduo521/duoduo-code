import { describe, expect, test } from "bun:test"
import { logo, go, marks } from "../../src/cli/logo"

describe("cli.logo", () => {
  test("logo.left has 4 rows", () => {
    expect(logo.left).toHaveLength(4)
  })

  test("logo.right has 4 rows", () => {
    expect(logo.right).toHaveLength(4)
  })

  test("go.left has 4 rows", () => {
    expect(go.left).toHaveLength(4)
  })

  test("go.right has 4 rows", () => {
    expect(go.right).toHaveLength(4)
  })

  test("marks contains expected glyph characters", () => {
    expect(marks).toContain("_")
    expect(marks).toContain("^")
    expect(marks).toContain("~")
    expect(marks).toHaveLength(4)
  })

  test("logo.left rows contain expected characters or spaces", () => {
    // Row 0 is all spaces, rows 1-3 contain block characters or glyph marks
    const nonEmptyRows = logo.left.slice(1)
    for (const row of nonEmptyRows) {
      const hasGlyph = marks.split("").some((m) => row.includes(m))
      expect(hasGlyph || row.includes("█") || row.includes("▀")).toBe(true)
    }
  })

  test("logo data is consistent — left and right have same row count", () => {
    expect(logo.left.length).toBe(logo.right.length)
  })

  test("go data is consistent — left and right have same row count", () => {
    expect(go.left.length).toBe(go.right.length)
  })
})
