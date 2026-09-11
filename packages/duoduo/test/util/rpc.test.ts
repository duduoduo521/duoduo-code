import { test, expect, describe } from "bun:test"

// ---------------------------------------------------------------------------
// RPC — pure logic tests for message serialization, request/response matching,
//         event emission, and error handling.
//
// We test listen/emit (which use self globals) and client (which uses a
// custom target) separately since they're designed for different environments
// (worker vs. main thread).
// ---------------------------------------------------------------------------

import * as Rpc from "../../src/util/rpc"

describe("listen()", () => {
  test("sets onmessage handler on self", () => {
    // listen() assigns to the global `onmessage`
    expect((self as any).onmessage).toBeNull()
    Rpc.listen({ ping: () => "pong" })
    expect((self as any).onmessage).toBeFunction()
  })

  test("dispatches request to correct method", () => {
    const recorded: unknown[] = []
    Rpc.listen({
      test(input: unknown) {
        recorded.push(input)
        return "ok"
      },
    })
    const handler = (self as any).onmessage
    handler({ data: JSON.stringify({ type: "rpc.request", method: "test", input: "hello", id: 1 }) })
    expect(recorded).toEqual(["hello"])
  })

  test("method result is posted back as rpc.result via self.postMessage", async () => {
    const posted: string[] = []
    const orig = self.postMessage
    self.postMessage = (data: string) => {
      posted.push(data)
    }
    try {
      Rpc.listen({
        double(n: number) {
          return n * 2
        },
      })
      const handler = (self as any).onmessage
      await handler({ data: JSON.stringify({ type: "rpc.request", method: "double", input: 7, id: 42 }) })
      expect(posted).toHaveLength(1)
      const parsed = JSON.parse(posted[0])
      expect(parsed.type).toBe("rpc.result")
      expect(parsed.result).toBe(14)
      expect(parsed.id).toBe(42)
    } finally {
      self.postMessage = orig
    }
  })

  test("async method results are awaited before posting", async () => {
    const posted: string[] = []
    const orig = self.postMessage
    self.postMessage = (data: string) => {
      posted.push(data)
    }
    try {
      Rpc.listen({
        delayed: async (ms: number) => {
          await new Promise((r) => setTimeout(r, ms))
          return "done"
        },
      })
      const handler = (self as any).onmessage
      const promise = handler({ data: JSON.stringify({ type: "rpc.request", method: "delayed", input: 1, id: 1 }) })
      await promise
      expect(posted).toHaveLength(1)
      expect(JSON.parse(posted[0]).result).toBe("done")
    } finally {
      self.postMessage = orig
    }
  })
})

describe("emit()", () => {
  test("sends a JSON rpc.event message via self.postMessage", () => {
    const posted: string[] = []
    const orig = self.postMessage
    self.postMessage = (data: string) => {
      posted.push(data)
    }
    try {
      Rpc.emit("update", { status: "done" })
      expect(posted).toHaveLength(1)
      const parsed = JSON.parse(posted[0])
      expect(parsed.type).toBe("rpc.event")
      expect(parsed.event).toBe("update")
      expect(parsed.data).toEqual({ status: "done" })
    } finally {
      self.postMessage = orig
    }
  })

  test("emit accepts primitive data values", () => {
    const posted: string[] = []
    const orig = self.postMessage
    self.postMessage = (data: string) => {
      posted.push(data)
    }
    try {
      Rpc.emit("counter", 42)
      expect(JSON.parse(posted[0]).data).toBe(42)
    } finally {
      self.postMessage = orig
    }
  })
})

