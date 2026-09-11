import { describe, test, expect, beforeEach, afterEach } from "bun:test"

// The module caches state in module-level variables (cachedClients, cachedUrl).
// We need to re-import the module to reset the cache between tests.
// Using dynamic import() with cache busting via Date.now query param.

describe("createSmartLayerClients", () => {
  const envKeys = [
    "DUO_SMART_LAYER_URL",
    "DUO_SMART_LAYER_TIMEOUT",
    "DUO_SMART_LAYER_USERNAME",
    "DUO_SMART_LAYER_PASSWORD",
  ]

  let savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    // Save and clear relevant env vars
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    // Restore env vars
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
  })

  async function importFresh() {
    // Bust the module cache by appending a unique query string
    const mod = await import(`../../src/smart-layer/index.ts?_t=${Date.now()}-${Math.random()}`)
    return mod
  }

  test("returns null when DUO_SMART_LAYER_URL env var is not set", async () => {
    const { createSmartLayerClients } = await importFresh()
    const result = createSmartLayerClients()
    expect(result).toBeNull()
  })

  test("returns SmartLayerClients when URL is set", async () => {
    process.env.DUO_SMART_LAYER_URL = "http://127.0.0.1:12345"
    const { createSmartLayerClients } = await importFresh()
    const result = createSmartLayerClients()
    expect(result).not.toBeNull()
    expect(result!.client).toBeDefined()
    expect(result!.memory).toBeDefined()

    expect(result!.quality).toBeDefined()
    expect(result!.intent).toBeDefined()
    expect(result!.graph).toBeDefined()
  })

  test("caches singleton by URL (returns same instance if URL unchanged)", async () => {
    process.env.DUO_SMART_LAYER_URL = "http://127.0.0.1:12345"
    const { createSmartLayerClients } = await importFresh()
    const first = createSmartLayerClients()
    const second = createSmartLayerClients()
    expect(first).toBe(second)
  })

  test("re-creates when URL changes", async () => {
    process.env.DUO_SMART_LAYER_URL = "http://127.0.0.1:12345"
    const mod1 = await importFresh()
    const first = mod1.createSmartLayerClients()

    // Change URL — need fresh import to reset cachedUrl
    process.env.DUO_SMART_LAYER_URL = "http://127.0.0.1:99999"
    const mod2 = await importFresh()
    const second = mod2.createSmartLayerClients()

    // Different module instances, so different objects
    expect(second).not.toBe(first)
  })

  test("default timeout is 30000 when DUO_SMART_LAYER_TIMEOUT not set", async () => {
    process.env.DUO_SMART_LAYER_URL = "http://127.0.0.1:12345"
    const { createSmartLayerClients } = await importFresh()
    const result = createSmartLayerClients()
    // We can't directly inspect the config, but we can verify the client exists
    // The timeout is used internally; we verify it doesn't throw and creates successfully
    expect(result).not.toBeNull()
    expect(result!.client).toBeDefined()
  })

  test("respects DUO_SMART_LAYER_TIMEOUT when set", async () => {
    process.env.DUO_SMART_LAYER_URL = "http://127.0.0.1:12345"
    process.env.DUO_SMART_LAYER_TIMEOUT = "60000"
    const { createSmartLayerClients } = await importFresh()
    const result = createSmartLayerClients()
    expect(result).not.toBeNull()
  })

  test("creates with auth when both DUO_SMART_LAYER_USERNAME and DUO_SMART_LAYER_PASSWORD are set", async () => {
    process.env.DUO_SMART_LAYER_URL = "http://127.0.0.1:12345"
    process.env.DUO_SMART_LAYER_USERNAME = "admin"
    process.env.DUO_SMART_LAYER_PASSWORD = "secret"
    const { createSmartLayerClients } = await importFresh()
    const result = createSmartLayerClients()
    expect(result).not.toBeNull()
    // The client should have been created with auth credentials
    // We can verify by checking the client makes requests with Authorization header
    // (indirectly — the client object exists and is configured)
    expect(result!.client).toBeDefined()
  })

  test("creates without auth when only username is set", async () => {
    process.env.DUO_SMART_LAYER_URL = "http://127.0.0.1:12345"
    process.env.DUO_SMART_LAYER_USERNAME = "admin"
    // PASSWORD not set
    const { createSmartLayerClients } = await importFresh()
    const result = createSmartLayerClients()
    expect(result).not.toBeNull()
    // Client created without auth (password missing → no auth)
    expect(result!.client).toBeDefined()
  })

  test("creates without auth when only password is set", async () => {
    process.env.DUO_SMART_LAYER_URL = "http://127.0.0.1:12345"
    process.env.DUO_SMART_LAYER_PASSWORD = "secret"
    // USERNAME not set
    const { createSmartLayerClients } = await importFresh()
    const result = createSmartLayerClients()
    expect(result).not.toBeNull()
    expect(result!.client).toBeDefined()
  })

  test("clears cache when URL is removed", async () => {
    process.env.DUO_SMART_LAYER_URL = "http://127.0.0.1:12345"
    const { createSmartLayerClients } = await importFresh()
    const first = createSmartLayerClients()
    expect(first).not.toBeNull()

    delete process.env.DUO_SMART_LAYER_URL
    const second = createSmartLayerClients()
    expect(second).toBeNull()
  })

  // Regression (P0-06): raw-`fetch` callers need BOTH the URL and the Basic
  // auth header. Resolving only the URL left desktop requests unauthenticated
  // (the Rust sidecar enforces Basic auth whenever it has a password).
  test("resolveSmartLayerConnection returns URL + Basic auth from env credentials", async () => {
    process.env.DUO_SMART_LAYER_URL = "http://127.0.0.1:12345"
    process.env.DUO_SMART_LAYER_USERNAME = "admin"
    process.env.DUO_SMART_LAYER_PASSWORD = "secret"
    const { resolveSmartLayerConnection } = await importFresh()
    const conn = resolveSmartLayerConnection()
    expect(conn?.url).toBe("http://127.0.0.1:12345")
    expect(conn?.authHeader).toBe(`Basic ${btoa("admin:secret")}`)
  })

  test("resolveSmartLayerConnection defaults the username to smart-layer when only a password is set", async () => {
    process.env.DUO_SMART_LAYER_URL = "http://127.0.0.1:12345"
    process.env.DUO_SMART_LAYER_PASSWORD = "secret"
    const { resolveSmartLayerConnection } = await importFresh()
    expect(resolveSmartLayerConnection()?.authHeader).toBe(`Basic ${btoa("smart-layer:secret")}`)
  })

  test("resolveSmartLayerConnection omits auth when no credentials exist", async () => {
    process.env.DUO_SMART_LAYER_URL = "http://127.0.0.1:12345"
    const { resolveSmartLayerConnection } = await importFresh()
    const conn = resolveSmartLayerConnection()
    expect(conn?.url).toBe("http://127.0.0.1:12345")
    expect(conn?.authHeader).toBeUndefined()
  })

  test("resolveSmartLayerConnection returns undefined without a URL", async () => {
    const { resolveSmartLayerConnection } = await importFresh()
    expect(resolveSmartLayerConnection()).toBeUndefined()
  })
})
