import { describe, expect, test } from "bun:test"
import { ProviderID, ModelID } from "../../src/provider/schema"

describe("ProviderID", () => {
  test("creates branded string", () => {
    const id = ProviderID.make("test-provider")
    expect(id).toBe("test-provider" as any)
  })

  test("well-known duoduo provider", () => {
    expect(ProviderID.duoduo).toBe("duoduo" as any)
  })

  test("well-known ollama provider", () => {
    expect(ProviderID.ollama).toBe("ollama" as any)
  })

  test("well-known lm-studio provider", () => {
    expect(ProviderID["lm-studio"]).toBe("lm-studio" as any)
  })

  test("well-known llama-cpp provider", () => {
    expect(ProviderID["llama-cpp"]).toBe("llama-cpp" as any)
  })

  test("well-known vllm provider", () => {
    expect(ProviderID.vllm).toBe("vllm" as any)
  })

  test("well-known tgi provider", () => {
    expect(ProviderID.tgi).toBe("tgi" as any)
  })

  test("well-known lmdeploy provider", () => {
    expect(ProviderID.lmdeploy).toBe("lmdeploy" as any)
  })

  test("well-known sglang provider", () => {
    expect(ProviderID.sglang).toBe("sglang" as any)
  })

  test("well-known mlx provider", () => {
    expect(ProviderID.mlx).toBe("mlx" as any)
  })

  test("cloud vendors removed (custom + 8 local + duoduo only)", () => {
    const removed = [
      "anthropic",
      "openai",
      "google",
      "google-vertex",
      "github-copilot",
      "amazon-bedrock",
      "azure",
      "openrouter",
      "mistral",
      "gitlab",
    ]
    for (const id of removed) {
      expect((ProviderID as Record<string, unknown>)[id]).toBeUndefined()
    }
  })

  test("zod schema validates string", () => {
    const result = ProviderID.zod.safeParse("my-provider")
    expect(result.success).toBe(true)
  })

  test("zod schema rejects non-string", () => {
    const result = ProviderID.zod.safeParse(123)
    expect(result.success).toBe(false)
  })

  test("all well-known IDs are strings", () => {
    const wellKnown = [
      ProviderID.duoduo,
      ProviderID.ollama,
      ProviderID["lm-studio"],
      ProviderID["llama-cpp"],
      ProviderID.vllm,
      ProviderID.tgi,
      ProviderID.lmdeploy,
      ProviderID.sglang,
      ProviderID.mlx,
    ]
    for (const id of wellKnown) {
      expect(typeof id).toBe("string")
      expect(id.length).toBeGreaterThan(0)
    }
  })
})

describe("ModelID", () => {
  test("creates branded string", () => {
    const id = ModelID.make("gpt-4")
    expect(id).toBe("gpt-4" as any)
  })

  test("zod schema validates string", () => {
    const result = ModelID.zod.safeParse("claude-3-opus")
    expect(result.success).toBe(true)
  })

  test("zod schema rejects non-string", () => {
    const result = ModelID.zod.safeParse(42)
    expect(result.success).toBe(false)
  })
})
