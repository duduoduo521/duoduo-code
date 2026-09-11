import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"

// After OPT-6/15 every provider is served through `@ai-sdk/openai-compatible`
// (or the `custom` OpenAI-compatible base_url path). Cloud-vendor SDK-specific
// behavior (azure/openai `store`, google `thinkingConfig`, gateway slug remap,
// bedrock/copilot cache keys, anthropic empty-content filtering) was removed.
// These tests assert the cleaned behavior only.

function baseModel(overrides: Partial<any> = {}): any {
  return {
    id: "custom/test-model",
    providerID: "custom",
    api: {
      id: "test-model",
      url: "https://api.test.com",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    limit: { context: 128000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
    ...overrides,
  }
}

describe("ProviderTransform.options - setCacheKey", () => {
  const sessionID = "test-session-123"
  const mockModel = baseModel()

  test("should set promptCacheKey when providerOptions.setCacheKey is true", () => {
    const result = ProviderTransform.options({
      model: mockModel,
      sessionID,
      providerOptions: { setCacheKey: true },
    })
    // Stable per-model routing key — session/date independent so the cache
    // shard survives session churn and is shared across sessions of a model.
    expect(result.promptCacheKey).toBe("duoduo:custom/test-model")
  })

  test("promptCacheKey is deterministic across sessions and days", () => {
    const a = ProviderTransform.options({ model: mockModel, sessionID: "s1", providerOptions: { setCacheKey: true } })
    const b = ProviderTransform.options({ model: mockModel, sessionID: "s2", providerOptions: { setCacheKey: true } })
    expect(a.promptCacheKey).toBe(b.promptCacheKey)
  })

  test("should not set promptCacheKey when providerOptions.setCacheKey is false", () => {
    const result = ProviderTransform.options({
      model: mockModel,
      sessionID,
      providerOptions: { setCacheKey: false },
    })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should not set promptCacheKey when providerOptions is undefined", () => {
    const result = ProviderTransform.options({ model: mockModel, sessionID, providerOptions: undefined })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should not set promptCacheKey when providerOptions does not have setCacheKey", () => {
    const result = ProviderTransform.options({ model: mockModel, sessionID, providerOptions: {} })
    expect(result.promptCacheKey).toBeUndefined()
  })
})

describe("ProviderTransform.options - zai/zhipuai thinking", () => {
  const sessionID = "test-session-123"

  const createModel = (providerID: string) =>
    baseModel({
      id: `${providerID}/glm-4.6`,
      providerID,
      api: {
        id: "glm-4.6",
        url: "https://open.bigmodel.cn/api/paas/v4",
        npm: "@ai-sdk/openai-compatible",
      },
    })

  for (const providerID of ["zai-coding-plan", "zai", "zhipuai-coding-plan", "zhipuai"]) {
    test(`${providerID} should set thinking cfg`, () => {
      const result = ProviderTransform.options({
        model: createModel(providerID),
        sessionID,
        providerOptions: {},
      })

      expect(result.thinking).toEqual({
        type: "enabled",
        clear_thinking: false,
      })
    })
  }
})

describe("ProviderTransform.options - google thinkingConfig gating (removed)", () => {
  const sessionID = "test-session-123"

  // After OPT-6/15 google models are served through the OpenAI-compatible path,
  // so no google-specific `thinkingConfig` is injected. These tests lock that in.
  const createGoogleModel = (reasoning: boolean) =>
    baseModel({
      id: "google/gemini-2.0-flash",
      providerID: "google",
      api: {
        id: "gemini-2.0-flash",
        url: "https://generativelanguage.googleapis.com",
        npm: "@ai-sdk/openai-compatible",
      },
      capabilities: { ...baseModel().capabilities, reasoning },
    })

  test("does not set thinkingConfig for google models without reasoning capability", () => {
    const result = ProviderTransform.options({
      model: createGoogleModel(false),
      sessionID,
      providerOptions: {},
    })
    expect(result.thinkingConfig).toBeUndefined()
  })

  test("does not set thinkingConfig for google models with reasoning capability", () => {
    const result = ProviderTransform.options({
      model: createGoogleModel(true),
      sessionID,
      providerOptions: {},
    })
    expect(result.thinkingConfig).toBeUndefined()
  })
})

describe("ProviderTransform.options - gpt-5 textVerbosity", () => {
  const sessionID = "test-session-123"

  const createGpt5Model = (apiId: string) =>
    baseModel({
      id: `openai/${apiId}`,
      providerID: "openai",
      api: {
        id: apiId,
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai-compatible",
      },
      capabilities: { ...baseModel().capabilities, reasoning: true },
    })

  test("gpt-5.2 should have textVerbosity set to low", () => {
    const model = createGpt5Model("gpt-5.2")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBe("low")
  })

  test("gpt-5.1 should have textVerbosity set to low", () => {
    const model = createGpt5Model("gpt-5.1")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBe("low")
  })

  test("gpt-5.2-chat-latest should NOT have textVerbosity set (only supports medium)", () => {
    const model = createGpt5Model("gpt-5.2-chat-latest")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5.1-chat-latest should NOT have textVerbosity set (only supports medium)", () => {
    const model = createGpt5Model("gpt-5.1-chat-latest")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5.2-chat should NOT have textVerbosity set", () => {
    const model = createGpt5Model("gpt-5.2-chat")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5-chat should NOT have textVerbosity set", () => {
    const model = createGpt5Model("gpt-5-chat")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5.2-codex should NOT have textVerbosity set (codex models excluded)", () => {
    const model = createGpt5Model("gpt-5.2-codex")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })
})

describe("ProviderTransform.options - provider-specific flags", () => {
  const sessionID = "test-session-123"

  test("alibaba-cn reasoning model enables thinking (non kimi-k2-thinking)", () => {
    const model = baseModel({
      providerID: "alibaba-cn",
      api: { id: "qwen-plus", url: "https://dashscope.aliyuncs.com", npm: "@ai-sdk/openai-compatible" },
      capabilities: { ...baseModel().capabilities, reasoning: true },
    })
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.enable_thinking).toBe(true)
  })

  test("alibaba-cn kimi-k2-thinking does not enable thinking", () => {
    const model = baseModel({
      providerID: "alibaba-cn",
      api: { id: "kimi-k2-thinking", url: "https://dashscope.aliyuncs.com", npm: "@ai-sdk/openai-compatible" },
      capabilities: { ...baseModel().capabilities, reasoning: true },
    })
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.enable_thinking).toBeUndefined()
  })

  test("venice sets promptCacheKey", () => {
    const model = baseModel({ providerID: "venice" })
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.promptCacheKey).toBe("duoduo:venice/test-model")
  })
})

