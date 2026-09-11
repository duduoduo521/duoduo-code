import { describe, expect, test } from "bun:test"
import { formatErrorMessage } from "./format-error-message"

// Used by dialog-open-project / dialog-remote-directory, which read the 400 body
// of the project + mcp routes. Those handlers return the declared BadRequestError
// shape, so the text arrives nested at data.error.
const badRequest = { data: { error: "Failed to connect remote project: auth failed" }, errors: [], success: false }

describe("formatErrorMessage", () => {
  test("returns Error.message", () => {
    expect(formatErrorMessage(new Error("boom"))).toBe("boom")
  })

  test("returns strings unchanged", () => {
    expect(formatErrorMessage("plain text")).toBe("plain text")
  })

  test("unwraps a legacy bare { error } body", () => {
    expect(formatErrorMessage({ error: "legacy shape" })).toBe("legacy shape")
  })

  test("unwraps the declared 400 body (data.error)", () => {
    expect(formatErrorMessage(badRequest)).toBe("Failed to connect remote project: auth failed")
  })

  test("falls back to a message field", () => {
    expect(formatErrorMessage({ message: "from message" })).toBe("from message")
  })

  test("stringifies an opaque object instead of rendering [object Object]", () => {
    expect(formatErrorMessage({ foo: 1 })).toBe('{"foo":1}')
  })

  test("stringifies null and undefined rather than throwing", () => {
    expect(formatErrorMessage(null)).toBe("null")
    expect(formatErrorMessage(undefined)).toBe("undefined")
  })

  test("survives circular references", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(formatErrorMessage(circular)).toBe(String(circular))
  })
})
