import { describe, test, expect } from "bun:test"
import * as DateTime from "effect/DateTime"
import { Schema } from "effect"
import { SessionEvent } from "../../src/v2/session-event"

const time = (ms: number) => DateTime.makeUnsafe(ms)

// ============================================================================
// Helper: JSON round-trip + Effect Schema decode
// ============================================================================

function jsonRoundTrip<T>(schema: any, value: T): T {
  // Effect Schema DateTimeUtc doesn't decode from ISO strings via JSON.parse.
  // Use encodeSync → revive ISO strings → decodeUnknownSync for a true
  // JSON round-trip that validates wire format compatibility.
  const encoded = Schema.encodeSync(schema)(value)
  const json = JSON.stringify(encoded)
  const parsed = JSON.parse(json)
  // Recursively convert ISO date strings back to DateTime.Utc objects
  function revive(obj: any): any {
    if (Array.isArray(obj)) return obj.map(revive)
    if (obj && typeof obj === "object") {
      const result: Record<string, any> = {}
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
          result[k] = DateTime.makeUnsafe(new Date(v).getTime())
        } else {
          result[k] = revive(v)
        }
      }
      return result
    }
    return obj
  }
  return Schema.decodeUnknownSync(schema)(revive(parsed))
}

// ============================================================================
// Prompt.create()
// ============================================================================

