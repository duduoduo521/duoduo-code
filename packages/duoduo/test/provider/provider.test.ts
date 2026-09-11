import { afterEach, test, expect } from "bun:test"
import { mkdir, unlink } from "fs/promises"
import path from "path"

import { tmpdir } from "../fixture/fixture"
import { disposeAllWithTimeout } from "../lib/dispose"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { ModelsDev } from "../../src/provider"
import { Provider } from "../../src/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Filesystem } from "../../src/util"
import { Env } from "../../src/env"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { makeRuntime } from "../../src/effect/run-service"
import { APP_CONFIG_SCHEMA } from "../../src/config/domains"

const savedEnv = new Map<string, string | undefined>()

function setEnv(key: string, value: string) {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  process.env[key] = value
}

afterEach(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
  await disposeAllWithTimeout()
})

async function run<A, E>(fn: (provider: Provider.Interface) => Effect.Effect<A, E, never>) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      return yield* fn(provider)
    }),
  )
}

async function list() {
  return run((provider) => provider.list())
}

async function getProvider(providerID: ProviderID) {
  return run((provider) => provider.getProvider(providerID))
}

async function getModel(providerID: ProviderID, modelID: ModelID) {
  return run((provider) => provider.getModel(providerID, modelID))
}

async function getLanguage(model: Provider.Model) {
  return run((provider) => provider.getLanguage(model))
}

async function closest(providerID: ProviderID, query: string[]) {
  return run((provider) => provider.closest(providerID, query))
}

async function getSmallModel(providerID: ProviderID) {
  return run((provider) => provider.getSmallModel(providerID))
}

async function defaultModel() {
  return run((provider) => provider.defaultModel())
}

// ── Shared provider config fragments ──────────────────────────────
// Since models.dev data is gone, providers must be fully declared in
// config with their models. These fragments avoid repetition.

const anthropicModels = {
  "claude-sonnet-4-20250514": {
    name: "Claude Sonnet 4",
    release_date: "2025-01-01",
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    limit: { context: 200000, input: 200000, output: 64000 },
  },
  "claude-opus-4-20250514": {
    name: "Claude Opus 4",
    release_date: "2025-01-01",
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    limit: { context: 200000, input: 200000, output: 32000 },
  },
  "claude-haiku-3-5-20241022": {
    name: "Claude 3.5 Haiku",
    release_date: "2024-10-01",
    attachment: true,
    reasoning: false,
    temperature: true,
    tool_call: true,
    limit: { context: 200000, input: 200000, output: 8192 },
  },
} as const

const anthropicBase = {
  name: "Anthropic",
  npm: "@ai-sdk/openai-compatible",
  env: ["ANTHROPIC_API_KEY"],
  models: { ...anthropicModels },
} as const

const openaiModels = {
  "gpt-5": {
    name: "GPT-5",
    release_date: "2025-06-01",
    attachment: true,
    reasoning: true,
    temperature: true,
    tool_call: true,
    limit: { context: 400000, input: 400000, output: 32768 },
  },
} as const

const openaiBase = {
  name: "OpenAI",
  npm: "@ai-sdk/openai-compatible",
  env: ["OPENAI_API_KEY"],
  models: { ...openaiModels },
} as const

const duoduoModels = {
  "duoduo-free": {
    name: "Duoduo Free",
    release_date: "2025-01-01",
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    limit: { context: 200000, input: 200000, output: 64000 },
  },
  "duoduo-pro": {
    name: "Duoduo Pro",
    release_date: "2025-01-01",
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    limit: { context: 200000, input: 200000, output: 64000 },
  },
} as const

const duoduoBase = {
  name: "Duoduo",
  npm: "@ai-sdk/anthropic",
  env: [],
  models: { ...duoduoModels },
} as const

const cloudflareAiGatewayBase = {
  name: "Cloudflare AI Gateway",
  npm: "@ai-sdk/openai-compatible",
  env: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
  models: {
    "cf-gpt-4": {
      name: "CF GPT-4",
      tool_call: true,
      limit: { context: 128000, output: 4096 },
    },
  },
} as const

test("provider loaded from env variable", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: anthropicBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("anthropic")]).toBeDefined()
      // Provider should retain its connection source even if custom loaders
      // merge additional options.
      expect(providers[ProviderID.make("anthropic")].source).toBe("env")
    },
  })
})

test("provider loaded from config with apiKey option", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              options: {
                apiKey: "config-api-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("anthropic")]).toBeDefined()
    },
  })
})