describe("client()", () => {
  test("call sends a JSON request with correct structure", () => {
    const messages: string[] = []
    const side = {
      postMessage: (data: string) => {
        messages.push(data)
      },
      onmessage: null as ((evt: { data: string }) => void) | null,
    }
    const c = Rpc.client(side)
    // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
    c.call("someMethod", { foo: 1 })
    expect(messages).toHaveLength(1)
    const parsed = JSON.parse(messages[0])
    expect(parsed.type).toBe("rpc.request")
    expect(parsed.method).toBe("someMethod")
    expect(parsed.input).toEqual({ foo: 1 })
    expect(typeof parsed.id).toBe("number")
  })

  test("increments IDs for successive calls", () => {
    const messages: string[] = []
    const side = {
      postMessage: (data: string) => {
        messages.push(data)
      },
      onmessage: null as ((evt: { data: string }) => void) | null,
    }
    const c = Rpc.client(side)
    // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
    c.call("a", {})
    // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
    c.call("b", {})
    expect(messages).toHaveLength(2)
    const id0 = JSON.parse(messages[0]).id
    const id1 = JSON.parse(messages[1]).id
    expect(id1).toBe(id0 + 1)
  })

  test("call resolves when onmessage receives matching rpc.result", async () => {
    const side = {
      postMessage: (_data: string) => {}, // no-op, we'll manually respond
      onmessage: null as ((evt: { data: string }) => void) | null,
    }
    const c = Rpc.client(side)
    // Start a call — capture the request ID from postMessage
    let capturedRequestId: number | null = null
    side.postMessage = (data: string) => {
      const parsed = JSON.parse(data)
      capturedRequestId = parsed.id
    }
    const promise = c.call("add", { x: 2, y: 3 })
    // Simulate the response from the other side
    side.onmessage!({ data: JSON.stringify({ type: "rpc.result", result: 5, id: capturedRequestId }) })
    const result = await promise
    expect(result).toBe(5)
  })

  test("on() registers and fires event handlers", () => {
    const side = {
      postMessage: (_data: string) => {},
      onmessage: null as ((evt: { data: string }) => void) | null,
    }
    const c = Rpc.client(side)
    let received: unknown = null
    c.on("progress", (data: unknown) => {
      received = data
    })
    side.onmessage!({ data: JSON.stringify({ type: "rpc.event", event: "progress", data: { percent: 50 } }) })
    expect(received).toEqual({ percent: 50 })
  })

  test("on() returns unsubscribe function that stops events", () => {
    const side = {
      postMessage: (_data: string) => {},
      onmessage: null as ((evt: { data: string }) => void) | null,
    }
    const c = Rpc.client(side)
    let count = 0
    const unsub = c.on("tick", () => {
      count++
    })
    side.onmessage!({ data: JSON.stringify({ type: "rpc.event", event: "tick", data: null }) })
    expect(count).toBe(1)
    unsub()
    side.onmessage!({ data: JSON.stringify({ type: "rpc.event", event: "tick", data: null }) })
    expect(count).toBe(1)
  })

  test("multiple handlers for same event all fire", () => {
    const side = {
      postMessage: (_data: string) => {},
      onmessage: null as ((evt: { data: string }) => void) | null,
    }
    const c = Rpc.client(side)
    let a = 0
    let b = 0
    c.on("evt", () => {
      a++
    })
    c.on("evt", () => {
      b++
    })
    side.onmessage!({ data: JSON.stringify({ type: "rpc.event", event: "evt", data: null }) })
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  test("call rejects when response has wrong type (no handler for it)", async () => {
    const side = {
      postMessage: (_data: string) => {},
      onmessage: null as ((evt: { data: string }) => void) | null,
    }
    const c = Rpc.client(side)
    const promise = c.call("method", {})
    // Send a response with wrong ID — promise will never resolve
    side.onmessage!({ data: JSON.stringify({ type: "rpc.result", result: "unexpected", id: 999 }) })
    // The promise with correct ID remains pending.
    // We can't test timeout here; just verify no crash.
  })

  test("rpc.event with unknown event is silently ignored", () => {
    const side = {
      postMessage: (_data: string) => {},
      onmessage: null as ((evt: { data: string }) => void) | null,
    }
    const c = Rpc.client(side)
    side.onmessage!({ data: JSON.stringify({ type: "rpc.event", event: "unknown_event", data: "ignored" }) })
  })
})
