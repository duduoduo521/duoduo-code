import { describe, expect, test } from "bun:test"
import { messageIdFromHash } from "./message-id-from-hash"

describe("messageIdFromHash", () => {
  test("extracts message ID from hash with # prefix", () => {
    expect(messageIdFromHash("#message-abc123")).toBe("abc123")
  })

  test("extracts message ID from hash without # prefix", () => {
    expect(messageIdFromHash("message-abc123")).toBe("abc123")
  })

  test("returns undefined for non-message hash", () => {
    expect(messageIdFromHash("#some-other-hash")).toBeUndefined()
  })

  test("returns undefined for empty string", () => {
    expect(messageIdFromHash("")).toBeUndefined()
  })

  test("returns undefined for just #", () => {
    expect(messageIdFromHash("#")).toBeUndefined()
  })

  test("extracts message ID with complex ID format", () => {
    expect(messageIdFromHash("#message-msg_123-abc")).toBe("msg_123-abc")
  })

  test("returns undefined for message- without ID", () => {
    expect(messageIdFromHash("#message-")).toBeUndefined()
  })

  test("handles hash that starts with message- but has no #", () => {
    expect(messageIdFromHash("message-test-id")).toBe("test-id")
  })
})
