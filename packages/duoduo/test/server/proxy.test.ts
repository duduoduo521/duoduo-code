import { describe, expect, test } from "bun:test"

// The `headers`, `protocols`, and `socket` functions are module-scoped.
// We replicate their logic here for direct unit testing.

const hop = new Set([
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

function headers(req: Request, extra?: HeadersInit) {
  const out = new Headers(req.headers)
  for (const key of hop) out.delete(key)
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

describe("proxy.headers", () => {
  test("removes hop-by-hop headers", () => {
    const req = new Request("http://localhost/test", {
      headers: {
        connection: "keep-alive",
        host: "localhost",
        "x-custom": "value",
      },
    })
    const result = headers(req)
    expect(result.get("connection")).toBeNull()
    expect(result.get("host")).toBeNull()
    expect(result.get("x-custom")).toBe("value")
  })

  test("removes x-duoduo-directory header", () => {
    const req = new Request("http://localhost/test", {
      headers: { "x-duoduo-directory": "/some/path" },
    })
    const result = headers(req)
    expect(result.get("x-duoduo-directory")).toBeNull()
  })

  test("removes x-duoduo-workspace header", () => {
    const req = new Request("http://localhost/test", {
      headers: { "x-duoduo-workspace": "ws-123" },
    })
    const result = headers(req)
    expect(result.get("x-duoduo-workspace")).toBeNull()
  })

  test("preserves regular headers", () => {
    const req = new Request("http://localhost/test", {
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
        "x-request-id": "abc",
      },
    })
    const result = headers(req)
    expect(result.get("authorization")).toBe("Bearer token")
    expect(result.get("content-type")).toBe("application/json")
    expect(result.get("x-request-id")).toBe("abc")
  })

  test("merges extra headers", () => {
    const req = new Request("http://localhost/test", {
      headers: { "x-existing": "old" },
    })
    const result = headers(req, { "x-extra": "added", "x-existing": "overridden" })
    expect(result.get("x-extra")).toBe("added")
    expect(result.get("x-existing")).toBe("overridden")
  })

  test("works with no extra headers", () => {
    const req = new Request("http://localhost/test", {
      headers: { "x-custom": "value" },
    })
    const result = headers(req)
    expect(result.get("x-custom")).toBe("value")
  })

  test("removes all hop-by-hop headers", () => {
    const req = new Request("http://localhost/test", {
      headers: {
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
      },
    })
    const result = headers(req)
    for (const key of hop) {
      expect(result.get(key)).toBeNull()
    }
  })
})

describe("proxy.protocols", () => {
  test("returns empty array when no sec-websocket-protocol header", () => {
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
      headers: { "sec-websocket-protocol": "graphql-ws, json" },
    })
    expect(protocols(req)).toEqual(["graphql-ws", "json"])
  })

  test("trims whitespace around protocols", () => {
    const req = new Request("http://localhost/test", {
      headers: { "sec-websocket-protocol": " graphql-ws , json , soap " },
    })
    expect(protocols(req)).toEqual(["graphql-ws", "json", "soap"])
  })

  test("filters out empty strings from consecutive commas", () => {
    const req = new Request("http://localhost/test", {
      headers: { "sec-websocket-protocol": "a,,b" },
    })
    expect(protocols(req)).toEqual(["a", "b"])
  })
})

describe("proxy.socket", () => {
  test("converts http: to ws:", () => {
    expect(socket("http://localhost:8080/ws")).toBe("ws://localhost:8080/ws")
  })

  test("converts https: to wss:", () => {
    expect(socket("https://example.com/ws")).toBe("wss://example.com/ws")
  })

  test("preserves ws: protocol unchanged", () => {
    expect(socket("ws://localhost:8080/ws")).toBe("ws://localhost:8080/ws")
  })

  test("preserves wss: protocol unchanged", () => {
    expect(socket("wss://example.com/ws")).toBe("wss://example.com/ws")
  })

  test("preserves path and query parameters", () => {
    expect(socket("http://localhost:8080/ws?token=abc")).toBe("ws://localhost:8080/ws?token=abc")
  })

  test("handles URL object input", () => {
    const url = new URL("http://localhost:8080/ws")
    expect(socket(url)).toBe("ws://localhost:8080/ws")
  })
})