test("disabled_providers excludes provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          disabled_providers: ["anthropic"],
          provider: {
            anthropic: anthropicBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("anthropic")]).toBeUndefined()
    },
  })
})

test("enabled_providers restricts to only listed providers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          enabled_providers: ["anthropic"],
          provider: {
            anthropic: anthropicBase,
            openai: openaiBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
      setEnv("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("anthropic")]).toBeDefined()
      expect(providers[ProviderID.make("openai")]).toBeUndefined()
    },
  })
})

test("model whitelist filters models for provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              whitelist: ["claude-sonnet-4-20250514"],
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("anthropic")]).toBeDefined()
      const models = Object.keys(providers[ProviderID.make("anthropic")].models)
      expect(models).toContain("claude-sonnet-4-20250514")
      expect(models.length).toBe(1)
    },
  })
})

test("model blacklist excludes specific models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              blacklist: ["claude-sonnet-4-20250514"],
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("anthropic")]).toBeDefined()
      const models = Object.keys(providers[ProviderID.make("anthropic")].models)
      expect(models).not.toContain("claude-sonnet-4-20250514")
    },
  })
})

test("custom model alias via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              models: {
                "my-alias": {
                  id: "claude-sonnet-4-20250514",
                  name: "My Custom Alias",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("anthropic")]).toBeDefined()
      expect(providers[ProviderID.make("anthropic")].models["my-alias"]).toBeDefined()
      expect(providers[ProviderID.make("anthropic")].models["my-alias"].name).toBe("My Custom Alias")
    },
  })
})

test("custom provider with npm package", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "custom-provider": {
              name: "Custom Provider",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.custom.com/v1",
              env: ["CUSTOM_API_KEY"],
              models: {
                "custom-model": {
                  name: "Custom Model",
                  tool_call: true,
                  limit: {
                    context: 128000,
                    output: 4096,
                  },
                },
              },
              options: {
                apiKey: "custom-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("custom-provider")]).toBeDefined()
      expect(providers[ProviderID.make("custom-provider")].name).toBe("Custom Provider")
      expect(providers[ProviderID.make("custom-provider")].models["custom-model"]).toBeDefined()
    },
  })
})

test("env variable takes precedence, config merges options", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              options: {
                timeout: 60000,
                chunkTimeout: 15000,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "env-api-key")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("anthropic")]).toBeDefined()
      // Config options should be merged
      expect(providers[ProviderID.make("anthropic")].options.timeout).toBe(60000)
      expect(providers[ProviderID.make("anthropic")].options.chunkTimeout).toBe(15000)
    },
  })
})

test("getModel returns model for valid provider/model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: anthropicBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await getModel(ProviderID.make("anthropic"), ModelID.make("claude-sonnet-4-20250514"))
      expect(model).toBeDefined()
      expect(String(model.providerID)).toBe("anthropic")
      expect(String(model.id)).toBe("claude-sonnet-4-20250514")
      const language = await getLanguage(model)
      expect(language).toBeDefined()
    },
  })
})

test("getModel throws ModelNotFoundError for invalid model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: anthropicBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      expect(getModel(ProviderID.make("anthropic"), ModelID.make("nonexistent-model"))).rejects.toThrow()
    },
  })
})

test("getModel throws ModelNotFoundError for invalid provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(getModel(ProviderID.make("nonexistent-provider"), ModelID.make("some-model"))).rejects.toThrow()
    },
  })
})

test("parseModel correctly parses provider/model string", () => {
  const result = Provider.parseModel("anthropic/claude-sonnet-4")
  expect(String(result.providerID)).toBe("anthropic")
  expect(String(result.modelID)).toBe("claude-sonnet-4")
})

test("parseModel handles model IDs with slashes", () => {
  const result = Provider.parseModel("openrouter/anthropic/claude-3-opus")
  expect(String(result.providerID)).toBe("openrouter")
  expect(String(result.modelID)).toBe("anthropic/claude-3-opus")
})

test("defaultModel returns first available model when no config set", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: anthropicBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await defaultModel()
      expect(model.providerID).toBeDefined()
      expect(model.modelID).toBeDefined()
    },
  })
})

test("defaultModel respects config model setting", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          model: "anthropic/claude-sonnet-4-20250514",
          provider: {
            anthropic: anthropicBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await defaultModel()
      expect(String(model.providerID)).toBe("anthropic")
      expect(String(model.modelID)).toBe("claude-sonnet-4-20250514")
    },
  })
})