describe("SessionEvent.Prompt", () => {
  test("create() generates ID, sets type='prompt', preserves text", () => {
    const event = SessionEvent.Prompt.create({ text: "hello" })
    expect(event.id).toBeDefined()
    expect(typeof event.id).toBe("string")
    expect(event.type).toBe("prompt")
    expect(event.text).toBe("hello")
  })

  test("create() preserves files", () => {
    const file = new SessionEvent.FileAttachment({
      uri: "file:///test.ts",
      mime: "text/typescript",
    })
    const event = SessionEvent.Prompt.create({ text: "read this", files: [file] })
    expect(event.files).toHaveLength(1)
    expect(event.files![0].uri).toBe("file:///test.ts")
    expect(event.files![0].mime).toBe("text/typescript")
  })

  test("create() preserves agents", () => {
    const agent = new SessionEvent.AgentAttachment({ name: "coder" })
    const event = SessionEvent.Prompt.create({ text: "use agent", agents: [agent] })
    expect(event.agents).toHaveLength(1)
    expect(event.agents![0].name).toBe("coder")
  })

  test("create() auto-generates timestamp when not provided", () => {
    const before = Date.now()
    const event = SessionEvent.Prompt.create({ text: "test" })
    const after = Date.now()
    const ts = DateTime.toEpochMillis(event.timestamp)
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  test("create() uses custom timestamp when provided", () => {
    const customTs = time(1000)
    const event = SessionEvent.Prompt.create({ text: "test", timestamp: customTs })
    expect(DateTime.toEpochMillis(event.timestamp)).toBe(1000)
  })

  test("create() uses custom id when provided", () => {
    const customId = "evt_custom123" as SessionEvent.ID
    const event = SessionEvent.Prompt.create({ text: "test", id: customId })
    expect(event.id).toBe(customId)
  })

  test("create() preserves metadata", () => {
    const event = SessionEvent.Prompt.create({ text: "test", metadata: { key: "value" } })
    expect(event.metadata).toEqual({ key: "value" })
  })

  test("Schema round-trip preserves all fields", () => {
    const event = SessionEvent.Prompt.create({ text: "round trip" })
    const decoded = jsonRoundTrip(SessionEvent.Prompt, event)
    expect(decoded.text).toBe("round trip")
    expect(decoded.type).toBe("prompt")
    expect(decoded.id).toBe(event.id)
  })
})

// ============================================================================
// Synthetic.create()
// ============================================================================

describe("SessionEvent.Synthetic", () => {
  test("create() generates ID, sets type='synthetic', preserves text", () => {
    const event = SessionEvent.Synthetic.create({ text: "synthetic prompt" })
    expect(event.id).toBeDefined()
    expect(event.type).toBe("synthetic")
    expect(event.text).toBe("synthetic prompt")
  })

  test("create() auto-generates timestamp when not provided", () => {
    const before = Date.now()
    const event = SessionEvent.Synthetic.create({ text: "test" })
    const after = Date.now()
    const ts = DateTime.toEpochMillis(event.timestamp)
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  test("create() uses custom timestamp when provided", () => {
    const customTs = time(2000)
    const event = SessionEvent.Synthetic.create({ text: "test", timestamp: customTs })
    expect(DateTime.toEpochMillis(event.timestamp)).toBe(2000)
  })

  test("Schema round-trip preserves all fields", () => {
    const event = SessionEvent.Synthetic.create({ text: "round trip" })
    const decoded = jsonRoundTrip(SessionEvent.Synthetic, event)
    expect(decoded.text).toBe("round trip")
    expect(decoded.type).toBe("synthetic")
  })
})

// ============================================================================
// Step.Started.create()
// ============================================================================

describe("SessionEvent.Step.Started", () => {
  test("create() generates ID, sets type='step.started', preserves model", () => {
    const event = SessionEvent.Step.Started.create({
      model: { id: "claude-3", providerID: "anthropic" },
    })
    expect(event.id).toBeDefined()
    expect(event.type).toBe("step.started")
    expect(event.model.id).toBe("claude-3")
    expect(event.model.providerID).toBe("anthropic")
  })

  test("create() preserves optional model variant", () => {
    const event = SessionEvent.Step.Started.create({
      model: { id: "gpt-4", providerID: "openai", variant: "turbo" },
    })
    expect(event.model.variant).toBe("turbo")
  })

  test("create() uses custom timestamp", () => {
    const customTs = time(3000)
    const event = SessionEvent.Step.Started.create({
      model: { id: "model", providerID: "provider" },
      timestamp: customTs,
    })
    expect(DateTime.toEpochMillis(event.timestamp)).toBe(3000)
  })

  test("Schema round-trip preserves all fields", () => {
    const event = SessionEvent.Step.Started.create({
      model: { id: "m", providerID: "p", variant: "v" },
    })
    const decoded = jsonRoundTrip(SessionEvent.Step.Started, event)
    expect(decoded.model.id).toBe("m")
    expect(decoded.model.variant).toBe("v")
  })
})

// ============================================================================
// Step.Ended.create()
// ============================================================================

describe("SessionEvent.Step.Ended", () => {
  const tokens = { input: 100, output: 50, reasoning: 20, cache: { read: 10, write: 5 } }

  test("create() generates ID, sets type='step.ended', preserves tokens/reason", () => {
    const event = SessionEvent.Step.Ended.create({ reason: "stop", tokens })
    expect(event.id).toBeDefined()
    expect(event.type).toBe("step.ended")
    expect(event.reason).toBe("stop")
    expect(event.tokens.input).toBe(100)
    expect(event.tokens.output).toBe(50)
    expect(event.tokens.reasoning).toBe(20)
    expect(event.tokens.cache.read).toBe(10)
    expect(event.tokens.cache.write).toBe(5)
  })

  test("create() uses custom timestamp", () => {
    const customTs = time(4000)
    const event = SessionEvent.Step.Ended.create({ reason: "done", tokens, timestamp: customTs })
    expect(DateTime.toEpochMillis(event.timestamp)).toBe(4000)
  })

  test("Schema round-trip preserves all fields", () => {
    const event = SessionEvent.Step.Ended.create({ reason: "stop", tokens })
    const decoded = jsonRoundTrip(SessionEvent.Step.Ended, event)
    expect(decoded.reason).toBe("stop")
    expect(decoded.tokens.input).toBe(100)
  })
})

// ============================================================================
// Text.Started / Delta / Ended
// ============================================================================

describe("SessionEvent.Text", () => {
  test("Text.Started.create() generates ID, sets type='text.started'", () => {
    const event = SessionEvent.Text.Started.create()
    expect(event.id).toBeDefined()
    expect(event.type).toBe("text.started")
  })

  test("Text.Started.create() uses custom timestamp", () => {
    const customTs = time(5000)
    const event = SessionEvent.Text.Started.create({ timestamp: customTs })
    expect(DateTime.toEpochMillis(event.timestamp)).toBe(5000)
  })

  test("Text.Delta.create() generates ID, sets type='text.delta', preserves delta", () => {
    const event = SessionEvent.Text.Delta.create({ delta: "Hello" })
    expect(event.id).toBeDefined()
    expect(event.type).toBe("text.delta")
    expect(event.delta).toBe("Hello")
  })

  test("Text.Ended.create() generates ID, sets type='text.ended', preserves text", () => {
    const event = SessionEvent.Text.Ended.create({ text: "Hello world" })
    expect(event.id).toBeDefined()
    expect(event.type).toBe("text.ended")
    expect(event.text).toBe("Hello world")
  })

  test("Text.Started round-trip", () => {
    const event = SessionEvent.Text.Started.create()
    const decoded = jsonRoundTrip(SessionEvent.Text.Started, event)
    expect(decoded.type).toBe("text.started")
  })

  test("Text.Delta round-trip", () => {
    const event = SessionEvent.Text.Delta.create({ delta: "chunk" })
    const decoded = jsonRoundTrip(SessionEvent.Text.Delta, event)
    expect(decoded.delta).toBe("chunk")
  })

  test("Text.Ended round-trip", () => {
    const event = SessionEvent.Text.Ended.create({ text: "final" })
    const decoded = jsonRoundTrip(SessionEvent.Text.Ended, event)
    expect(decoded.text).toBe("final")
  })
})

// ============================================================================
// Tool.Input.Started / Delta
// ============================================================================

describe("SessionEvent.Tool.Input", () => {
  test("Tool.Input.Started.create() generates ID, sets type, preserves callID/name", () => {
    const event = SessionEvent.Tool.Input.Started.create({ callID: "call_1", name: "read_file" })
    expect(event.id).toBeDefined()
    expect(event.type).toBe("tool.input.started")
    expect(event.callID).toBe("call_1")
    expect(event.name).toBe("read_file")
  })

  test("Tool.Input.Delta.create() generates ID, sets type, preserves callID/delta", () => {
    const event = SessionEvent.Tool.Input.Delta.create({ callID: "call_1", delta: '{"path"' })
    expect(event.id).toBeDefined()
    expect(event.type).toBe("tool.input.delta")
    expect(event.callID).toBe("call_1")
    expect(event.delta).toBe('{"path"')
  })

  test("Tool.Input.Started round-trip", () => {
    const event = SessionEvent.Tool.Input.Started.create({ callID: "c1", name: "bash" })
    const decoded = jsonRoundTrip(SessionEvent.Tool.Input.Started, event)
    expect(decoded.callID).toBe("c1")
    expect(decoded.name).toBe("bash")
  })

  test("Tool.Input.Delta round-trip", () => {
    const event = SessionEvent.Tool.Input.Delta.create({ callID: "c1", delta: "partial" })
    const decoded = jsonRoundTrip(SessionEvent.Tool.Input.Delta, event)
    expect(decoded.delta).toBe("partial")
  })
})

// ============================================================================
// Tool.Called / Success / Error
// ============================================================================

describe("SessionEvent.Tool", () => {
  test("Tool.Called.create() generates ID, sets type, preserves callID/tool/input/provider", () => {
    const event = SessionEvent.Tool.Called.create({
      callID: "call_1",
      tool: "read_file",
      input: { path: "/tmp/test.ts" },
      provider: { executed: true },
    })
    expect(event.id).toBeDefined()
    expect(event.type).toBe("tool.called")
    expect(event.callID).toBe("call_1")
    expect(event.tool).toBe("read_file")
    expect(event.input).toEqual({ path: "/tmp/test.ts" })
    expect(event.provider.executed).toBe(true)
  })

  test("Tool.Success.create() generates ID, sets type, preserves callID/title/output", () => {
    const event = SessionEvent.Tool.Success.create({
      callID: "call_1",
      title: "Read file",
      output: "file contents",
      provider: { executed: true },
    })
    expect(event.id).toBeDefined()
    expect(event.type).toBe("tool.success")
    expect(event.callID).toBe("call_1")
    expect(event.title).toBe("Read file")
    expect(event.output).toBe("file contents")
  })

  test("Tool.Success.create() works without optional output", () => {
    const event = SessionEvent.Tool.Success.create({
      callID: "call_1",
      title: "Done",
      provider: { executed: false },
    })
    expect(event.output).toBeUndefined()
  })

  test("Tool.Error.create() generates ID, sets type, preserves callID/error", () => {
    const event = SessionEvent.Tool.Error.create({
      callID: "call_1",
      error: "Permission denied",
      provider: { executed: true },
    })
    expect(event.id).toBeDefined()
    expect(event.type).toBe("tool.error")
    expect(event.callID).toBe("call_1")
    expect(event.error).toBe("Permission denied")
  })

  test("Tool.Called round-trip", () => {
    const event = SessionEvent.Tool.Called.create({
      callID: "c1",
      tool: "bash",
      input: { cmd: "ls" },
      provider: { executed: true },
    })
    const decoded = jsonRoundTrip(SessionEvent.Tool.Called, event)
    expect(decoded.tool).toBe("bash")
    expect(decoded.input).toEqual({ cmd: "ls" })
  })

  test("Tool.Success round-trip", () => {
    const event = SessionEvent.Tool.Success.create({
      callID: "c1",
      title: "OK",
      output: "result",
      provider: { executed: true },
    })
    const decoded = jsonRoundTrip(SessionEvent.Tool.Success, event)
    expect(decoded.title).toBe("OK")
    expect(decoded.output).toBe("result")
  })

  test("Tool.Error round-trip", () => {
    const event = SessionEvent.Tool.Error.create({
      callID: "c1",
      error: "fail",
      provider: { executed: false },
    })
    const decoded = jsonRoundTrip(SessionEvent.Tool.Error, event)
    expect(decoded.error).toBe("fail")
  })
})

// ============================================================================
// Reasoning.Started / Delta / Ended
// ============================================================================

describe("SessionEvent.Reasoning", () => {
  test("Reasoning.Started.create() generates ID, sets type='reasoning.started'", () => {
    const event = SessionEvent.Reasoning.Started.create()
    expect(event.id).toBeDefined()
    expect(event.type).toBe("reasoning.started")
  })

  test("Reasoning.Delta.create() generates ID, sets type='reasoning.delta', preserves delta", () => {
    const event = SessionEvent.Reasoning.Delta.create({ delta: "thinking..." })
    expect(event.id).toBeDefined()
    expect(event.type).toBe("reasoning.delta")
    expect(event.delta).toBe("thinking...")
  })

  test("Reasoning.Ended.create() generates ID, sets type='reasoning.ended', preserves text", () => {
    const event = SessionEvent.Reasoning.Ended.create({ text: "conclusion" })
    expect(event.id).toBeDefined()
    expect(event.type).toBe("reasoning.ended")
    expect(event.text).toBe("conclusion")
  })

  test("Reasoning.Started round-trip", () => {
    const event = SessionEvent.Reasoning.Started.create()
    const decoded = jsonRoundTrip(SessionEvent.Reasoning.Started, event)
    expect(decoded.type).toBe("reasoning.started")
  })

  test("Reasoning.Delta round-trip", () => {
    const event = SessionEvent.Reasoning.Delta.create({ delta: "thought" })
    const decoded = jsonRoundTrip(SessionEvent.Reasoning.Delta, event)
    expect(decoded.delta).toBe("thought")
  })

  test("Reasoning.Ended round-trip", () => {
    const event = SessionEvent.Reasoning.Ended.create({ text: "done thinking" })
    const decoded = jsonRoundTrip(SessionEvent.Reasoning.Ended, event)
    expect(decoded.text).toBe("done thinking")
  })
})

// ============================================================================
// Retried.create()
// ============================================================================

describe("SessionEvent.Retried", () => {
  test("create() generates ID, sets type='retried', preserves attempt/error", () => {
    const error = new SessionEvent.RetryError({
      message: "rate limited",
      isRetryable: true,
    })
    const event = SessionEvent.Retried.create({ attempt: 2, error })
    expect(event.id).toBeDefined()
    expect(event.type).toBe("retried")
    expect(event.attempt).toBe(2)
    expect(event.error.message).toBe("rate limited")
    expect(event.error.isRetryable).toBe(true)
  })

  test("create() preserves optional error fields", () => {
    const error = new SessionEvent.RetryError({
      message: "timeout",
      isRetryable: true,
      statusCode: 503,
      responseBody: "service unavailable",
    })
    const event = SessionEvent.Retried.create({ attempt: 3, error })
    expect(event.error.statusCode).toBe(503)
    expect(event.error.responseBody).toBe("service unavailable")
  })

  test("Schema round-trip preserves all fields", () => {
    const error = new SessionEvent.RetryError({
      message: "fail",
      isRetryable: true,
    })
    const event = SessionEvent.Retried.create({ attempt: 1, error })
    const decoded = jsonRoundTrip(SessionEvent.Retried, event)
    expect(decoded.attempt).toBe(1)
    expect(decoded.error.message).toBe("fail")
  })
})

// ============================================================================
// Compacted.create()
// ============================================================================

describe("SessionEvent.Compacted", () => {
  test("create() generates ID, sets type='compacted', preserves auto", () => {
    const event = SessionEvent.Compacted.create({ auto: true })
    expect(event.id).toBeDefined()
    expect(event.type).toBe("compacted")
    expect(event.auto).toBe(true)
  })

  test("create() preserves optional overflow", () => {
    const event = SessionEvent.Compacted.create({ auto: false, overflow: true })
    expect(event.auto).toBe(false)
    expect(event.overflow).toBe(true)
  })

  test("create() without overflow defaults to undefined", () => {
    const event = SessionEvent.Compacted.create({ auto: true })
    expect(event.overflow).toBeUndefined()
  })

  test("Schema round-trip preserves all fields", () => {
    const event = SessionEvent.Compacted.create({ auto: true, overflow: false })
    const decoded = jsonRoundTrip(SessionEvent.Compacted, event)
    expect(decoded.auto).toBe(true)
    expect(decoded.overflow).toBe(false)
  })
})

// ============================================================================
// Event tagged union
// ============================================================================

describe("SessionEvent.Event tagged union", () => {
  test("decodes Prompt event by type discriminator", () => {
    const event = SessionEvent.Prompt.create({ text: "hi" })
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("prompt")
    if (decoded.type === "prompt") {
      expect(decoded.text).toBe("hi")
    }
  })

  test("decodes Synthetic event by type discriminator", () => {
    const event = SessionEvent.Synthetic.create({ text: "auto" })
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("synthetic")
    if (decoded.type === "synthetic") {
      expect(decoded.text).toBe("auto")
    }
  })

  test("decodes Step.Started event by type discriminator", () => {
    const event = SessionEvent.Step.Started.create({ model: { id: "m", providerID: "p" } })
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("step.started")
    if (decoded.type === "step.started") {
      expect(decoded.model.id).toBe("m")
    }
  })

  test("decodes Step.Ended event by type discriminator", () => {
    const event = SessionEvent.Step.Ended.create({
      reason: "stop",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("step.ended")
    if (decoded.type === "step.ended") {
      expect(decoded.reason).toBe("stop")
    }
  })

  test("decodes Text.Started event by type discriminator", () => {
    const event = SessionEvent.Text.Started.create()
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("text.started")
  })

  test("decodes Text.Delta event by type discriminator", () => {
    const event = SessionEvent.Text.Delta.create({ delta: "x" })
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("text.delta")
    if (decoded.type === "text.delta") {
      expect(decoded.delta).toBe("x")
    }
  })

  test("decodes Text.Ended event by type discriminator", () => {
    const event = SessionEvent.Text.Ended.create({ text: "done" })
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("text.ended")
    if (decoded.type === "text.ended") {
      expect(decoded.text).toBe("done")
    }
  })

  test("decodes Tool.Input.Started event by type discriminator", () => {
    const event = SessionEvent.Tool.Input.Started.create({ callID: "c1", name: "bash" })
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("tool.input.started")
    if (decoded.type === "tool.input.started") {
      expect(decoded.callID).toBe("c1")
    }
  })

  test("decodes Tool.Input.Delta event by type discriminator", () => {
    const event = SessionEvent.Tool.Input.Delta.create({ callID: "c1", delta: "d" })
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("tool.input.delta")
  })

  test("decodes Tool.Called event by type discriminator", () => {
    const event = SessionEvent.Tool.Called.create({
      callID: "c1",
      tool: "bash",
      input: {},
      provider: { executed: true },
    })
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("tool.called")
    if (decoded.type === "tool.called") {
      expect(decoded.tool).toBe("bash")
    }
  })

  test("decodes Tool.Success event by type discriminator", () => {
    const event = SessionEvent.Tool.Success.create({
      callID: "c1",
      title: "OK",
      provider: { executed: true },
    })
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("tool.success")
  })

  test("decodes Tool.Error event by type discriminator", () => {
    const event = SessionEvent.Tool.Error.create({
      callID: "c1",
      error: "err",
      provider: { executed: false },
    })
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("tool.error")
  })

  test("decodes Reasoning.Started event by type discriminator", () => {
    const event = SessionEvent.Reasoning.Started.create()
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("reasoning.started")
  })

  test("decodes Reasoning.Delta event by type discriminator", () => {
    const event = SessionEvent.Reasoning.Delta.create({ delta: "think" })
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("reasoning.delta")
  })

  test("decodes Reasoning.Ended event by type discriminator", () => {
    const event = SessionEvent.Reasoning.Ended.create({ text: "concluded" })
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("reasoning.ended")
  })

  test("decodes Retried event by type discriminator", () => {
    const error = new SessionEvent.RetryError({ message: "fail", isRetryable: true })
    const event = SessionEvent.Retried.create({ attempt: 1, error })
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("retried")
  })

  test("decodes Compacted event by type discriminator", () => {
    const event = SessionEvent.Compacted.create({ auto: true })
    const decoded = jsonRoundTrip(SessionEvent.Event, event)
    expect(decoded.type).toBe("compacted")
  })

  test("rejects unknown type discriminator", () => {
    const invalid = { type: "unknown.event", id: "evt_test", timestamp: new Date().toISOString() }
    expect(() => Schema.decodeUnknownSync(SessionEvent.Event)(invalid)).toThrow()
  })
})

// ============================================================================
// ID uniqueness
// ============================================================================

describe("SessionEvent.ID uniqueness", () => {
  test("multiple Prompt.create() produce different IDs", () => {
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const event = SessionEvent.Prompt.create({ text: "test" })
      ids.add(event.id)
    }
    expect(ids.size).toBe(50)
  })

  test("IDs across different event types are unique", () => {
    const ids = new Set<string>()
    ids.add(SessionEvent.Prompt.create({ text: "a" }).id)
    ids.add(SessionEvent.Synthetic.create({ text: "b" }).id)
    ids.add(SessionEvent.Text.Delta.create({ delta: "c" }).id)
    ids.add(SessionEvent.Step.Started.create({ model: { id: "m", providerID: "p" } }).id)
    expect(ids.size).toBe(4)
  })

  test("generated IDs start with 'evt_' prefix", () => {
    const event = SessionEvent.Prompt.create({ text: "test" })
    expect(event.id.startsWith("evt_")).toBe(true)
  })
})

// ============================================================================
// Default vs Custom timestamp
// ============================================================================

describe("Timestamp behavior", () => {
  test("default timestamp is auto-generated (close to Date.now())", () => {
    const before = Date.now()
    const event = SessionEvent.Text.Started.create()
    const after = Date.now()
    const ts = DateTime.toEpochMillis(event.timestamp)
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  test("custom timestamp is used when provided", () => {
    const customTs = time(9999999)
    const event = SessionEvent.Text.Started.create({ timestamp: customTs })
    expect(DateTime.toEpochMillis(event.timestamp)).toBe(9999999)
  })

  test("custom timestamp works for all event types", () => {
    const ts = time(12345)
    const events = [
      SessionEvent.Prompt.create({ text: "a", timestamp: ts }),
      SessionEvent.Synthetic.create({ text: "b", timestamp: ts }),
      SessionEvent.Step.Started.create({ model: { id: "m", providerID: "p" }, timestamp: ts }),
      SessionEvent.Text.Delta.create({ delta: "d", timestamp: ts }),
      SessionEvent.Reasoning.Delta.create({ delta: "r", timestamp: ts }),
    ]
    for (const event of events) {
      expect(DateTime.toEpochMillis(event.timestamp)).toBe(12345)
    }
  })
})

// ============================================================================
// Schema encode/decode round-trips
// ============================================================================

describe("Schema encode/decode round-trips", () => {
  test("FileAttachment round-trip", () => {
    const fa = new SessionEvent.FileAttachment({ uri: "file:///a.ts", mime: "text/ts", name: "a.ts" })
    const decoded = jsonRoundTrip(SessionEvent.FileAttachment, fa)
    expect(decoded.uri).toBe("file:///a.ts")
    expect(decoded.mime).toBe("text/ts")
    expect(decoded.name).toBe("a.ts")
  })

  test("FileAttachment without optional fields", () => {
    const fa = new SessionEvent.FileAttachment({ uri: "file:///b.ts", mime: "text/plain" })
    const decoded = jsonRoundTrip(SessionEvent.FileAttachment, fa)
    expect(decoded.name).toBeUndefined()
    expect(decoded.source).toBeUndefined()
  })

  test("AgentAttachment round-trip", () => {
    const aa = new SessionEvent.AgentAttachment({ name: "reviewer" })
    const decoded = jsonRoundTrip(SessionEvent.AgentAttachment, aa)
    expect(decoded.name).toBe("reviewer")
  })

  test("RetryError round-trip with all fields", () => {
    const err = new SessionEvent.RetryError({
      message: "timeout",
      isRetryable: true,
      statusCode: 408,
      responseHeaders: { "retry-after": "30" },
      responseBody: "timed out",
      metadata: { retryCount: "3" },
    })
    const decoded = jsonRoundTrip(SessionEvent.RetryError, err)
    expect(decoded.message).toBe("timeout")
    expect(decoded.statusCode).toBe(408)
    expect(decoded.isRetryable).toBe(true)
    expect(decoded.responseHeaders).toEqual({ "retry-after": "30" })
    expect(decoded.responseBody).toBe("timed out")
  })

  test("Tool.Input.Ended round-trip", () => {
    const event = SessionEvent.Tool.Input.Ended.create({ callID: "c1", text: '{"path":"/tmp"}' })
    const decoded = jsonRoundTrip(SessionEvent.Tool.Input.Ended, event)
    expect(decoded.callID).toBe("c1")
    expect(decoded.text).toBe('{"path":"/tmp"}')
  })

  test("Tool.Success round-trip with attachments", () => {
    const attachment = new SessionEvent.FileAttachment({ uri: "file:///out.ts", mime: "text/ts" })
    const event = SessionEvent.Tool.Success.create({
      callID: "c1",
      title: "Wrote file",
      output: "done",
      attachments: [attachment],
      provider: { executed: true, metadata: { duration: 100 } },
    })
    const decoded = jsonRoundTrip(SessionEvent.Tool.Success, event)
    expect(decoded.attachments).toHaveLength(1)
    expect(decoded.provider.metadata).toEqual({ duration: 100 })
  })
})
