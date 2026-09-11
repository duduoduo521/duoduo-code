import { describe, expect, test } from "bun:test"
import { validateCustomProvider, modelRow, headerRow } from "./dialog-custom-provider-form"
import type { FormState, ModelRow, HeaderRow } from "./dialog-custom-provider-form"

const t = (key: string) => key

function makeForm(overrides: Partial<FormState> = {}): FormState {
  return {
    providerID: "my-provider",
    name: "My Provider",
    baseURL: "https://api.example.com",
    apiKey: "sk-test-key",
    models: [{ row: "m0", id: "model-a", name: "Model A", err: {}, contextLimit: "128000", outputLimit: "8192" }],
    headers: [],
    err: {},
    ...overrides,
  }
}

describe("validateCustomProvider", () => {
  describe("providerID validation", () => {
    test("requires providerID", () => {
      const result = validateCustomProvider({
        form: makeForm({ providerID: "" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.err.providerID).toBe("provider.custom.error.providerID.required")
      expect(result.result).toBeUndefined()
    })

    test("rejects providerID starting with non-alphanumeric", () => {
      const result = validateCustomProvider({
        form: makeForm({ providerID: "-bad" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.err.providerID).toBe("provider.custom.error.providerID.format")
    })

    test("rejects providerID with uppercase letters", () => {
      const result = validateCustomProvider({
        form: makeForm({ providerID: "MyProvider" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.err.providerID).toBe("provider.custom.error.providerID.format")
    })

    test("rejects providerID with spaces", () => {
      const result = validateCustomProvider({
        form: makeForm({ providerID: "my provider" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.err.providerID).toBe("provider.custom.error.providerID.format")
    })

    test("accepts providerID with lowercase, digits, hyphens, underscores", () => {
      const result = validateCustomProvider({
        form: makeForm({ providerID: "my-provider_v2" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.err.providerID).toBeUndefined()
      expect(result.result).toBeDefined()
    })

    test("accepts single-character providerID", () => {
      const result = validateCustomProvider({
        form: makeForm({ providerID: "a" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.err.providerID).toBeUndefined()
    })

    test("flags existing providerID as duplicate", () => {
      const result = validateCustomProvider({
        form: makeForm({ providerID: "existing" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(["existing"]),
      })
      expect(result.err.providerID).toBe("provider.custom.error.providerID.exists")
    })

    test("allows existing providerID when it is in disabledProviders", () => {
      const result = validateCustomProvider({
        form: makeForm({ providerID: "existing" }),
        t,
        disabledProviders: ["existing"],
        existingProviderIDs: new Set(["existing"]),
      })
      expect(result.err.providerID).toBeUndefined()
      expect(result.result).toBeDefined()
    })

    test("allows editing a provider that keeps its own id", () => {
      const result = validateCustomProvider({
        form: makeForm({ providerID: "existing" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(["existing"]),
        editProviderID: "existing",
      })
      expect(result.err.providerID).toBeUndefined()
      expect(result.result).toBeDefined()
    })
  })

  describe("name handling", () => {
    test("name falls back to providerID when empty", () => {
      const result = validateCustomProvider({
        form: makeForm({ name: "" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      // name field removed from UI; name falls back to providerID
      expect(result.err.name).toBeUndefined()
      expect(result.result!.name).toBe("my-provider")
    })

    test("name falls back to providerID when whitespace-only", () => {
      const result = validateCustomProvider({
        form: makeForm({ name: "  " }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.err.name).toBeUndefined()
      expect(result.result!.name).toBe("my-provider")
    })
  })

  describe("baseURL validation", () => {
    test("requires baseURL", () => {
      const result = validateCustomProvider({
        form: makeForm({ baseURL: "" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.err.baseURL).toBe("provider.custom.error.baseURL.required")
    })

    test("rejects non-http URL", () => {
      const result = validateCustomProvider({
        form: makeForm({ baseURL: "ftp://example.com" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.err.baseURL).toBe("provider.custom.error.baseURL.format")
    })

    test("accepts https URL", () => {
      const result = validateCustomProvider({
        form: makeForm({ baseURL: "https://api.example.com" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.err.baseURL).toBeUndefined()
    })

    test("accepts http URL", () => {
      const result = validateCustomProvider({
        form: makeForm({ baseURL: "http://localhost:8080" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.err.baseURL).toBeUndefined()
    })

    test("trims baseURL whitespace", () => {
      const result = validateCustomProvider({
        form: makeForm({ baseURL: "  https://api.example.com  " }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.err.baseURL).toBeUndefined()
      expect(result.result!.config.options.baseURL).toBe("https://api.example.com")
    })
  })

  describe("apiKey handling", () => {
    test("passes plain apiKey as key in result", () => {
      const result = validateCustomProvider({
        form: makeForm({ apiKey: "sk-test-key" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.result!.key).toBe("sk-test-key")
      expect(result.result!.config.env).toBeUndefined()
    })

    test("extracts env variable from {env:NAME} format", () => {
      const result = validateCustomProvider({
        form: makeForm({ apiKey: "{env:MY_API_KEY}" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.result!.key).toBeUndefined()
      expect(result.result!.config.env).toEqual(["MY_API_KEY"])
    })

    test("trims whitespace in env variable name", () => {
      const result = validateCustomProvider({
        form: makeForm({ apiKey: "{env: MY_API_KEY }" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.result!.config.env).toEqual(["MY_API_KEY"])
    })

    test("empty apiKey results in no key and no env", () => {
      const result = validateCustomProvider({
        form: makeForm({ apiKey: "" }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.result!.key).toBeUndefined()
      expect(result.result!.config.env).toBeUndefined()
    })
  })

  describe("model validation", () => {
    test("flags empty model id", () => {
      const result = validateCustomProvider({
        form: makeForm({
          models: [{ row: "m0", id: "", name: "Model A", err: {}, contextLimit: "", outputLimit: "" }],
        }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.models[0]!.id).toBe("provider.custom.error.required")
      expect(result.result).toBeUndefined()
    })

    test("model name is optional and falls back to model id", () => {
      const result = validateCustomProvider({
        form: makeForm({
          models: [{ row: "m0", id: "model-a", name: "", err: {}, contextLimit: "", outputLimit: "" }],
        }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      // model name is no longer validated; empty name falls back to model id in config
      expect(result.models[0]!.name).toBeUndefined()
      expect(result.result).toBeDefined()
    })

    test("flags duplicate model ids", () => {
      const result = validateCustomProvider({
        form: makeForm({
          models: [
            { row: "m0", id: "model-a", name: "Model A", err: {}, contextLimit: "", outputLimit: "" },
            { row: "m1", id: "model-a", name: "Model A 2", err: {}, contextLimit: "", outputLimit: "" },
          ],
        }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.models[1]!.id).toBe("provider.custom.error.duplicate")
    })

    test("includes context and output limits in model config when provided", () => {
      const result = validateCustomProvider({
        form: makeForm({
          models: [{ row: "m0", id: "model-a", name: "Model A", err: {}, contextLimit: "128000", outputLimit: "8192" }],
        }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.result!.config.models["model-a"]).toEqual({
        name: "Model A",
        limit: { context: 128000, output: 8192 },
        supports_temperature: true,
      })
    })

    test("includes temperature and topP in model config when provided", () => {
      const result = validateCustomProvider({
        form: makeForm({
          models: [
            {
              row: "m0",
              id: "model-a",
              name: "Model A",
              err: {},
              contextLimit: "128000",
              outputLimit: "8192",
              temperature: "0.2",
              topP: "0.25",
            },
          ],
        }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.result!.config.models["model-a"]).toEqual({
        name: "Model A",
        limit: { context: 128000, output: 8192 },
        temperature: 0.2,
        top_p: 0.25,
        supports_temperature: true,
      })
    })

    test("flags invalid temperature", () => {
      const result = validateCustomProvider({
        form: makeForm({
          models: [{ row: "m0", id: "model-a", name: "Model A", err: {}, contextLimit: "", outputLimit: "", temperature: "abc" }],
        }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.models[0]!.temperature).toBe("provider.custom.error.temperature.invalid")
    })

    test("flags invalid topP", () => {
      const result = validateCustomProvider({
        form: makeForm({
          models: [{ row: "m0", id: "model-a", name: "Model A", err: {}, contextLimit: "", outputLimit: "", topP: "xyz" }],
        }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.models[0]!.topP).toBe("provider.custom.error.topP.invalid")
    })

    test("omits limit when both context and output are 0", () => {
      const result = validateCustomProvider({
        form: makeForm({
          models: [{ row: "m0", id: "model-a", name: "Model A", err: {}, contextLimit: "0", outputLimit: "0" }],
        }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.result!.config.models["model-a"]).toEqual({ name: "Model A", supports_temperature: true })
    })

    test("omits limit when contextLimit and outputLimit are empty strings", () => {
      const result = validateCustomProvider({
        form: makeForm({
          models: [{ row: "m0", id: "model-a", name: "Model A", err: {}, contextLimit: "", outputLimit: "" }],
        }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.result!.config.models["model-a"]).toEqual({ name: "Model A", supports_temperature: true })
    })
  })

  describe("header validation", () => {
    test("skips empty header rows (no key and no value)", () => {
      const result = validateCustomProvider({
        form: makeForm({
          headers: [{ row: "h0", key: "", value: "", err: {} }],
        }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.headers[0]!).toEqual({})
      expect(result.result).toBeDefined()
    })

    test("flags header with key but no value", () => {
      const result = validateCustomProvider({
        form: makeForm({
          headers: [{ row: "h0", key: "X-Custom", value: "", err: {} }],
        }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.headers[0]!.value).toBe("provider.custom.error.required")
    })

    test("flags header with value but no key", () => {
      const result = validateCustomProvider({
        form: makeForm({
          headers: [{ row: "h0", key: "", value: "some-value", err: {} }],
        }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.headers[0]!.key).toBe("provider.custom.error.required")
    })

    test("flags duplicate header keys (case-insensitive)", () => {
      const result = validateCustomProvider({
        form: makeForm({
          headers: [
            { row: "h0", key: "Authorization", value: "one", err: {} },
            { row: "h1", key: "authorization", value: "two", err: {} },
          ],
        }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.headers[1]!.key).toBe("provider.custom.error.duplicate")
    })

    test("includes valid headers in config", () => {
      const result = validateCustomProvider({
        form: makeForm({
          headers: [{ row: "h0", key: "X-Test", value: "enabled", err: {} }],
        }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.result!.config.options.headers).toEqual({ "X-Test": "enabled" })
    })

    test("omits headers from config when none are valid", () => {
      const result = validateCustomProvider({
        form: makeForm({ headers: [] }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.result!.config.options.headers).toBeUndefined()
    })
  })

  describe("result payload", () => {
    test("uses @ai-sdk/openai-compatible as npm package", () => {
      const result = validateCustomProvider({
        form: makeForm(),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.result!.config.npm).toBe("@ai-sdk/openai-compatible")
    })

    test("trims all fields in result", () => {
      const result = validateCustomProvider({
        form: makeForm({
          providerID: " my-provider ",
          name: " My Provider ",
          baseURL: " https://api.example.com ",
          apiKey: " sk-test ",
          models: [{ row: "m0", id: " model-a ", name: " Model A ", err: {}, contextLimit: "", outputLimit: "" }],
          headers: [{ row: "h0", key: " X-Test ", value: " enabled ", err: {} }],
        }),
        t,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      })
      expect(result.result!.providerID).toBe("my-provider")
      expect(result.result!.name).toBe("My Provider")
      expect(result.result!.config.options.baseURL).toBe("https://api.example.com")
      expect(result.result!.key).toBe("sk-test")
      expect(result.result!.config.models["model-a"]!.name).toBe("Model A")
      expect(result.result!.config.options.headers).toEqual({ "X-Test": "enabled" })
    })
  })
})

describe("modelRow", () => {
  test("returns a default model row with expected defaults", () => {
    const row = modelRow()
    expect(row.id).toBe("")
    expect(row.name).toBe("")
    expect(row.contextLimit).toBe("128000")
    expect(row.outputLimit).toBe("32000")
    expect(row.temperature).toBe("0.2")
    expect(row.topP).toBe("0.25")
    expect(row.err).toEqual({})
    expect(row.row).toMatch(/^row-\d+$/)
  })

  test("generates unique row ids", () => {
    const a = modelRow()
    const b = modelRow()
    expect(a.row).not.toBe(b.row)
  })
})

describe("headerRow", () => {
  test("returns a default header row with empty fields", () => {
    const row = headerRow()
    expect(row.key).toBe("")
    expect(row.value).toBe("")
    expect(row.err).toEqual({})
    expect(row.row).toMatch(/^row-\d+$/)
  })

  test("generates unique row ids", () => {
    const a = headerRow()
    const b = headerRow()
    expect(a.row).not.toBe(b.row)
  })
})
