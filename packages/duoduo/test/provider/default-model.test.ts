import { describe, expect, test } from "bun:test"
import { defaultModelIDs } from "../../src/provider/provider"

describe("Provider.defaultModelIDs", () => {
  test("returns empty default IDs when no providers given", () => {
    const result = defaultModelIDs({})
    expect(result).toEqual({})
  })

  test("returns default model ID for single provider", () => {
    const providers = {
      anthropic: {
        id: "anthropic",
        name: "Anthropic",
        source: "models.dev",
        env: ["ANTHROPIC_API_KEY"],
        key: "anthropic",
        options: {},
        models: {
          "claude-sonnet-4-20250514": {
            id: "claude-sonnet-4-20250514",
            providerID: "anthropic",
            api: { id: "claude-sonnet-4-20250514", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
            name: "Claude Sonnet 4",
            family: "claude",
            capabilities: {
              temperature: true,
              reasoning: true,
              attachment: true,
              toolcall: true,
              input: { text: true, audio: false, image: true, video: false, pdf: false },
              output: { text: true, audio: false, image: false, video: false, pdf: false },
              interleaved: undefined,
            },

            limit: { context: 200000, input: undefined, output: 64000 },
            status: "active",
            options: {},
            headers: {},
          },
        },
      },
    } as any

    const result = defaultModelIDs(providers)
    expect(result.anthropic).toBeDefined()
    expect(typeof result.anthropic).toBe("string")
  })

  test("returns default model IDs for multiple providers", () => {
    const providers = {
      openai: {
        id: "openai",
        name: "OpenAI",
        source: "models.dev",
        env: ["OPENAI_API_KEY"],
        key: "openai",
        options: {},
        models: {
          "gpt-4o": {
            id: "gpt-4o",
            providerID: "openai",
            api: { id: "gpt-4o", url: "https://api.openai.com", npm: "@ai-sdk/openai" },
            name: "GPT-4o",
            family: "gpt",
            capabilities: {
              temperature: true,
              reasoning: false,
              attachment: true,
              toolcall: true,
              input: { text: true, audio: false, image: true, video: false, pdf: false },
              output: { text: true, audio: false, image: false, video: false, pdf: false },
              interleaved: undefined,
            },

            limit: { context: 128000, input: undefined, output: 4096 },
            status: "active",
            options: {},
            headers: {},
          },
        },
      },
      anthropic: {
        id: "anthropic",
        name: "Anthropic",
        source: "models.dev",
        env: ["ANTHROPIC_API_KEY"],
        key: "anthropic",
        options: {},
        models: {
          "claude-sonnet-4-20250514": {
            id: "claude-sonnet-4-20250514",
            providerID: "anthropic",
            api: { id: "claude-sonnet-4-20250514", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
            name: "Claude Sonnet 4",
            family: "claude",
            capabilities: {
              temperature: true,
              reasoning: true,
              attachment: true,
              toolcall: true,
              input: { text: true, audio: false, image: true, video: false, pdf: false },
              output: { text: true, audio: false, image: false, video: false, pdf: false },
              interleaved: undefined,
            },

            limit: { context: 200000, input: undefined, output: 64000 },
            status: "active",
            options: {},
            headers: {},
          },
        },
      },
    } as any

    const result = defaultModelIDs(providers)
    expect(result.openai).toBeDefined()
    expect(result.anthropic).toBeDefined()
  })
})
