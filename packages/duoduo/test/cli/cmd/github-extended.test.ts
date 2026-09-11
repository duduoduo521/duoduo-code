import { describe, expect, test } from "bun:test"
import { extractResponseText, formatPromptTooLargeError } from "../../../src/cli/cmd/github"

describe("cli.cmd.github.extractResponseText", () => {
  test("returns text from last text part", () => {
    const parts = [
      { type: "text", text: "first" } as any,
      { type: "text", text: "second" } as any,
    ]
    expect(extractResponseText(parts)).toBe("second")
  })

  test("returns text from single text part", () => {
    const parts = [{ type: "text", text: "hello" } as any]
    expect(extractResponseText(parts)).toBe("hello")
  })

  test("returns null for non-text parts (signals summary needed)", () => {
    const parts = [{ type: "tool", tool: "bash" } as any]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns null for mixed parts without text", () => {
    const parts = [
      { type: "tool", tool: "bash" } as any,
      { type: "reasoning", text: "thinking" } as any,
    ]
    expect(extractResponseText(parts)).toBeNull()
  })

  test("returns text when text part exists alongside non-text parts", () => {
    const parts = [
      { type: "tool", tool: "bash" } as any,
      { type: "text", text: "result" } as any,
    ]
    expect(extractResponseText(parts)).toBe("result")
  })

  test("throws for empty parts array", () => {
    expect(() => extractResponseText([])).toThrow("no parts returned")
  })
})

describe("cli.cmd.github.formatPromptTooLargeError", () => {
  test("formats error with file details", () => {
    const files = [
      { filename: "src/index.ts", content: "a".repeat(1366) }, // ~1KB after 0.75 factor
      { filename: "README.md", content: "b".repeat(2732) }, // ~2KB
    ]
    const result = formatPromptTooLargeError(files)
    expect(result).toContain("PROMPT_TOO_LARGE")
    expect(result).toContain("src/index.ts")
    expect(result).toContain("README.md")
    expect(result).toContain("KB")
  })

  test("formats error without files", () => {
    const result = formatPromptTooLargeError([])
    expect(result).toContain("PROMPT_TOO_LARGE")
    expect(result).not.toContain("Files in prompt")
  })

  test("calculates file sizes using 0.75 base64 factor", () => {
    // 1366 bytes * 0.75 = 1024.5 → ~1 KB
    const files = [{ filename: "test.ts", content: "x".repeat(1366) }]
    const result = formatPromptTooLargeError(files)
    expect(result).toContain("1 KB")
  })
})
