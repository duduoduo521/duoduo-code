import { describe, expect, test } from "bun:test"

// formatError from dialog-connect-provider.tsx — not exported, replicated here for testing
function formatError(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "data" in value) {
    const data = (value as { data?: { message?: unknown } }).data
    if (typeof data?.message === "string" && data.message) return data.message
  }
  if (value && typeof value === "object" && "error" in value) {
    const nested = formatError((value as { error?: unknown }).error, "")
    if (nested) return nested
  }
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  if (value instanceof Error && value.message) return value.message
  if (typeof value === "string" && value) return value
  return fallback
}

describe("formatError (dialog-connect-provider)", () => {
  test("extracts message from data.message", () => {
    expect(formatError({ data: { message: "API error" } }, "fallback")).toBe("API error")
  })

  test("returns fallback when data.message is empty string", () => {
    expect(formatError({ data: { message: "" } }, "fallback")).toBe("fallback")
  })

  test("returns fallback when data.message is not string", () => {
    expect(formatError({ data: { message: 42 } }, "fallback")).toBe("fallback")
  })

  test("extracts nested error recursively", () => {
    expect(formatError({ error: { message: "inner error" } }, "fallback")).toBe("inner error")
  })

  test("extracts deeply nested error", () => {
    expect(
      formatError({ error: { error: { data: { message: "deep error" } } } }, "fallback"),
    ).toBe("deep error")
  })

  test("extracts message from object with message property", () => {
    expect(formatError({ message: "object error" }, "fallback")).toBe("object error")
  })

  test("returns fallback when message is empty", () => {
    expect(formatError({ message: "" }, "fallback")).toBe("fallback")
  })

  test("extracts message from Error instance", () => {
    expect(formatError(new Error("error message"), "fallback")).toBe("error message")
  })

  test("returns string value directly", () => {
    expect(formatError("string error", "fallback")).toBe("string error")
  })

  test("returns fallback for empty string", () => {
    expect(formatError("", "fallback")).toBe("fallback")
  })

  test("returns fallback for null", () => {
    expect(formatError(null, "fallback")).toBe("fallback")
  })

  test("returns fallback for undefined", () => {
    expect(formatError(undefined, "fallback")).toBe("fallback")
  })

  test("returns fallback for number", () => {
    expect(formatError(42, "fallback")).toBe("fallback")
  })

  test("prioritizes data.message over message property", () => {
    expect(formatError({ data: { message: "from data" }, message: "from message" }, "fallback")).toBe(
      "from data",
    )
  })

  test("handles error with empty message", () => {
    const err = new Error("")
    expect(formatError(err, "fallback")).toBe("fallback")
  })
})
