import { describe, expect, test } from "bun:test"

// The `headers`, `protocols`, and `socket` functions are module-scoped in proxy.ts
// and not exported. We replicate the logic here for unit testing.
// This follows the same pattern used in workspace.test.ts for `local()` and `getSessionID()`.

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
])

function proxyHeaders(req: Request, extra?: HeadersInit) {
  const out = new Headers(req.headers)
  for (const key of HOP_HEADERS) out.delete(key)
  out.delete("x-duoduo-directory")
  out.delete("x-duoduo-workspace")
  if (!extra) return out
  for (const [key, value] of new Headers(extra).entries()) {
    out.set(key, value)
  }
  return out
}

function protocols(req: Request) {
  const value = req.headers.get("sec-websocket-protocol")
  if (!value) return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function socket(url: string | URL) {
  const next = new URL(url)
  if (next.protocol === "http:") next.protocol = "ws:"
  if (next.protocol === "https:") next.protocol = "wss:"
  return next.toString()
}

// ─── proxyHeaders ───

describe("ServerProxy.headers", () => {
  test("removes hop-by-hop headers", () => {
    const req = new Request("http://localhost/test", {
      headers: {
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked",
        host: "localhost",
        "content-type": "application/json",
      },
    })
    const result = proxyHeaders(req)
    expect(result.get("connection")).toBeNull()
    expect(result.get("keep-alive")).toBeNull()
    expect(result.get("transfer-encoding")).toBeNull()
    expect(result.get("host")).toBeNull()
    expect(result.get("content-type")).toBe("application/json")
  })

  test("removes x-duoduo-directory header", () => {
    const req = new Request("http://localhost/test", {
      headers: { "x-duoduo-directory": "/home/user/project" },
    })
    const result = proxyHeaders(req)
    expect(result.get("x-duoduo-directory")).toBeNull()
  })

  test("removes x-duoduo-workspace header", () => {
    const req = new Request("http://localhost/test", {
      headers: { "x-duoduo-workspace": "ws-123" },
    })
    const result = proxyHeaders(req)
    expect(result.get("x-duoduo-workspace")).toBeNull()
  })

  test("preserves other headers", () => {
    const req = new Request("http://localhost/test", {
      headers: {
        authorization: "Bearer token123",
        "content-type": "application/json",
        "x-custom": "value",
      },
    })
    const result = proxyHeaders(req)
    expect(result.get("authorization")).toBe("Bearer token123")
    expect(result.get("content-type")).toBe("application/json")
    expect(result.get("x-custom")).toBe("value")
  })

  test("merges extra headers", () => {
    const req = new Request("http://localhost/test", {
      headers: { "content-type": "application/json" },
    })
    const result = proxyHeaders(req, { "X-Extra": "extra-value" })
    expect(result.get("x-extra")).toBe("extra-value")
    expect(result.get("content-type")).toBe("application/json")
  })

  test("extra headers override request headers", () => {
    const req = new Request("http://localhost/test", {
      headers: { authorization: "original" },
    })
    const result = proxyHeaders(req, { Authorization: "overridden" })
    expect(result.get("authorization")).toBe("overridden")
  })

  test("returns headers without extra when not provided", () => {
    const req = new Request("http://localhost/test", {
      headers: { "content-type": "text/plain" },
    })
    const result = proxyHeaders(req)
    expect(result.get("content-type")).toBe("text/plain")
  })

  test("removes all hop-by-hop headers comprehensively", () => {
    const allHopHeaders: Record<string, string> = {
      connection: "close",
      "keep-alive": "timeout=5",
      "proxy-authenticate": "Basic",
      "proxy-authorization": "Basic abc",
      "proxy-connection": "keep-alive",
      te: "trailers",
      trailer: "x-trailer",
      "transfer-encoding": "chunked",
      upgrade: "websocket",
      host: "example.com",
    }
    const req = new Request("http://localhost/test", { headers: allHopHeaders })
    const result = proxyHeaders(req)
    for (const key of Object.keys(allHopHeaders)) {
      expect(result.get(key)).toBeNull()
    }
  })
})

// ─── protocols ───

describe("ServerProxy.protocols", () => {
  test("returns empty array when sec-websocket-protocol is missing", () => {
    const req = new Request("http://localhost/test")
    expect(protocols(req)).toEqual([])
  })

  test("parses single protocol", () => {
    const req = new Request("http://localhost/test", {
      headers: { "sec-websocket-protocol": "graphql-ws" },
    })
    expect(protocols(req)).toEqual(["graphql-ws"])
  })

  test("parses multiple comma-separated protocols", () => {
    const req = new Request("http://localhost/test", {
      headers: { "sec-websocket-protocol": "graphql-ws, graphql-transport-ws" },
    })
    expect(protocols(req)).toEqual(["graphql-ws", "graphql-transport-ws"])
  })

  test("trims whitespace from protocols", () => {
    const req = new Request("http://localhost/test", {
      headers: { "sec-websocket-protocol": " graphql-ws , graphql-transport-ws " },
    })
    expect(protocols(req)).toEqual(["graphql-ws", "graphql-transport-ws"])
  })

  test("filters out empty strings from protocol list", () => {
    const req = new Request("http://localhost/test", {
      headers: { "sec-websocket-protocol": "graphql-ws,,graphql-transport-ws" },
    })
    expect(protocols(req)).toEqual(["graphql-ws", "graphql-transport-ws"])
  })
})

// ─── socket ───

describe("ServerProxy.socket", () => {
  test("converts http: to ws:", () => {
    expect(socket("http://localhost:8080/ws")).toBe("ws://localhost:8080/ws")
  })

  test("converts https: to wss:", () => {
    expect(socket("https://localhost:8080/ws")).toBe("wss://localhost:8080/ws")
  })

  test("preserves ws: protocol", () => {
    expect(socket("ws://localhost:8080/ws")).toBe("ws://localhost:8080/ws")
  })

  test("preserves wss: protocol", () => {
    expect(socket("wss://localhost:8080/ws")).toBe("wss://localhost:8080/ws")
  })

  test("preserves path and query string", () => {
    expect(socket("http://localhost:8080/api/ws?token=abc")).toBe("ws://localhost:8080/api/ws?token=abc")
  })

  test("handles URL object input", () => {
    const url = new URL("http://localhost:8080/ws")
    expect(socket(url)).toBe("ws://localhost:8080/ws")
  })
})