describe("ProviderTransform.providerOptions - keyed by providerID", () => {
  const createModel = (overrides: Partial<any> = {}) =>
    baseModel({
      id: "test/test-model",
      providerID: "test",
      api: {
        id: "test-model",
        url: "https://api.test.com",
        npm: "@ai-sdk/openai-compatible",
      },
      ...overrides,
    })

  test("keys options by the model providerID (openai-compatible default)", () => {
    const model = createModel()
    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "high" })).toEqual({
      test: { reasoningEffort: "high" },
    })
  })

  test("keys options by providerID regardless of npm package", () => {
    const model = createModel({
      providerID: "my-bedrock",
      api: { id: "anthropic.claude-sonnet-4", url: "https://bedrock.aws", npm: "@ai-sdk/openai-compatible" },
    })
    expect(ProviderTransform.providerOptions(model, { cachePoint: { type: "default" } })).toEqual({
      "my-bedrock": { cachePoint: { type: "default" } },
    })
  })

  test("keys options by providerID for custom OpenAI-compatible gateway model", () => {
    const model = createModel({
      providerID: "vercel",
      api: { id: "anthropic/claude-sonnet-4", url: "https://ai-gateway.vercel.sh/v3/ai", npm: "@ai-sdk/openai-compatible" },
    })
    // After OPT-6/15 there is no slug remap; the key is always the providerID.
    expect(ProviderTransform.providerOptions(model, { thinking: { type: "enabled", budgetTokens: 12_000 } })).toEqual({
      vercel: { thinking: { type: "enabled", budgetTokens: 12_000 } },
    })
  })
})

