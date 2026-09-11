import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { namedSchemaError } from "../../src/util/named-schema-error"

describe("util.named-schema-error", () => {
  test("creates error class with correct tag", () => {
    const TestError = namedSchemaError("TestError", {
      code: Schema.String,
    })
    expect(TestError.tag).toBe("TestError")
    expect(TestError.name).toBe("TestError")
  })

  test("instance has correct name property", () => {
    const TestError = namedSchemaError("TestError", {
      code: Schema.String,
    })
    const err = new TestError({ code: "E_TEST" })
    expect(err.name).toBe("TestError")
  })

  test("instance has data property", () => {
    const TestError = namedSchemaError("TestError", {
      code: Schema.String,
    })
    const err = new TestError({ code: "E_TEST" })
    expect(err.data).toEqual({ code: "E_TEST" })
  })

  test("toObject returns name and data", () => {
    const TestError = namedSchemaError("TestError", {
      code: Schema.String,
      message: Schema.String,
    })
    const err = new TestError({ code: "E_TEST", message: "something failed" })
    expect(err.toObject()).toEqual({
      name: "TestError",
      data: { code: "E_TEST", message: "something failed" },
    })
  })

  test("isInstance returns true for matching name", () => {
    const TestError = namedSchemaError("TestError", {
      code: Schema.String,
    })
    const err = new TestError({ code: "E_TEST" })
    expect(TestError.isInstance(err)).toBe(true)
  })

  test("isInstance returns false for non-matching name", () => {
    const TestError = namedSchemaError("TestError", {
      code: Schema.String,
    })
    const OtherError = namedSchemaError("OtherError", {
      code: Schema.String,
    })
    const err = new OtherError({ code: "E_OTHER" })
    expect(TestError.isInstance(err)).toBe(false)
  })

  test("isInstance returns false for non-objects", () => {
    const TestError = namedSchemaError("TestError", {
      code: Schema.String,
    })
    expect(TestError.isInstance(null)).toBe(false)
    expect(TestError.isInstance(undefined)).toBe(false)
    expect(TestError.isInstance("string")).toBe(false)
  })

  test("static Schema is a Zod schema", () => {
    const TestError = namedSchemaError("TestError", {
      code: Schema.String,
    })
    expect(TestError.Schema).toBeDefined()
    expect(typeof TestError.Schema.parse).toBe("function")
  })

  test("accepts cause option", () => {
    const TestError = namedSchemaError("TestError", {
      code: Schema.String,
    })
    const cause = new Error("root cause")
    const err = new TestError({ code: "E_TEST" }, { cause })
    expect(err.cause).toBe(cause)
  })
})
