import { describe, expect, test } from "bun:test"
import { errorMessage } from "./error-message"

describe("errorMessage", () => {
  test("returns error.message for Error instances", () => {
    expect(errorMessage(new Error("something went wrong"), "fallback")).toBe("something went wrong")
  })

  test("returns error.message for Error with empty string (falls through)", () => {
    // Error.message is "" — falsy, so it should NOT match the first branch
    expect(errorMessage(new Error(""), "fallback")).toBe("fallback")
  })

  test("returns string error directly", () => {
    expect(errorMessage("plain error string", "fallback")).toBe("plain error string")
  })

  test("returns fallback for empty string", () => {
    expect(errorMessage("", "fallback")).toBe("fallback")
  })

  test("extracts data.message from backend NamedError format", () => {
    const error = { name: "SomeError", data: { message: "detailed error" } }
    expect(errorMessage(error, "fallback")).toBe("detailed error")
  })

  test("extracts data.error from backend object when data.message is absent", () => {
    const error = { name: "SomeError", data: { error: "data-level error" } }
    expect(errorMessage(error, "fallback")).toBe("data-level error")
  })

  test("prefers data.message over data.error", () => {
    const error = { name: "SomeError", data: { message: "from message", error: "from error" } }
    expect(errorMessage(error, "fallback")).toBe("from message")
  })

  test("extracts direct error field from object", () => {
    const error = { error: "direct error" }
    expect(errorMessage(error, "fallback")).toBe("direct error")
  })

  test("extracts the message from a 400 BadRequestError body", () => {
    // `errors(400)` declares `{ data, errors, success: false }`; handlers build it
    // with badRequest(), which places the text at data.error.
    const error = {
      data: { error: "Failed to push to remote: permission denied" },
      errors: [],
      success: false,
    }
    expect(errorMessage(error, "fallback")).toBe("Failed to push to remote: permission denied")
  })

  test("extracts message field from object as fallback", () => {
    const error = { message: "object message" }
    expect(errorMessage(error, "fallback")).toBe("object message")
  })

  test("extracts name field from object as further fallback", () => {
    const error = { name: "UnknownError" }
    expect(errorMessage(error, "fallback")).toBe("UnknownError")
  })

  test("stringifies object as last resort", () => {
    const error = { custom: "value", count: 42 }
    const result = errorMessage(error, "fallback")
    expect(result).toBe('{"custom":"value","count":42}')
  })

  test("returns fallback for empty object {}", () => {
    expect(errorMessage({}, "fallback")).toBe("fallback")
  })

  test("returns fallback for null", () => {
    expect(errorMessage(null, "fallback")).toBe("fallback")
  })

  test("returns fallback for undefined", () => {
    expect(errorMessage(undefined, "fallback")).toBe("fallback")
  })

  test("returns fallback for number", () => {
    expect(errorMessage(42, "fallback")).toBe("fallback")
  })

  test("returns fallback for boolean", () => {
    expect(errorMessage(true, "fallback")).toBe("fallback")
  })

  test("returns fallback for array", () => {
    expect(errorMessage([1, 2, 3], "fallback")).toBe("fallback")
  })

  test("prefers data.message over top-level error", () => {
    const error = { data: { message: "from data.message" }, error: "from error" }
    expect(errorMessage(error, "fallback")).toBe("from data.message")
  })

  test("prefers top-level error over message", () => {
    const error = { error: "from error", message: "from message" }
    expect(errorMessage(error, "fallback")).toBe("from error")
  })

  test("prefers message over name", () => {
    const error = { message: "from message", name: "SomeError" }
    expect(errorMessage(error, "fallback")).toBe("from message")
  })

  test("handles data as non-object gracefully", () => {
    const error = { data: "not-an-object" }
    // data is not an object, so falls through to stringify as last resort
    expect(errorMessage(error, "fallback")).toBe('{"data":"not-an-object"}')
  })

  test("handles circular references in object by returning fallback", () => {
    const error: Record<string, unknown> = {}
    error.self = error
    // JSON.stringify on circular throws, caught silently, returns fallback
    expect(errorMessage(error, "fallback")).toBe("fallback")
  })
})