describe("ProviderTransform.variants", () => {
  const createModel = (apiId: string, overrides: Partial<any> = {}): any =>
    baseModel({
      id: `custom/${apiId}`,
      providerID: "custom",
      api: { id: apiId, url: "https://api.test.com", npm: "@ai-sdk/openai-compatible" },
      ...overrides,
    })

  test("returns empty object for non-reasoning models", () => {
    const model = createModel("gpt-4o", { capabilities: { ...baseModel().capabilities, reasoning: false } })
    expect(ProviderTransform.variants(model)).toEqual({})
  })

  test("returns the uniform effort set for deepseek reasoning models", () => {
    const model = createModel("deepseek/deepseek-v4-pro", {
      capabilities: { ...baseModel().capabilities, reasoning: true },
    })
    expect(ProviderTransform.variants(model)).toEqual({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
    })
  })

  test("returns the uniform effort set for glm reasoning models", () => {
    const model = createModel("glm-4.6", { capabilities: { ...baseModel().capabilities, reasoning: true } })
    expect(ProviderTransform.variants(model)).toEqual({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
    })
  })

  test("returns adaptive efforts for grok-3-mini", () => {
    const model = createModel("grok-3-mini", { capabilities: { ...baseModel().capabilities, reasoning: true } })
    expect(ProviderTransform.variants(model)).toEqual({
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    })
  })

  test("returns empty object for other grok models", () => {
    const model = createModel("grok-4", { capabilities: { ...baseModel().capabilities, reasoning: true } })
    expect(ProviderTransform.variants(model)).toEqual({})
  })

  test("returns the uniform widely-supported effort set for generic reasoning models", () => {
    const model = createModel("some-reasoning-model", {
      capabilities: { ...baseModel().capabilities, reasoning: true },
    })
    expect(ProviderTransform.variants(model)).toEqual({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
    })
  })
})

describe("ProviderTransform.smallOptions", () => {
  test("venice returns disableThinking", () => {
    const model = baseModel({ providerID: "venice" })
    expect(ProviderTransform.smallOptions(model)).toEqual({ veniceParameters: { disableThinking: true } })
  })

  test("other providers return empty object", () => {
    const model = baseModel({ providerID: "custom" })
    expect(ProviderTransform.smallOptions(model)).toEqual({})
  })
})

