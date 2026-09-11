import { describe, expect, test } from "bun:test"
import * as Fence from "../../src/server/fence"

describe("Fence.diff", () => {
  test("returns empty state when prev and next are identical", () => {
    const state: Record<string, number> = { a: 1, b: 2 }
    expect(Fence.diff(state, state)).toEqual({})
  })

  test("returns changed entries when values differ", () => {
    const prev: Record<string, number> = { a: 1, b: 2 }
    const next: Record<string, number> = { a: 1, b: 3 }
    const result = Fence.diff(prev, next)
    expect(result).toEqual({ b: 3 })
  })

  test("includes new keys with their value", () => {
    const prev: Record<string, number> = { a: 1 }
    const next: Record<string, number> = { a: 1, b: 5 }
    const result = Fence.diff(prev, next)
    expect(result).toEqual({ b: 5 })
  })

  test("treats missing keys in next as -1", () => {
    const prev: Record<string, number> = { a: 1, b: 2 }
    const next: Record<string, number> = { a: 1 }
    const result = Fence.diff(prev, next)
    expect(result).toEqual({ b: -1 })
  })

  test("handles both additions and removals", () => {
    const prev: Record<string, number> = { a: 1, b: 2 }
    const next: Record<string, number> = { a: 3, c: 4 }
    const result = Fence.diff(prev, next)
    expect(result).toEqual({ a: 3, b: -1, c: 4 })
  })

  test("returns empty for two empty states", () => {
    expect(Fence.diff({}, {})).toEqual({})
  })

  test("returns all entries from next when prev is empty", () => {
    const next: Record<string, number> = { a: 10, b: 20 }
    const result = Fence.diff({}, next)
    expect(result).toEqual({ a: 10, b: 20 })
  })

  test("returns all entries as -1 when next is empty", () => {
    const prev: Record<string, number> = { a: 10, b: 20 }
    const result = Fence.diff(prev, {})
    expect(result).toEqual({ a: -1, b: -1 })
  })

  test("handles value going to 0 correctly", () => {
    const prev: Record<string, number> = { a: 5 }
    const next: Record<string, number> = { a: 0 }
    const result = Fence.diff(prev, next)
    expect(result).toEqual({ a: 0 })
  })
})

describe("Fence.parse", () => {
  test("returns undefined when header is missing", () => {
    const headers = new Headers()
    expect(Fence.parse(headers)).toBeUndefined()
  })

  test("returns undefined when header is empty string", () => {
    const headers = new Headers({ "x-duoduo-sync": "" })
    expect(Fence.parse(headers)).toBeUndefined()
  })

  test("returns undefined for invalid JSON", () => {
    const headers = new Headers({ "x-duoduo-sync": "not-json" })
    expect(Fence.parse(headers)).toBeUndefined()
  })

  test("rejects array JSON input", () => {
    // Fixed: Fence.parse now rejects arrays via Array.isArray check
    const headers = new Headers({ "x-duoduo-sync": "[1,2,3]" })
    expect(Fence.parse(headers)).toBeUndefined()
  })

  test("returns undefined for non-object JSON (string)", () => {
    const headers = new Headers({ "x-duoduo-sync": '"hello"' })
    expect(Fence.parse(headers)).toBeUndefined()
  })

  test("returns undefined for non-object JSON (number)", () => {
    const headers = new Headers({ "x-duoduo-sync": "42" })
    expect(Fence.parse(headers)).toBeUndefined()
  })

  test("parses valid sync state", () => {
    const headers = new Headers({ "x-duoduo-sync": '{"a":1,"b":2}' })
    const result = Fence.parse(headers)
    expect(result).toEqual({ a: 1, b: 2 })
  })

  test("filters out non-integer values", () => {
    const headers = new Headers({ "x-duoduo-sync": '{"a":1,"b":2.5,"c":"hello","d":3}' })
    const result = Fence.parse(headers)
    expect(result).toEqual({ a: 1, d: 3 })
  })

  test("filters out non-string keys (edge case)", () => {
    const headers = new Headers({ "x-duoduo-sync": '{"a":1,"0":5}' })
    const result = Fence.parse(headers)
    expect(result).toEqual({ a: 1, "0": 5 })
  })

  test("handles empty object", () => {
    const headers = new Headers({ "x-duoduo-sync": "{}" })
    const result = Fence.parse(headers)
    expect(result).toEqual({})
  })

  test("handles zero as valid sequence number", () => {
    const headers = new Headers({ "x-duoduo-sync": '{"a":0}' })
    const result = Fence.parse(headers)
    expect(result).toEqual({ a: 0 })
  })

  test("handles negative integer as valid sequence number", () => {
    const headers = new Headers({ "x-duoduo-sync": '{"a":-1}' })
    const result = Fence.parse(headers)
    expect(result).toEqual({ a: -1 })
  })

  test("filters out null values", () => {
    const headers = new Headers({ "x-duoduo-sync": '{"a":null,"b":1}' })
    const result = Fence.parse(headers)
    expect(result).toEqual({ b: 1 })
  })

  test("filters out boolean values", () => {
    const headers = new Headers({ "x-duoduo-sync": '{"a":true,"b":1}' })
    const result = Fence.parse(headers)
    expect(result).toEqual({ b: 1 })
  })
})
