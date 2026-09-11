import { describe, expect, test } from "bun:test"
import { ERRORS, errors } from "../../src/server/error"

describe("errors", () => {
  test("returns requested error codes", () => {
    const result = errors(400, 404)
    expect(Object.keys(result)).toEqual(["400", "404"])
    expect(result[400]).toBe(ERRORS[400])
    expect(result[404]).toBe(ERRORS[404])
  })

  test("returns single error code", () => {
    const result = errors(400)
    expect(Object.keys(result)).toEqual(["400"])
    expect(result[400]).toBe(ERRORS[400])
  })

  test("returns empty object for no codes", () => {
    const result = errors()
    expect(result).toEqual({})
  })

  test("400 error has correct structure", () => {
    expect(ERRORS[400].description).toBe("Bad request")
    expect(ERRORS[400].content["application/json"].schema).toBeDefined()
  })

  test("404 error has correct structure", () => {
    expect(ERRORS[404].description).toBe("Not found")
    expect(ERRORS[404].content["application/json"].schema).toBeDefined()
  })

  test("unknown codes return undefined entries", () => {
    const result = errors(500)
    expect(result[500]).toBeUndefined()
  })
})