describe("ProviderTransform.schema - gemini array items", () => {
  test("adds missing items for array properties", () => {
    const geminiModel = {
      providerID: "google",
      api: {
        id: "gemini-3-pro",
      },
    } as any

    const schema = {
      type: "object",
      properties: {
        nodes: { type: "array" },
        edges: { type: "array", items: { type: "string" } },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.nodes.items).toBeDefined()
    expect(result.properties.edges.items.type).toBe("string")
  })
})

describe("ProviderTransform.schema - gemini nested array items", () => {
  const geminiModel = {
    providerID: "google",
    api: {
      id: "gemini-3-pro",
    },
  } as any

  test("adds type to 2D array with empty inner items", () => {
    const schema = {
      type: "object",
      properties: {
        values: {
          type: "array",
          items: {
            type: "array",
            items: {}, // Empty items object
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    // Inner items should have a default type
    expect(result.properties.values.items.items.type).toBe("string")
  })

  test("adds items and type to 2D array with missing inner items", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "array",
          items: { type: "array" }, // No items at all
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.data.items.items).toBeDefined()
    expect(result.properties.data.items.items.type).toBe("string")
  })

  test("handles deeply nested arrays (3D)", () => {
    const schema = {
      type: "object",
      properties: {
        matrix: {
          type: "array",
          items: {
            type: "array",
            items: {
              type: "array",
              // No items
            },
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.matrix.items.items.items).toBeDefined()
    expect(result.properties.matrix.items.items.items.type).toBe("string")
  })

  test("preserves existing item types in nested arrays", () => {
    const schema = {
      type: "object",
      properties: {
        numbers: {
          type: "array",
          items: {
            type: "array",
            items: { type: "number" }, // Has explicit type
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    // Should preserve the explicit type
    expect(result.properties.numbers.items.items.type).toBe("number")
  })

  test("handles mixed nested structures with objects and arrays", () => {
    const schema = {
      type: "object",
      properties: {
        spreadsheetData: {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: {
                type: "array",
                items: {}, // Empty items
              },
            },
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.spreadsheetData.properties.rows.items.items.type).toBe("string")
  })
})

describe("ProviderTransform.schema - gemini combiner nodes", () => {
  const geminiModel = {
    providerID: "google",
    api: {
      id: "gemini-3-pro",
    },
  } as any

  const walk = (node: any, cb: (node: any, path: (string | number)[]) => void, path: (string | number)[] = []) => {
    if (node === null || typeof node !== "object") {
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, cb, [...path, i]))
      return
    }
    cb(node, path)
    Object.entries(node).forEach(([key, value]) => walk(value, cb, [...path, key]))
  }

  test("keeps edits.items.anyOf without adding type", () => {
    const schema = {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                properties: {
                  old_string: { type: "string" },
                  new_string: { type: "string" },
                },
                required: ["old_string", "new_string"],
              },
              {
                type: "object",
                properties: {
                  old_string: { type: "string" },
                  new_string: { type: "string" },
                  replace_all: { type: "boolean" },
                },
                required: ["old_string", "new_string"],
              },
            ],
          },
        },
      },
      required: ["edits"],
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(Array.isArray(result.properties.edits.items.anyOf)).toBe(true)
    expect(result.properties.edits.items.type).toBeUndefined()
  })

  test("does not add sibling keys to combiner nodes during sanitize", () => {
    const schema = {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            anyOf: [{ type: "string" }, { type: "number" }],
          },
        },
        value: {
          oneOf: [{ type: "string" }, { type: "boolean" }],
        },
        meta: {
          allOf: [
            {
              type: "object",
              properties: { a: { type: "string" } },
            },
            {
              type: "object",
              properties: { b: { type: "string" } },
            },
          ],
        },
      },
    } as any
    const input = JSON.parse(JSON.stringify(schema))
    const result = ProviderTransform.schema(geminiModel, schema) as any

    walk(result, (node, path) => {
      const hasCombiner = Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf)
      if (!hasCombiner) {
        return
      }
      const before = path.reduce((acc: any, key) => acc?.[key], input)
      const added = Object.keys(node).filter((key) => !(key in before))
      expect(added).toEqual([])
    })
  })
})

describe("ProviderTransform.schema - gemini non-object properties removal", () => {
  const geminiModel = {
    providerID: "google",
    api: {
      id: "gemini-3-pro",
    },
  } as any

  test("removes properties from non-object types", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "string",
          properties: { invalid: { type: "string" } },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.data.type).toBe("string")
    expect(result.properties.data.properties).toBeUndefined()
  })

  test("removes required from non-object types", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "array",
          items: { type: "string" },
          required: ["invalid"],
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.data.type).toBe("array")
    expect(result.properties.data.required).toBeUndefined()
  })

  test("removes properties and required from nested non-object types", () => {
    const schema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: {
            inner: {
              type: "number",
              properties: { bad: { type: "string" } },
              required: ["bad"],
            },
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.outer.properties.inner.type).toBe("number")
    expect(result.properties.outer.properties.inner.properties).toBeUndefined()
    expect(result.properties.outer.properties.inner.required).toBeUndefined()
  })

  test("keeps properties and required on object types", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.data.type).toBe("object")
    expect(result.properties.data.properties).toBeDefined()
    expect(result.properties.data.required).toEqual(["name"])
  })

  test("does not affect non-gemini providers", () => {
    const openaiModel = {
      providerID: "openai",
      api: {
        id: "gpt-4",
      },
    } as any

    const schema = {
      type: "object",
      properties: {
        data: {
          type: "string",
          properties: { invalid: { type: "string" } },
        },
      },
    } as any

    const result = ProviderTransform.schema(openaiModel, schema) as any

    expect(result.properties.data.properties).toBeDefined()
  })
})

describe("ProviderTransform.message - DeepSeek reasoning content", () => {
  test("DeepSeek with tool calls includes reasoning_content in providerOptions", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Let me think about this..." },
          {
            type: "tool-call",
            toolCallId: "test",
            toolName: "bash",
            input: { command: "echo hello" },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(
      msgs,
      {
        id: ModelID.make("deepseek/deepseek-chat"),
        providerID: ProviderID.make("deepseek"),
        api: {
          id: "deepseek-chat",
          url: "https://api.deepseek.com",
          npm: "@ai-sdk/openai-compatible",
        },
        name: "DeepSeek Chat",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: {
            field: "reasoning_content",
          },
        },

        limit: {
          context: 128000,
          output: 8192,
        },
        status: "active",
        options: {},
        headers: {},
        release_date: "2023-04-01",
      },
      {},
    )

    expect(result).toHaveLength(1)
    expect(result[0].content).toEqual([
      {
        type: "tool-call",
        toolCallId: "test",
        toolName: "bash",
        input: { command: "echo hello" },
      },
    ])
    expect(result[0].providerOptions?.openaiCompatible?.reasoning_content).toBe("Let me think about this...")
  })

  test("Non-DeepSeek providers leave reasoning content unchanged", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Should not be processed" },
          { type: "text", text: "Answer" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(
      msgs,
      {
        id: ModelID.make("openai/gpt-4"),
        providerID: ProviderID.make("openai"),
        api: {
          id: "gpt-4",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
        name: "GPT-4",
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: false, image: true, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },

        limit: {
          context: 128000,
          output: 4096,
        },
        status: "active",
        options: {},
        headers: {},
        release_date: "2023-04-01",
      },
      {},
    )

    expect(result[0].content).toEqual([
      { type: "reasoning", text: "Should not be processed" },
      { type: "text", text: "Answer" },
    ])
    expect(result[0].providerOptions?.openaiCompatible?.reasoning_content).toBeUndefined()
  })
})

