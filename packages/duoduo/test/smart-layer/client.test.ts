import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"
import { SmartLayerClient, SmartLayerError } from "../../src/smart-layer/client"
import type { SmartLayerConfig } from "../../src/smart-layer/types"

const defaultConfig: SmartLayerConfig = { url: "http://localhost:12345", timeout: 5000 }

describe("SmartLayerClient", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetch(response: { ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }) {
    globalThis.fetch = mock(() => Promise.resolve(response)) as unknown as typeof globalThis.fetch
  }

  describe("constructor", () => {
    test("without auth: no Authorization header", async () => {
      let capturedHeaders: Record<string, string> = {}
      globalThis.fetch = mock((_url: string, init: RequestInit) => {
        capturedHeaders = init.headers as Record<string, string>
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve({ data: "test" }),
        } as Response)
      }) as unknown as typeof globalThis.fetch

      const client = new SmartLayerClient(defaultConfig)
      await client.get("/test")

      expect(capturedHeaders["Authorization"]).toBeUndefined()
      expect(capturedHeaders["Content-Type"]).toBe("application/json")
    })

    test("with auth: sets Basic auth header (btoa of username:password)", async () => {
      let capturedHeaders: Record<string, string> = {}
      globalThis.fetch = mock((_url: string, init: RequestInit) => {
        capturedHeaders = init.headers as Record<string, string>
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve({ data: "test" }),
        } as Response)
      }) as unknown as typeof globalThis.fetch

      const client = new SmartLayerClient(defaultConfig, { username: "user", password: "pass" })
      await client.get("/test")

      const expected = `Basic ${btoa("user:pass")}`
      expect(capturedHeaders["Authorization"]).toBe(expected)
    })
  })

  describe("get()", () => {
    test("with params: appends URLSearchParams to path", async () => {
      let capturedUrl = ""
      globalThis.fetch = mock((url: string, _init: RequestInit) => {
        capturedUrl = url
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve([]),
        } as Response)
      }) as unknown as typeof globalThis.fetch

      const client = new SmartLayerClient(defaultConfig)
      await client.get("/memory/stats", { key: "value", foo: "bar" })

      expect(capturedUrl).toBe("http://localhost:12345/memory/stats?key=value&foo=bar")
    })

    test("without params: path used as-is", async () => {
      let capturedUrl = ""
      globalThis.fetch = mock((url: string, _init: RequestInit) => {
        capturedUrl = url
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve({}),
        } as Response)
      }) as unknown as typeof globalThis.fetch

      const client = new SmartLayerClient(defaultConfig)
      await client.get("/memory/stats")

      expect(capturedUrl).toBe("http://localhost:12345/memory/stats")
    })
  })

  describe("post()", () => {
    test("sends body as JSON", async () => {
      let capturedBody: string | undefined
      let capturedMethod: string | undefined
      globalThis.fetch = mock((_url: string, init: RequestInit) => {
        capturedBody = init.body as string
        capturedMethod = init.method
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve({ id: "123" }),
        } as Response)
      }) as unknown as typeof globalThis.fetch

      const client = new SmartLayerClient(defaultConfig)
      await client.post("/memory/store", { content: "hello", layer: "L1" })

      expect(capturedMethod).toBe("POST")
      expect(capturedBody).toBe(JSON.stringify({ content: "hello", layer: "L1" }))
    })
  })

  describe("put()", () => {
    test("sends body as JSON", async () => {
      let capturedBody: string | undefined
      let capturedMethod: string | undefined
      globalThis.fetch = mock((_url: string, init: RequestInit) => {
        capturedBody = init.body as string
        capturedMethod = init.method
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve({ id: "123" }),
        } as Response)
      }) as unknown as typeof globalThis.fetch

      const client = new SmartLayerClient(defaultConfig)
      await client.put("/memory/abc", { content: "updated", layer: "L2" })

      expect(capturedMethod).toBe("PUT")
      expect(capturedBody).toBe(JSON.stringify({ content: "updated", layer: "L2" }))
    })
  })

  describe("del()", () => {
    test("with params: appends URLSearchParams", async () => {
      let capturedUrl = ""
      let capturedMethod: string | undefined
      globalThis.fetch = mock((url: string, init: RequestInit) => {
        capturedUrl = url
        capturedMethod = init.method
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve({ deleted: 1 }),
        } as Response)
      }) as unknown as typeof globalThis.fetch

      const client = new SmartLayerClient(defaultConfig)
      await client.del("/memory/abc", { force: "true" })

      expect(capturedMethod).toBe("DELETE")
      expect(capturedUrl).toBe("http://localhost:12345/memory/abc?force=true")
    })

    test("without params: path used as-is", async () => {
      let capturedUrl = ""
      globalThis.fetch = mock((url: string, _init: RequestInit) => {
        capturedUrl = url
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve({ deleted: 1 }),
        } as Response)
      }) as unknown as typeof globalThis.fetch

      const client = new SmartLayerClient(defaultConfig)
      await client.del("/memory/clear")

      expect(capturedUrl).toBe("http://localhost:12345/memory/clear")
    })
  })

  describe("error handling", () => {
    test("Non-2xx response: throws SmartLayerError with status and message", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          statusText: "Not Found",
          json: () => Promise.resolve({ message: "Resource not found" }),
        } as Response),
      ) as unknown as typeof globalThis.fetch

      const client = new SmartLayerClient(defaultConfig)
      try {
        await client.get("/missing")
        expect.unreachable("Should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(SmartLayerError)
        const error = err as SmartLayerError
        expect(error.status).toBe(404)
        expect(error.message).toContain("Resource not found")
      }
    })

    test("Non-2xx with non-JSON body: SmartLayerError with statusText fallback", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          json: () => Promise.reject(new Error("not JSON")),
        } as Response),
      ) as unknown as typeof globalThis.fetch

      const client = new SmartLayerClient(defaultConfig)
      try {
        await client.get("/broken")
        expect.unreachable("Should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(SmartLayerError)
        const error = err as SmartLayerError
        expect(error.status).toBe(500)
        expect(error.message).toContain("Internal Server Error")
      }
    })
  })

  describe("request configuration", () => {
    test("Content-Type: application/json header always set", async () => {
      let capturedHeaders: Record<string, string> = {}
      globalThis.fetch = mock((_url: string, init: RequestInit) => {
        capturedHeaders = init.headers as Record<string, string>
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve({}),
        } as Response)
      }) as unknown as typeof globalThis.fetch

      const client = new SmartLayerClient(defaultConfig)
      await client.get("/test")

      expect(capturedHeaders["Content-Type"]).toBe("application/json")
    })

    test("Timeout via AbortSignal.timeout(config.timeout)", async () => {
      let capturedSignal: AbortSignal | undefined
      globalThis.fetch = mock((_url: string, init: RequestInit) => {
        capturedSignal = init.signal ?? undefined
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve({}),
        } as Response)
      }) as unknown as typeof globalThis.fetch

      const config: SmartLayerConfig = { url: "http://localhost:9999", timeout: 15000 }
      const client = new SmartLayerClient(config)
      await client.get("/test")

      // AbortSignal.timeout creates a signal that aborts after the specified ms
      expect(capturedSignal).toBeDefined()
      expect(capturedSignal?.aborted).toBe(false)
    })
  })
})

describe("SmartLayerError", () => {
  test("has correct name and message", () => {
    const error = new SmartLayerError(400, "Bad Request")
    expect(error.name).toBe("SmartLayerError")
    expect(error.status).toBe(400)
    expect(error.message).toBe("SmartLayer error 400: Bad Request")
  })

  test("is instance of Error", () => {
    const error = new SmartLayerError(500, "Server Error")
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(SmartLayerError)
  })
})
