import { describe, expect, test } from "bun:test"

// Replicate the CSP (Content-Security-Policy) logic from routes/ui.ts for unit testing.
// These are pure string-formatting functions.

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:"

const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:`

describe("UIRoutes.csp", () => {
  test("DEFAULT_CSP has expected directives", () => {
    expect(DEFAULT_CSP).toContain("default-src 'self'")
    expect(DEFAULT_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(DEFAULT_CSP).toContain("style-src 'self' 'unsafe-inline'")
    expect(DEFAULT_CSP).toContain("img-src 'self' data: https:")
    expect(DEFAULT_CSP).toContain("font-src 'self' data:")
    expect(DEFAULT_CSP).toContain("media-src 'self' data:")
    expect(DEFAULT_CSP).toContain("connect-src 'self' data:")
  })

  test("csp() without hash matches DEFAULT_CSP", () => {
    expect(csp()).toBe(DEFAULT_CSP)
  })

  test("csp() with empty string matches DEFAULT_CSP", () => {
    expect(csp("")).toBe(DEFAULT_CSP)
  })

  test("csp() with hash appends sha256 directive to script-src", () => {
    const result = csp("abc123")
    expect(result).toContain("'sha256-abc123'")
    expect(result).toContain("script-src 'self' 'wasm-unsafe-eval' 'sha256-abc123'")
  })

  test("csp() with hash preserves all other directives", () => {
    const result = csp("testhash")
    expect(result).toContain("default-src 'self'")
    expect(result).toContain("style-src 'self' 'unsafe-inline'")
    expect(result).toContain("img-src 'self' data: https:")
    expect(result).toContain("font-src 'self' data:")
    expect(result).toContain("media-src 'self' data:")
    expect(result).toContain("connect-src 'self' data:")
  })

  test("csp() with different hashes produces different results", () => {
    expect(csp("hash1")).not.toBe(csp("hash2"))
  })
})
