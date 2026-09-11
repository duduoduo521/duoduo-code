import { describe, expect, test, beforeAll, mock } from "bun:test"

let decode64: typeof import("./base64").decode64
let base64Encode: typeof import("@duoduo-ai/shared/util/encode").base64Encode

beforeAll(async () => {
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@duoduo-ai/shared/util/encode", () => ({
    base64Decode: (value: string) => {
      const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"))
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
      return new TextDecoder().decode(bytes)
    },
    base64Encode: (value: string) => {
      const bytes = new TextEncoder().encode(value)
      const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("")
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
    },
  }))
  const mod = await import("./base64")
  const encodeMod = await import("@duoduo-ai/shared/util/encode")
  decode64 = mod.decode64
  base64Encode = encodeMod.base64Encode
})

describe("decode64", () => {
  test("decodes valid base64 string", () => {
    expect(decode64(btoa("hello world"))).toBe("hello world")
  })

  test("decodes URL-safe base64 string", () => {
    const encoded = base64Encode("test data")
    expect(decode64(encoded)).toBe("test data")
  })

  test("returns undefined for undefined input", () => {
    expect(decode64(undefined)).toBeUndefined()
  })

  test("returns undefined for invalid base64", () => {
    expect(decode64("!!!invalid!!!")).toBeUndefined()
  })

  test("decodes empty string", () => {
    expect(decode64("")).toBe("")
  })

  test("round-trips unicode content", () => {
    const original = "你好世界 🌍 café"
    const encoded = base64Encode(original)
    expect(decode64(encoded)).toBe(original)
  })

  test("round-trips ASCII content", () => {
    const original = "The quick brown fox jumps over the lazy dog"
    const encoded = base64Encode(original)
    expect(decode64(encoded)).toBe(original)
  })

  test("handles URL-safe characters (- and _)", () => {
    // btoa of a long string that produces + and / in standard base64
    const original = "a".repeat(100)
    const encoded = base64Encode(original)
    // URL-safe encoding replaces + with - and / with _
    expect(encoded).not.toMatch(/\+/)
    expect(decode64(encoded)).toBe(original)
  })
})
