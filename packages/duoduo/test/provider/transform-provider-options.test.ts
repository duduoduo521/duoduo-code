import { describe, expect, test } from "bun:test"
import { providerOptions } from "../../src/provider/transform"

function makeModel(overrides: { id?: string; providerID?: string; npm?: string }) {
  return {
    id: overrides.id ?? "test-model",
    providerID: overrides.providerID ?? "test",
    api: {
      id: overrides.id ?? "test-model",
      url: "https://api.test.com",
      npm: overrides.npm ?? "@ai-sdk/openai-compatible",
    },
  } as any
}

// ─── providerOptions ───
// After OPT-6/15 every provider is served through `@ai-sdk/openai-compatible`
// (or the `custom` OpenAI-compatible base_url path). `sdkKey` always returns
// `undefined`, so provider options are always keyed by the model's providerID
// with no cloud-vendor-specific remapping (no gateway split, no azure dual-key,
// no bedrock/vertex/copilot remap).

describe("ProviderTransform.providerOptions", () => {
  test("keys options by providerID (openai-compatible default)", () => {
    const model = makeModel({ providerID: "my-custom", npm: "@ai-sdk/openai-compatible" })
    const result = providerOptions(model, { someOption: "value" })
    expect(result).toEqual({
      "my-custom": { someOption: "value" },
    })
  })

  test("keys options by providerID regardless of npm package", () => {
    const model = makeModel({ providerID: "anthropic", npm: "@ai-sdk/anthropic" })
    const result = providerOptions(model, { thinking: { type: "enabled", budgetTokens: 10000 } })
    expect(result).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 10000 } },
    })
  })

  test("uses providerID as key for local frameworks", () => {
    const model = makeModel({ providerID: "vllm", npm: "@ai-sdk/openai-compatible" })
    const result = providerOptions(model, { reasoningEffort: "high" })
    expect(result).toEqual({ vllm: { reasoningEffort: "high" } })
  })
})
