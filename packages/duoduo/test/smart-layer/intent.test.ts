import { describe, test, expect } from "bun:test"
import { IntentClient } from "../../src/smart-layer/intent"
import type { SmartLayerClient } from "../../src/smart-layer/client"

function createMockClient() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []

  const mockClient = {
    calls,

    get<T>(path: string, params?: Record<string, string>): Promise<T> {
      calls.push({ method: "GET", path, body: params })
      return Promise.resolve({ _mock: true } as T)
    },

    post<T>(path: string, body?: unknown): Promise<T> {
      calls.push({ method: "POST", path, body })
      return Promise.resolve({ _mock: true } as T)
    },

    put<T>(path: string, body?: unknown): Promise<T> {
      calls.push({ method: "PUT", path, body })
      return Promise.resolve({ _mock: true } as T)
    },

    del<T>(path: string, params?: Record<string, string>): Promise<T> {
      calls.push({ method: "DELETE", path, body: params })
      return Promise.resolve({ _mock: true } as T)
    },
  } as unknown as SmartLayerClient

  return mockClient
}

describe("IntentClient", () => {
  test("clarify: POST /intent/clarify with request body", async () => {
    const mock = createMockClient()
    const client = new IntentClient(mock)
    await client.clarify({
      user_input: "How do I fix the auth bug?",
    })

    expect((mock as any).calls).toHaveLength(1)
    const call = (mock as any).calls[0]!
    expect(call.method).toBe("POST")
    expect(call.path).toBe("/intent/clarify")
    expect(call.body).toEqual({
      user_input: "How do I fix the auth bug?",
    })
  })

  test("clarify with project_context", async () => {
    const mock = createMockClient()
    const client = new IntentClient(mock)
    await client.clarify({
      user_input: "Refactor the API",
      project_context: { language: "typescript", framework: "hono" },
    })

    const call = (mock as any).calls[0]!
    expect(call.body).toEqual({
      user_input: "Refactor the API",
      project_context: { language: "typescript", framework: "hono" },
    })
  })
})