test("provider with baseURL from config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "custom-openai": {
              name: "Custom OpenAI",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "gpt-4": {
                  name: "GPT-4",
                  tool_call: true,
                  limit: { context: 128000, output: 4096 },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://custom.openai.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("custom-openai")]).toBeDefined()
      expect(providers[ProviderID.make("custom-openai")].options.baseURL).toBe("https://custom.openai.com/v1")
    },
  })
})


test("model options are merged from config model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              models: {
                "claude-sonnet-4-20250514": {
                  options: {
                    customOption: "custom-value",
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("anthropic")].models["claude-sonnet-4-20250514"]
      expect(model.options.customOption).toBe("custom-value")
    },
  })
})

test("provider removed when all models filtered out", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              whitelist: ["nonexistent-model"],
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("anthropic")]).toBeUndefined()
    },
  })
})

test("closest finds model by partial match", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: anthropicBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const result = await closest(ProviderID.make("anthropic"), ["sonnet-4"])
      expect(result).toBeDefined()
      expect(String(result?.providerID)).toBe("anthropic")
      expect(String(result?.modelID)).toContain("sonnet-4")
    },
  })
})

test("closest returns undefined for nonexistent provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await closest(ProviderID.make("nonexistent"), ["model"])
      expect(result).toBeUndefined()
    },
  })
})

test("getModel uses realIdByKey for aliased models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              models: {
                "my-sonnet": {
                  id: "claude-sonnet-4-20250514",
                  name: "My Sonnet Alias",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("anthropic")].models["my-sonnet"]).toBeDefined()

      const model = await getModel(ProviderID.make("anthropic"), ModelID.make("my-sonnet"))
      expect(model).toBeDefined()
      expect(String(model.id)).toBe("my-sonnet")
      expect(model.name).toBe("My Sonnet Alias")
    },
  })
})

test("provider api field sets model api.url", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "custom-api": {
              name: "Custom API",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.example.com/v1",
              env: [],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                apiKey: "test-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      // api field is stored on model.api.url, used by getSDK to set baseURL
      expect(providers[ProviderID.make("custom-api")].models["model-1"].api.url).toBe("https://api.example.com/v1")
    },
  })
})

test("explicit baseURL overrides api field", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "custom-api": {
              name: "Custom API",
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.example.com/v1",
              env: [],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: "https://custom.override.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("custom-api")].options.baseURL).toBe("https://custom.override.com/v1")
    },
  })
})

test("model config overrides properties on declared model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              models: {
                "claude-sonnet-4-20250514": {
                  name: "Custom Name for Sonnet",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("anthropic")].models["claude-sonnet-4-20250514"]
      expect(model.name).toBe("Custom Name for Sonnet")
      // Properties from config declaration are preserved when explicitly set.
      // Without models.dev data, undeclared fields use conservative defaults
      // (toolcall defaults to true, attachment/limit default to false/0).
      expect(model.capabilities.toolcall).toBe(true)
      expect(model.capabilities.attachment).toBe(false)
      expect(model.limit.context).toBe(0)
    },
  })
})

test("disabled_providers prevents loading even with env var", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          disabled_providers: ["openai"],
          provider: {
            openai: openaiBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("openai")]).toBeUndefined()
    },
  })
})

test("enabled_providers with empty array allows no providers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          enabled_providers: [],
          provider: {
            anthropic: anthropicBase,
            openai: openaiBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
      setEnv("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const providers = await list()
      expect(Object.keys(providers).length).toBe(0)
    },
  })
})

test("whitelist and blacklist can be combined", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              whitelist: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
              blacklist: ["claude-opus-4-20250514"],
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("anthropic")]).toBeDefined()
      const models = Object.keys(providers[ProviderID.make("anthropic")].models)
      expect(models).toContain("claude-sonnet-4-20250514")
      expect(models).not.toContain("claude-opus-4-20250514")
      expect(models.length).toBe(1)
    },
  })
})

test("model modalities default correctly", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "test-provider": {
              name: "Test",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("test-provider")].models["test-model"]
      expect(model.capabilities.input.text).toBe(true)
      expect(model.capabilities.output.text).toBe(true)
    },
  })
})


test("getSmallModel returns appropriate small model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: anthropicBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await getSmallModel(ProviderID.make("anthropic"))
      expect(model).toBeDefined()
      expect(model?.id).toContain("haiku")
    },
  })
})

test("getSmallModel respects config small_model override", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          small_model: "anthropic/claude-sonnet-4-20250514",
          provider: {
            anthropic: anthropicBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model = await getSmallModel(ProviderID.make("anthropic"))
      expect(model).toBeDefined()
      expect(String(model?.providerID)).toBe("anthropic")
      expect(String(model?.id)).toBe("claude-sonnet-4-20250514")
    },
  })
})

