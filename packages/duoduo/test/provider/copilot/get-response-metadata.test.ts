import { describe, expect, test } from "bun:test"
import { getResponseMetadata } from "../../../src/provider/sdk/copilot/chat/get-response-metadata"

describe("getResponseMetadata", () => {
  test("returns id, modelId, timestamp from full input", () => {
    const result = getResponseMetadata({
      id: "chatcmpl-abc123",
      model: "gpt-4",
      created: 1700000000,
    })
    expect(result.id).toBe("chatcmpl-abc123")
    expect(result.modelId).toBe("gpt-4")
    expect(result.timestamp).toEqual(new Date(1700000000 * 1000))
  })

  test("returns undefined for missing id", () => {
    const result = getResponseMetadata({ model: "gpt-4", created: 1700000000 })
    expect(result.id).toBeUndefined()
    expect(result.modelId).toBe("gpt-4")
  })

  test("returns undefined for missing model", () => {
    const result = getResponseMetadata({ id: "abc", created: 1700000000 })
    expect(result.modelId).toBeUndefined()
  })

  test("returns undefined for missing created", () => {
    const result = getResponseMetadata({ id: "abc", model: "gpt-4" })
    expect(result.timestamp).toBeUndefined()
  })

  test("handles null values as undefined", () => {
    const result = getResponseMetadata({ id: null, model: null, created: null })
    expect(result.id).toBeUndefined()
    expect(result.modelId).toBeUndefined()
    expect(result.timestamp).toBeUndefined()
  })

  test("handles undefined values", () => {
    const result = getResponseMetadata({ id: undefined, model: undefined, created: undefined })
    expect(result.id).toBeUndefined()
    expect(result.modelId).toBeUndefined()
    expect(result.timestamp).toBeUndefined()
  })

  test("handles empty object", () => {
    const result = getResponseMetadata({})
    expect(result.id).toBeUndefined()
    expect(result.modelId).toBeUndefined()
    expect(result.timestamp).toBeUndefined()
  })

  test("converts unix timestamp to Date correctly", () => {
    const result = getResponseMetadata({ created: 0 })
    expect(result.timestamp).toEqual(new Date(0))
  })
})
