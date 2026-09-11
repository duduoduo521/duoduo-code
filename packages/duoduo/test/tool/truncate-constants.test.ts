import { describe, expect, test } from "bun:test"
import { MAX_LINES, MAX_BYTES, DIR, GLOB, type Result, type Options } from "../../src/tool/truncate"

describe("tool/truncate constants", () => {
  test("MAX_LINES is 2000", () => {
    expect(MAX_LINES).toBe(2000)
  })

  test("MAX_BYTES is 50KB", () => {
    expect(MAX_BYTES).toBe(50 * 1024)
  })

  test("DIR is defined and non-empty", () => {
    expect(DIR).toBeDefined()
    expect(DIR.length).toBeGreaterThan(0)
  })

  test("GLOB includes DIR as prefix", () => {
    expect(GLOB).toContain(DIR)
    expect(GLOB).toContain("*")
  })
})

describe("tool/truncate type checks", () => {
  describe("Result type", () => {
    test("non-truncated has content and truncated=false", () => {
      const result: Result = { content: "hello", truncated: false }
      expect(result.content).toBe("hello")
      expect(result.truncated).toBe(false)
    })

    test("non-truncated result has no outputPath", () => {
      const result: Result = { content: "", truncated: false }
      expect(result.truncated).toBe(false)
      expect("outputPath" in result).toBe(false)
    })

    test("truncated has content, truncated=true, and outputPath", () => {
      const result: Result = {
        content: "truncated preview...",
        truncated: true,
        outputPath: "/tmp/tool_output_123",
      }
      expect(result.truncated).toBe(true)
      if (result.truncated) {
        expect(result.outputPath).toBe("/tmp/tool_output_123")
      }
    })

    test("truncated result with empty content and outputPath", () => {
      const result: Result = {
        content: "",
        truncated: true,
        outputPath: "/tmp/tool_output_empty",
      }
      expect(result.truncated).toBe(true)
      if (result.truncated) {
        expect(result.outputPath).toBe("/tmp/tool_output_empty")
      }
    })
  })

  describe("Options type", () => {
    test("supports all optional fields", () => {
      const opts: Options = {
        maxLines: 100,
        maxBytes: 1024,
        direction: "tail",
      }
      expect(opts.maxLines).toBe(100)
      expect(opts.maxBytes).toBe(1024)
      expect(opts.direction).toBe("tail")
    })

    test("allows empty options", () => {
      const opts: Options = {}
      expect(opts.maxLines).toBeUndefined()
      expect(opts.maxBytes).toBeUndefined()
      expect(opts.direction).toBeUndefined()
    })

    test("supports only maxLines", () => {
      const opts: Options = { maxLines: 50 }
      expect(opts.maxLines).toBe(50)
      expect(opts.maxBytes).toBeUndefined()
      expect(opts.direction).toBeUndefined()
    })

    test("supports only maxBytes", () => {
      const opts: Options = { maxBytes: 500 }
      expect(opts.maxLines).toBeUndefined()
      expect(opts.maxBytes).toBe(500)
      expect(opts.direction).toBeUndefined()
    })

    test("supports head direction", () => {
      const opts: Options = { direction: "head" }
      expect(opts.direction).toBe("head")
    })

    test("supports zero values for limits", () => {
      // 0 is a valid value that means "truncate everything"
      const opts: Options = { maxLines: 0, maxBytes: 0 }
      expect(opts.maxLines).toBe(0)
      expect(opts.maxBytes).toBe(0)
    })
  })
})
