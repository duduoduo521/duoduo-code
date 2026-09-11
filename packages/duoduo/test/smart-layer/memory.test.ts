import { describe, test, expect } from "bun:test"
import { MemoryClient } from "../../src/smart-layer/memory"
import type { SmartLayerClient } from "../../src/smart-layer/client"

/**
 * Creates a mock SmartLayerClient that records all calls and returns
 * predetermined values.
 */
function createMockClient() {
  const calls: Array<{ method: string; path: string; body?: unknown; params?: Record<string, string> }> = []

  const mockClient = {
    calls,

    get<T>(path: string, params?: Record<string, string>): Promise<T> {
      calls.push({ method: "GET", path, params })
      return Promise.resolve({ _mock: true, method: "GET", path } as T)
    },

    post<T>(path: string, body?: unknown): Promise<T> {
      calls.push({ method: "POST", path, body })
      return Promise.resolve({ _mock: true, method: "POST", path, body } as T)
    },

    put<T>(path: string, body?: unknown): Promise<T> {
      calls.push({ method: "PUT", path, body })
      return Promise.resolve({ _mock: true, method: "PUT", path, body } as T)
    },

    del<T>(path: string, params?: Record<string, string>): Promise<T> {
      calls.push({ method: "DELETE", path, params })
      return Promise.resolve({ _mock: true, method: "DELETE", path } as T)
    },
  } as unknown as SmartLayerClient

  return mockClient
}

describe("MemoryClient", () => {
  test("search calls POST /memory/search with correct body", async () => {
    const mock = createMockClient()
    const client = new MemoryClient(mock)
    await client.search("test query", 5, ["L1", "L2"], ["tag1"], "/project")

    expect((mock as any).calls).toHaveLength(1)
    const call = (mock as any).calls[0]!
    expect(call.method).toBe("POST")
    expect(call.path).toBe("/memory/search")
    expect(call.body).toEqual({
      query: "test query",
      limit: 5,
      layers: ["L1", "L2"],
      tags: ["tag1"],
      projectPath: "/project",
    })
  })

  test("search uses default limit=10", async () => {
    const mock = createMockClient()
    const client = new MemoryClient(mock)
    await client.search("hello")

    const call = (mock as any).calls[0]!
    expect(call.body).toEqual({
      query: "hello",
      limit: 10,
      layers: undefined,
      tags: undefined,
      projectPath: undefined,
    })
  })

  test("store calls POST /memory/store with camelCase wire format (P1-11)", async () => {
    const mock = createMockClient()
    const client = new MemoryClient(mock)
    await client.store("content", "L1", {
      importance: 0.8,
      pin: true,
      sessionId: "sess-1",
      memoryType: "fact",
      metadata: { key: "val" },
      tags: ["t1"],
      projectPath: "/proj",
    })

    const call = (mock as any).calls[0]!
    expect(call.method).toBe("POST")
    expect(call.path).toBe("/memory/store")
    expect(call.body).toEqual({
      id: undefined,
      content: "content",
      layer: "L1",
      importance: 0.8,
      pin: true,
      sessionId: "sess-1",
      memoryType: "fact",
      metadata: { key: "val" },
      tags: ["t1"],
      projectPath: "/proj",
    })
  })

  test("store without options maps correctly", async () => {
    const mock = createMockClient()
    const client = new MemoryClient(mock)
    await client.store("content", "L2")

    const call = (mock as any).calls[0]!
    expect(call.body).toEqual({
      id: undefined,
      content: "content",
      layer: "L2",
      importance: undefined,
      pin: undefined,
      sessionId: undefined,
      memoryType: undefined,
      metadata: undefined,
      tags: undefined,
      projectPath: undefined,
    })
  })












  test("getProfile calls GET /memory/profile with params", async () => {
    const mock = createMockClient()
    const client = new MemoryClient(mock)
    await client.getProfile("user1", "proj1")

    const call = (mock as any).calls[0]!
    expect(call.method).toBe("GET")
    expect(call.path).toBe("/memory/profile")
    expect(call.params).toEqual({ user_id: "user1", project_id: "proj1" })
  })

  test("getProfile with default userId", async () => {
    const mock = createMockClient()
    const client = new MemoryClient(mock)
    await client.getProfile()

    const call = (mock as any).calls[0]!
    expect(call.params).toEqual({ user_id: "default" })
  })

  test("updateProfile calls POST /memory/profile with camelCase", async () => {
    const mock = createMockClient()
    const client = new MemoryClient(mock)
    await client.updateProfile({
      content: "prefers dark mode",
      category: "ui",
      userId: "user1",
      projectId: "proj1",
      metadata: { source: "inferred" },
    })

    const call = (mock as any).calls[0]!
    expect(call.method).toBe("POST")
    expect(call.path).toBe("/memory/profile")
    expect(call.body).toEqual({
      content: "prefers dark mode",
      category: "ui",
      userId: "user1",
      projectId: "proj1",
      metadata: { source: "inferred" },
    })
  })



















})
