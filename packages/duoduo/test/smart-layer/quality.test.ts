import { describe, test, expect } from "bun:test"
import { QualityClient } from "../../src/smart-layer/quality"
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

describe("QualityClient", () => {
  test("validate: POST /quality/validate with request body", async () => {
    const mock = createMockClient()
    const client = new QualityClient(mock)
    await client.validate({
      artifact: {
        type: "function",
        content: "function add(a, b) { return a + b; }",
        language: "typescript",
        file_path: "src/math.ts",
      },
      quality_level: "self_check",
    })

    expect((mock as any).calls).toHaveLength(1)
    const call = (mock as any).calls[0]!
    expect(call.method).toBe("POST")
    expect(call.path).toBe("/quality/validate")
    expect(call.body).toEqual({
      artifact: {
        type: "function",
        content: "function add(a, b) { return a + b; }",
        language: "typescript",
        file_path: "src/math.ts",
      },
      quality_level: "self_check",
    })
  })

  test("validate with optional fields", async () => {
    const mock = createMockClient()
    const client = new QualityClient(mock)
    await client.validate({
      artifact: {
        type: "class",
        content: "class Foo {}",
        language: "python",
      },
      quality_level: "full",
      interfaceContract: {
        extends: "Base",
        properties: { id: "string" },
        methods: {},
      },
      sharedTypes: [
        {
          name: "Status",
          kind: "enum",
          values: ["active", "inactive"],
          file: "types.ts",
        },
      ],
    })

    const call = (mock as any).calls[0]!
    expect(call.body).toEqual({
      artifact: {
        type: "class",
        content: "class Foo {}",
        language: "python",
      },
      quality_level: "full",
      interfaceContract: {
        extends: "Base",
        properties: { id: "string" },
        methods: {},
      },
      sharedTypes: [
        {
          name: "Status",
          kind: "enum",
          values: ["active", "inactive"],
          file: "types.ts",
        },
      ],
    })
  })
})
