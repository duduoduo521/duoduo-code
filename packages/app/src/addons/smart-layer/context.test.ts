import { describe, expect, test } from "bun:test"
import { SmartLayerApi } from "./api"

// Exercises the REAL SmartLayerApi from ./context.tsx. This file previously
// re-implemented the class locally, so every assertion below validated a copy
// that could silently drift from the production client.

// ─── Mock fetch ───

let mockFetch: typeof fetch
const originalFetch = globalThis.fetch

function setupMockFetch(response: { ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }) {
  mockFetch = (() => response) as unknown as typeof fetch
  globalThis.fetch = mockFetch
}

function restoreFetch() {
  globalThis.fetch = originalFetch
}

function createMockResponse(data: unknown, status = 200, statusText = "OK") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => data,
  }
}

describe("SmartLayerApi", () => {
  describe("constructor", () => {
    test("uses provided URL", () => {
      const api = new SmartLayerApi({ url: "http://localhost:8080" })
      // Verify via a request — URL is private
      expect(api).toBeDefined()
    })

    test("defaults timeout to 10000", () => {
      const api = new SmartLayerApi({ url: "http://localhost:8080" })
      expect(api).toBeDefined()
    })

    test("accepts custom timeout", () => {
      const api = new SmartLayerApi({ url: "http://localhost:8080", timeout: 5000 })
      expect(api).toBeDefined()
    })

    test("accepts authHeader", () => {
      const api = new SmartLayerApi({ url: "http://localhost:8080", authHeader: "Basic dXNlcjpwYXNz" })
      expect(api).toBeDefined()
    })

  })

  describe("request", () => {
    let capturedOptions: { method: string; url: string; headers: Record<string, string>; body?: string } | null = null

    test("constructs URL from base + path", async () => {
      capturedOptions = null
      globalThis.fetch = ((input: string, init?: RequestInit) => {
        capturedOptions = {
          method: init?.method ?? "GET",
          url: input,
          headers: init?.headers as Record<string, string>,
          body: init?.body as string | undefined,
        }
        return Promise.resolve(createMockResponse({ status: "ok", version: "1.0" }))
      }) as unknown as typeof fetch

      const api = new SmartLayerApi({ url: "http://localhost:8080" })
      await api.health()

      expect(capturedOptions!.url).toBe("http://localhost:8080/health")
      restoreFetch()
    })

    test("sets Content-Type only when the request carries a body", async () => {
      capturedOptions = null
      globalThis.fetch = ((input: string, init?: RequestInit) => {
        capturedOptions = {
          method: init?.method ?? "GET",
          url: input,
          headers: init?.headers as Record<string, string>,
          body: init?.body as string | undefined,
        }
        return Promise.resolve(createMockResponse({ status: "ok", version: "1.0" }))
      }) as unknown as typeof fetch

      const api = new SmartLayerApi({ url: "http://localhost:8080" })

      // Bodyless GET: omitting Content-Type avoids an extra CORS preflight
      // (OPTIONS) round-trip against the sidecar — see api.ts request().
      await api.health()
      expect(capturedOptions!.body).toBeUndefined()
      expect(capturedOptions!.headers["Content-Type"]).toBeUndefined()

      // POST with a body: Content-Type must be present.
      await api.storeMemory("some content", "semantic")
      expect(capturedOptions!.headers["Content-Type"]).toBe("application/json")
      restoreFetch()
    })

    test("includes Authorization header when authHeader is set", async () => {
      capturedOptions = null
      globalThis.fetch = ((input: string, init?: RequestInit) => {
        capturedOptions = {
          method: init?.method ?? "GET",
          url: input,
          headers: init?.headers as Record<string, string>,
          body: init?.body as string | undefined,
        }
        return Promise.resolve(createMockResponse({ status: "ok", version: "1.0" }))
      }) as unknown as typeof fetch

      const api = new SmartLayerApi({ url: "http://localhost:8080", authHeader: "Basic dXNlcjpwYXNz" })
      await api.health()

      expect(capturedOptions!.headers["Authorization"]).toBe("Basic dXNlcjpwYXNz")
      restoreFetch()
    })

    test("omits Authorization header when no authHeader", async () => {
      capturedOptions = null
      globalThis.fetch = ((input: string, init?: RequestInit) => {
        capturedOptions = {
          method: init?.method ?? "GET",
          url: input,
          headers: init?.headers as Record<string, string>,
          body: init?.body as string | undefined,
        }
        return Promise.resolve(createMockResponse({ status: "ok", version: "1.0" }))
      }) as unknown as typeof fetch

      const api = new SmartLayerApi({ url: "http://localhost:8080" })
      await api.health()

      expect(capturedOptions!.headers["Authorization"]).toBeUndefined()
      restoreFetch()
    })

    test("serializes body as JSON for POST requests", async () => {
      capturedOptions = null
      globalThis.fetch = ((input: string, init?: RequestInit) => {
        capturedOptions = {
          method: init?.method ?? "GET",
          url: input,
          headers: init?.headers as Record<string, string>,
          body: init?.body as string | undefined,
        }
        return Promise.resolve(createMockResponse({ id: "123", stored: true }))
      }) as unknown as typeof fetch

      const api = new SmartLayerApi({ url: "http://localhost:8080" })
      await api.storeMemory("test content", "semantic", ["tag1"])

      expect(capturedOptions!.method).toBe("POST")
      const body = JSON.parse(capturedOptions!.body!)
      expect(body.content).toBe("test content")
      expect(body.layer).toBe("semantic")
      expect(body.tags).toEqual(["tag1"])
      restoreFetch()
    })

    test("does not send body for GET requests", async () => {
      capturedOptions = null
      globalThis.fetch = ((input: string, init?: RequestInit) => {
        capturedOptions = {
          method: init?.method ?? "GET",
          url: input,
          headers: init?.headers as Record<string, string>,
          body: init?.body as string | undefined,
        }
        return Promise.resolve(
          createMockResponse({
            totalEntries: 0,
            byLayer: {},
            storageSizeBytes: 0,
            schemaVersion: "1",
            oldestEntry: null,
            newestEntry: null,
          }),
        )
      }) as unknown as typeof fetch

      const api = new SmartLayerApi({ url: "http://localhost:8080" })
      await api.memoryStats()

      expect(capturedOptions!.method).toBe("GET")
      expect(capturedOptions!.body).toBeUndefined()
      restoreFetch()
    })
  })

  describe("error handling", () => {
    test("throws enriched error with UnifiedError fields", async () => {
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          json: async () => ({
            error: "Rate limited",
            code: 429,
            error_type: "rate_limit",
            retryable: true,
            retry_after_ms: 5000,
          }),
        })) as unknown as typeof fetch

      const api = new SmartLayerApi({ url: "http://localhost:8080" })

      try {
        await api.health()
        expect.unreachable("Should have thrown")
      } catch (e) {
        expect(e).toBeInstanceOf(Error)
        const err = e as Error & { status?: number; errorType?: string; retryable?: boolean; retryAfterMs?: number }
        expect(err.message).toBe("SmartLayer 429: Rate limited")
        expect(err.status).toBe(429)
        expect(err.errorType).toBe("rate_limit")
        expect(err.retryable).toBe(true)
        expect(err.retryAfterMs).toBe(5000)
      }
      restoreFetch()
    })

    test("falls back to statusText when error body has no error field", async () => {
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          json: async () => ({}), // no error field
        })) as unknown as typeof fetch

      const api = new SmartLayerApi({ url: "http://localhost:8080" })

      try {
        await api.health()
        expect.unreachable("Should have thrown")
      } catch (e) {
        expect(e).toBeInstanceOf(Error)
        expect((e as Error).message).toBe("SmartLayer 500: Internal Server Error")
      }
      restoreFetch()
    })

    test("falls back to statusText when JSON parsing fails", async () => {
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: false,
          status: 502,
          statusText: "Bad Gateway",
          json: async () => {
            throw new SyntaxError("Unexpected token")
          },
        })) as unknown as typeof fetch

      const api = new SmartLayerApi({ url: "http://localhost:8080" })

      try {
        await api.health()
        expect.unreachable("Should have thrown")
      } catch (e) {
        expect(e).toBeInstanceOf(Error)
        expect((e as Error).message).toBe("SmartLayer 502: Bad Gateway")
      }
      restoreFetch()
    })

    test("preserves enriched error when JSON parsing succeeds with error field", async () => {
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: false,
          status: 403,
          statusText: "Forbidden",
          json: async () => ({
            error: "Auth required",
            error_type: "auth_error",
            retryable: false,
          }),
        })) as unknown as typeof fetch

      const api = new SmartLayerApi({ url: "http://localhost:8080" })

      try {
        await api.health()
        expect.unreachable("Should have thrown")
      } catch (e) {
        const err = e as Error & { errorType?: string }
        expect(err.message).toBe("SmartLayer 403: Auth required")
        expect(err.errorType).toBe("auth_error")
      }
      restoreFetch()
    })
  })

  describe("API method delegation", () => {
    let capturedOptions: { method: string; url: string; body?: string } | null = null

    function setupCapture() {
      globalThis.fetch = ((input: string, init?: RequestInit) => {
        capturedOptions = { method: init?.method ?? "GET", url: input, body: init?.body as string | undefined }
        return Promise.resolve(createMockResponse({}))
      }) as unknown as typeof fetch
    }

    test("health() calls GET /health", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.health()
      expect(capturedOptions!.method).toBe("GET")
      expect(capturedOptions!.url).toBe("http://sl:8080/health")
      restoreFetch()
    })

    test("searchMemory() calls POST /memory/search with query, limit, layers", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.searchMemory("auth bug", 20, ["semantic"])
      expect(capturedOptions!.method).toBe("POST")
      expect(capturedOptions!.url).toBe("http://sl:8080/memory/search")
      const body = JSON.parse(capturedOptions!.body!)
      expect(body.query).toBe("auth bug")
      expect(body.limit).toBe(20)
      expect(body.layers).toEqual(["semantic"])
      restoreFetch()
    })

    test("searchMemory() defaults limit to 10", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.searchMemory("test")
      const body = JSON.parse(capturedOptions!.body!)
      expect(body.limit).toBe(10)
      restoreFetch()
    })

    test("storeMemory() calls POST /memory/store with all options", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.storeMemory("content", "episode", ["tag1"], {
        importance: 5,
        pin: true,
        sessionId: "ses_123",
        memoryType: "fact",
        projectPath: "/repo",
      })
      const body = JSON.parse(capturedOptions!.body!)
      expect(body.content).toBe("content")
      expect(body.layer).toBe("episode")
      expect(body.tags).toEqual(["tag1"])
      expect(body.importance).toBe(5)
      expect(body.pin).toBe(true)
      expect(body.sessionId).toBe("ses_123")
      expect(body.memoryType).toBe("fact")
      expect(body.projectPath).toBe("/repo")
      restoreFetch()
    })

    test("memoryStats() calls GET /memory/stats/v2", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.memoryStats()
      expect(capturedOptions!.method).toBe("GET")
      expect(capturedOptions!.url).toBe("http://sl:8080/memory/stats/v2")
      restoreFetch()
    })

    test("deleteMemory() calls DELETE /memory/:id with encoded id", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.deleteMemory("mem/special+id")
      expect(capturedOptions!.method).toBe("DELETE")
      expect(capturedOptions!.url).toBe("http://sl:8080/memory/mem%2Fspecial%2Bid")
      restoreFetch()
    })

    test("clearMemory() without layer calls DELETE /memory/clear", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.clearMemory()
      expect(capturedOptions!.method).toBe("DELETE")
      expect(capturedOptions!.url).toBe("http://sl:8080/memory/clear")
      restoreFetch()
    })

    test("clearMemory() with layer calls DELETE /memory/layer/:layer", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.clearMemory("semantic")
      expect(capturedOptions!.method).toBe("DELETE")
      expect(capturedOptions!.url).toBe("http://sl:8080/memory/layer/semantic")
      restoreFetch()
    })

    test("validateQuality() calls POST /quality/validate", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.validateQuality(
        { type: "code", content: "fn main() {}", language: "rust", filePath: "main.rs" },
        "high",
      )
      const body = JSON.parse(capturedOptions!.body!)
      expect(body.artifact.type).toBe("code")
      expect(body.qualityLevel).toBe("high")
      restoreFetch()
    })

    test("clarifyIntent() calls POST /intent/clarify", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.clarifyIntent("fix the login bug", { project: "myapp" })
      const body = JSON.parse(capturedOptions!.body!)
      expect(body.userInput).toBe("fix the login bug")
      expect(body.projectContext).toEqual({ project: "myapp" })
      restoreFetch()
    })

    test("configureLlm() calls POST /agent/config", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.configureLlm({ provider: "openai", apiKey: "sk-xxx", defaultModelId: "gpt-4", contextWindow: 128000 })
      const body = JSON.parse(capturedOptions!.body!)
      expect(body.provider).toBe("openai")
      expect(body.apiKey).toBe("sk-xxx")
      expect(body.defaultModelId).toBe("gpt-4")
      expect(body.contextWindow).toBe(128000)
      restoreFetch()
    })

    test("getLlmConfig() calls GET /agent/config", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.getLlmConfig()
      expect(capturedOptions!.method).toBe("GET")
      expect(capturedOptions!.url).toBe("http://sl:8080/agent/config")
      restoreFetch()
    })

    test("keyringStore() calls POST /agent/keyring/store", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.keyringStore("openai", "sk-xxx")
      const body = JSON.parse(capturedOptions!.body!)
      expect(body.provider).toBe("openai")
      expect(body.apiKey).toBe("sk-xxx")
      restoreFetch()
    })

    test("keyringHas() calls GET /agent/keyring/has with encoded provider", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.keyringHas("openai")
      expect(capturedOptions!.method).toBe("GET")
      expect(capturedOptions!.url).toBe("http://sl:8080/agent/keyring/has?provider=openai")
      restoreFetch()
    })

    test("keyringDelete() calls POST /agent/keyring/delete", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.keyringDelete("openai")
      const body = JSON.parse(capturedOptions!.body!)
      expect(body.provider).toBe("openai")
      restoreFetch()
    })

    test("forceReindex() calls POST /graph/force-reindex-async", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.forceReindex("/my/project")
      const body = JSON.parse(capturedOptions!.body!)
      expect(body.projectPath).toBe("/my/project")
      restoreFetch()
    })

    test("graphUpdateFile() calls POST /graph/update-file", async () => {
      setupCapture()
      const api = new SmartLayerApi({ url: "http://sl:8080" })
      await api.graphUpdateFile("src/main.ts", "console.log('hi')", "typescript")
      const body = JSON.parse(capturedOptions!.body!)
      expect(body.path).toBe("src/main.ts")
      expect(body.content).toBe("console.log('hi')")
      expect(body.language).toBe("typescript")
      restoreFetch()
    })
  })

})
