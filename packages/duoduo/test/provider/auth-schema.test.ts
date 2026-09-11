import { describe, expect, test } from "bun:test"
import { Method, Authorization, AuthorizeInput, CallbackInput } from "../../src/provider/auth"

// ─── Method schema ───

describe("ProviderAuth.Method", () => {
  test("validates oauth method type", () => {
    const result = Method.zod.safeParse({
      type: "oauth",
      label: "Sign in with Google",
    })
    expect(result.success).toBe(true)
  })

  test("validates api method type", () => {
    const result = Method.zod.safeParse({
      type: "api",
      label: "API Key",
    })
    expect(result.success).toBe(true)
  })

  test("rejects invalid method type", () => {
    const result = Method.zod.safeParse({
      type: "invalid",
      label: "Bad",
    })
    expect(result.success).toBe(false)
  })

  test("rejects missing label", () => {
    const result = Method.zod.safeParse({
      type: "oauth",
    })
    expect(result.success).toBe(false)
  })

  test("accepts method with text prompts", () => {
    const result = Method.zod.safeParse({
      type: "api",
      label: "API Key",
      prompts: [
        {
          type: "text",
          key: "api_key",
          message: "Enter your API key",
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  test("accepts method with select prompts", () => {
    const result = Method.zod.safeParse({
      type: "api",
      label: "Choose region",
      prompts: [
        {
          type: "select",
          key: "region",
          message: "Select a region",
          options: [
            { label: "US East", value: "us-east-1" },
            { label: "EU West", value: "eu-west-1" },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  test("accepts text prompt with when condition", () => {
    const result = Method.zod.safeParse({
      type: "api",
      label: "Custom",
      prompts: [
        {
          type: "text",
          key: "token",
          message: "Enter token",
          when: { key: "auth_type", op: "eq", value: "token" },
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  test("accepts text prompt with placeholder", () => {
    const result = Method.zod.safeParse({
      type: "api",
      label: "Custom",
      prompts: [
        {
          type: "text",
          key: "api_key",
          message: "Enter API key",
          placeholder: "sk-...",
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  test("accepts select option with hint", () => {
    const result = Method.zod.safeParse({
      type: "api",
      label: "Custom",
      prompts: [
        {
          type: "select",
          key: "plan",
          message: "Choose a plan",
          options: [{ label: "Pro", value: "pro", hint: "Unlimited usage" }],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  test("rejects prompt with invalid when op", () => {
    const result = Method.zod.safeParse({
      type: "api",
      label: "Custom",
      prompts: [
        {
          type: "text",
          key: "token",
          message: "Enter token",
          when: { key: "auth_type", op: "invalid", value: "token" },
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  test("prompts are optional", () => {
    const result = Method.zod.safeParse({
      type: "oauth",
      label: "Sign in",
    })
    expect(result.success).toBe(true)
  })
})

// ─── Authorization schema ───

describe("ProviderAuth.Authorization", () => {
  test("validates auto authorization", () => {
    const result = Authorization.zod.safeParse({
      url: "https://auth.example.com/authorize",
      method: "auto",
      instructions: "Click the link to authorize",
    })
    expect(result.success).toBe(true)
  })

  test("validates code authorization", () => {
    const result = Authorization.zod.safeParse({
      url: "https://auth.example.com/authorize",
      method: "code",
      instructions: "Paste the code from the redirect",
    })
    expect(result.success).toBe(true)
  })

  test("rejects invalid method", () => {
    const result = Authorization.zod.safeParse({
      url: "https://auth.example.com/authorize",
      method: "invalid",
      instructions: "Bad",
    })
    expect(result.success).toBe(false)
  })

  test("rejects missing url", () => {
    const result = Authorization.zod.safeParse({
      method: "auto",
      instructions: "Bad",
    })
    expect(result.success).toBe(false)
  })

  test("rejects missing instructions", () => {
    const result = Authorization.zod.safeParse({
      url: "https://auth.example.com/authorize",
      method: "auto",
    })
    expect(result.success).toBe(false)
  })
})

// ─── AuthorizeInput schema ───

describe("ProviderAuth.AuthorizeInput", () => {
  test("validates with method index only", () => {
    const result = AuthorizeInput.zod.safeParse({
      method: 0,
    })
    expect(result.success).toBe(true)
  })

  test("validates with method and inputs", () => {
    const result = AuthorizeInput.zod.safeParse({
      method: 1,
      inputs: { api_key: "sk-abc123" },
    })
    expect(result.success).toBe(true)
  })

  test("rejects missing method", () => {
    const result = AuthorizeInput.zod.safeParse({
      inputs: { api_key: "sk-abc123" },
    })
    expect(result.success).toBe(false)
  })

  test("rejects non-number method", () => {
    const result = AuthorizeInput.zod.safeParse({
      method: "first",
    })
    expect(result.success).toBe(false)
  })

  test("inputs are optional", () => {
    const result = AuthorizeInput.zod.safeParse({
      method: 0,
    })
    expect(result.success).toBe(true)
  })
})

// ─── CallbackInput schema ───

describe("ProviderAuth.CallbackInput", () => {
  test("validates with method index only", () => {
    const result = CallbackInput.zod.safeParse({
      method: 0,
    })
    expect(result.success).toBe(true)
  })

  test("validates with method and code", () => {
    const result = CallbackInput.zod.safeParse({
      method: 0,
      code: "abc123",
    })
    expect(result.success).toBe(true)
  })

  test("rejects missing method", () => {
    const result = CallbackInput.zod.safeParse({
      code: "abc123",
    })
    expect(result.success).toBe(false)
  })

  test("rejects non-number method", () => {
    const result = CallbackInput.zod.safeParse({
      method: "first",
      code: "abc123",
    })
    expect(result.success).toBe(false)
  })

  test("code is optional", () => {
    const result = CallbackInput.zod.safeParse({
      method: 0,
    })
    expect(result.success).toBe(true)
  })
})

// ─── Named errors ───

describe("ProviderAuth error types", () => {
  test("OauthMissing error can be created", async () => {
    const { OauthMissing } = await import("../../src/provider/auth")
    const err = new OauthMissing({ providerID: "test-provider" as any })
    expect(err).toBeDefined()
    expect(err instanceof Error).toBe(true)
  })

  test("OauthCodeMissing error can be created", async () => {
    const { OauthCodeMissing } = await import("../../src/provider/auth")
    const err = new OauthCodeMissing({ providerID: "test-provider" as any })
    expect(err).toBeDefined()
    expect(err instanceof Error).toBe(true)
  })

  test("OauthCallbackFailed error can be created", async () => {
    const { OauthCallbackFailed } = await import("../../src/provider/auth")
    const err = new OauthCallbackFailed({})
    expect(err).toBeDefined()
    expect(err instanceof Error).toBe(true)
  })

  test("ValidationFailed error can be created", async () => {
    const { ValidationFailed } = await import("../../src/provider/auth")
    const err = new ValidationFailed({ field: "api_key", message: "Invalid API key format" })
    expect(err).toBeDefined()
    expect(err instanceof Error).toBe(true)
  })
})
