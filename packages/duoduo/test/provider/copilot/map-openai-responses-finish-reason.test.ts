import { describe, expect, test } from "bun:test"
import { mapOpenAIResponseFinishReason } from "../../../src/provider/sdk/copilot/responses/map-openai-responses-finish-reason"

describe("mapOpenAIResponseFinishReason", () => {
  test("returns 'stop' when finishReason is undefined and no function call", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: undefined, hasFunctionCall: false })).toBe("stop")
  })

  test("returns 'tool-calls' when finishReason is undefined but has function call", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: undefined, hasFunctionCall: true })).toBe("tool-calls")
  })

  test("returns 'stop' when finishReason is null and no function call", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: null, hasFunctionCall: false })).toBe("stop")
  })

  test("returns 'tool-calls' when finishReason is null but has function call", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: null, hasFunctionCall: true })).toBe("tool-calls")
  })

  test("maps 'max_output_tokens' to 'length'", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: "max_output_tokens", hasFunctionCall: false })).toBe("length")
  })

  test("maps 'content_filter' to 'content-filter'", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: "content_filter", hasFunctionCall: false })).toBe(
      "content-filter",
    )
  })

  test("returns 'tool-calls' for unknown finish reason when has function call", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: "stopped", hasFunctionCall: true })).toBe("tool-calls")
  })

  test("returns 'other' for unknown finish reason when no function call", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: "stopped", hasFunctionCall: false })).toBe("other")
  })

  test("returns 'other' for empty string finish reason without function call", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: "", hasFunctionCall: false })).toBe("other")
  })

  test("returns 'tool-calls' for empty string finish reason with function call", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: "", hasFunctionCall: true })).toBe("tool-calls")
  })
})
