import { afterEach, describe, expect, test } from "bun:test"
import {
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
} from "./file/content-cache"

const DIR = "/test-project"

describe("file content eviction accounting", () => {
  afterEach(() => {
    resetFileContentLru()
  })

  test("updates byte totals incrementally for set, overwrite, remove, and reset", () => {
    setFileContentBytes(DIR, "a", 10)
    setFileContentBytes(DIR, "b", 15)
    expect(getFileContentBytesTotal(DIR)).toBe(25)
    expect(getFileContentEntryCount(DIR)).toBe(2)

    setFileContentBytes(DIR, "a", 5)
    expect(getFileContentBytesTotal(DIR)).toBe(20)
    expect(getFileContentEntryCount(DIR)).toBe(2)

    touchFileContent(DIR, "a")
    expect(getFileContentBytesTotal(DIR)).toBe(20)

    removeFileContentBytes(DIR, "b")
    expect(getFileContentBytesTotal(DIR)).toBe(5)
    expect(getFileContentEntryCount(DIR)).toBe(1)

    resetFileContentLru()
    expect(getFileContentBytesTotal(DIR)).toBe(0)
    expect(getFileContentEntryCount(DIR)).toBe(0)
  })

  test("evicts by entry cap using LRU order", () => {
    for (const i of Array.from({ length: 41 }, (_, n) => n)) {
      setFileContentBytes(DIR, `f-${i}`, 1)
    }

    const evicted: string[] = []
    evictContentLru(DIR, undefined, (path) => evicted.push(path))

    expect(evicted).toEqual(["f-0"])
    expect(getFileContentEntryCount(DIR)).toBe(40)
    expect(getFileContentBytesTotal(DIR)).toBe(40)
  })

  test("evicts by byte cap while preserving protected entries", () => {
    const chunk = 8 * 1024 * 1024
    setFileContentBytes(DIR, "a", chunk)
    setFileContentBytes(DIR, "b", chunk)
    setFileContentBytes(DIR, "c", chunk)

    const evicted: string[] = []
    evictContentLru(DIR, new Set(["a"]), (path) => evicted.push(path))

    expect(evicted).toEqual(["b"])
    expect(getFileContentEntryCount(DIR)).toBe(2)
    expect(getFileContentBytesTotal(DIR)).toBe(chunk * 2)
  })

  test("isolates caches per directory", () => {
    setFileContentBytes("/project-a", "a", 10)
    setFileContentBytes("/project-b", "a", 20)

    expect(getFileContentBytesTotal("/project-a")).toBe(10)
    expect(getFileContentBytesTotal("/project-b")).toBe(20)

    resetFileContentLru("/project-a")
    expect(getFileContentEntryCount("/project-a")).toBe(0)
    expect(getFileContentEntryCount("/project-b")).toBe(1)
  })
})
