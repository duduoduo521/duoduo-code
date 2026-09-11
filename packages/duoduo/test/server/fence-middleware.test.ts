import { describe, expect, test } from "bun:test"

// Replicate the FenceMiddleware skip logic for unit testing.
// The middleware skips fence processing for GET, HEAD, and OPTIONS requests.

function shouldSkipFence(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS"
}

describe("Fence.FenceMiddleware.skipLogic", () => {
  test("skips GET requests", () => {
    expect(shouldSkipFence("GET")).toBe(true)
  })

  test("skips HEAD requests", () => {
    expect(shouldSkipFence("HEAD")).toBe(true)
  })

  test("skips OPTIONS requests", () => {
    expect(shouldSkipFence("OPTIONS")).toBe(true)
  })

  test("does NOT skip POST requests", () => {
    expect(shouldSkipFence("POST")).toBe(false)
  })

  test("does NOT skip PUT requests", () => {
    expect(shouldSkipFence("PUT")).toBe(false)
  })

  test("does NOT skip PATCH requests", () => {
    expect(shouldSkipFence("PATCH")).toBe(false)
  })

  test("does NOT skip DELETE requests", () => {
    expect(shouldSkipFence("DELETE")).toBe(false)
  })

  test("is case-sensitive — lowercase 'get' is NOT skipped", () => {
    expect(shouldSkipFence("get")).toBe(false)
  })
})
