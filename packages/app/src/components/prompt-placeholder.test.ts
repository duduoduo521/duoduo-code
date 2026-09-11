import { describe, expect, test } from "bun:test"
import { promptPlaceholder } from "./prompt-input/placeholder"

describe("promptPlaceholder", () => {
  const t = (key: string, params?: Record<string, string>) => {
    if (params) return `${key}:${JSON.stringify(params)}`
    return key
  }

  test("returns shell placeholder for shell mode", () => {
    expect(promptPlaceholder({ mode: "shell", commentCount: 0, example: "", suggest: false, t })).toBe(
      "prompt.placeholder.shell",
    )
  })

  test("shell mode ignores other parameters", () => {
    expect(promptPlaceholder({ mode: "shell", commentCount: 5, example: "ex", suggest: true, t })).toBe(
      "prompt.placeholder.shell",
    )
  })

  test("returns summarizeComments for multiple comments", () => {
    expect(promptPlaceholder({ mode: "normal", commentCount: 3, example: "", suggest: false, t })).toBe(
      "prompt.placeholder.summarizeComments",
    )
  })

  test("returns summarizeComment for single comment", () => {
    expect(promptPlaceholder({ mode: "normal", commentCount: 1, example: "", suggest: false, t })).toBe(
      "prompt.placeholder.summarizeComment",
    )
  })

  test("returns simple placeholder when suggest is false and no comments", () => {
    expect(promptPlaceholder({ mode: "normal", commentCount: 0, example: "ex", suggest: false, t })).toBe(
      "prompt.placeholder.simple",
    )
  })

  test("returns normal placeholder with example when suggest is true", () => {
    const result = promptPlaceholder({ mode: "normal", commentCount: 0, example: "hello world", suggest: true, t })
    expect(result).toContain("prompt.placeholder.normal")
    expect(result).toContain("hello world")
  })

  test("prioritizes shell mode over comments", () => {
    expect(promptPlaceholder({ mode: "shell", commentCount: 1, example: "", suggest: false, t })).toBe(
      "prompt.placeholder.shell",
    )
  })

  test("prioritizes comments over suggest", () => {
    expect(promptPlaceholder({ mode: "normal", commentCount: 2, example: "ex", suggest: true, t })).toBe(
      "prompt.placeholder.summarizeComments",
    )
  })

  test("prioritizes single comment over suggest", () => {
    expect(promptPlaceholder({ mode: "normal", commentCount: 1, example: "ex", suggest: true, t })).toBe(
      "prompt.placeholder.summarizeComment",
    )
  })
})
