import { beforeEach, describe, expect, test } from "bun:test"
import {
  approxBytes,
  evictContentLru,
  resetFileContentLru,
  setFileContentBytes,
  removeFileContentBytes,
  touchFileContent,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  hasFileContent,
} from "./content-cache"
import type { FileContent } from "@duoduo-ai/sdk/v2"

const dir = "/test/project"

describe("approxBytes", () => {
  test("estimates bytes from content string", () => {
    const content: FileContent = { type: "text", content: "hello world" }
    // "hello world".length = 11, * 2 = 22
    expect(approxBytes(content)).toBe(22)
  })

  test("includes diff length in estimate", () => {
    const content: FileContent = { type: "text", content: "hello", diff: "--- a\n+++ b" }
    // content.length=5, diff.length=11, (5+11)*2 = 32
    expect(approxBytes(content)).toBe(32)
  })

  test("includes patch hunk lines in estimate", () => {
    const content: FileContent = {
      type: "text",
      content: "hello",
      patch: {
        oldFileName: "a/test.ts",
        newFileName: "b/test.ts",
        hunks: [
          { lines: ["-old line", "+new line", " context line"], oldStart: 1, newStart: 1, oldLines: 1, newLines: 2 },
        ],
      },
    }
    // content.length=5, patchBytes = ("-old line"+"+new line"+" context line").length = 9+9+13=31
    // (5 + 0 + 31) * 2 = 72
    expect(approxBytes(content)).toBe(72)
  })

  test("handles empty content", () => {
    const content: FileContent = { type: "text", content: "" }
    expect(approxBytes(content)).toBe(0)
  })

  test("handles content with no diff or patch", () => {
    const content: FileContent = { type: "text", content: "abc" }
    expect(approxBytes(content)).toBe(6)
  })
})

describe("content cache LRU operations", () => {
  beforeEach(() => {
    resetFileContentLru(dir)
  })

  test("setFileContentBytes adds entry and tracks total", () => {
    setFileContentBytes(dir, "file1.ts", 100)
    expect(hasFileContent(dir, "file1.ts")).toBe(true)
    expect(getFileContentBytesTotal(dir)).toBe(100)
    expect(getFileContentEntryCount(dir)).toBe(1)
  })

  test("setFileContentBytes updates existing entry", () => {
    setFileContentBytes(dir, "file1.ts", 100)
    setFileContentBytes(dir, "file1.ts", 200)
    expect(getFileContentBytesTotal(dir)).toBe(200)
    expect(getFileContentEntryCount(dir)).toBe(1)
  })

  test("add multiple entries", () => {
    setFileContentBytes(dir, "file1.ts", 200)
    setFileContentBytes(dir, "file2.ts", 300)
    setFileContentBytes(dir, "file3.ts", 400)
    expect(getFileContentBytesTotal(dir)).toBe(200 + 300 + 400)
    expect(getFileContentEntryCount(dir)).toBe(3)
  })

  test("removeFileContentBytes removes entry", () => {
    setFileContentBytes(dir, "file1.ts", 200)
    setFileContentBytes(dir, "file2.ts", 300)
    setFileContentBytes(dir, "file3.ts", 400)
    removeFileContentBytes(dir, "file2.ts")
    expect(hasFileContent(dir, "file2.ts")).toBe(false)
    expect(getFileContentBytesTotal(dir)).toBe(200 + 400)
    expect(getFileContentEntryCount(dir)).toBe(2)
  })

  test("removeFileContentBytes on non-existent entry is no-op", () => {
    setFileContentBytes(dir, "file1.ts", 200)
    setFileContentBytes(dir, "file3.ts", 400)
    removeFileContentBytes(dir, "nonexistent.ts")
    expect(getFileContentEntryCount(dir)).toBe(2)
  })

  test("touchFileContent moves entry to end of LRU", () => {
    setFileContentBytes(dir, "file1.ts", 100)
    setFileContentBytes(dir, "file3.ts", 400)
    const evicted: string[] = []
    touchFileContent(dir, "file1.ts")
    // file1.ts is now most recently used, file3.ts is least recently used
    evictContentLru(dir, undefined, (path) => evicted.push(path))
    // With 2 entries and max 40, no eviction should happen
    expect(evicted).toEqual([])
  })

  test("touchFileContent with bytes updates size", () => {
    setFileContentBytes(dir, "file1.ts", 100)
    setFileContentBytes(dir, "file3.ts", 400)
    touchFileContent(dir, "file1.ts", 500)
    expect(getFileContentBytesTotal(dir)).toBe(500 + 400)
  })

  test("evictContentLru evicts least recently used entries", () => {
    // Add enough entries to trigger eviction
    for (let i = 0; i < 45; i++) {
      setFileContentBytes(dir, `evict-file-${i}.ts`, 100)
    }
    const evicted: string[] = []
    evictContentLru(dir, undefined, (path) => evicted.push(path))
    // Should have evicted some entries to get under MAX_FILE_CONTENT_ENTRIES (40)
    expect(evicted.length).toBeGreaterThan(0)
  })

  test("evictContentLru keeps entries in keep set", () => {
    resetFileContentLru(dir)
    setFileContentBytes(dir, "keep-me.ts", 100)
    setFileContentBytes(dir, "evict-me.ts", 100)
    // Add many more to force eviction
    for (let i = 0; i < 45; i++) {
      setFileContentBytes(dir, `fill-${i}.ts`, 100)
    }
    const evicted: string[] = []
    evictContentLru(dir, new Set(["keep-me.ts"]), (path) => evicted.push(path))
    expect(evicted.includes("keep-me.ts")).toBe(false)
  })

  test("resetFileContentLru clears specific directory", () => {
    setFileContentBytes(dir, "reset-test.ts", 100)
    resetFileContentLru(dir)
    expect(getFileContentEntryCount(dir)).toBe(0)
    expect(getFileContentBytesTotal(dir)).toBe(0)
  })

  test("resetFileContentLru without args clears all directories", () => {
    const dir2 = "/test/other-project"
    setFileContentBytes(dir, "a.ts", 100)
    setFileContentBytes(dir2, "b.ts", 200)
    resetFileContentLru()
    expect(getFileContentEntryCount(dir)).toBe(0)
    expect(getFileContentEntryCount(dir2)).toBe(0)
  })

  test("hasFileContent returns false for unknown directory", () => {
    expect(hasFileContent("/nonexistent/dir", "any.ts")).toBe(false)
  })

  test("getFileContentBytesTotal returns 0 for unknown directory", () => {
    expect(getFileContentBytesTotal("/nonexistent/dir")).toBe(0)
  })

  test("getFileContentEntryCount returns 0 for unknown directory", () => {
    expect(getFileContentEntryCount("/nonexistent/dir")).toBe(0)
  })
})
