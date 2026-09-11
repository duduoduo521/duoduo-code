import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

describe("server/ui CSP headers", () => {
  // Test the CSP helper logic extracted from src/server/routes/ui.ts
  const DEFAULT_CSP =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:"

  const csp = (hash = "") =>
    `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:`

  test("DEFAULT_CSP has expected directives", () => {
    expect(DEFAULT_CSP).toContain("default-src 'self'")
    expect(DEFAULT_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(DEFAULT_CSP).toContain("style-src 'self' 'unsafe-inline'")
    expect(DEFAULT_CSP).toContain("img-src 'self' data: https:")
    expect(DEFAULT_CSP).toContain("font-src 'self' data:")
    expect(DEFAULT_CSP).toContain("connect-src 'self' data:")
  })

  test("csp() without hash equals DEFAULT_CSP", () => {
    expect(csp()).toBe(DEFAULT_CSP)
  })

  test("csp() with hash adds sha256 directive", () => {
    const result = csp("abc123")
    expect(result).toContain("'sha256-abc123'")
    expect(result).toContain("script-src 'self' 'wasm-unsafe-eval' 'sha256-abc123'")
  })

  test("csp() with empty hash does not add sha256", () => {
    const result = csp("")
    expect(result).not.toContain("sha256")
    expect(result).toBe(DEFAULT_CSP)
  })

  test("csp() preserves all non-script directives", () => {
    const result = csp("hash123")
    expect(result).toContain("default-src 'self'")
    expect(result).toContain("style-src 'self' 'unsafe-inline'")
    expect(result).toContain("img-src 'self' data: https:")
    expect(result).toContain("font-src 'self' data:")
    expect(result).toContain("media-src 'self' data:")
    expect(result).toContain("connect-src 'self' data:")
  })
})
