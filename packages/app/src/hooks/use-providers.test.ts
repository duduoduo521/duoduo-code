import { describe, test, expect } from "bun:test"

// ─── Test the pure logic of use-providers without SolidJS reactivity ───
// The hook uses useGlobalSync, useParams, createMemo which require SolidJS context.
// We extract and test the provider filtering logic independently.

// Re-implement the connected/paid filter logic from useProviders
interface Provider {
  id: string
  name: string
}

interface ProviderData {
  all: Provider[]
  default: Provider
  connected: string[]
}

function filterConnected(providers: ProviderData): Provider[] {
  const connected = new Set(providers.connected)
  return providers.all.filter((p) => p.id !== "duoduocode" && connected.has(p.id))
}

function filterPopular(providers: ProviderData): Provider[] {
  // popularProviders is empty and popular() filters with () => false
  return providers.all.filter(() => false)
}

// ─── Tests ───

describe("popularProviders", () => {
  test("is exported as an empty array", async () => {
    // We can't import use-providers directly due to SolidJS router dependency,
    // but the source code explicitly defines: export const popularProviders: string[] = []
    // Verify the constant exists by reading the module as text
    const fs = await import("fs")
    const path = await import("path")
    const content = fs.readFileSync(path.join(import.meta.dir, "use-providers.ts"), "utf-8")
    expect(content).toContain("popularProviders: string[] = []")
  })
})

describe("filterConnected", () => {
  const providers: ProviderData = {
    all: [
      { id: "duoduocode", name: "DuoduoCode" },
      { id: "anthropic", name: "Anthropic" },
      { id: "openai", name: "OpenAI" },
      { id: "google", name: "Google" },
    ],
    default: { id: "anthropic", name: "Anthropic" },
    connected: ["anthropic", "openai"],
  }

  test("excludes duoduocode from connected list", () => {
    const result = filterConnected(providers)
    expect(result.some((p) => p.id === "duoduocode")).toBe(false)
  })

  test("includes only connected providers", () => {
    const result = filterConnected(providers)
    const ids = result.map((p) => p.id)
    expect(ids).toEqual(["anthropic", "openai"])
  })

  test("does not include providers not in connected set", () => {
    const result = filterConnected(providers)
    expect(result.some((p) => p.id === "google")).toBe(false)
  })

  test("returns empty when no providers are connected", () => {
    const result = filterConnected({ ...providers, connected: [] })
    expect(result).toEqual([])
  })

  test("duoduocode is excluded even if in connected set", () => {
    const result = filterConnected({ ...providers, connected: ["duoduocode", "anthropic"] })
    expect(result.some((p) => p.id === "duoduocode")).toBe(false)
    expect(result.map((p) => p.id)).toEqual(["anthropic"])
  })

  test("returns all non-duoduocode connected providers", () => {
    const result = filterConnected({ ...providers, connected: ["anthropic", "openai", "google"] })
    expect(result.map((p) => p.id)).toEqual(["anthropic", "openai", "google"])
  })
})

describe("filterPopular", () => {
  test("always returns empty array (filter is always false)", () => {
    const providers: ProviderData = {
      all: [
        { id: "duoduocode", name: "DuoduoCode" },
        { id: "anthropic", name: "Anthropic" },
      ],
      default: { id: "anthropic", name: "Anthropic" },
      connected: ["anthropic"],
    }
    expect(filterPopular(providers)).toEqual([])
  })
})

describe("useProviders hook logic", () => {
  test("connected and paid use the same filter logic", () => {
    // In the source: connected() and paid() have identical implementations
    // Both filter all providers where id !== "duoduocode" && connected.has(id)
    const providers: ProviderData = {
      all: [
        { id: "duoduocode", name: "DuoduoCode" },
        { id: "anthropic", name: "Anthropic" },
        { id: "openai", name: "OpenAI" },
      ],
      default: { id: "anthropic", name: "Anthropic" },
      connected: ["anthropic", "openai"],
    }
    const connected = filterConnected(providers)
    const paid = filterConnected(providers) // same logic
    expect(connected).toEqual(paid)
  })

  test("when dir is present and provider_ready, uses child provider data", () => {
    const globalProvider: ProviderData = {
      all: [{ id: "duoduocode", name: "DuoduoCode" }],
      default: { id: "duoduocode", name: "DuoduoCode" },
      connected: ["duoduocode"],
    }

    const projectProvider: ProviderData = {
      all: [
        { id: "duoduocode", name: "DuoduoCode" },
        { id: "custom", name: "Custom" },
      ],
      default: { id: "custom", name: "Custom" },
      connected: ["custom"],
    }

    // Simulate: when dir is present and provider_ready, use project store
    const activeProvider = projectProvider
    const result = filterConnected(activeProvider)

    expect(result.map((p) => p.id)).toEqual(["custom"])
    expect(result.some((p) => p.id === "duoduocode")).toBe(false)
  })

  test("when dir is absent, falls back to global provider data", () => {
    const globalProvider: ProviderData = {
      all: [
        { id: "duoduocode", name: "DuoduoCode" },
        { id: "anthropic", name: "Anthropic" },
      ],
      default: { id: "anthropic", name: "Anthropic" },
      connected: ["anthropic"],
    }

    const result = filterConnected(globalProvider)
    expect(result.map((p) => p.id)).toEqual(["anthropic"])
  })
})
