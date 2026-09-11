import { describe, expect, test } from "bun:test"
import { TRUNCATION_DIR } from "../../src/tool/truncation-dir"
import path from "path"

describe("tool/truncation-dir", () => {
  test("TRUNCATION_DIR is under data/tool-output", () => {
    expect(TRUNCATION_DIR).toContain("tool-output")
  })

  test("TRUNCATION_DIR is an absolute path", () => {
    expect(path.isAbsolute(TRUNCATION_DIR)).toBe(true)
  })
})
