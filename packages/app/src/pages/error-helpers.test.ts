import { describe, expect, test } from "bun:test"

// Pure functions extracted from error.tsx — not exported, replicated for testing

function isIssue(value: unknown): value is { message: string; path: string[] } {
  if (!value || typeof value !== "object") return false
  if (!("message" in value) || !("path" in value)) return false
  const message = (value as { message: unknown }).message
  const path = (value as { path: unknown }).path
  if (typeof message !== "string") return false
  if (!Array.isArray(path)) return false
  return path.every((part) => typeof part === "string")
}

function isInitError(error: unknown): error is { name: string; data: Record<string, unknown> } {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    "data" in error &&
    typeof (error as { data: unknown }).data === "object"
  )
}

function safeJson(value: unknown, circular: string): string {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === "bigint") return val.toString()
      if (typeof val === "object" && val) {
        if (seen.has(val)) return circular
        seen.add(val)
      }
      return val
    },
    2,
  )
  return json ?? String(value)
}

describe("isIssue", () => {
  test("returns true for valid issue object", () => {
    expect(isIssue({ message: "test", path: ["a", "b"] })).toBe(true)
  })

  test("returns false for null", () => {
    expect(isIssue(null)).toBe(false)
  })

  test("returns false for non-object", () => {
    expect(isIssue("string")).toBe(false)
  })

  test("returns false when message is missing", () => {
    expect(isIssue({ path: ["a"] })).toBe(false)
  })

  test("returns false when path is missing", () => {
    expect(isIssue({ message: "test" })).toBe(false)
  })

  test("returns false when message is not string", () => {
    expect(isIssue({ message: 42, path: ["a"] })).toBe(false)
  })

  test("returns false when path is not array", () => {
    expect(isIssue({ message: "test", path: "a.b" })).toBe(false)
  })

  test("returns false when path contains non-string", () => {
    expect(isIssue({ message: "test", path: ["a", 42] })).toBe(false)
  })

  test("returns true for empty path array", () => {
    expect(isIssue({ message: "test", path: [] })).toBe(true)
  })
})

describe("isInitError", () => {
  test("returns true for valid init error", () => {
    expect(isInitError({ name: "TestError", data: { key: "value" } })).toBe(true)
  })

  test("returns false for null", () => {
    expect(isInitError(null)).toBe(false)
  })

  test("returns false for non-object", () => {
    expect(isInitError("error")).toBe(false)
  })

  test("returns false when name is missing", () => {
    expect(isInitError({ data: {} })).toBe(false)
  })

  test("returns false when data is missing", () => {
    expect(isInitError({ name: "TestError" })).toBe(false)
  })

  test("returns false when data is not object", () => {
    expect(isInitError({ name: "TestError", data: "string" })).toBe(false)
  })

  test("returns true when data is null (typeof null === object in JS)", () => {
    // typeof null === "object" in JavaScript, so this is a valid InitError
    expect(isInitError({ name: "TestError", data: null })).toBe(true)
  })

  test("returns true when data is empty object", () => {
    expect(isInitError({ name: "TestError", data: {} })).toBe(true)
  })
})

describe("safeJson", () => {
  test("serializes simple object", () => {
    expect(safeJson({ a: 1 }, "circular")).toBe('{\n  "a": 1\n}')
  })

  test("handles circular references", () => {
    const obj: any = { name: "root" }
    obj.self = obj
    const result = safeJson(obj, "CIRCULAR")
    expect(result).toContain("CIRCULAR")
  })

  test("handles bigint", () => {
    expect(safeJson({ big: BigInt(123) }, "circular")).toBe('{\n  "big": "123"\n}')
  })

  test("returns string representation for non-serializable", () => {
    const result = safeJson(undefined, "circular")
    expect(result).toBe("undefined")
  })

  test("handles arrays", () => {
    expect(safeJson([1, 2, 3], "circular")).toBe("[\n  1,\n  2,\n  3\n]")
  })

  test("handles nested objects", () => {
    const result = safeJson({ a: { b: 1 } }, "circular")
    expect(result).toContain('"b"')
  })
})
