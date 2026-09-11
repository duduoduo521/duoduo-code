import { describe, expect, test } from "bun:test"
import {
  Method,
  Methods,
  Authorization,
  AuthorizeInput,
  CallbackInput,
  OauthMissing,
  OauthCodeMissing,
  OauthCallbackFailed,
  ValidationFailed,
} from "../../src/provider/auth"
import { Schema } from "effect"

describe("ProviderAuth.Method", () => {
  test("validates oauth method", () => {
    const result = Schema.decodeUnknownSync(Method)({
      type: "oauth",
      label: "GitHub OAuth",
    })
    expect(result.type).toBe("oauth")
    expect(result.label).toBe("GitHub OAuth")
  })

  test("validates api method", () => {
    const result = Schema.decodeUnknownSync(Method)({
      type: "api",
      label: "API Key",
    })
    expect(result.type).toBe("api")
    expect(result.label).toBe("API Key")
  })

  test("validates method with prompts", () => {
    const result = Schema.decodeUnknownSync(Method)({
      type: "oauth",
      label: "OAuth with prompts",
      prompts: [
        { type: "text", key: "org", message: "Organization" },
        {
          type: "select",
          key: "region",
          message: "Region",
          options: [
            { label: "US", value: "us" },
            { label: "EU", value: "eu" },
          ],
        },
      ],
    })
    expect(result.prompts).toBeDefined()
    expect(result.prompts!.length).toBe(2)
  })

  test("rejects invalid type", () => {
    expect(() => Schema.decodeUnknownSync(Method)({ type: "saml", label: "SAML" })).toThrow()
  })
})

describe("ProviderAuth.Methods", () => {
  test("validates methods map", () => {
    const result = Schema.decodeUnknownSync(Methods)({
      github: [{ type: "oauth", label: "GitHub" }],
      openai: [{ type: "api", label: "OpenAI API Key" }],
    })
    expect(result).toBeDefined()
  })

  test("has zod static method", () => {
    expect(Methods.zod).toBeDefined()
    const result = Methods.zod.safeParse({
      test: [{ type: "oauth", label: "Test" }],
    })
    expect(result.success).toBe(true)
  })
})

describe("ProviderAuth.Authorization", () => {
  test("validates authorization with auto method", () => {
    const result = Schema.decodeUnknownSync(Authorization)({
      url: "https://github.com/login/oauth/authorize",
      method: "auto",
      instructions: "Follow the link",
    })
    expect(result.method).toBe("auto")
  })

  test("validates authorization with code method", () => {
    const result = Schema.decodeUnknownSync(Authorization)({
      url: "https://example.com/auth",
      method: "code",
      instructions: "Enter the code",
    })
    expect(result.method).toBe("code")
  })

  test("has zod static method", () => {
    expect(Authorization.zod).toBeDefined()
  })
})

describe("ProviderAuth.AuthorizeInput", () => {
  test("has zod static method", () => {
    expect(AuthorizeInput.zod).toBeDefined()
    const result = AuthorizeInput.zod.safeParse({ method: 0 })
    expect(result.success).toBe(true)
  })

  test("validates with optional inputs", () => {
    const result = AuthorizeInput.zod.safeParse({
      method: 0,
      inputs: { org: "my-org" },
    })
    expect(result.success).toBe(true)
  })
})

describe("ProviderAuth.CallbackInput", () => {
  test("has zod static method", () => {
    expect(CallbackInput.zod).toBeDefined()
    const result = CallbackInput.zod.safeParse({ method: 0 })
    expect(result.success).toBe(true)
  })

  test("validates with optional code", () => {
    const result = CallbackInput.zod.safeParse({
      method: 0,
      code: "abc123",
    })
    expect(result.success).toBe(true)
  })
})

describe("ProviderAuth errors", () => {
  test("OauthMissing creates error with providerID", () => {
    const err = new OauthMissing({ providerID: "github" as any })
    expect(err.name).toBe("ProviderAuthOauthMissing")
    expect(err.data.providerID).toBe("github")
  })

  test("OauthCodeMissing creates error with providerID", () => {
    const err = new OauthCodeMissing({ providerID: "github" as any })
    expect(err.name).toBe("ProviderAuthOauthCodeMissing")
    expect(err.data.providerID).toBe("github")
  })

  test("OauthCallbackFailed creates error", () => {
    const err = new OauthCallbackFailed({})
    expect(err.name).toBe("ProviderAuthOauthCallbackFailed")
  })

  test("ValidationFailed creates error with field and message", () => {
    const err = new ValidationFailed({ field: "api_key", message: "Invalid key format" })
    expect(err.name).toBe("ProviderAuthValidationFailed")
    expect(err.data.field).toBe("api_key")
    expect(err.data.message).toBe("Invalid key format")
  })
})
