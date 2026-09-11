import { describe, expect, test } from "bun:test"
import { paramToAttributeKey, requestAttributes } from "../../src/server/routes/instance/trace"
import type { RequestLike } from "../../src/server/routes/instance/trace"

describe("server/trace.paramToAttributeKey", () => {
  test("converts sessionID to session.id", () => {
    expect(paramToAttributeKey("sessionID")).toBe("session.id")
  })

  test("converts messageID to message.id", () => {
    expect(paramToAttributeKey("messageID")).toBe("message.id")
  })

  test("converts partID to part.id", () => {
    expect(paramToAttributeKey("partID")).toBe("part.id")
  })

  test("converts requestID to request.id", () => {
    expect(paramToAttributeKey("requestID")).toBe("request.id")
  })

  test("namespaces non-ID params under duoduo.", () => {
    expect(paramToAttributeKey("name")).toBe("duoduo.name")
    expect(paramToAttributeKey("command")).toBe("duoduo.command")
    expect(paramToAttributeKey("type")).toBe("duoduo.type")
  })

  test("handles single-char keys", () => {
    expect(paramToAttributeKey("aID")).toBe("a.id")
  })
})

describe("server/trace.requestAttributes", () => {
  function makeRequest(method: string, url: string, params: Record<string, string> = {}): RequestLike {
    return {
      req: {
        method,
        url,
        param: () => params,
      },
    }
  }

  test("includes http.method and http.path", () => {
    const attrs = requestAttributes(makeRequest("GET", "http://localhost/session/sess_1"))
    expect(attrs["http.method"]).toBe("GET")
    expect(attrs["http.path"]).toBe("/session/sess_1")
  })

  test("includes route params converted to attribute keys", () => {
    const attrs = requestAttributes(
      makeRequest("POST", "http://localhost/session/sess_1/message", {
        sessionID: "sess_1",
      }),
    )
    expect(attrs["session.id"]).toBe("sess_1")
  })

  test("includes multiple route params", () => {
    const attrs = requestAttributes(
      makeRequest("GET", "http://localhost/session/sess_1/message/msg_1", {
        sessionID: "sess_1",
        messageID: "msg_1",
      }),
    )
    expect(attrs["session.id"]).toBe("sess_1")
    expect(attrs["message.id"]).toBe("msg_1")
  })

  test("handles request with no params", () => {
    const attrs = requestAttributes(makeRequest("GET", "http://localhost/health"))
    expect(attrs["http.method"]).toBe("GET")
    expect(attrs["http.path"]).toBe("/health")
    expect(Object.keys(attrs).filter((k) => k.startsWith("duoduo.") || k.includes(".id"))).toEqual([])
  })

  test("namespaces non-ID params", () => {
    const attrs = requestAttributes(
      makeRequest("GET", "http://localhost/search", { query: "test" }),
    )
    expect(attrs["duoduo.query"]).toBe("test")
  })
})
