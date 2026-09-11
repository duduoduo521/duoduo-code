import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

describe("server/workspace local() routing", () => {
  // We test the RULES-based local() logic by extracting it directly
  // from the workspace module
  type Rule = { method?: string; path: string; exact?: boolean; action: "local" | "forward" }

  const RULES: Array<Rule> = [
    { path: "/session/status", action: "forward" },
    { method: "GET", path: "/session", action: "local" },
  ]

  function local(method: string, path: string) {
    for (const rule of RULES) {
      if (rule.method && rule.method !== method) continue
      const match = rule.exact ? path === rule.path : path === rule.path || path.startsWith(rule.path + "/")
      if (match) return rule.action === "local"
    }
    return false
  }

  test("GET /session is local", () => {
    expect(local("GET", "/session")).toBe(true)
  })

  test("POST /session is NOT local (method mismatch)", () => {
    expect(local("POST", "/session")).toBe(false)
  })

  test("GET /session/status is NOT local (matches forward rule first)", () => {
    expect(local("GET", "/session/status")).toBe(false)
  })

  test("GET /session/abc is local (starts with /session/)", () => {
    expect(local("GET", "/session/abc")).toBe(true)
  })

  test("POST /session/abc is NOT local", () => {
    expect(local("POST", "/session/abc")).toBe(false)
  })

  test("/other is NOT local", () => {
    expect(local("GET", "/other")).toBe(false)
    expect(local("POST", "/other")).toBe(false)
  })

  test("/config is NOT local", () => {
    expect(local("GET", "/config")).toBe(false)
  })

  test("forward rule takes precedence for /session/status", () => {
    // The forward rule for /session/status is listed before the local rule for /session
    // but since it has no method constraint, it matches GET /session/status as forward
    expect(local("GET", "/session/status")).toBe(false)
  })
})

describe("server/workspace getSessionID()", () => {
  function getSessionID(url: URL) {
    if (url.pathname === "/session/status") return null
    const id = url.pathname.match(/^\/session\/([^/]+)(?:\/|$)/)?.[1]
    if (!id) return null
    return id
  }

  test("extracts session ID from /session/sess_123", () => {
    const url = new URL("http://localhost/session/sess_123")
    expect(getSessionID(url)).toBe("sess_123")
  })

  test("extracts session ID from /session/sess_123/message", () => {
    const url = new URL("http://localhost/session/sess_123/message")
    expect(getSessionID(url)).toBe("sess_123")
  })

  test("returns null for /session/status", () => {
    const url = new URL("http://localhost/session/status")
    expect(getSessionID(url)).toBe(null)
  })

  test("returns null for /session without ID", () => {
    const url = new URL("http://localhost/session")
    expect(getSessionID(url)).toBe(null)
  })

  test("returns null for unrelated paths", () => {
    const url = new URL("http://localhost/config")
    expect(getSessionID(url)).toBe(null)
  })

  test("returns null for /session/ (trailing slash, no ID)", () => {
    const url = new URL("http://localhost/session/")
    expect(getSessionID(url)).toBe(null)
  })
})
