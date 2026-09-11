import { describe, expect, test } from "bun:test"
import { updateSchema } from "../../src/util/update-schema"
import { z } from "zod"

describe("util.update-schema", () => {
  test("accepts null for each field", () => {
    const original = z.object({
      name: z.string(),
      age: z.number(),
    })
    const update = updateSchema(original)

    const result = update.parse({ name: null, age: null })
    expect(result.name).toBeNull()
    expect(result.age).toBeNull()
  })

  test("accepts valid values", () => {
    const original = z.object({
      name: z.string(),
      age: z.number(),
    })
    const update = updateSchema(original)

    const result = update.parse({ name: "Alice", age: 30 })
    expect(result.name).toBe("Alice")
    expect(result.age).toBe(30)
  })

  // NOTE: This test documents a known bug (#10) in updateSchema:
  // In Zod v4, schema.required().shape returns ZodNonOptional wrappers,
  // and .nullable().optional() doesn't make fields truly optional.
  // Empty objects fail validation because inner ZodNonOptional rejects undefined.
  test("empty object fails validation (Zod v4 bug documented as #10)", () => {
    const original = z.object({
      name: z.string(),
      age: z.number(),
    })
    const update = updateSchema(original)

    // This SHOULD pass (fields should be optional), but currently fails
    // due to ZodNonOptional wrapper rejecting undefined.
    expect(() => update.parse({})).toThrow()
  })

  test("partial updates fail for missing fields (Zod v4 bug documented as #10)", () => {
    const original = z.object({
      name: z.string(),
      age: z.number(),
      active: z.boolean(),
    })
    const update = updateSchema(original)

    // This SHOULD pass, but currently fails due to ZodNonOptional
    expect(() => update.parse({ name: "Bob" })).toThrow()
  })

  test("preserves nested schema structure as nullable/optional", () => {
    const original = z.object({
      nested: z.object({ value: z.string() }),
    })
    const update = updateSchema(original)

    // nested field can be null
    const result = update.parse({ nested: null })
    expect(result.nested).toBeNull()
  })

  test("all fields accept null simultaneously", () => {
    const original = z.object({
      name: z.string(),
      age: z.number(),
      active: z.boolean(),
    })
    const update = updateSchema(original)

    const result = update.parse({ name: null, age: null, active: null })
    expect(result.name).toBeNull()
    expect(result.age).toBeNull()
    expect(result.active).toBeNull()
  })
})