test("provider.sort prioritizes preferred models", () => {
  const models = [
    { id: "random-model", name: "Random" },
    { id: "claude-sonnet-4-latest", name: "Claude Sonnet 4" },
    { id: "gpt-5-turbo", name: "GPT-5 Turbo" },
    { id: "other-model", name: "Other" },
  ] as any[]

  const sorted = Provider.sort(models)
  expect(sorted[0].id).toContain("sonnet-4")
  expect(sorted[0].id).toContain("latest")
  expect(sorted[sorted.length - 1].id).not.toContain("gpt-5")
  expect(sorted[sorted.length - 1].id).not.toContain("sonnet-4")
})

test("multiple providers can be configured simultaneously", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              options: { timeout: 30000 },
            },
            openai: {
              ...openaiBase,
              options: { timeout: 60000 },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-anthropic-key")
      setEnv("OPENAI_API_KEY", "test-openai-key")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("anthropic")]).toBeDefined()
      expect(providers[ProviderID.make("openai")]).toBeDefined()
      expect(providers[ProviderID.make("anthropic")].options.timeout).toBe(30000)
      expect(providers[ProviderID.make("openai")].options.timeout).toBe(60000)
    },
  })
})

test("provider with custom npm package", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "local-llm": {
              name: "Local LLM",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "llama-3": {
                  name: "Llama 3",
                  tool_call: true,
                  limit: { context: 8192, output: 2048 },
                },
              },
              options: {
                apiKey: "not-needed",
                baseURL: "http://localhost:11434/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("local-llm")]).toBeDefined()
      expect(providers[ProviderID.make("local-llm")].models["llama-3"].api.npm).toBe("@ai-sdk/openai-compatible")
      expect(providers[ProviderID.make("local-llm")].options.baseURL).toBe("http://localhost:11434/v1")
    },
  })
})

// Edge cases for model configuration

test("model alias name defaults to alias key when id differs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              models: {
                sonnet: {
                  id: "claude-sonnet-4-20250514",
                  // no name specified - should default to "sonnet" (the key)
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("anthropic")].models["sonnet"].name).toBe("sonnet")
    },
  })
})

test("provider with multiple env var options only includes apiKey when single env", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "multi-env": {
              name: "Multi Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["MULTI_ENV_KEY_1", "MULTI_ENV_KEY_2"],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                baseURL: "https://api.example.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("MULTI_ENV_KEY_1", "test-key")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("multi-env")]).toBeDefined()
      // When multiple env options exist, key should NOT be auto-set
      expect(providers[ProviderID.make("multi-env")].key).toBeUndefined()
    },
  })
})

test("provider with single env var includes apiKey automatically", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "single-env": {
              name: "Single Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["SINGLE_ENV_KEY"],
              models: {
                "model-1": {
                  name: "Model 1",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
              options: {
                baseURL: "https://api.example.com/v1",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("SINGLE_ENV_KEY", "my-api-key")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("single-env")]).toBeDefined()
      // Single env option should auto-set key
      expect(providers[ProviderID.make("single-env")].key).toBe("my-api-key")
    },
  })
})


test("completely new provider not in database can be configured", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "brand-new-provider": {
              name: "Brand New",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              api: "https://new-api.com/v1",
              models: {
                "new-model": {
                  name: "New Model",
                  tool_call: true,
                  reasoning: true,
                  attachment: true,
                  temperature: true,
                  limit: { context: 32000, output: 8000 },
                  modalities: {
                    input: ["text", "image"],
                    output: ["text"],
                  },
                },
              },
              options: {
                apiKey: "new-key",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("brand-new-provider")]).toBeDefined()
      expect(providers[ProviderID.make("brand-new-provider")].name).toBe("Brand New")
      const model = providers[ProviderID.make("brand-new-provider")].models["new-model"]
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.capabilities.attachment).toBe(true)
      expect(model.capabilities.input.image).toBe(true)
    },
  })
})

test("disabled_providers and enabled_providers interaction", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          // enabled_providers takes precedence - only these are considered
          enabled_providers: ["anthropic", "openai"],
          // Then disabled_providers filters from the enabled set
          disabled_providers: ["openai"],
          provider: {
            anthropic: anthropicBase,
            openai: openaiBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-anthropic")
      setEnv("OPENAI_API_KEY", "test-openai")
    },
    fn: async () => {
      const providers = await list()
      // anthropic: in enabled, not in disabled = allowed
      expect(providers[ProviderID.make("anthropic")]).toBeDefined()
      // openai: in enabled, but also in disabled = NOT allowed
      expect(providers[ProviderID.make("openai")]).toBeUndefined()
    },
  })
})

