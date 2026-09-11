import { describe, expect, test } from "bun:test"

// looksComplete from dialog-select-server.tsx — not exported, replicated here for testing
// Depends on normalizeServerUrl from context/server.tsx
import { normalizeServerUrl } from "@/context/server"

function looksComplete(value: string): boolean {
  const normalized = normalizeServerUrl(value)
  if (!normalized) return false
  const host = normalized.replace(/^https?:\/\//, "").split("/")[0]
  if (!host) return false
  if (host.includes("localhost") || host.startsWith("127.0.0.1")) return true
  return host.includes(".") || host.includes(":")
}

describe("looksComplete (dialog-select-server)", () => {
  test("returns true for localhost", () => {
    expect(looksComplete("localhost:8080")).toBe(true)
  })

  test("returns true for 127.0.0.1", () => {
    expect(looksComplete("127.0.0.1:4096")).toBe(true)
  })

  test("returns true for domain with dot", () => {
    expect(looksComplete("api.example.com")).toBe(true)
  })

  test("returns true for domain with port", () => {
    expect(looksComplete("example.com:443")).toBe(true)
  })

  test("returns true for https URL", () => {
    expect(looksComplete("https://api.example.com")).toBe(true)
  })

  test("returns true for http URL", () => {
    expect(looksComplete("http://localhost:3000")).toBe(true)
  })

  test("returns false for empty string", () => {
    expect(looksComplete("")).toBe(false)
  })

  test("returns false for whitespace only", () => {
    expect(looksComplete("   ")).toBe(false)
  })

  test("returns false for single word without dot or colon", () => {
    expect(looksComplete("myserver")).toBe(false)
  })

  test("returns false for partial input", () => {
    expect(looksComplete("local")).toBe(false)
  })

  test("returns true for IP address with port", () => {
    expect(looksComplete("192.168.1.1:8080")).toBe(true)
  })

  test("returns true for IP address without port", () => {
    expect(looksComplete("192.168.1.1")).toBe(true)
  })

  test("returns true for IPv6 loopback", () => {
    expect(looksComplete("[::1]:4096")).toBe(true)
  })

  test("returns true for IPv6 loopback without port", () => {
    expect(looksComplete("[::1]")).toBe(true)
  })

  test("localhost.example.com is not treated as localhost", () => {
    // looksComplete returns true because it has dots, but isHttpNonLocal should warn
    expect(looksComplete("localhost.example.com")).toBe(true)
  })
})
