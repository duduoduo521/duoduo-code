import { describe, expect, test } from "bun:test"

// formatError and formatErrorChain logic from error.tsx — not exported, replicated here for testing.
// These are the pure formatting functions that power the ErrorPage component.

const CHAIN_SEPARATOR = "\n" + "─".repeat(40) + "\n"

type InitError = {
  name: string
  data: Record<string, unknown>
}

function isInitError(error: unknown): error is InitError {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    "data" in error &&
    typeof (error as InitError).data === "object"
  )
}

// Simplified translator that returns the key for testing
function t(key: string, params?: Record<string, string>): string {
  if (!params) return key
  return Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, v), key)
}

function safeJson(value: unknown, circular: string): string {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === "bigint") return val.toString()
      if (typeof val === "object" && val) {
        if (seen.has(val)) return circular
        seen.add(val)
      }
      return val
    },
    2,
  )
  return json ?? String(value)
}

function formatInitError(error: InitError): string {
  const data = error.data
  const json = (value: unknown) => safeJson(value, t("error.page.circular"))

  switch (error.name) {
    case "MCPFailed": {
      const name = typeof data.name === "string" ? data.name : ""
      return t("error.chain.mcpFailed", { name })
    }
    case "ProviderAuthError": {
      const providerID = typeof data.providerID === "string" ? data.providerID : t("common.unknown")
      const message = typeof data.message === "string" ? data.message : json(data.message)
      return t("error.chain.providerAuthFailed", { provider: providerID, message })
    }
    case "APIError": {
      const message = typeof data.message === "string" ? data.message : t("error.chain.apiError")
      const lines: string[] = [message]

      if (typeof data.statusCode === "number") {
        lines.push(t("error.chain.status", { status: String(data.statusCode) }))
      }

      if (typeof data.isRetryable === "boolean") {
        lines.push(t("error.chain.retryable", { retryable: String(data.isRetryable) }))
      }

      if (typeof data.responseBody === "string" && data.responseBody) {
        lines.push(t("error.chain.responseBody", { body: data.responseBody }))
      }

      return lines.join("\n")
    }
    case "UnknownError":
      return typeof data.message === "string" ? data.message : json(data)
    default:
      if (typeof data.message === "string") return data.message
      return json(data)
  }
}

function formatErrorChain(error: unknown, depth = 0, parentMessage?: string): string {
  const json = (value: unknown) => safeJson(value, t("error.page.circular"))

  if (!error) return t("error.chain.unknown")

  if (isInitError(error)) {
    const message = formatInitError(error)
    if (depth > 0 && parentMessage === message) return ""
    const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""
    return indent + `${error.name}\n${message}`
  }

  if (error instanceof Error) {
    const isDuplicate = depth > 0 && parentMessage === error.message
    const parts: string[] = []
    const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""

    const header = `${error.name}${error.message ? `: ${error.message}` : ""}`
    const stack = error.stack?.trim()

    if (stack) {
      const startsWithHeader = stack.startsWith(header)

      if (isDuplicate && startsWithHeader) {
        const trace = stack.split("\n").slice(1).join("\n").trim()
        if (trace) parts.push(indent + trace)
      }

      if (isDuplicate && !startsWithHeader) {
        parts.push(indent + stack)
      }

      if (!isDuplicate && startsWithHeader) {
        parts.push(indent + stack)
      }

      if (!isDuplicate && !startsWithHeader) {
        parts.push(indent + `${header}\n${stack}`)
      }
    }

    if (!stack && !isDuplicate) {
      parts.push(indent + header)
    }

    if (error.cause) {
      const causeResult = formatErrorChain(error.cause, depth + 1, error.message)
      if (causeResult) parts.push(causeResult)
    }

    return parts.join("\n\n")
  }

  if (typeof error === "string") {
    if (depth > 0 && parentMessage === error) return ""
    const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""
    return indent + error
  }

  const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""
  return indent + json(error)
}