test("model with tool_call false", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "no-tools": {
              name: "No Tools Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                "basic-model": {
                  name: "Basic Model",
                  tool_call: false,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("no-tools")].models["basic-model"].capabilities.toolcall).toBe(false)
    },
  })
})

test("model defaults tool_call to true when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "default-tools": {
              name: "Default Tools Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  // tool_call not specified
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("default-tools")].models["model"].capabilities.toolcall).toBe(true)
    },
  })
})

test("model headers are preserved", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "headers-provider": {
              name: "Headers Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                  headers: {
                    "X-Custom-Header": "custom-value",
                    Authorization: "Bearer special-token",
                  },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("headers-provider")].models["model"]
      expect(model.headers).toEqual({
        "X-Custom-Header": "custom-value",
        Authorization: "Bearer special-token",
      })
    },
  })
})

test("provider env fallback - second env var used if first missing", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "fallback-env": {
              name: "Fallback Env Provider",
              npm: "@ai-sdk/openai-compatible",
              env: ["PRIMARY_KEY", "FALLBACK_KEY"],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { baseURL: "https://api.example.com" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      // Only set fallback, not primary
      setEnv("FALLBACK_KEY", "fallback-api-key")
    },
    fn: async () => {
      const providers = await list()
      // Provider should load because fallback env var is set
      expect(providers[ProviderID.make("fallback-env")]).toBeDefined()
    },
  })
})

test("getModel returns consistent results", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: anthropicBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const model1 = await getModel(ProviderID.make("anthropic"), ModelID.make("claude-sonnet-4-20250514"))
      const model2 = await getModel(ProviderID.make("anthropic"), ModelID.make("claude-sonnet-4-20250514"))
      expect(model1.providerID).toEqual(model2.providerID)
      expect(model1.id).toEqual(model2.id)
      expect(model1).toEqual(model2)
    },
  })
})

test("provider name defaults to id when not in database", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "my-custom-id": {
              // no name specified
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  limit: { context: 4000, output: 1000 },
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("my-custom-id")].name).toBe("my-custom-id")
    },
  })
})

test("ModelNotFoundError includes suggestions for typos", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: anthropicBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      try {
        await getModel(ProviderID.make("anthropic"), ModelID.make("claude-sonet-4")) // typo: sonet instead of sonnet
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.data.suggestions).toBeDefined()
        expect(e.data.suggestions.length).toBeGreaterThan(0)
      }
    },
  })
})

test("ModelNotFoundError for provider includes suggestions", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: anthropicBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      try {
        await getModel(ProviderID.make("antropic"), ModelID.make("claude-sonnet-4")) // typo: antropic
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.data.suggestions).toBeDefined()
        expect(e.data.suggestions).toContain("anthropic")
      }
    },
  })
})

test("getProvider returns undefined for nonexistent provider", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const provider = await getProvider(ProviderID.make("nonexistent"))
      expect(provider).toBeUndefined()
    },
  })
})

test("getProvider returns provider info", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: anthropicBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const provider = await getProvider(ProviderID.make("anthropic"))
      expect(provider).toBeDefined()
      expect(String(provider?.id)).toBe("anthropic")
    },
  })
})

test("closest returns undefined when no partial match found", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: anthropicBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const result = await closest(ProviderID.make("anthropic"), ["nonexistent-xyz-model"])
      expect(result).toBeUndefined()
    },
  })
})

test("closest checks multiple query terms in order", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: anthropicBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      // First term won't match, second will
      const result = await closest(ProviderID.make("anthropic"), ["nonexistent", "haiku"])
      expect(result).toBeDefined()
      expect(result?.modelID).toContain("haiku")
    },
  })
})

test("model limit defaults to zero when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "no-limit": {
              name: "No Limit Provider",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                model: {
                  name: "Model",
                  tool_call: true,
                  // no limit specified
                },
              },
              options: { apiKey: "test" },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("no-limit")].models["model"]
      expect(model.limit.context).toBe(0)
      expect(model.limit.output).toBe(0)
    },
  })
})

test("provider options are deeply merged", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              options: {
                headers: {
                  "X-Custom": "custom-value",
                },
                timeout: 30000,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      // Custom options should be merged
      expect(providers[ProviderID.make("anthropic")].options.timeout).toBe(30000)
      expect(providers[ProviderID.make("anthropic")].options.headers["X-Custom"]).toBe("custom-value")
    },
  })
})