describe("ProviderTransform.message - empty image / unsupported modality handling", () => {
  const mockModel = baseModel({
    id: "custom/test-model",
    providerID: "custom",
    api: { id: "test-model", url: "https://api.test.com", npm: "@ai-sdk/openai-compatible" },
    capabilities: { ...baseModel().capabilities, input: { text: true, audio: false, image: true, video: false, pdf: true } },
  })

  test("should replace empty base64 image with error text", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", image: "data:image/png;base64," },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: "text", text: "What is in this image?" })
    expect(result[0].content[1]).toEqual({
      type: "text",
      text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
    })
  })

  test("should keep valid base64 images unchanged", () => {
    const validBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", image: `data:image/png;base64,${validBase64}` },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: "text", text: "What is in this image?" })
    expect(result[0].content[1]).toEqual({ type: "image", image: `data:image/png;base64,${validBase64}` })
  })

  test("should handle mixed valid and empty images", () => {
    const validBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "Compare these images" },
          { type: "image", image: `data:image/png;base64,${validBase64}` },
          { type: "image", image: "data:image/jpeg;base64," },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(3)
    expect(result[0].content[0]).toEqual({ type: "text", text: "Compare these images" })
    expect(result[0].content[1]).toEqual({ type: "image", image: `data:image/png;base64,${validBase64}` })
    expect(result[0].content[2]).toEqual({
      type: "text",
      text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
    })
  })

  test("should replace unsupported image modality with error text", () => {
    const model = baseModel({
      capabilities: { ...baseModel().capabilities, input: { text: true, audio: false, image: false, video: false, pdf: false } },
    })
    const validBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          { type: "image", image: `data:image/png;base64,${validBase64}` },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]
    expect(result[0].content[1].type).toBe("text")
    expect(result[0].content[1].text).toContain("does not support image input")
  })
})

describe("ProviderTransform.message - claude toolCallId scrubbing", () => {
  const claudeModel = baseModel({
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: { id: "claude-3-5-sonnet-20241022", url: "https://api.anthropic.com", npm: "@ai-sdk/openai-compatible" },
  })

  test("scrubs invalid characters from tool call ids", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "toolu_1!@#", toolName: "bash", input: { command: "ls" } },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, claudeModel, {}) as any[]
    expect(result[0].content[0].toolCallId).toBe("toolu_1___")
  })
})

describe("ProviderTransform.message - interleaved reasoning moved to openaiCompatible", () => {
  test("moves reasoning text into the configured interleaved field", () => {
    const model = baseModel({
      capabilities: {
        ...baseModel().capabilities,
        interleaved: { field: "reasoning_content" },
      },
    })
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Let me think..." },
          { type: "text", text: "Answer" },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]
    expect(result[0].content).toEqual([{ type: "text", text: "Answer" }])
    expect(result[0].providerOptions?.openaiCompatible?.reasoning_content).toBe("Let me think...")
  })
})

describe("ProviderTransform.message - cache control (openaiCompatible)", () => {
  const claudeModel = baseModel({
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: { id: "claude-3-5-sonnet-20241022", url: "https://api.anthropic.com", npm: "@ai-sdk/openai-compatible" },
  })
  const openaiModel = baseModel({
    id: "openai/gpt-4",
    providerID: "openai",
    api: { id: "gpt-4", url: "https://api.openai.com", npm: "@ai-sdk/openai-compatible" },
  })

  test("adds ephemeral cache_control for claude/anthropic models", () => {
    const msgs = [
      { role: "system", content: [{ type: "text", text: "You are helpful" }] },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, claudeModel, {}) as any[]
    expect(result[0].content[0].providerOptions?.openaiCompatible?.cache_control).toEqual({ type: "ephemeral" })
    expect(result[1].content[0].providerOptions?.openaiCompatible?.cache_control).toEqual({ type: "ephemeral" })
  })

  test("does not add cache_control for non-claude/anthropic models", () => {
    const msgs = [
      { role: "system", content: [{ type: "text", text: "You are helpful" }] },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, openaiModel, {}) as any[]
    expect(result[0].content[0].providerOptions?.openaiCompatible).toBeUndefined()
    expect(result[1].content[0].providerOptions?.openaiCompatible).toBeUndefined()
  })
})

