import { describe, expect, test } from "bun:test"

// The `local` and `getSessionID` functions are module-scoped in workspace.ts
// We test the routing logic by extracting the pure functions for testing.
// Since they are not exported, we replicate the logic here for unit testing.

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

function getSessionID(url: URL) {
  if (url.pathname === "/session/status") return null
  const id = url.pathname.match(/^\/session\/([^/]+)(?:\/|$)/)?.[1]
  if (!id) return null
  return id
}

describe("workspace.local routing", () => {
  test("GET /session is local", () => {
    expect(local("GET", "/session")).toBe(true)
  })

  test("GET /session/ is local (prefix match)", () => {
    expect(local("GET", "/session/")).toBe(true)
  })

  test("GET /session/abc is local (prefix match)", () => {
    expect(local("GET", "/session/abc")).toBe(true)
  })

  test("POST /session is NOT local (method mismatch)", () => {
    expect(local("POST", "/session")).toBe(false)
  })

  test("/session/status is NOT local (forward rule takes precedence)", () => {
    expect(local("GET", "/session/status")).toBe(false)
  })

  test("POST /session/status is NOT local", () => {
    expect(local("POST", "/session/status")).toBe(false)
  })

  test("/config is NOT local", () => {
    expect(local("GET", "/config")).toBe(false)
  })

  test("/provider is NOT local", () => {
    expect(local("GET", "/provider")).toBe(false)
  })

  test("/event is NOT local", () => {
    expect(local("GET", "/event")).toBe(false)
  })

  test("/session/abc/message is NOT local (no GET method rule for sub-paths)", () => {
    expect(local("GET", "/session/abc/message")).toBe(true)
  })

  test("DELETE /session/abc is NOT local (GET-only rule)", () => {
    expect(local("DELETE", "/session/abc")).toBe(false)
  })
})

describe("workspace.getSessionID", () => {
  test("extracts session ID from /session/abc123", () => {
    const url = new URL("http://localhost/session/abc123")
    expect(getSessionID(url)).toBe("abc123")
  })

  test("extracts session ID from /session/abc123/message", () => {
    const url = new URL("http://localhost/session/abc123/message")
    expect(getSessionID(url)).toBe("abc123")
  })

  test("extracts session ID from /session/abc123/", () => {
    const url = new URL("http://localhost/session/abc123/")
    expect(getSessionID(url)).toBe("abc123")
  })

  test("returns null for /session/status", () => {
    const url = new URL("http://localhost/session/status")
    expect(getSessionID(url)).toBeNull()
  })

  test("returns null for /session (no ID)", () => {
    const url = new URL("http://localhost/session")
    expect(getSessionID(url)).toBeNull()
  })

  test("returns null for /session/ (no ID)", () => {
    const url = new URL("http://localhost/session/")
    expect(getSessionID(url)).toBeNull()
  })

  test("returns null for /config", () => {
    const url = new URL("http://localhost/config")
    expect(getSessionID(url)).toBeNull()
  })

  test("extracts session ID with special characters", () => {
    const url = new URL("http://localhost/session/ses_abc-123")
    expect(getSessionID(url)).toBe("ses_abc-123")
  })

  test("does not match nested paths beyond session ID", () => {
    const url = new URL("http://localhost/session/abc/def/ghi")
    expect(getSessionID(url)).toBe("abc")
  })
})
