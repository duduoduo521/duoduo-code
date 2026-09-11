import { describe, expect, test } from "bun:test"

// The following pure functions are defined inside error.tsx but not exported.
// We replicate the logic here for testing (same pattern as debug-bar.test.ts).

const CHAIN_SEPARATOR = "\n" + "─".repeat(40) + "\n"

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
    expect(isIssue({ message: "err", path: ["a", "b"] })).toBe(true)
  })

  test("returns true for issue with empty path", () => {
    expect(isIssue({ message: "err", path: [] })).toBe(true)
  })

  test("returns false for null", () => {
    expect(isIssue(null)).toBe(false)
  })

  test("returns false for undefined", () => {
    expect(isIssue(undefined)).toBe(false)
  })

  test("returns false for non-object", () => {
    expect(isIssue("string")).toBe(false)
    expect(isIssue(42)).toBe(false)
  })

  test("returns false when message is missing", () => {
    expect(isIssue({ path: ["a"] })).toBe(false)
  })

  test("returns false when path is missing", () => {
    expect(isIssue({ message: "err" })).toBe(false)
  })

  test("returns false when message is not a string", () => {
    expect(isIssue({ message: 42, path: ["a"] })).toBe(false)
  })

  test("returns false when path is not an array", () => {
    expect(isIssue({ message: "err", path: "a.b" })).toBe(false)
  })

  test("returns false when path contains non-string elements", () => {
    expect(isIssue({ message: "err", path: ["a", 42] })).toBe(false)
  })
})

describe("isInitError", () => {
  test("returns true for valid init error", () => {
    expect(isInitError({ name: "MCPFailed", data: { name: "mcp1" } })).toBe(true)
  })

  test("returns true for init error with empty data", () => {
    expect(isInitError({ name: "UnknownError", data: {} })).toBe(true)
  })

  test("returns true for init error with null data", () => {
    expect(isInitError({ name: "UnknownError", data: null })).toBe(true)
  })

  test("returns false for null", () => {
    expect(isInitError(null)).toBe(false)
  })

  test("returns false for undefined", () => {
    expect(isInitError(undefined)).toBe(false)
  })

  test("returns false for non-object", () => {
    expect(isInitError("string")).toBe(false)
  })

  test("returns false when name is missing", () => {
    expect(isInitError({ data: {} })).toBe(false)
  })

  test("returns false when data is missing", () => {
    expect(isInitError({ name: "MCPFailed" })).toBe(false)
  })

  test("returns false when data is a string", () => {
    expect(isInitError({ name: "MCPFailed", data: "not an object" })).toBe(false)
  })
})

describe("safeJson", () => {
  test("serializes simple object", () => {
    expect(safeJson({ a: 1 }, "[circular]")).toBe('{\n  "a": 1\n}')
  })

  test("serializes string", () => {
    expect(safeJson("hello", "[circular]")).toBe('"hello"')
  })

  test("serializes number", () => {
    expect(safeJson(42, "[circular]")).toBe("42")
  })

  test("handles bigint by converting to string", () => {
    expect(safeJson({ n: BigInt(9007199254740991) }, "[circular]")).toBe(
      '{\n  "n": "9007199254740991"\n}',
    )
  })

  test("handles circular references", () => {
    const obj: { self?: unknown } = {}
    obj.self = obj
    const result = safeJson(obj, "[circular]")
    expect(result).toContain("[circular]")
  })

  test("handles null", () => {
    expect(safeJson(null, "[circular]")).toBe("null")
  })

  test("handles undefined by returning string representation", () => {
    // JSON.stringify(undefined) returns undefined, so fallback to String(undefined)
    expect(safeJson(undefined, "[circular]")).toBe("undefined")
  })

  test("handles nested objects", () => {
    const result = safeJson({ a: { b: 2 } }, "[circular]")
    expect(result).toContain('"b"')
    expect(result).toContain("2")
  })

  test("handles arrays", () => {
    expect(safeJson([1, 2, 3], "[circular]")).toBe("[\n  1,\n  2,\n  3\n]")
  })
})
