import { describe, expect, test } from "bun:test"
import { computeDiff, linesForSide } from "./compute"

describe("computeDiff no-newline markers", () => {
  test("marks no-newline patch markers without including them in side text", () => {
    const result = computeDiff("one\ntwo", "one\nthree")

    const markers = result.lines.filter((line) => line.type === "no-newline")
    expect(markers).toHaveLength(2)
    expect(markers.map((line) => line.content)).toEqual([" No newline at end of file", " No newline at end of file"])

    expect(linesForSide(result.lines, "deletions")).toEqual(["one", "two"])
    expect(linesForSide(result.lines, "additions")).toEqual(["one", "three"])
  })
})
