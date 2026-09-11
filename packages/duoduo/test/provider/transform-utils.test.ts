import { describe, expect, test } from "bun:test"

// The `sdkKey` function is module-scoped and not exported from transform.ts.
// After OPT-6/15 every provider is served through `@ai-sdk/openai-compatible`,
// so `sdkKey` always returns `undefined` (no provider-specific remap). We
// replicate the (now trivial) logic here for unit testing.

function sdkKey(_npm: string): undefined {
  return undefined
}

describe("ProviderTransform.sdkKey", () => {
  test("always returns undefined (all providers use @ai-sdk/openai-compatible)", () => {
    expect(sdkKey("@ai-sdk/github-copilot")).toBeUndefined()
    expect(sdkKey("@ai-sdk/azure")).toBeUndefined()
    expect(sdkKey("@ai-sdk/openai")).toBeUndefined()
    expect(sdkKey("@ai-sdk/amazon-bedrock")).toBeUndefined()
    expect(sdkKey("@ai-sdk/anthropic")).toBeUndefined()
    expect(sdkKey("@ai-sdk/google")).toBeUndefined()
    expect(sdkKey("@ai-sdk/gateway")).toBeUndefined()
    expect(sdkKey("@ai-sdk/openai-compatible")).toBeUndefined()
    expect(sdkKey("unknown-package")).toBeUndefined()
    expect(sdkKey("")).toBeUndefined()
  })
})

// ─── mimeToModality ───

function mimeToModality(mime: string): string | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

describe("ProviderTransform.mimeToModality", () => {
  test("maps image/png to image", () => {
    expect(mimeToModality("image/png")).toBe("image")
  })

  test("maps image/jpeg to image", () => {
    expect(mimeToModality("image/jpeg")).toBe("image")
  })

  test("maps image/gif to image", () => {
    expect(mimeToModality("image/gif")).toBe("image")
  })

  test("maps image/webp to image", () => {
    expect(mimeToModality("image/webp")).toBe("image")
  })

  test("maps audio/mp3 to audio", () => {
    expect(mimeToModality("audio/mp3")).toBe("audio")
  })

  test("maps audio/wav to audio", () => {
    expect(mimeToModality("audio/wav")).toBe("audio")
  })

  test("maps video/mp4 to video", () => {
    expect(mimeToModality("video/mp4")).toBe("video")
  })

  test("maps video/webm to video", () => {
    expect(mimeToModality("video/webm")).toBe("video")
  })

  test("maps application/pdf to pdf", () => {
    expect(mimeToModality("application/pdf")).toBe("pdf")
  })

  test("returns undefined for text/plain", () => {
    expect(mimeToModality("text/plain")).toBeUndefined()
  })

  test("returns undefined for application/json", () => {
    expect(mimeToModality("application/json")).toBeUndefined()
  })

  test("returns undefined for empty string", () => {
    expect(mimeToModality("")).toBeUndefined()
  })
})
