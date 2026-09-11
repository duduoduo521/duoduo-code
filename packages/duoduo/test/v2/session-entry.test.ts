import { describe, test, expect } from "bun:test"
import * as DateTime from "effect/DateTime"
import { Schema } from "effect"
import { SessionEvent } from "../../src/v2/session-event"
import {
  User,
  Synthetic,
  Assistant,
  Compaction,
  AssistantRetry,
  ToolState,
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
  AssistantContent,
  AssistantText,
  AssistantReasoning,
  AssistantTool,
  Entry,
} from "../../src/v2/session-entry"

const time = (ms: number) => DateTime.makeUnsafe(ms)

// ============================================================================
// Helper: JSON round-trip + Effect Schema decode
// ============================================================================

function jsonRoundTrip<T>(schema: any, value: T): T {
  const encoded = Schema.encodeSync(schema)(value)
  const json = JSON.stringify(encoded)
  const parsed = JSON.parse(json)
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
// User.fromEvent()
// ============================================================================

describe("User.fromEvent()", () => {
  test("maps Prompt event to User entry, sets type='user'", () => {
    const event = SessionEvent.Prompt.create({ text: "hello" })
    const entry = User.fromEvent(event)
    expect(entry.type).toBe("user")
    expect(entry.text).toBe("hello")
  })

  test("maps timestamp → time.created", () => {
    const customTs = time(1000)
    const event = SessionEvent.Prompt.create({ text: "test", timestamp: customTs })
    const entry = User.fromEvent(event)
    expect(DateTime.toEpochMillis(entry.time.created)).toBe(1000)
  })

  test("preserves id from event", () => {
    const event = SessionEvent.Prompt.create({ text: "test" })
    const entry = User.fromEvent(event)
    expect(entry.id).toBe(event.id)
  })

  test("preserves files from event", () => {
    const file = new SessionEvent.FileAttachment({ uri: "file:///a.ts", mime: "text/ts" })
    const event = SessionEvent.Prompt.create({ text: "test", files: [file] })
    const entry = User.fromEvent(event)
    expect(entry.files).toHaveLength(1)
    expect(entry.files![0].uri).toBe("file:///a.ts")
  })

  test("preserves agents from event", () => {
    const agent = new SessionEvent.AgentAttachment({ name: "coder" })
    const event = SessionEvent.Prompt.create({ text: "test", agents: [agent] })
    const entry = User.fromEvent(event)
    expect(entry.agents).toHaveLength(1)
    expect(entry.agents![0].name).toBe("coder")
  })

  test("preserves metadata from event", () => {
    const event = SessionEvent.Prompt.create({ text: "test", metadata: { key: "val" } })
    const entry = User.fromEvent(event)
    expect(entry.metadata).toEqual({ key: "val" })
  })

  test("Schema round-trip preserves all fields", () => {
    const event = SessionEvent.Prompt.create({ text: "round trip" })
    const entry = User.fromEvent(event)
    const decoded = jsonRoundTrip(User, entry)
    expect(decoded.type).toBe("user")
    expect(decoded.text).toBe("round trip")
  })
})

// ============================================================================
// Synthetic.fromEvent()
// ============================================================================

describe("Synthetic.fromEvent()", () => {
  test("maps Synthetic event to Synthetic entry", () => {
    const event = SessionEvent.Synthetic.create({ text: "auto prompt" })
    const entry = Synthetic.fromEvent(event)
    expect(entry.type).toBe("synthetic")
    expect(entry.text).toBe("auto prompt")
  })

  test("maps timestamp → time.created", () => {
    const customTs = time(2000)
    const event = SessionEvent.Synthetic.create({ text: "test", timestamp: customTs })
    const entry = Synthetic.fromEvent(event)
    expect(DateTime.toEpochMillis(entry.time.created)).toBe(2000)
  })

  test("preserves id from event", () => {
    const event = SessionEvent.Synthetic.create({ text: "test" })
    const entry = Synthetic.fromEvent(event)
    expect(entry.id).toBe(event.id)
  })

  test("Schema round-trip preserves all fields", () => {
    const event = SessionEvent.Synthetic.create({ text: "round trip" })
    const entry = Synthetic.fromEvent(event)
    const decoded = jsonRoundTrip(Synthetic, entry)
    expect(decoded.type).toBe("synthetic")
    expect(decoded.text).toBe("round trip")
  })
})

// ============================================================================
// Assistant.fromEvent()
// ============================================================================

describe("Assistant.fromEvent()", () => {
  test("maps Step.Started to Assistant, empty content, empty retries", () => {
    const event = SessionEvent.Step.Started.create({
      model: { id: "claude-3", providerID: "anthropic" },
    })
    const entry = Assistant.fromEvent(event)
    expect(entry.type).toBe("assistant")
    expect(entry.content).toEqual([])
    expect(entry.retries).toEqual([])
  })

  test("maps timestamp → time.created", () => {
    const customTs = time(3000)
    const event = SessionEvent.Step.Started.create({
      model: { id: "m", providerID: "p" },
      timestamp: customTs,
    })
    const entry = Assistant.fromEvent(event)
    expect(DateTime.toEpochMillis(entry.time.created)).toBe(3000)
  })

  test("preserves id from event", () => {
    const event = SessionEvent.Step.Started.create({
      model: { id: "m", providerID: "p" },
    })
    const entry = Assistant.fromEvent(event)
    expect(entry.id).toBe(event.id)
  })

  test("time.completed is undefined initially", () => {
    const event = SessionEvent.Step.Started.create({
      model: { id: "m", providerID: "p" },
    })
    const entry = Assistant.fromEvent(event)
    expect(entry.time.completed).toBeUndefined()
  })

  test("tokens are undefined initially", () => {
    const event = SessionEvent.Step.Started.create({
      model: { id: "m", providerID: "p" },
    })
    const entry = Assistant.fromEvent(event)
    expect(entry.tokens).toBeUndefined()
  })

  test("Schema round-trip preserves all fields", () => {
    const event = SessionEvent.Step.Started.create({
      model: { id: "m", providerID: "p" },
    })
    const entry = Assistant.fromEvent(event)
    const decoded = jsonRoundTrip(Assistant, entry)
    expect(decoded.type).toBe("assistant")
    expect(decoded.content).toEqual([])
  })
})

// ============================================================================
// Compaction.fromEvent()
// ============================================================================

describe("Compaction.fromEvent()", () => {
  test("maps Compacted event to Compaction entry", () => {
    const event = SessionEvent.Compacted.create({ auto: true })
    const entry = Compaction.fromEvent(event)
    expect(entry.type).toBe("compaction")
    expect(entry.auto).toBe(true)
  })

  test("maps timestamp → time.created", () => {
    const customTs = time(4000)
    const event = SessionEvent.Compacted.create({ auto: false, timestamp: customTs })
    const entry = Compaction.fromEvent(event)
    expect(DateTime.toEpochMillis(entry.time.created)).toBe(4000)
  })

  test("preserves overflow from event", () => {
    const event = SessionEvent.Compacted.create({ auto: true, overflow: true })
    const entry = Compaction.fromEvent(event)
    expect(entry.overflow).toBe(true)
  })

  test("Schema round-trip preserves all fields", () => {
    const event = SessionEvent.Compacted.create({ auto: true, overflow: false })
    const entry = Compaction.fromEvent(event)
    const decoded = jsonRoundTrip(Compaction, entry)
    expect(decoded.type).toBe("compaction")
    expect(decoded.auto).toBe(true)
    expect(decoded.overflow).toBe(false)
  })
})

// ============================================================================
// AssistantRetry.fromEvent()
// ============================================================================

describe("AssistantRetry.fromEvent()", () => {
  test("maps Retried event to AssistantRetry", () => {
    const error = new SessionEvent.RetryError({ message: "fail", isRetryable: true })
    const event = SessionEvent.Retried.create({ attempt: 2, error })
    const entry = AssistantRetry.fromEvent(event)
    expect(entry.attempt).toBe(2)
    expect(entry.error.message).toBe("fail")
    expect(entry.error.isRetryable).toBe(true)
  })

  test("maps timestamp → time.created", () => {
    const customTs = time(5000)
    const error = new SessionEvent.RetryError({ message: "fail", isRetryable: false })
    const event = SessionEvent.Retried.create({ attempt: 1, error, timestamp: customTs })
    const entry = AssistantRetry.fromEvent(event)
    expect(DateTime.toEpochMillis(entry.time.created)).toBe(5000)
  })

  test("Schema round-trip preserves all fields", () => {
    const error = new SessionEvent.RetryError({ message: "err", isRetryable: true })
    const event = SessionEvent.Retried.create({ attempt: 3, error })
    const entry = AssistantRetry.fromEvent(event)
    const decoded = jsonRoundTrip(AssistantRetry, entry)
    expect(decoded.attempt).toBe(3)
    expect(decoded.error.message).toBe("err")
  })
})

// ============================================================================
// ToolState tagged union
// ============================================================================

describe("ToolState tagged union", () => {
  test("discriminates pending by status", () => {
    const state = new ToolStatePending({ status: "pending", input: "{}" })
    const decoded = jsonRoundTrip(ToolState, state)
    if (decoded.status === "pending") {
      expect(decoded.input).toBe("{}")
    } else {
      expect.unreachable("Expected pending status")
    }
  })

  test("discriminates running by status", () => {
    const state = new ToolStateRunning({
      status: "running",
      input: { path: "/tmp" },
      title: "Reading file",
    })
    const decoded = jsonRoundTrip(ToolState, state)
    if (decoded.status === "running") {
      expect(decoded.input).toEqual({ path: "/tmp" })
      expect(decoded.title).toBe("Reading file")
    } else {
      expect.unreachable("Expected running status")
    }
  })

  test("discriminates completed by status", () => {
    const state = new ToolStateCompleted({
      status: "completed",
      input: { path: "/tmp" },
      output: "file contents",
      title: "Read file",
      metadata: { duration: 100 },
    })
    const decoded = jsonRoundTrip(ToolState, state)
    if (decoded.status === "completed") {
      expect(decoded.output).toBe("file contents")
      expect(decoded.title).toBe("Read file")
    } else {
      expect.unreachable("Expected completed status")
    }
  })

  test("discriminates error by status", () => {
    const state = new ToolStateError({
      status: "error",
      input: { path: "/tmp" },
      error: "Permission denied",
    })
    const decoded = jsonRoundTrip(ToolState, state)
    if (decoded.status === "error") {
      expect(decoded.error).toBe("Permission denied")
    } else {
      expect.unreachable("Expected error status")
    }
  })

  test("rejects invalid status value", () => {
    const invalid = { status: "unknown", input: "{}" }
    expect(() => Schema.decodeUnknownSync(ToolState)(invalid)).toThrow()
  })

  test("ToolStateRunning with optional fields", () => {
    const state = new ToolStateRunning({ status: "running", input: {} })
    const decoded = jsonRoundTrip(ToolState, state)
    if (decoded.status === "running") {
      expect(decoded.title).toBeUndefined()
      expect(decoded.metadata).toBeUndefined()
    }
  })

  test("ToolStateCompleted with optional attachments", () => {
    const attachment = new SessionEvent.FileAttachment({ uri: "file:///a.ts", mime: "text/ts" })
    const state = new ToolStateCompleted({
      status: "completed",
      input: {},
      output: "ok",
      title: "Done",
      metadata: {},
      attachments: [attachment],
    })
    const decoded = jsonRoundTrip(ToolState, state)
    if (decoded.status === "completed") {
      expect(decoded.attachments).toHaveLength(1)
    }
  })
})

// ============================================================================
// AssistantContent tagged union
// ============================================================================

describe("AssistantContent tagged union", () => {
  test("discriminates text by type", () => {
    const content = new AssistantText({ type: "text", text: "Hello" })
    const decoded = jsonRoundTrip(AssistantContent, content)
    if (decoded.type === "text") {
      expect(decoded.text).toBe("Hello")
    } else {
      expect.unreachable("Expected text type")
    }
  })

  test("discriminates reasoning by type", () => {
    const content = new AssistantReasoning({ type: "reasoning", text: "I think..." })
    const decoded = jsonRoundTrip(AssistantContent, content)
    if (decoded.type === "reasoning") {
      expect(decoded.text).toBe("I think...")
    } else {
      expect.unreachable("Expected reasoning type")
    }
  })

  test("discriminates tool by type", () => {
    const toolState = new ToolStatePending({ status: "pending", input: "{}" })
    const content = new AssistantTool({
      type: "tool",
      callID: "call_1",
      name: "bash",
      state: toolState,
      time: { created: time(0) },
    })
    const decoded = jsonRoundTrip(AssistantContent, content)
    if (decoded.type === "tool") {
      expect(decoded.callID).toBe("call_1")
      expect(decoded.name).toBe("bash")
    } else {
      expect.unreachable("Expected tool type")
    }
  })

  test("rejects invalid type value", () => {
    const invalid = { type: "unknown", text: "x" }
    expect(() => Schema.decodeUnknownSync(AssistantContent)(invalid)).toThrow()
  })
})

// ============================================================================
// Entry tagged union
// ============================================================================

describe("Entry tagged union", () => {
  test("discriminates user by type", () => {
    const event = SessionEvent.Prompt.create({ text: "hi" })
    const entry = User.fromEvent(event)
    const decoded = jsonRoundTrip(Entry, entry)
    if (decoded.type === "user") {
      expect(decoded.text).toBe("hi")
    } else {
      expect.unreachable("Expected user type")
    }
  })

  test("discriminates synthetic by type", () => {
    const event = SessionEvent.Synthetic.create({ text: "auto" })
    const entry = Synthetic.fromEvent(event)
    const decoded = jsonRoundTrip(Entry, entry)
    if (decoded.type === "synthetic") {
      expect(decoded.text).toBe("auto")
    } else {
      expect.unreachable("Expected synthetic type")
    }
  })

  test("discriminates assistant by type", () => {
    const event = SessionEvent.Step.Started.create({ model: { id: "m", providerID: "p" } })
    const entry = Assistant.fromEvent(event)
    const decoded = jsonRoundTrip(Entry, entry)
    if (decoded.type === "assistant") {
      expect(decoded.content).toEqual([])
    } else {
      expect.unreachable("Expected assistant type")
    }
  })

  test("discriminates compaction by type", () => {
    const event = SessionEvent.Compacted.create({ auto: true })
    const entry = Compaction.fromEvent(event)
    const decoded = jsonRoundTrip(Entry, entry)
    if (decoded.type === "compaction") {
      expect(decoded.auto).toBe(true)
    } else {
      expect.unreachable("Expected compaction type")
    }
  })

  test("rejects invalid type value", () => {
    const invalid = { type: "unknown", id: "evt_test", time: { created: new Date().toISOString() } }
    expect(() => Schema.decodeUnknownSync(Entry)(invalid)).toThrow()
  })

  test("round-trips assistant with content and retries", () => {
    const event = SessionEvent.Step.Started.create({ model: { id: "m", providerID: "p" } })
    const entry = Assistant.fromEvent(event)
    const fullEntry = new Assistant({
      id: entry.id,
      type: "assistant",
      time: entry.time,
      content: [
        new AssistantText({ type: "text", text: "Hello" }),
        new AssistantReasoning({ type: "reasoning", text: "thinking" }),
      ],
      retries: [
        new AssistantRetry({
          attempt: 1,
          error: new SessionEvent.RetryError({ message: "timeout", isRetryable: true }),
          time: { created: entry.time.created },
        }),
      ],
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 3 } },
    })
    const decoded = jsonRoundTrip(Entry, fullEntry)
    if (decoded.type === "assistant") {
      expect(decoded.content).toHaveLength(2)
      expect(decoded.retries).toHaveLength(1)
      expect(decoded.tokens!.input).toBe(100)
    }
  })
})