describe("ProviderTransform.message - strip openai metadata when store=false", () => {
  const openaiModel = {
    id: "openai/gpt-5",
    providerID: "openai",
    api: {
      id: "gpt-5",
      url: "https://api.openai.com",
      npm: "@ai-sdk/openai",
    },
    name: "GPT-5",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },

    limit: { context: 128000, output: 4096 },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("preserves itemId and reasoningEncryptedContent when store=false", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking...",
            providerOptions: {
              openai: {
                itemId: "rs_123",
                reasoningEncryptedContent: "encrypted",
              },
            },
          },
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_456",
              },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, openaiModel, { store: false }) as any[]

    expect(result).toHaveLength(1)
    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("rs_123")
    expect(result[0].content[1].providerOptions?.openai?.itemId).toBe("msg_456")
  })

  test("preserves itemId and reasoningEncryptedContent when store=false even when not openai", () => {
    const zenModel = {
      ...openaiModel,
      providerID: "zen",
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking...",
            providerOptions: {
              openai: {
                itemId: "rs_123",
                reasoningEncryptedContent: "encrypted",
              },
            },
          },
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_456",
              },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, zenModel, { store: false }) as any[]

    expect(result).toHaveLength(1)
    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("rs_123")
    expect(result[0].content[1].providerOptions?.openai?.itemId).toBe("msg_456")
  })

  test("preserves other openai options including itemId", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_123",
                otherOption: "value",
              },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, openaiModel, { store: false }) as any[]

    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_123")
    expect(result[0].content[0].providerOptions?.openai?.otherOption).toBe("value")
  })

  test("preserves metadata for openai package when store is true", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_123",
              },
            },
          },
        ],
      },
    ] as any[]

    // openai package preserves itemId regardless of store value
    const result = ProviderTransform.message(msgs, openaiModel, { store: true }) as any[]

    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_123")
  })

  test("preserves metadata for non-openai packages when store is false", () => {
    const anthropicModel = {
      ...openaiModel,
      providerID: "anthropic",
      api: {
        id: "claude-3",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_123",
              },
            },
          },
        ],
      },
    ] as any[]

    // store=false preserves metadata for non-openai packages
    const result = ProviderTransform.message(msgs, anthropicModel, { store: false }) as any[]

    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_123")
  })

  test("preserves metadata using providerID key when store is false", () => {
    const duoduoModel = {
      ...openaiModel,
      providerID: "duoduo",
      api: {
        id: "duoduo-test",
        url: "https://api.www.dd322.cn/code",
        npm: "@ai-sdk/openai-compatible",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              duoduo: {
                itemId: "msg_123",
                otherOption: "value",
              },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, duoduoModel, { store: false }) as any[]

    expect(result[0].content[0].providerOptions?.duoduo?.itemId).toBe("msg_123")
    expect(result[0].content[0].providerOptions?.duoduo?.otherOption).toBe("value")
  })

  test("preserves itemId across all providerOptions keys", () => {
    const duoduoModel = {
      ...openaiModel,
      providerID: "duoduo",
      api: {
        id: "duoduo-test",
        url: "https://api.www.dd322.cn/code",
        npm: "@ai-sdk/openai-compatible",
      },
    }
    const msgs = [
      {
        role: "assistant",
        providerOptions: {
          openai: { itemId: "msg_root" },
          duoduo: { itemId: "msg.duoduo" },
          extra: { itemId: "msg_extra" },
        },
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: { itemId: "msg_openai_part" },
              duoduo: { itemId: "msg.duoduo_part" },
              extra: { itemId: "msg_extra_part" },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, duoduoModel, { store: false }) as any[]

    expect(result[0].providerOptions?.openai?.itemId).toBe("msg_root")
    expect(result[0].providerOptions?.duoduo?.itemId).toBe("msg.duoduo")
    expect(result[0].providerOptions?.extra?.itemId).toBe("msg_extra")
    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_openai_part")
    expect(result[0].content[0].providerOptions?.duoduo?.itemId).toBe("msg.duoduo_part")
    expect(result[0].content[0].providerOptions?.extra?.itemId).toBe("msg_extra_part")
  })

  test("does not strip metadata for non-openai packages when store is not false", () => {
    const anthropicModel = {
      ...openaiModel,
      providerID: "anthropic",
      api: {
        id: "claude-3",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_123",
              },
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {}) as any[]

    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_123")
  })
})