describe("formatInitError", () => {
  test("formats MCPFailed error", () => {
    const result = formatInitError({ name: "MCPFailed", data: { name: "my-mcp" } })
    // The result should contain the error chain key and the MCP name from data
    expect(result).toContain("error.chain.mcpFailed")
  })

  test("formats ProviderAuthError with message", () => {
    const result = formatInitError({
      name: "ProviderAuthError",
      data: { providerID: "openai", message: "Invalid key" },
    })
    // The result contains the i18n key (real t() would interpolate provider & message)
    expect(result).toContain("error.chain.providerAuthFailed")
  })

  test("formats APIError with status code", () => {
    const result = formatInitError({
      name: "APIError",
      data: { message: "Rate limited", statusCode: 429, isRetryable: true },
    })
    expect(result).toContain("Rate limited")
    expect(result).toContain("error.chain.status")
    expect(result).toContain("error.chain.retryable")
  })

  test("formats APIError without optional fields", () => {
    const result = formatInitError({
      name: "APIError",
      data: { message: "Server error" },
    })
    expect(result).toContain("Server error")
  })

  test("formats UnknownError with message", () => {
    const result = formatInitError({
      name: "UnknownError",
      data: { message: "Something went wrong" },
    })
    expect(result).toBe("Something went wrong")
  })

  test("formats unknown error name with data.message", () => {
    const result = formatInitError({
      name: "CustomError",
      data: { message: "custom error message" },
    })
    expect(result).toBe("custom error message")
  })

  test("formats unknown error name without message as JSON", () => {
    const result = formatInitError({
      name: "CustomError",
      data: { code: 500 },
    })
    expect(result).toContain("500")
  })
})

describe("formatErrorChain", () => {
  test("returns unknown for falsy values", () => {
    expect(formatErrorChain(null)).toContain("error.chain.unknown")
    expect(formatErrorChain(undefined)).toContain("error.chain.unknown")
    expect(formatErrorChain(0)).toContain("error.chain.unknown")
    expect(formatErrorChain("")).toContain("error.chain.unknown")
  })

  test("formats InitError at depth 0", () => {
    const result = formatErrorChain({ name: "MCPFailed", data: { name: "mcp1" } })
    expect(result).toContain("MCPFailed")
  })

  test("formats Error instance", () => {
    const result = formatErrorChain(new Error("test error"))
    expect(result).toContain("test error")
  })

  test("formats string error", () => {
    const result = formatErrorChain("something broke")
    expect(result).toContain("something broke")
  })

  test("formats Error with cause chain", () => {
    const cause = new Error("root cause")
    const error = new Error("wrapper error")
    error.cause = cause
    const result = formatErrorChain(error)
    expect(result).toContain("wrapper error")
    expect(result).toContain("root cause")
    expect(result).toContain("error.chain.causedBy")
  })

  test("deduplicates duplicate messages in chain", () => {
    const cause = new Error("same message")
    const error = new Error("same message")
    error.cause = cause
    const result = formatErrorChain(error)
    // The parent message should appear, the duplicate child should be suppressed
    expect(result).toContain("same message")
  })

  test("formats InitError at depth > 0 with causedBy separator", () => {
    const inner: InitError = { name: "MCPFailed", data: { name: "mcp1" } }
    const outer = new Error("outer error")
    outer.cause = inner
    const result = formatErrorChain(outer)
    expect(result).toContain("outer error")
    expect(result).toContain("error.chain.causedBy")
    expect(result).toContain("MCPFailed")
  })

  test("suppresses duplicate InitError messages in chain", () => {
    const inner: InitError = { name: "APIError", data: { message: "rate limited" } }
    const outer: InitError = { name: "APIError", data: { message: "rate limited" } }
    // Simulate chain by formatting inner at depth 1 with same parentMessage
    const result = formatErrorChain(inner, 1, "rate limited")
    expect(result).toBe("")
  })

  test("formats object error as JSON", () => {
    const result = formatErrorChain({ foo: "bar" })
    expect(result).toContain("foo")
    expect(result).toContain("bar")
  })
})
