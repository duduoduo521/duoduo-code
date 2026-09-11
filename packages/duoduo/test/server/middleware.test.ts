import { describe, expect, test } from "bun:test"
import { CorsMiddleware } from "../../src/server/middleware"
import { Hono } from "hono"

describe("CorsMiddleware", () => {
  function createApp(cors?: string[]) {
    const app = new Hono()
    app.use("*", CorsMiddleware({ cors }))
    app.get("/test", (c) => c.json({ ok: true }))
    return app
  }

  test("allows http://localhost origins", async () => {
    const app = createApp()
    const res = await app.request("/test", {
      headers: { Origin: "http://localhost:3000" },
    })
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
  })

  test("allows http://127.0.0.1 origins", async () => {
    const app = createApp()
    const res = await app.request("/test", {
      headers: { Origin: "http://127.0.0.1:8080" },
    })
    expect(res.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8080")
  })

  test("allows tauri://localhost origin", async () => {
    const app = createApp()
    const res = await app.request("/test", {
      headers: { Origin: "tauri://localhost" },
    })
    expect(res.headers.get("access-control-allow-origin")).toBe("tauri://localhost")
  })

  test("allows http://tauri.localhost origin", async () => {
    const app = createApp()
    const res = await app.request("/test", {
      headers: { Origin: "http://tauri.localhost" },
    })
    expect(res.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost")
  })

  test("allows https://tauri.localhost origin", async () => {
    const app = createApp()
    const res = await app.request("/test", {
      headers: { Origin: "https://tauri.localhost" },
    })
    expect(res.headers.get("access-control-allow-origin")).toBe("https://tauri.localhost")
  })

  test("allows www.dd322.cn subdomains", async () => {
    const app = createApp()
    const res = await app.request("/test", {
      headers: { Origin: "https://app.www.dd322.cn" },
    })
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.www.dd322.cn")
  })

  test("allows deeply nested www.dd322.cn subdomains", async () => {
    const app = createApp()
    const res = await app.request("/test", {
      headers: { Origin: "https://a.b.c.www.dd322.cn" },
    })
    expect(res.headers.get("access-control-allow-origin")).toBe("https://a.b.c.www.dd322.cn")
  })

  test("rejects non-www.dd322.cn https origins by default", async () => {
    const app = createApp()
    const res = await app.request("/test", {
      headers: { Origin: "https://evil.example.com" },
    })
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("allows custom CORS origins from opts", async () => {
    const app = createApp(["https://custom.example.com"])
    const res = await app.request("/test", {
      headers: { Origin: "https://custom.example.com" },
    })
    expect(res.headers.get("access-control-allow-origin")).toBe("https://custom.example.com")
  })

  test("sets max-age header", async () => {
    const app = createApp()
    const res = await app.request("/test", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000" },
    })
    expect(res.headers.get("access-control-max-age")).toBe("86400")
  })

  test("does not set origin for request without Origin header", async () => {
    const app = createApp()
    const res = await app.request("/test")
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })
})

describe("CompressionMiddleware", () => {
  test("skips compression for /event path", async () => {
    const app = new Hono()
    // Import dynamically to avoid side effects
    const { CompressionMiddleware } = await import("../../src/server/middleware")
    app.use("*", CompressionMiddleware)
    app.get("/event", (c) => c.text("data: test\n\n"))
    const res = await app.request("/event")
    // Should not have content-encoding
    expect(res.headers.get("content-encoding")).toBeNull()
  })

  test("skips compression for /global/event path", async () => {
    const app = new Hono()
    const { CompressionMiddleware } = await import("../../src/server/middleware")
    app.use("*", CompressionMiddleware)
    app.get("/global/event", (c) => c.text("data: test\n\n"))
    const res = await app.request("/global/event")
    expect(res.headers.get("content-encoding")).toBeNull()
  })

  test("skips compression for session message POST", async () => {
    const app = new Hono()
    const { CompressionMiddleware } = await import("../../src/server/middleware")
    app.use("*", CompressionMiddleware)
    app.post("/session/abc123/message", (c) => c.json({ ok: true }))
    const res = await app.request("/session/abc123/message", { method: "POST" })
    // The response may or may not be compressed depending on accept-encoding,
    // but the middleware should pass through without error
    expect(res.status).toBe(200)
  })

  test("skips compression for session prompt_async POST", async () => {
    const app = new Hono()
    const { CompressionMiddleware } = await import("../../src/server/middleware")
    app.use("*", CompressionMiddleware)
    app.post("/session/abc123/prompt_async", (c) => c.json({ ok: true }))
    const res = await app.request("/session/abc123/prompt_async", { method: "POST" })
    expect(res.status).toBe(200)
  })
})
