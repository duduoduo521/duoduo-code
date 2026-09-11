import { describe, expect, test } from "bun:test"
import {
  ACCEPTED_IMAGE_TYPES,
  ACCEPTED_FILE_TYPES,
  ACCEPTED_FILE_EXTENSIONS,
  filePickerFilters,
} from "./file-picker"

describe("ACCEPTED_IMAGE_TYPES", () => {
  test("contains expected image MIME types", () => {
    expect(ACCEPTED_IMAGE_TYPES).toContain("image/png")
    expect(ACCEPTED_IMAGE_TYPES).toContain("image/jpeg")
    expect(ACCEPTED_IMAGE_TYPES).toContain("image/gif")
    expect(ACCEPTED_IMAGE_TYPES).toContain("image/webp")
  })
})

describe("ACCEPTED_FILE_TYPES", () => {
  test("includes all image types", () => {
    for (const type of ACCEPTED_IMAGE_TYPES) {
      expect(ACCEPTED_FILE_TYPES).toContain(type)
    }
  })

  test("includes common document types", () => {
    expect(ACCEPTED_FILE_TYPES).toContain("application/pdf")
    expect(ACCEPTED_FILE_TYPES).toContain("application/json")
  })

  test("includes text wildcard", () => {
    expect(ACCEPTED_FILE_TYPES).toContain("text/*")
  })

  test("includes file extension entries starting with dot", () => {
    const dotEntries = ACCEPTED_FILE_TYPES.filter((t) => t.startsWith("."))
    expect(dotEntries.length).toBeGreaterThan(0)
    expect(dotEntries).toContain(".ts")
    expect(dotEntries).toContain(".tsx")
  })
})

describe("ACCEPTED_FILE_EXTENSIONS", () => {
  test("is sorted alphabetically", () => {
    for (let i = 1; i < ACCEPTED_FILE_EXTENSIONS.length; i++) {
      expect(ACCEPTED_FILE_EXTENSIONS[i]! >= ACCEPTED_FILE_EXTENSIONS[i - 1]!).toBe(true)
    }
  })

  test("contains no duplicates", () => {
    const set = new Set(ACCEPTED_FILE_EXTENSIONS)
    expect(set.size).toBe(ACCEPTED_FILE_EXTENSIONS.length)
  })

  test("contains no leading dots", () => {
    for (const ext of ACCEPTED_FILE_EXTENSIONS) {
      expect(ext).not.toMatch(/^\./)
    }
  })

  test("contains extensions derived from MIME map", () => {
    expect(ACCEPTED_FILE_EXTENSIONS).toContain("png")
    expect(ACCEPTED_FILE_EXTENSIONS).toContain("jpg")
    expect(ACCEPTED_FILE_EXTENSIONS).toContain("pdf")
    expect(ACCEPTED_FILE_EXTENSIONS).toContain("json")
  })

  test("contains extensions derived from dot-prefixed entries", () => {
    expect(ACCEPTED_FILE_EXTENSIONS).toContain("ts")
    expect(ACCEPTED_FILE_EXTENSIONS).toContain("tsx")
    expect(ACCEPTED_FILE_EXTENSIONS).toContain("py")
  })

  test("contains text/* derived extensions", () => {
    expect(ACCEPTED_FILE_EXTENSIONS).toContain("txt")
    expect(ACCEPTED_FILE_EXTENSIONS).toContain("md")
    expect(ACCEPTED_FILE_EXTENSIONS).toContain("csv")
  })
})

describe("filePickerFilters", () => {
  test("returns filter with extensions when provided", () => {
    expect(filePickerFilters(["ts", "tsx"])).toEqual([
      { name: "Files", extensions: ["ts", "tsx"] },
    ])
  })

  test("returns undefined when no extensions provided", () => {
    expect(filePickerFilters()).toBeUndefined()
  })

  test("returns undefined when empty array provided", () => {
    expect(filePickerFilters([])).toBeUndefined()
  })

  test("returns single extension filter", () => {
    expect(filePickerFilters(["pdf"])).toEqual([{ name: "Files", extensions: ["pdf"] }])
  })

  test("uses ACCEPTED_FILE_EXTENSIONS with the filter", () => {
    const result = filePickerFilters(ACCEPTED_FILE_EXTENSIONS)
    expect(result).toEqual([{ name: "Files", extensions: ACCEPTED_FILE_EXTENSIONS }])
  })
})
