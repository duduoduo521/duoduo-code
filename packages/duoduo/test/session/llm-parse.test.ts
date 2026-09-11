import { describe, expect, test } from "bun:test"
import * as Stream from "effect/Stream"
import * as Effect from "effect/Effect"
import { mapChunk, parseSSEStream, type Event } from "../../src/session/llm"

const emptyTools: Record<string, never> = {}

function freshState() {
  return { reasoningStarted: false, reasoningId: "", textStarted: false }
}

function toStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(enc.encode(chunks[i++]))
    },
  })
}

async function runParse(chunks: string[]): Promise<Event[]> {
  const stream = parseSSEStream(toStream(chunks), emptyTools)
  return await Effect.runPromise(Stream.runCollect(stream))
}

describe("mapChunk", () => {
  test("thinking emits reasoning-start then reasoning-delta", () => {
    const state = freshState()
    const events = mapChunk("thinking", JSON.stringify({ content: "let me think" }), emptyTools, state)
    expect(state.reasoningStarted).toBe(true)
    expect(events[0]).toEqual({ type: "reasoning-start", id: state.reasoningId })
    expect(events[1]).toEqual({ type: "reasoning-delta", id: state.reasoningId, text: "let me think" })
  })

  test("delta closes reasoning boundary then emits text-start + text-delta", () => {
    const state = { reasoningStarted: true, reasoningId: "r1", textStarted: false }
    const events = mapChunk("delta", JSON.stringify({ content: "hello" }), emptyTools, state)
    expect(state.reasoningStarted).toBe(false)
    expect(state.textStarted).toBe(true)
    expect(events[0]).toEqual({ type: "reasoning-end", id: "r1" })
    expect(events[1].type).toBe("text-start")
    expect(events[2]).toEqual({ type: "text-delta", text: "hello" })
  })

  test("delta without prior thinking emits text-start + text-delta (no reasoning-end)", () => {
    const state = freshState()
    const events = mapChunk("delta", JSON.stringify({ content: "hi" }), emptyTools, state)
    expect(events.some((e) => e.type === "reasoning-end")).toBe(false)
    expect(events[0].type).toBe("text-start")
    expect(events[1]).toEqual({ type: "text-delta", text: "hi" })
  })

  test("done closes boundaries and emits finish-step + finish with usage", () => {
    const state = { reasoningStarted: true, reasoningId: "r1", textStarted: true }
    const payload = {
      content: "final",
      modelId: "m",
      tokenUsage: { promptTokens: 10, completionTokens: 5 },
      finishReason: "stop",
    }
    const events = mapChunk("done", JSON.stringify(payload), emptyTools, state)
    expect(state.reasoningStarted).toBe(false)
    expect(state.textStarted).toBe(false)
    expect(events[0]).toEqual({ type: "reasoning-end", id: "r1" })
    expect(events[1].type).toBe("text-end")
    expect(events.some((e) => e.type === "finish-step")).toBe(true)
    expect(events[events.length - 1]).toEqual({
      type: "finish",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 10 },
        outputTokenDetails: { reasoningTokens: 0 },
      },
    })
  })

  test("done with toolCalls emits tool-input-start + tool-call (exact match)", () => {
    const state = freshState()
    const tool = { description: "x", parameters: {} } as unknown as import("ai").Tool
    const toolsMap = { webfetch: tool }
    const payload = {
      toolCalls: [{ id: "call_1", function: { name: "webfetch", arguments: '{"url":"https://x"}' } }],
    }
    const events = mapChunk("done", JSON.stringify(payload), toolsMap, state)
    expect(events[0]).toEqual({ type: "tool-input-start", toolName: "webfetch", id: "call_1" })
    expect(events[1]).toEqual({ type: "tool-call", toolName: "webfetch", toolCallId: "call_1", input: { url: "https://x" } })
  })

  test("done with case-mismatched toolName is repaired to lower-case", () => {
    const state = freshState()
    const tool = { description: "x", parameters: {} } as unknown as import("ai").Tool
    const toolsMap = { webfetch: tool }
    const payload = {
      toolCalls: [{ id: "c2", function: { name: "WebFetch", arguments: "{}" } }],
    }
    const events = mapChunk("done", JSON.stringify(payload), toolsMap, state)
    expect(events[1]).toEqual({ type: "tool-call", toolName: "webfetch", toolCallId: "c2", input: {} })
  })

  test("done with unknown toolName is marked invalid", () => {
    const state = freshState()
    const payload = {
      toolCalls: [{ id: "c3", function: { name: "nonexistent", arguments: "{}" } }],
    }
    const events = mapChunk("done", JSON.stringify(payload), {}, state)
    expect(events[1]).toEqual({
      type: "tool-call",
      toolName: "invalid",
      toolCallId: "c3",
      input: { tool: "nonexistent", error: "Unknown tool: nonexistent" },
    })
  })

  test("error closes open boundaries and returns a single error event (no throw)", () => {
    const state = { reasoningStarted: true, reasoningId: "r1", textStarted: true }
    const events = mapChunk("error", JSON.stringify({ message: "boom" }), emptyTools, state)
    expect(state.reasoningStarted).toBe(false)
    expect(state.textStarted).toBe(false)
    expect(events[0]).toEqual({ type: "reasoning-end", id: "r1" })
    expect(events[1].type).toBe("text-end")
    expect(events[2]).toEqual({ type: "error", error: expect.any(Error) })
    expect((events[2] as { error: Error }).error.message).toBe("boom")
  })

  test("unknown eventType yields no events and does not throw", () => {
    const state = freshState()
    const events = mapChunk("telemetry", JSON.stringify({ foo: 1 }), emptyTools, state)
    expect(events).toEqual([])
  })

  test("malformed JSON in delta does not throw (caught internally)", () => {
    const state = freshState()
    expect(() => mapChunk("delta", "{not json", emptyTools, state)).not.toThrow()
  })
})

