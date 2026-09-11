import { describe, expect, test } from "bun:test"
import type { ConfigInvalidError, ProviderModelNotFoundError } from "./server-errors"
import { formatServerError, parseReadableConfigInvalidError } from "./server-errors"

function fill(text: string, vars?: Record<string, string | number>) {
  if (!vars) return text
  return text.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) => {
    const value = vars[key]
    if (value === undefined) return ""
    return String(value)
  })
}

function useLanguageMock() {
  const dict: Record<string, string> = {
    "error.chain.unknown": "Erro desconhecido",
    "error.chain.configInvalid": "Arquivo de config em {{path}} invalido",
    "error.chain.configInvalidWithMessage": "Arquivo de config em {{path}} invalido: {{message}}",
    "error.chain.modelNotFound": "Modelo nao encontrado: {{provider}}/{{model}}",
    "error.chain.didYouMean": "Voce quis dizer: {{suggestions}}",
    "error.chain.checkConfig": "Revise provider/model no config",
  }
  return {
    t(key: string, vars?: Record<string, string | number>) {
      const text = dict[key]
      if (!text) return key
      return fill(text, vars)
    },
  }
}

const language = useLanguageMock()

describe("parseReadableConfigInvalidError", () => {
  test("formats issues with file path", () => {
    const error = {
      name: "ConfigInvalidError",
      data: {
        path: "duoduo.config.ts",
        issues: [
          { path: ["settings", "host"], message: "Required" },
          { path: ["mode"], message: "Invalid" },
        ],
      },
    } satisfies ConfigInvalidError

    // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
    const result = parseReadableConfigInvalidError(error, language.t)

    expect(result).toBe(
      ["Arquivo de config em duoduo.config.ts invalido: settings.host: Required", "mode: Invalid"].join("\n"),
    )
  })

  test("uses trimmed message when issues are missing", () => {
    const error = {
      name: "ConfigInvalidError",
      data: {
        path: "config",
        message: "  Bad value  ",
      },
    } satisfies ConfigInvalidError

    // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
    const result = parseReadableConfigInvalidError(error, language.t)

    expect(result).toBe("Arquivo de config em config invalido: Bad value")
  })
})

describe("formatServerError", () => {
  test("formats config invalid errors", () => {
    const error = {
      name: "ConfigInvalidError",
      data: {
        message: "Missing host",
      },
    } satisfies ConfigInvalidError

    // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
    const result = formatServerError(error, language.t)

    expect(result).toBe("Arquivo de config em config invalido: Missing host")
  })

  test("returns error messages", () => {
    // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
    expect(formatServerError(new Error("Request failed with status 503"), language.t)).toBe(
      "Request failed with status 503",
    )
  })

  test("returns provided string errors", () => {
    // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
    expect(formatServerError("Failed to connect to server", language.t)).toBe("Failed to connect to server")
  })

  test("uses translated unknown fallback", () => {
    // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
    expect(formatServerError(0, language.t)).toBe("Erro desconhecido")
  })

  test("surfaces real info for unknown structured error objects", () => {
    // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
    expect(formatServerError({ name: "ServerTimeoutError", data: { seconds: 30 } }, language.t)).toBe(
      'ServerTimeoutError: {\n  "seconds": 30\n}',
    )
  })

  test("surfaces data.message from the API error envelope", () => {
    // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
    expect(formatServerError({ data: { message: "connection refused" } }, language.t)).toBe("connection refused")
  })

  test("formats provider model errors using provider/model", () => {
    const error = {
      name: "ProviderModelNotFoundError",
      data: {
        providerID: "openai",
        modelID: "gpt-4.1",
      },
    } satisfies ProviderModelNotFoundError

    // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
    expect(formatServerError(error, language.t)).toBe(
      ["Modelo nao encontrado: openai/gpt-4.1", "Revise provider/model no config"].join("\n"),
    )
  })

  test("formats provider model suggestions", () => {
    const error = {
      name: "ProviderModelNotFoundError",
      data: {
        providerID: "x",
        modelID: "y",
        suggestions: ["x/y2", "x/y3"],
      },
    } satisfies ProviderModelNotFoundError

    // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
    expect(formatServerError(error, language.t)).toBe(
      ["Modelo nao encontrado: x/y", "Voce quis dizer: x/y2, x/y3", "Revise provider/model no config"].join("\n"),
    )
  })
})
