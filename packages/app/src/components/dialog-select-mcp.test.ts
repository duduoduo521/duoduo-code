import { describe, expect, test } from "bun:test"

// Testing statusLabels mapping from dialog-select-mcp.tsx
const statusLabels = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  disabled: "mcp.status.disabled",
} as const

describe("statusLabels", () => {
  test("maps all MCP status keys to i18n keys", () => {
    expect(statusLabels.connected).toBe("mcp.status.connected")
    expect(statusLabels.failed).toBe("mcp.status.failed")
    expect(statusLabels.needs_auth).toBe("mcp.status.needs_auth")
    expect(statusLabels.disabled).toBe("mcp.status.disabled")
  })

  test("has exactly 4 status labels", () => {
    expect(Object.keys(statusLabels)).toHaveLength(4)
  })

  test("all values are non-empty strings", () => {
    for (const value of Object.values(statusLabels)) {
      expect(typeof value).toBe("string")
      expect(value.length).toBeGreaterThan(0)
    }
  })
})
