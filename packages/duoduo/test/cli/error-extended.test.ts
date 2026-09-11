import { describe, expect, test } from "bun:test"
import { FormatError } from "../../src/cli/error"
import { NamedError } from "@duoduo-ai/shared/util/error"
import z from "zod"

describe("cli.error.FormatError", () => {
  test("formats MCPFailed error", () => {
    const MCPFailed = NamedError.create("MCPFailed", z.object({ name: z.string() }))
    const err = new MCPFailed({ name: "my-server" })
    const result = FormatError(err)
    expect(result).toContain("my-server")
    expect(result).toContain("MCP server")
    expect(result).toContain("does not support MCP authentication")
  })

  test("formats ProviderModelNotFoundError with suggestions", () => {
    const ModelNotFound = NamedError.create(
      "ProviderModelNotFoundError",
      z.object({
        providerID: z.string(),
        modelID: z.string(),
        suggestions: z.array(z.string()).optional(),
      }),
    )
    const err = new ModelNotFound({
      providerID: "openai",
      modelID: "gpt-5",
      suggestions: ["gpt-4o", "gpt-4o-mini"],
    })
    const result = FormatError(err)
    expect(result).toContain("Model not found: openai/gpt-5")
    expect(result).toContain("Did you mean: gpt-4o, gpt-4o-mini")
    expect(result).toContain("duoduocode models")
  })

  test("formats ProviderModelNotFoundError without suggestions", () => {
    const ModelNotFound = NamedError.create(
      "ProviderModelNotFoundError",
      z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
    )
    const err = new ModelNotFound({
      providerID: "anthropic",
      modelID: "claude-10",
    })
    const result = FormatError(err)
    expect(result).toContain("Model not found: anthropic/claude-10")
    expect(result).not.toContain("Did you mean")
    expect(result).toContain("duoduocode models")
  })

  test("formats ProviderInitError", () => {
    const ProviderInitError = NamedError.create(
      "ProviderInitError",
      z.object({
        providerID: z.string(),
      }),
    )
    const err = new ProviderInitError({ providerID: "openai" })
    const result = FormatError(err)
    expect(result).toContain("Failed to initialize provider")
    expect(result).toContain("openai")
    expect(result).toContain("Check credentials")
  })

  test("formats ConfigJsonError with message", () => {
    const ConfigJsonError = NamedError.create(
      "ConfigJsonError",
      z.object({
        path: z.string(),
        message: z.string().optional(),
      }),
    )
    const err = new ConfigJsonError({ path: "/home/user/duoduo-ai.json", message: "Unexpected token" })
    const result = FormatError(err)
    expect(result).toContain("/home/user/duoduo-ai.json")
    expect(result).toContain("not valid JSON")
    expect(result).toContain("Unexpected token")
  })

  test("formats ConfigJsonError without message", () => {
    const ConfigJsonError = NamedError.create(
      "ConfigJsonError",
      z.object({
        path: z.string(),
        message: z.string().optional(),
      }),
    )
    const err = new ConfigJsonError({ path: "/home/user/duoduo-ai.json", message: undefined })
    const result = FormatError(err)
    expect(result).toContain("/home/user/duoduo-ai.json")
    expect(result).toContain("not valid JSON")
    expect(result).not.toContain(": undefined")
  })

  test("formats ConfigDirectoryTypoError", () => {
    const ConfigDirectoryTypoError = NamedError.create(
      "ConfigDirectoryTypoError",
      z.object({
        dir: z.string(),
        path: z.string(),
        suggestion: z.string(),
      }),
    )
    const err = new ConfigDirectoryTypoError({
      dir: "promt",
      path: "/home/user/duoduo-ai.json",
      suggestion: "prompt",
    })
    const result = FormatError(err)
    expect(result).toContain('"promt"')
    expect(result).toContain('"prompt"')
    expect(result).toContain("common typo")
  })

  test("formats ConfigFrontmatterError", () => {
    const ConfigFrontmatterError = NamedError.create(
      "ConfigFrontmatterError",
      z.object({
        message: z.string(),
      }),
    )
    const err = new ConfigFrontmatterError({ message: "Invalid frontmatter format" })
    const result = FormatError(err)
    expect(result).toBe("Invalid frontmatter format")
  })

  test("formats ConfigInvalidError with path and issues", () => {
    const ConfigInvalidError = NamedError.create(
      "ConfigInvalidError",
      z.object({
        path: z.string().optional(),
        message: z.string().optional(),
        issues: z.array(z.object({ message: z.string(), path: z.array(z.string()) })),
      }),
    )
    const err = new ConfigInvalidError({
      path: "/home/user/duoduo-ai.json",
      message: "Validation failed",
      issues: [
        { message: "Required field missing", path: ["server", "port"] },
        { message: "Invalid type", path: ["server", "hostname"] },
      ],
    })
    const result = FormatError(err)
    expect(result).toContain("/home/user/duoduo-ai.json")
    expect(result).toContain("Validation failed")
    expect(result).toContain("↳ Required field missing server.port")
    expect(result).toContain("↳ Invalid type server.hostname")
  })

  test("formats ConfigInvalidError without path", () => {
    const ConfigInvalidError = NamedError.create(
      "ConfigInvalidError",
      z.object({
        path: z.string().optional(),
        message: z.string().optional(),
        issues: z.array(z.object({ message: z.string(), path: z.array(z.string()) })),
      }),
    )
    const err = new ConfigInvalidError({
      path: "config",
      message: undefined,
      issues: [],
    })
    const result = FormatError(err)
    expect(result).toContain("Configuration is invalid")
    expect(result).not.toContain("at config")
  })

  test("formats UICancelledError as empty string", () => {
    const UICancelledError = NamedError.create("UICancelledError", z.object({}))
    const err = new UICancelledError({})
    const result = FormatError(err)
    expect(result).toBe("")
  })

  test("returns undefined for unknown error types", () => {
    const err = new Error("unknown error")
    const result = FormatError(err)
    expect(result).toBeUndefined()
  })

  test("handles tagged AccountServiceError", () => {
    const err = { _tag: "AccountServiceError", message: "Service unavailable" }
    const result = FormatError(err)
    expect(result).toBe("Service unavailable")
  })

  test("handles tagged AccountTransportError", () => {
    const err = { _tag: "AccountTransportError", message: "Connection refused" }
    const result = FormatError(err)
    expect(result).toBe("Connection refused")
  })

  test("handles tagged AccountServiceError without message", () => {
    const err = { _tag: "AccountServiceError" }
    const result = FormatError(err)
    expect(result).toBe("")
  })
})
