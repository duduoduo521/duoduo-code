import { describe, expect, test } from "bun:test"
import { fn } from "../../src/util/fn"
import { z } from "zod"

describe("util.fn", () => {
  test("calls callback with parsed input", () => {
    const add = fn(z.tuple([z.number(), z.number()]), ([a, b]) => a + b)
    expect(add([1, 2])).toBe(3)
  })

  test("throws on invalid input", () => {
    const add = fn(z.tuple([z.number(), z.number()]), ([a, b]) => a + b)
    expect(() => add(["a", "b"] as any)).toThrow()
  })

  test("exposes force method that skips validation", () => {
    const add = fn(z.tuple([z.number(), z.number()]), ([a, b]) => a + b)
    // force bypasses schema.parse — we pass raw values directly
    expect(add.force([1, 2] as any)).toBe(3)
  })

  test("exposes schema property", () => {
    const schema = z.string()
    const upper = fn(schema, (s) => s.toUpperCase())
    expect(upper.schema).toBe(schema)
  })

  test("preserves return value type", () => {
    const getLength = fn(z.string(), (s) => s.length)
    expect(getLength("hello")).toBe(5)
  })

  test("handles object schema", () => {
    const greet = fn(z.object({ name: z.string() }), ({ name }) => `Hello, ${name}!`)
    expect(greet({ name: "World" })).toBe("Hello, World!")
  })
})