describe("parseSSEStream", () => {
  test("parses SSE frames whose bytes are split across chunks (byte-level reassembly)", async () => {
    // One complete frame `event: delta\ndata: {"content":"hello"}\n\n`. Split the
    // byte sequence at a line boundary and inside the JSON value — the parser must
    // reassemble the buffer across chunk boundaries. The full `event: delta` line
    // stays intact within chunk 1 (only the `\n` trailing it is at the boundary).
    const frame = 'event: delta\ndata: {"content":"hello"}\n\n'
    const chunks = [frame.slice(0, 13), frame.slice(13, 30), frame.slice(30)]
    const events = await runParse(chunks)
    const deltas = events.filter((e) => e.type === "text-delta") as Array<{ type: "text-delta"; text: string }>
    expect(deltas.map((d) => d.text).join("")).toBe("hello")
  })

  test("emits start/start-step on first event then delta", async () => {
    const events = await runParse(['event: delta\ndata: {"content":"x"}\n\n'])
    expect(events[0]).toEqual({ type: "start" })
    expect(events[1]).toEqual({ type: "start-step" })
    expect(events[2].type).toBe("text-start")
  })

  test("unknown eventType still emits start/start-step but no business events", async () => {
    const events = await runParse(['event: telemetry\ndata: {"foo":1}\n\n'])
    // start/start-step are emitted on the first frame regardless of eventType;
    // the unknown `telemetry` payload is not mapped to any event.
    expect(events[0]).toEqual({ type: "start" })
    expect(events[1]).toEqual({ type: "start-step" })
    expect(events.filter((e) => e.type === "text-delta" || e.type === "reasoning-delta")).toEqual([])
  })

  test("corrupted data JSON does not crash the stream (caught per-chunk)", async () => {
    const events = await runParse(['event: delta\ndata: {bad-json}\n\n'])
    // mapChunk catches internally; parseSSEStream should not throw
    expect(Array.isArray(events)).toBe(true)
  })

  test("thinking then delta ordering produces reasoning-end before text-start", async () => {
    const events = await runParse([
      'event: thinking\ndata: {"content":"hmm"}\n\n',
      'event: delta\ndata: {"content":"ans"}\n\n',
    ])
    const types = events.map((e) => e.type)
    const idxReasonEnd = types.indexOf("reasoning-end")
    const idxTextStart = types.indexOf("text-start")
    expect(idxReasonEnd).toBeGreaterThan(-1)
    expect(idxTextStart).toBeGreaterThan(-1)
    expect(idxReasonEnd).toBeLessThan(idxTextStart)
  })

  test("event: line and data: line arriving in separate chunks still pair (regression guard)", async () => {
    // The `event:` line lands in chunk 1, the `data:` line in chunk 2. Before the
    // fix, currentEvent/currentData were reset per chunk read, dropping the event type.
    const chunks = ["event: delta\n", 'data: {"content":"split"}\n\n']
    const events = await runParse(chunks)
    const deltas = events.filter((e) => e.type === "text-delta") as Array<{ type: "text-delta"; text: string }>
    expect(deltas.map((d) => d.text).join("")).toBe("split")
  })
})