test("custom model inherits npm package from provider config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            openai: {
              ...openaiBase,
              models: {
                "my-custom-model": {
                  name: "My Custom Model",
                  tool_call: true,
                  limit: { context: 8000, output: 2000 },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("OPENAI_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("openai")].models["my-custom-model"]
      expect(model).toBeDefined()
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
    },
  })
})

test("custom model inherits api.url from provider config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            // Generic OpenAI-compatible gateway (replaces the removed
            // cloud-only `openrouter` vendor). Models inherit api.url.
            "custom-router": {
              name: "Custom Router",
              npm: "@ai-sdk/openai-compatible",
              api: "https://custom-router.example/v1",
              env: ["CUSTOM_ROUTER_KEY"],
              models: {
                "prime-intellect/intellect-3": {},
                "deepseek/deepseek-r1-0528": {
                  name: "DeepSeek R1",
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("CUSTOM_ROUTER_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("custom-router")]).toBeDefined()

      // New model not in database should inherit api.url from provider
      const intellect = providers[ProviderID.make("custom-router")].models["prime-intellect/intellect-3"]
      expect(intellect).toBeDefined()
      expect(intellect.api.url).toBe("https://custom-router.example/v1")

      // Another new model should also inherit api.url
      const deepseek = providers[ProviderID.make("custom-router")].models["deepseek/deepseek-r1-0528"]
      expect(deepseek).toBeDefined()
      expect(deepseek.api.url).toBe("https://custom-router.example/v1")
      expect(deepseek.name).toBe("DeepSeek R1")
    },
  })
})

test("mode applies provider body options from base model", () => {
  const provider = {
    id: "openai",
    name: "OpenAI",
    env: [],
    api: "https://api.openai.com/v1",
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        family: "gpt",
        release_date: "2026-03-05",
        attachment: true,
        reasoning: true,
        temperature: false,
        tool_call: true,
        limit: {
          context: 1_050_000,
          input: 922_000,
          output: 128_000,
        },
        experimental: {
          modes: {
            fast: {
              provider: {
                body: {
                  service_tier: "priority",
                },
              },
            },
          },
        },
      },
    },
  } as unknown as ModelsDev.Provider

  const model = Provider.fromModelsDevProvider(provider).models["gpt-5.4-fast"]
  expect(model.options["serviceTier"]).toEqual("priority")
})

test("models.dev normalization fills required response fields", () => {
  const provider = {
    id: "gateway",
    name: "Gateway",
    env: [],
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        family: "gpt",
        limit: {
          context: 1_050_000,
          input: 922_000,
          output: 128_000,
        },
      },
    },
  } as unknown as ModelsDev.Provider

  const model = Provider.fromModelsDevProvider(provider).models["gpt-5.4"]
  expect(model.api.url).toBe("")
  expect(model.capabilities.temperature).toBe(false)
  expect(model.capabilities.reasoning).toBe(false)
  expect(model.capabilities.attachment).toBe(false)
  expect(model.capabilities.toolcall).toBe(true)
  expect(model.release_date).toBe("")
})

test("model variants are generated for reasoning models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: anthropicBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      // Claude sonnet 4 has reasoning capability
      const model = providers[ProviderID.make("anthropic")].models["claude-sonnet-4-20250514"]
      expect(model.capabilities.reasoning).toBe(true)
      expect(model.variants).toBeDefined()
      expect(Object.keys(model.variants).length).toBeGreaterThan(0)
    },
  })
})

test("model variants can be disabled via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              models: {
                "claude-sonnet-4-20250514": {
                  reasoning: true,
                  variants: {
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("anthropic")].models["claude-sonnet-4-20250514"]
      expect(model.variants).toBeDefined()
      expect(model.variants!["high"]).toBeUndefined()
      // medium variant should still exist
      expect(model.variants!["medium"]).toBeDefined()
    },
  })
})

test("model variants can be customized via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              models: {
                "claude-sonnet-4-20250514": {
                  reasoning: true,
                  variants: {
                    high: {
                      thinking: {
                        type: "enabled",
                        budgetTokens: 20000,
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("anthropic")].models["claude-sonnet-4-20250514"]
      expect(model.variants!["high"]).toBeDefined()
      expect(model.variants!["high"].thinking.budgetTokens).toBe(20000)
    },
  })
})

