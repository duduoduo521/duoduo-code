import { describe, expect, test } from "bun:test"
import { Info as ProviderInfo } from "../../src/config/provider"

describe("config.provider", () => {
  describe("ProviderInfo", () => {
    test("has zod schema", () => {
      expect(ProviderInfo.zod).toBeDefined()
    })

    test("parses empty provider config", () => {
      const result = ProviderInfo.zod.parse({})
      expect(result).toEqual({})
    })

    test("parses provider with api and name", () => {
      const result = ProviderInfo.zod.parse({
        api: "openai",
        name: "OpenAI",
      })
      expect(result.api).toBe("openai")
      expect(result.name).toBe("OpenAI")
    })

    test("parses provider with env array", () => {
      const result = ProviderInfo.zod.parse({
        api: "anthropic",
        env: ["ANTHROPIC_API_KEY"],
      })
      expect(result.env).toEqual(["ANTHROPIC_API_KEY"])
    })

    test("parses provider with options", () => {
      const result = ProviderInfo.zod.parse({
        api: "openai",
        options: {
          apiKey: "sk-test",
          baseURL: "https://api.openai.com/v1",
        },
      })
      expect(result.options?.apiKey).toBe("sk-test")
      expect(result.options?.baseURL).toBe("https://api.openai.com/v1")
    })

    test("parses provider with whitelist and blacklist", () => {
      const result = ProviderInfo.zod.parse({
        whitelist: ["gpt-4", "gpt-3.5-turbo"],
        blacklist: ["gpt-4-32k"],
      })
      expect(result.whitelist).toEqual(["gpt-4", "gpt-3.5-turbo"])
      expect(result.blacklist).toEqual(["gpt-4-32k"])
    })

    test("parses provider with models", () => {
      const result = ProviderInfo.zod.parse({
        models: {
          "gpt-4": {
            name: "GPT-4",
            attachment: true,
            reasoning: false,
          },
        },
      })
      expect(result.models?.["gpt-4"]?.name).toBe("GPT-4")
      expect(result.models?.["gpt-4"]?.attachment).toBe(true)
    })

    test("parses provider with timeout options", () => {
      const result = ProviderInfo.zod.parse({
        options: {
          timeout: 60000,
          chunkTimeout: 5000,
        },
      })
      expect(result.options?.timeout).toBe(60000)
      expect(result.options?.chunkTimeout).toBe(5000)
    })

    test("parses provider with timeout disabled (false)", () => {
      const result = ProviderInfo.zod.parse({
        options: {
          timeout: false,
        },
      })
      expect(result.options?.timeout).toBe(false)
    })
  })
})
