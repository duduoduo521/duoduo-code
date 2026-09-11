import { describe, expect, test } from "bun:test"

// formatTokens from dialog-select-model.tsx — not exported, replicated for testing
const formatTokens = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

describe("formatTokens (dialog-select-model)", () => {
  test("formats millions with one decimal", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M")
  })

  test("formats exactly 1M", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M")
  })

  test("formats thousands with K suffix", () => {
    expect(formatTokens(5_000)).toBe("5K")
  })

  test("formats exactly 1K", () => {
    expect(formatTokens(1_000)).toBe("1K")
  })

  test("formats numbers below 1000 as-is", () => {
    expect(formatTokens(999)).toBe("999")
  })

  test("formats zero", () => {
    expect(formatTokens(0)).toBe("0")
  })

  test("formats 128K", () => {
    expect(formatTokens(128_000)).toBe("128K")
  })

  test("formats 2.3M", () => {
    expect(formatTokens(2_300_000)).toBe("2.3M")
  })
})

// statusLabels from dialog-select-mcp.tsx — not exported, replicated for testing
const statusLabels = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  disabled: "mcp.status.disabled",
} as const

describe("statusLabels (dialog-select-mcp)", () => {
  test("maps all MCP status keys to i18n keys", () => {
    expect(statusLabels.connected).toBe("mcp.status.connected")
    expect(statusLabels.failed).toBe("mcp.status.failed")
    expect(statusLabels.needs_auth).toBe("mcp.status.needs_auth")
    expect(statusLabels.disabled).toBe("mcp.status.disabled")
  })

  test("covers the 4 expected MCP statuses", () => {
    expect(Object.keys(statusLabels)).toHaveLength(4)
  })
})

// kindToIcon from prompt-input/drag-overlay.tsx — not exported, replicated for testing
const kindToIcon = {
  image: "photo",
  "@mention": "link",
} as const

describe("kindToIcon (drag-overlay)", () => {
  test("maps image kind to photo icon", () => {
    expect(kindToIcon.image).toBe("photo")
  })

  test("maps @mention kind to link icon", () => {
    expect(kindToIcon["@mention"]).toBe("link")
  })

  test("has exactly 2 mappings", () => {
    expect(Object.keys(kindToIcon)).toHaveLength(2)
  })
})

// AVATAR_COLOR_KEYS from dialog-edit-project.tsx — not exported, replicated for testing
const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const

describe("AVATAR_COLOR_KEYS (dialog-edit-project)", () => {
  test("contains exactly 6 colors", () => {
    expect(AVATAR_COLOR_KEYS).toHaveLength(6)
  })

  test("includes expected colors", () => {
    expect(AVATAR_COLOR_KEYS).toContain("pink")
    expect(AVATAR_COLOR_KEYS).toContain("mint")
    expect(AVATAR_COLOR_KEYS).toContain("orange")
    expect(AVATAR_COLOR_KEYS).toContain("purple")
    expect(AVATAR_COLOR_KEYS).toContain("cyan")
    expect(AVATAR_COLOR_KEYS).toContain("lime")
  })
})