test("disabled key is stripped from variant config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              models: {
                "claude-sonnet-4-20250514": {
                  reasoning: true,
                  variants: {
                    max: {
                      disabled: false,
                      customField: "test",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("anthropic")].models["claude-sonnet-4-20250514"]
      expect(model.variants!["max"]).toBeDefined()
      expect(model.variants!["max"].disabled).toBeUndefined()
      expect(model.variants!["max"].customField).toBe("test")
    },
  })
})

test("all variants can be disabled via config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              models: {
                "claude-sonnet-4-20250514": {
                  reasoning: true,
                  variants: {
                    low: { disabled: true },
                    medium: { disabled: true },
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("anthropic")].models["claude-sonnet-4-20250514"]
      expect(model.variants).toBeDefined()
      expect(Object.keys(model.variants).length).toBe(0)
    },
  })
})

test("variant config merges with generated variants", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            anthropic: {
              ...anthropicBase,
              models: {
                "claude-sonnet-4-20250514": {
                  reasoning: true,
                  variants: {
                    high: {
                      extraOption: "custom-value",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("ANTHROPIC_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("anthropic")].models["claude-sonnet-4-20250514"]
      expect(model.variants!["high"]).toBeDefined()
      // Should have both the generated reasoningEffort config and the custom option
      expect(model.variants!["high"].reasoningEffort).toBe("high")
      expect(model.variants!["high"].extraOption).toBe("custom-value")
    },
  })
})

test("variants filtered in second pass for config models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            openai: {
              ...openaiBase,
              models: {
                "gpt-5": {
                  reasoning: true,
                  variants: {
                    high: { disabled: true },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("OPENAI_API_KEY", "test-api-key")
    },
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("openai")].models["gpt-5"]
      expect(model.variants).toBeDefined()
      expect(model.variants!["high"]).toBeUndefined()
      // Other variants should still exist
      expect(model.variants!["medium"]).toBeDefined()
    },
  })
})

test("custom model with variants enabled and disabled", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const config = {
        $schema: APP_CONFIG_SCHEMA,
        provider: {
          "custom-reasoning": {
            name: "Custom Reasoning Provider",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            models: {
              "reasoning-model": {
                name: "Reasoning Model",
                tool_call: true,
                reasoning: true,
                limit: { context: 128000, output: 16000 },
                variants: {
                  low: { reasoningEffort: "low" },
                  medium: { reasoningEffort: "medium" },
                  high: { reasoningEffort: "high", disabled: true },
                  custom: { reasoningEffort: "custom", budgetTokens: 5000 },
                },
              },
            },
            options: { apiKey: "test-key" },
          },
        },
      }
      console.log("CONFIG JSON:", JSON.stringify(config, null, 2))
      await Bun.write(path.join(dir, "duoduo-ai.json"), JSON.stringify(config))
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await list()
      console.log("PROVIDER KEYS:", Object.keys(providers))
      const model = providers[ProviderID.make("custom-reasoning")]?.models?.["reasoning-model"]
      console.log("MODEL:", model)
      expect(model).toBeDefined()
      expect(model.variants).toBeDefined()
      // Enabled variants should exist
      expect(model.variants!["low"]).toBeDefined()
      expect(model.variants!["low"].reasoningEffort).toBe("low")
      expect(model.variants!["medium"]).toBeDefined()
      expect(model.variants!["medium"].reasoningEffort).toBe("medium")
      expect(model.variants!["custom"]).toBeDefined()
      expect(model.variants!["custom"].reasoningEffort).toBe("custom")
      expect(model.variants!["custom"].budgetTokens).toBe(5000)
      // Disabled variant should not exist
      expect(model.variants!["high"]).toBeUndefined()
      // disabled key should be stripped from all variants
      expect(model.variants!["low"].disabled).toBeUndefined()
      expect(model.variants!["medium"].disabled).toBeUndefined()
      expect(model.variants!["custom"].disabled).toBeUndefined()
    },
  })
})

test("Google Vertex: retains baseURL for custom proxy", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "vertex-proxy": {
              name: "Vertex Proxy",
              npm: "@ai-sdk/google-vertex",
              api: "https://my-proxy.com/v1",
              env: ["GOOGLE_APPLICATION_CREDENTIALS"], // Mock env var requirement
              models: {
                "gemini-pro": {
                  name: "Gemini Pro",
                  tool_call: true,
                },
              },
              options: {
                project: "test-project",
                location: "us-central1",
                baseURL: "https://my-proxy.com/v1", // Should be retained
              },
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("GOOGLE_APPLICATION_CREDENTIALS", "test-creds")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("vertex-proxy")]).toBeDefined()
      expect(providers[ProviderID.make("vertex-proxy")].options.baseURL).toBe("https://my-proxy.com/v1")
    },
  })
})

test("Google Vertex: supports OpenAI compatible models", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "vertex-openai": {
              name: "Vertex OpenAI",
              npm: "@ai-sdk/google-vertex",
              env: ["GOOGLE_APPLICATION_CREDENTIALS"],
              models: {
                "gpt-4": {
                  name: "GPT-4",
                  provider: {
                    npm: "@ai-sdk/openai-compatible",
                    api: "https://api.openai.com/v1",
                  },
                },
              },
              options: {
                project: "test-project",
                location: "us-central1",
              },
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("GOOGLE_APPLICATION_CREDENTIALS", "test-creds")
    },
    fn: async () => {
      const providers = await list()
      const model = providers[ProviderID.make("vertex-openai")].models["gpt-4"]

      expect(model).toBeDefined()
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
    },
  })
})

test("cloudflare-ai-gateway loads with env variables", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "cloudflare-ai-gateway": cloudflareAiGatewayBase,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("CLOUDFLARE_ACCOUNT_ID", "test-account")
      setEnv("CLOUDFLARE_GATEWAY_ID", "test-gateway")
      setEnv("CLOUDFLARE_API_TOKEN", "test-token")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("cloudflare-ai-gateway")]).toBeDefined()
    },
  })
})

test("cloudflare-ai-gateway forwards config metadata options", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            "cloudflare-ai-gateway": {
              ...cloudflareAiGatewayBase,
              options: {
                metadata: { invoked_by: "test", project: "duoduo" },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("CLOUDFLARE_ACCOUNT_ID", "test-account")
      setEnv("CLOUDFLARE_GATEWAY_ID", "test-gateway")
      setEnv("CLOUDFLARE_API_TOKEN", "test-token")
    },
    fn: async () => {
      const providers = await list()
      expect(providers[ProviderID.make("cloudflare-ai-gateway")]).toBeDefined()
      expect(providers[ProviderID.make("cloudflare-ai-gateway")].options.metadata).toEqual({
        invoked_by: "test",
        project: "duoduo",
      })
    },
  })
})

// TODO: plugin config() hook loading is disconnected (provider.ts:636 `const plugins: any[] = []`
// is a stub). Re-enable when the plugin loading pipeline is restored post TS→Rust migration.
test("duoduo loader loads models with and without config apiKey", async () => {
  await using base = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            duoduo: duoduoBase,
          },
        }),
      )
    },
  })

  const none = await Instance.provide({
    directory: base.path,
    fn: async () => {
      const providers = await list()
      const item = providers[ProviderID.make("duoduo")]
      if (!item) return 0
      return Object.values(item.models).length
    },
  })

  await using keyed = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            duoduo: {
              ...duoduoBase,
              options: {
                apiKey: "test-key",
              },
            },
          },
        }),
      )
    },
  })

  const keyedCount = await Instance.provide({
    directory: keyed.path,
    fn: async () => {
      const providers = await list()
      const item = providers[ProviderID.make("duoduo")]
      expect(item).toBeDefined()
      return Object.values(item.models).length
    },
  })

  expect(none).toBeGreaterThan(0)
  expect(keyedCount).toBeGreaterThan(0)
})

test("duoduo loader loads models with and without auth", async () => {
  await using base = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            duoduo: duoduoBase,
          },
        }),
      )
    },
  })

  const none = await Instance.provide({
    directory: base.path,
    fn: async () => {
      const providers = await list()
      const item = providers[ProviderID.make("duoduo")]
      if (!item) return 0
      return Object.values(item.models).length
    },
  })

  await using keyed = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo-ai.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          provider: {
            duoduo: duoduoBase,
          },
        }),
      )
    },
  })

  const authPath = path.join(Global.Path.data, "auth.json")
  let prev: string | undefined

  try {
    prev = await Filesystem.readText(authPath)
  } catch {}

  try {
    await Filesystem.write(
      authPath,
      JSON.stringify({
        duoduo: {
          type: "api",
          key: "test-key",
        },
      }),
    )

    const keyedCount = await Instance.provide({
      directory: keyed.path,
      fn: async () => {
        const providers = await list()
        const item = providers[ProviderID.make("duoduo")]
        expect(item).toBeDefined()
        return Object.values(item.models).length
      },
    })

    expect(none).toBeGreaterThan(0)
    expect(keyedCount).toBeGreaterThan(0)
  } finally {
    if (prev !== undefined) {
      await Filesystem.write(authPath, prev)
    }
    if (prev === undefined) {
      try {
        await unlink(authPath)
      } catch {}
    }
  }
})
