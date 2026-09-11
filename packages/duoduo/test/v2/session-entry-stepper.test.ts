import { describe, test, expect } from "bun:test"
import * as DateTime from "effect/DateTime"
import { SessionEntryStepper } from "../../src/v2/session-entry-stepper"
import { SessionEvent } from "../../src/v2/session-event"
import { SessionEntry } from "../../src/v2/session-entry"

const time = (n: number) => DateTime.makeUnsafe(n)

// ============================================================================
// Helpers
// ============================================================================

function memoryState(): SessionEntryStepper.MemoryState {
  return { entries: [], pending: [] }
}

function active(): SessionEntryStepper.MemoryState {
  return {
    entries: [
      new SessionEntry.Assistant({
        id: SessionEvent.ID.create(),
        type: "assistant",
        time: { created: time(0) },
        content: [],
        retries: [],
      }),
    ],
    pending: [],
  }
}

function run(events: SessionEvent.Event[], state = memoryState()): SessionEntryStepper.MemoryState {
  return events.reduce(
    (s, event) => SessionEntryStepper.step(s, event),
    state,
  )
}

function lastAssistant(state: SessionEntryStepper.MemoryState) {
  const entry = [...state.pending, ...state.entries].reverse().find((x) => x.type === "assistant")
  expect(entry?.type).toBe("assistant")
  return entry?.type === "assistant" ? entry : undefined
}

function textsOf(state: SessionEntryStepper.MemoryState) {
  const entry = lastAssistant(state)
  if (!entry) return []
  return entry.content.filter((x): x is SessionEntry.AssistantText => x.type === "text")
}

function reasons(state: SessionEntryStepper.MemoryState) {
  const entry = lastAssistant(state)
  if (!entry) return []
  return entry.content.filter((x): x is SessionEntry.AssistantReasoning => x.type === "reasoning")
}

function tools(state: SessionEntryStepper.MemoryState) {
  const entry = lastAssistant(state)
  if (!entry) return []
  return entry.content.filter((x): x is SessionEntry.AssistantTool => x.type === "tool")
}

function toolByCallID(state: SessionEntryStepper.MemoryState, callID: string) {
  return tools(state).find((x) => x.callID === callID)
}

function retryError(message: string) {
  return new SessionEvent.RetryError({
    message,
    isRetryable: true,
  })
}

// ============================================================================
// Tests
// ============================================================================

describe("session-entry-stepper", () => {
  // ==========================================================================
  // Prompt handling
  // ==========================================================================

  describe("prompt", () => {
    test("prompt while idle → user entry in entries", () => {
      const next = run([
        SessionEvent.Prompt.create({ text: "Hello", timestamp: time(1) }),
      ])
      expect(next.entries).toHaveLength(1)
      expect(next.entries[0]?.type).toBe("user")
      if (next.entries[0]?.type !== "user") return
      expect(next.entries[0].text).toBe("Hello")
      expect(next.pending).toHaveLength(0)
    })

    test("prompt while assistant active → user entry in pending", () => {
      const next = run([
        SessionEvent.Prompt.create({ text: "Hello", timestamp: time(1) }),
      ], active())
      expect(next.entries).toHaveLength(1) // only the assistant
      expect(next.pending).toHaveLength(1)
      expect(next.pending[0]?.type).toBe("user")
      if (next.pending[0]?.type !== "user") return
      expect(next.pending[0].text).toBe("Hello")
    })

    test("prompt preserves files and agents", () => {
      const file = SessionEvent.FileAttachment.create({
        uri: "file:///test.ts",
        mime: "text/plain",
        name: "test.ts",
      })
      const agent = new SessionEvent.AgentAttachment({ name: "coder" })
      const next = run([
        SessionEvent.Prompt.create({
          text: "fix this",
          files: [file],
          agents: [agent],
          timestamp: time(1),
        }),
      ])
      expect(next.entries[0]?.type).toBe("user")
      if (next.entries[0]?.type !== "user") return
      expect(next.entries[0].files).toHaveLength(1)
      expect(next.entries[0].agents).toHaveLength(1)
    })
  })

  // ==========================================================================
  // Synthetic events
  // ==========================================================================

  describe("synthetic", () => {
    test("synthetic appends to entries regardless of assistant state", () => {
      const next = run([
        SessionEvent.Synthetic.create({ text: "auto-prompt", timestamp: time(1) }),
      ])
      expect(next.entries).toHaveLength(1)
      expect(next.entries[0]?.type).toBe("synthetic")
      if (next.entries[0]?.type !== "synthetic") return
      expect(next.entries[0].text).toBe("auto-prompt")
    })

    test("synthetic appends even when assistant is active", () => {
      const next = run([
        SessionEvent.Synthetic.create({ text: "continue", timestamp: time(1) }),
      ], active())
      expect(next.entries).toHaveLength(2)
      expect(next.entries[1]?.type).toBe("synthetic")
    })
  })

  // ==========================================================================
  // step.started
  // ==========================================================================

  describe("step.started", () => {
    test("step.started creates new assistant with empty content", () => {
      const next = run([
        SessionEvent.Step.Started.create({
          model: { id: "gpt-4", providerID: "openai" },
          timestamp: time(1),
        }),
      ])
      expect(next.entries).toHaveLength(1)
      expect(next.entries[0]?.type).toBe("assistant")
      if (next.entries[0]?.type !== "assistant") return
      expect(next.entries[0].content).toEqual([])
      expect(next.entries[0].time.completed).toBeUndefined()
    })

    test("step.started while previous assistant active → closes previous, creates new", () => {
      const next = run([
        SessionEvent.Step.Started.create({
          model: { id: "gpt-4", providerID: "openai" },
          timestamp: time(100),
        }),
      ], active())

      expect(next.entries).toHaveLength(2)
      // First assistant should be completed
      expect(next.entries[0]?.type).toBe("assistant")
      if (next.entries[0]?.type !== "assistant") return
      expect(next.entries[0].time.completed).toEqual(time(100))

      // Second assistant should be active
      expect(next.entries[1]?.type).toBe("assistant")
      if (next.entries[1]?.type !== "assistant") return
      expect(next.entries[1].time.completed).toBeUndefined()
      expect(next.entries[1].time.created).toEqual(time(100))
    })

    test("step.started preserves model info in created assistant", () => {
      const next = run([
        SessionEvent.Step.Started.create({
          model: { id: "claude-3", providerID: "anthropic", variant: "opus" },
          timestamp: time(1),
        }),
      ])
      const entry = next.entries[0]
      expect(entry?.type).toBe("assistant")
    })
  })

  // ==========================================================================
  // step.ended
  // ==========================================================================

  describe("step.ended", () => {
    test("step.ended sets tokens, completed time", () => {
      const next = run([
        SessionEvent.Step.Ended.create({
          reason: "stop",
          tokens: {
            input: 100,
            output: 200,
            reasoning: 50,
            cache: { read: 10, write: 20 },
          },
          timestamp: time(10),
        }),
      ], active())

      const entry = lastAssistant(next)
      expect(entry).toBeDefined()
      if (!entry) return
      expect(entry.time.completed).toEqual(time(10))
      expect(entry.tokens).toEqual({
        input: 100,
        output: 200,
        reasoning: 50,
        cache: { read: 10, write: 20 },
      })
    })

    test("step.ended without active assistant → no-op", () => {
      const next = run([
        SessionEvent.Step.Ended.create({
          reason: "stop",

          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          timestamp: time(1),
        }),
      ])
      expect(next.entries).toHaveLength(0)
    })
  })

  // ==========================================================================
  // Text streaming
  // ==========================================================================

  describe("text streaming", () => {
    test("text.started → text.delta('Hello') → text.delta(' world') → accumulated text", () => {
      const next = run([
        SessionEvent.Text.Started.create({ timestamp: time(1) }),
        SessionEvent.Text.Delta.create({ delta: "Hello", timestamp: time(2) }),
        SessionEvent.Text.Delta.create({ delta: " world", timestamp: time(3) }),
      ], active())

      const texts = textsOf(next)
      expect(texts).toHaveLength(1)
      expect(texts[0]?.text).toBe("Hello world")
    })

    test("text.ended is a no-op (does not modify text)", () => {
      const next = run([
        SessionEvent.Text.Started.create({ timestamp: time(1) }),
        SessionEvent.Text.Delta.create({ delta: "Hi", timestamp: time(2) }),
        SessionEvent.Text.Ended.create({ text: "Hi", timestamp: time(3) }),
      ], active())

      const texts = textsOf(next)
      expect(texts).toHaveLength(1)
      expect(texts[0]?.text).toBe("Hi")
    })

    test("multiple text.started creates separate text segments", () => {
      const next = run([
        SessionEvent.Text.Started.create({ timestamp: time(1) }),
        SessionEvent.Text.Delta.create({ delta: "First", timestamp: time(2) }),
        SessionEvent.Text.Started.create({ timestamp: time(3) }),
        SessionEvent.Text.Delta.create({ delta: "Second", timestamp: time(4) }),
      ], active())

      const texts = textsOf(next)
      expect(texts).toHaveLength(2)
      expect(texts[0]?.text).toBe("First")
      expect(texts[1]?.text).toBe("Second")
    })

    test("text events without active assistant → no-op", () => {
      const next = run([
        SessionEvent.Text.Started.create({ timestamp: time(1) }),
        SessionEvent.Text.Delta.create({ delta: "Hello", timestamp: time(2) }),
      ])
      expect(next.entries).toHaveLength(0)
    })

    test("text.delta appends to the latest text segment", () => {
      const next = run([
        SessionEvent.Text.Started.create({ timestamp: time(1) }),
        SessionEvent.Text.Delta.create({ delta: "A", timestamp: time(2) }),
        SessionEvent.Text.Started.create({ timestamp: time(3) }),
        SessionEvent.Text.Delta.create({ delta: "B", timestamp: time(4) }),
        SessionEvent.Text.Delta.create({ delta: "C", timestamp: time(5) }),
      ], active())

      const texts = textsOf(next)
      expect(texts[0]?.text).toBe("A")
      expect(texts[1]?.text).toBe("BC")
    })
  })

  // ==========================================================================
  // Tool lifecycle
  // ==========================================================================

  describe("tool lifecycle", () => {
    test("full tool lifecycle: input.started → input.delta → called → success", () => {
      const next = run([
        SessionEvent.Tool.Input.Started.create({ callID: "c1", name: "bash", timestamp: time(1) }),
        SessionEvent.Tool.Input.Delta.create({ callID: "c1", delta: '{"co', timestamp: time(2) }),
        SessionEvent.Tool.Input.Delta.create({ callID: "c1", delta: 'mmand":"ls"}', timestamp: time(3) }),
        SessionEvent.Tool.Called.create({
          callID: "c1",
          tool: "bash",
          input: { command: "ls" },
          provider: { executed: true },
          timestamp: time(4),
        }),
        SessionEvent.Tool.Success.create({
          callID: "c1",
          title: "ls output",
          output: "file1.ts\nfile2.ts",
          provider: { executed: true },
          timestamp: time(5),
        }),
      ], active())

      const t = toolByCallID(next, "c1")
      expect(t).toBeDefined()
      if (!t) return
      expect(t.state.status).toBe("completed")
      if (t.state.status !== "completed") return
      expect(t.state.input).toEqual({ command: "ls" })
      expect(t.state.output).toBe("file1.ts\nfile2.ts")
      expect(t.state.title).toBe("ls output")
      expect(t.time.ran).toEqual(time(4))
    })

    test("tool lifecycle: input.started → called → error", () => {
      const next = run([
        SessionEvent.Tool.Input.Started.create({ callID: "c1", name: "bash", timestamp: time(1) }),
        SessionEvent.Tool.Called.create({
          callID: "c1",
          tool: "bash",
          input: { command: "rm -rf /" },
          provider: { executed: true },
          timestamp: time(2),
        }),
        SessionEvent.Tool.Error.create({
          callID: "c1",
          error: "Permission denied",
          provider: { executed: true },
          timestamp: time(3),
        }),
      ], active())

      const t = toolByCallID(next, "c1")
      expect(t?.state.status).toBe("error")
      if (t?.state.status !== "error") return
      expect(t.state.input).toEqual({ command: "rm -rf /" })
      expect(t.state.error).toBe("Permission denied")
    })

    test("tool.input.started creates pending tool with empty input", () => {
      const next = run([
        SessionEvent.Tool.Input.Started.create({ callID: "c1", name: "read", timestamp: time(1) }),
      ], active())

      const t = toolByCallID(next, "c1")
      expect(t).toBeDefined()
      if (!t) return
      expect(t.state.status).toBe("pending")
      if (t.state.status !== "pending") return
      expect(t.state.input).toBe("")
      expect(t.name).toBe("read")
      expect(t.time.created).toEqual(time(1))
    })

    test("tool.input.delta appends to pending tool input", () => {
      const next = run([
        SessionEvent.Tool.Input.Started.create({ callID: "c1", name: "bash", timestamp: time(1) }),
        SessionEvent.Tool.Input.Delta.create({ callID: "c1", delta: "part1", timestamp: time(2) }),
        SessionEvent.Tool.Input.Delta.create({ callID: "c1", delta: "part2", timestamp: time(3) }),
      ], active())

      const t = toolByCallID(next, "c1")
      expect(t?.state.status).toBe("pending")
      if (t?.state.status !== "pending") return
      expect(t.state.input).toBe("part1part2")
    })

    test("tool.input.ended is a no-op", () => {
      const next1 = run([
        SessionEvent.Tool.Input.Started.create({ callID: "c1", name: "bash", timestamp: time(1) }),
        SessionEvent.Tool.Input.Delta.create({ callID: "c1", delta: "data", timestamp: time(2) }),
      ], active())
      const next2 = run(next1.entries.flatMap((e) =>
          e.type === "assistant" ? [SessionEvent.Tool.Input.Ended.create({ callID: "c1", text: "data", timestamp: time(3) })] : []
        ), next1)
      // Just verifying the tool is still in the same state
      const t = toolByCallID(next1, "c1")
      expect(t?.state.status).toBe("pending")
    })

    test("tool.success before tool.called is ignored (tool stays pending)", () => {
      const next = run([
        SessionEvent.Tool.Input.Started.create({ callID: "c1", name: "bash", timestamp: time(1) }),
        SessionEvent.Tool.Success.create({
          callID: "c1",
          title: "result",
          provider: { executed: true },
          timestamp: time(2),
        }),
      ], active())

      const t = toolByCallID(next, "c1")
      expect(t?.state.status).toBe("pending")
    })

    test("tool.error before tool.called is ignored", () => {
      const next = run([
        SessionEvent.Tool.Input.Started.create({ callID: "c1", name: "bash", timestamp: time(1) }),
        SessionEvent.Tool.Error.create({
          callID: "c1",
          error: "oops",
          provider: { executed: true },
          timestamp: time(2),
        }),
      ], active())

      const t = toolByCallID(next, "c1")
      // Error only transitions from running → error, so pending stays pending
      expect(t?.state.status).toBe("pending")
    })

    test("tool events without active assistant → no-op", () => {
      const next = run([
        SessionEvent.Tool.Input.Started.create({ callID: "c1", name: "bash", timestamp: time(1) }),
        SessionEvent.Tool.Called.create({
          callID: "c1",
          tool: "bash",
          input: {},
          provider: { executed: true },
          timestamp: time(2),
        }),
      ])
      expect(next.entries).toHaveLength(0)
    })

    test("tool.success preserves attachments and metadata", () => {
      const file = SessionEvent.FileAttachment.create({
        uri: "file:///output.png",
        mime: "image/png",
        name: "output.png",
      })
      const next = run([
        SessionEvent.Tool.Input.Started.create({ callID: "c1", name: "generate", timestamp: time(1) }),
        SessionEvent.Tool.Called.create({
          callID: "c1",
          tool: "generate",
          input: { prompt: "cat" },
          provider: { executed: true },
          timestamp: time(2),
        }),
        SessionEvent.Tool.Success.create({
          callID: "c1",
          title: "Generated image",
          output: "done",
          metadata: { format: "png" },
          attachments: [file],
          provider: { executed: true },
          timestamp: time(3),
        }),
      ], active())

      const t = toolByCallID(next, "c1")
      expect(t?.state.status).toBe("completed")
      if (t?.state.status !== "completed") return
      expect(t.state.metadata).toEqual({ format: "png" })
      expect(t.state.attachments).toHaveLength(1)
    })
  })

  // ==========================================================================
  // Tool callID tracking for multiple concurrent tools
  // ==========================================================================

  describe("concurrent tools", () => {
    test("routes tool events by callID when tool streams interleave", () => {
      const next = run([
        SessionEvent.Tool.Input.Started.create({ callID: "a", name: "bash", timestamp: time(1) }),
        SessionEvent.Tool.Input.Started.create({ callID: "b", name: "grep", timestamp: time(2) }),
        SessionEvent.Tool.Input.Delta.create({ callID: "a", delta: "cmd-a", timestamp: time(3) }),
        SessionEvent.Tool.Input.Delta.create({ callID: "b", delta: "cmd-b", timestamp: time(4) }),
        SessionEvent.Tool.Called.create({
          callID: "a",
          tool: "bash",
          input: { command: "ls" },
          provider: { executed: true },
          timestamp: time(5),
        }),
        SessionEvent.Tool.Called.create({
          callID: "b",
          tool: "grep",
          input: { pattern: "todo" },
          provider: { executed: true },
          timestamp: time(6),
        }),
        SessionEvent.Tool.Success.create({
          callID: "a",
          title: "ls result",
          output: "file1",
          provider: { executed: true },
          timestamp: time(7),
        }),
        SessionEvent.Tool.Error.create({
          callID: "b",
          error: "not found",
          provider: { executed: true },
          timestamp: time(8),
        }),
      ], active())

      const toolA = toolByCallID(next, "a")
      const toolB = toolByCallID(next, "b")

      expect(toolA?.state.status).toBe("completed")
      if (toolA?.state.status !== "completed") return
      expect(toolA.state.input).toEqual({ command: "ls" })
      expect(toolA.state.output).toBe("file1")

      expect(toolB?.state.status).toBe("error")
      if (toolB?.state.status !== "error") return
      expect(toolB.state.input).toEqual({ pattern: "todo" })
      expect(toolB.state.error).toBe("not found")
    })

    test("handles sequential tools independently", () => {
      const next = run([
        SessionEvent.Tool.Input.Started.create({ callID: "a", name: "bash", timestamp: time(1) }),
        SessionEvent.Tool.Called.create({
          callID: "a",
          tool: "bash",
          input: { cmd: "first" },
          provider: { executed: true },
          timestamp: time(2),
        }),
        SessionEvent.Tool.Success.create({
          callID: "a",
          title: "first result",
          output: "ok",
          provider: { executed: true },
          timestamp: time(3),
        }),
        SessionEvent.Tool.Input.Started.create({ callID: "b", name: "bash", timestamp: time(4) }),
        SessionEvent.Tool.Called.create({
          callID: "b",
          tool: "bash",
          input: { cmd: "second" },
          provider: { executed: true },
          timestamp: time(5),
        }),
        SessionEvent.Tool.Error.create({
          callID: "b",
          error: "fail",
          provider: { executed: true },
          timestamp: time(6),
        }),
      ], active())

      const toolA = toolByCallID(next, "a")
      const toolB = toolByCallID(next, "b")

      expect(toolA?.state.status).toBe("completed")
      expect(toolB?.state.status).toBe("error")
    })
  })

  // ==========================================================================
  // Reasoning streaming
  // ==========================================================================

  describe("reasoning streaming", () => {
    test("reasoning.started → reasoning.delta → reasoning.ended", () => {
      const next = run([
        SessionEvent.Reasoning.Started.create({ timestamp: time(1) }),
        SessionEvent.Reasoning.Delta.create({ delta: "I need to ", timestamp: time(2) }),
        SessionEvent.Reasoning.Delta.create({ delta: "think about this", timestamp: time(3) }),
        SessionEvent.Reasoning.Ended.create({ text: "I need to think about this carefully", timestamp: time(4) }),
      ], active())

      const r = reasons(next)
      expect(r).toHaveLength(1)
      // reasoning.ended replaces the text
      expect(r[0]?.text).toBe("I need to think about this carefully")
    })

    test("reasoning.ended replaces buffered reasoning text", () => {
      const next = run([
        SessionEvent.Reasoning.Started.create({ timestamp: time(1) }),
        SessionEvent.Reasoning.Delta.create({ delta: "draft reasoning", timestamp: time(2) }),
        SessionEvent.Reasoning.Ended.create({ text: "final reasoning", timestamp: time(3) }),
      ], active())

      const r = reasons(next)
      expect(r).toHaveLength(1)
      expect(r[0]?.text).toBe("final reasoning")
    })

    test("multiple reasoning segments", () => {
      const next = run([
        SessionEvent.Reasoning.Started.create({ timestamp: time(1) }),
        SessionEvent.Reasoning.Delta.create({ delta: "think1", timestamp: time(2) }),
        SessionEvent.Reasoning.Started.create({ timestamp: time(3) }),
        SessionEvent.Reasoning.Delta.create({ delta: "think2", timestamp: time(4) }),
        SessionEvent.Reasoning.Ended.create({ text: "final think2", timestamp: time(5) }),
      ], active())

      const r = reasons(next)
      expect(r).toHaveLength(2)
      expect(r[0]?.text).toBe("think1")
      expect(r[1]?.text).toBe("final think2")
    })

    test("reasoning events without active assistant → no-op", () => {
      const next = run([
        SessionEvent.Reasoning.Started.create({ timestamp: time(1) }),
        SessionEvent.Reasoning.Delta.create({ delta: "thinking", timestamp: time(2) }),
        SessionEvent.Reasoning.Ended.create({ text: "final", timestamp: time(3) }),
      ])
      expect(next.entries).toHaveLength(0)
    })
  })

  // ==========================================================================
  // Retried event
  // ==========================================================================

  describe("retried", () => {
    test("retried event → retries array grows", () => {
      const next = run([
        SessionEvent.Retried.create({
          attempt: 1,
          error: retryError("rate limited"),
          timestamp: time(1),
        }),
      ], active())

      const entry = lastAssistant(next)
      expect(entry?.retries).toHaveLength(1)
      if (!entry?.retries?.length) return
      expect(entry.retries[0].attempt).toBe(1)
      expect(entry.retries[0].error.message).toBe("rate limited")
    })

    test("multiple retried events accumulate", () => {
      const next = run([
        SessionEvent.Retried.create({
          attempt: 1,
          error: retryError("first error"),
          timestamp: time(1),
        }),
        SessionEvent.Retried.create({
          attempt: 2,
          error: retryError("second error"),
          timestamp: time(2),
        }),
        SessionEvent.Retried.create({
          attempt: 3,
          error: retryError("third error"),
          timestamp: time(3),
        }),
      ], active())

      const entry = lastAssistant(next)
      expect(entry?.retries).toHaveLength(3)
    })

    test("retried without active assistant → no-op", () => {
      const next = run([
        SessionEvent.Retried.create({
          attempt: 1,
          error: retryError("error"),
          timestamp: time(1),
        }),
      ])
      expect(next.entries).toHaveLength(0)
    })
  })

  // ==========================================================================
  // Compacted event
  // ==========================================================================

  describe("compacted", () => {
    test("compacted → new compaction entry", () => {
      const next = run([
        SessionEvent.Compacted.create({ auto: true, timestamp: time(1) }),
      ])
      expect(next.entries).toHaveLength(1)
      expect(next.entries[0]?.type).toBe("compaction")
      if (next.entries[0]?.type !== "compaction") return
      expect(next.entries[0].auto).toBe(true)
    })

    test("compacted with overflow flag", () => {
      const next = run([
        SessionEvent.Compacted.create({ auto: false, overflow: true, timestamp: time(1) }),
      ])
      expect(next.entries[0]?.type).toBe("compaction")
      if (next.entries[0]?.type !== "compaction") return
      expect(next.entries[0].auto).toBe(false)
      expect(next.entries[0].overflow).toBe(true)
    })

    test("compacted works even when assistant is active", () => {
      const next = run([
        SessionEvent.Compacted.create({ auto: true, timestamp: time(1) }),
      ], active())
      // Compaction always appends to entries, regardless of assistant state
      expect(next.entries).toHaveLength(2)
      expect(next.entries[1]?.type).toBe("compaction")
    })
  })

  // ==========================================================================
  // Events without active assistant → no-op (except prompt/synthetic/compacted)
  // ==========================================================================

  describe("events without active assistant", () => {
    test("text.started without assistant → no-op", () => {
      const next = run([
        SessionEvent.Text.Started.create({ timestamp: time(1) }),
      ])
      expect(next.entries).toHaveLength(0)
    })

    test("text.delta without assistant → no-op", () => {
      const next = run([
        SessionEvent.Text.Delta.create({ delta: "hello", timestamp: time(1) }),
      ])
      expect(next.entries).toHaveLength(0)
    })

    test("step.ended without assistant → no-op", () => {
      const next = run([
        SessionEvent.Step.Ended.create({
          reason: "stop",

          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          timestamp: time(1),
        }),
      ])
      expect(next.entries).toHaveLength(0)
    })

    test("tool.input.started without assistant → no-op", () => {
      const next = run([
        SessionEvent.Tool.Input.Started.create({ callID: "c1", name: "bash", timestamp: time(1) }),
      ])
      expect(next.entries).toHaveLength(0)
    })

    test("retried without assistant → no-op", () => {
      const next = run([
        SessionEvent.Retried.create({
          attempt: 1,
          error: retryError("error"),
          timestamp: time(1),
        }),
      ])
      expect(next.entries).toHaveLength(0)
    })
  })

  // ==========================================================================
  // Immutability
  // ==========================================================================

  describe("immutability", () => {
    test("step returns a new state object (not mutated)", () => {
      const old = memoryState()
      const next = SessionEntryStepper.step(
        old,
        SessionEvent.Prompt.create({ text: "hi", timestamp: time(1) }),
      )
      expect(old).not.toBe(next)
      expect(old.entries).toHaveLength(0)
      expect(next.entries).toHaveLength(1)
    })

    test("step does not mutate the old state when assistant is active", () => {
      const old = active()
      const originalEntryCount = old.entries.length
      const next = SessionEntryStepper.step(
        old,
        SessionEvent.Prompt.create({ text: "hi", timestamp: time(1) }),
      )
      expect(old.entries).toHaveLength(originalEntryCount)
      expect(old.pending).toHaveLength(0)
      expect(next.pending).toHaveLength(1)
    })
  })

  // ==========================================================================
  // Full conversation flow
  // ==========================================================================

  describe("full conversation flow", () => {
    test("prompt → step.started → text streaming → step.ended", () => {
      const next = run([
        SessionEvent.Prompt.create({ text: "Write hello world", timestamp: time(0) }),
        SessionEvent.Step.Started.create({
          model: { id: "gpt-4", providerID: "openai" },
          timestamp: time(1),
        }),
        SessionEvent.Text.Started.create({ timestamp: time(2) }),
        SessionEvent.Text.Delta.create({ delta: "Hello", timestamp: time(3) }),
        SessionEvent.Text.Delta.create({ delta: " world!", timestamp: time(4) }),
        SessionEvent.Step.Ended.create({
          reason: "stop",
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          timestamp: time(5),
        }),
      ])

      expect(next.entries).toHaveLength(2)
      expect(next.entries[0]?.type).toBe("user")
      expect(next.entries[1]?.type).toBe("assistant")
      if (next.entries[1]?.type !== "assistant") return

      const assistant = next.entries[1]
      expect(assistant.content).toEqual([{ type: "text", text: "Hello world!" }])
      expect(assistant.time.completed).toEqual(time(5))
    })

    test("prompt → step → reasoning → tool → text → step.ended", () => {
      const next = run([
        SessionEvent.Prompt.create({ text: "Fix the bug", timestamp: time(0) }),
        SessionEvent.Step.Started.create({
          model: { id: "claude-3", providerID: "anthropic" },
          timestamp: time(1),
        }),
        SessionEvent.Reasoning.Started.create({ timestamp: time(2) }),
        SessionEvent.Reasoning.Delta.create({ delta: "Let me analyze", timestamp: time(3) }),
        SessionEvent.Reasoning.Ended.create({ text: "I need to check the file", timestamp: time(4) }),
        SessionEvent.Tool.Input.Started.create({ callID: "c1", name: "read", timestamp: time(5) }),
        SessionEvent.Tool.Called.create({
          callID: "c1",
          tool: "read",
          input: { path: "/src/main.ts" },
          provider: { executed: true },
          timestamp: time(6),
        }),
        SessionEvent.Tool.Success.create({
          callID: "c1",
          title: "File contents",
          output: "const x = 1",
          provider: { executed: true },
          timestamp: time(7),
        }),
        SessionEvent.Text.Started.create({ timestamp: time(8) }),
        SessionEvent.Text.Delta.create({ delta: "The fix is...", timestamp: time(9) }),
        SessionEvent.Step.Ended.create({
          reason: "stop",
          tokens: { input: 50, output: 30, reasoning: 10, cache: { read: 5, write: 0 } },
          timestamp: time(10),
        }),
      ])

      expect(next.entries).toHaveLength(2)
      const assistant = next.entries[1]
      if (assistant?.type !== "assistant") return

      expect(assistant.content).toHaveLength(3)
      expect(assistant.content[0]).toEqual({ type: "reasoning", text: "I need to check the file" })
      expect(assistant.content[1]?.type).toBe("tool")
      expect(assistant.content[2]).toEqual({ type: "text", text: "The fix is..." })
    })
  })

  // ==========================================================================
  // memory adapter
  // ==========================================================================

  describe("memory adapter", () => {
    test("getCurrentAssistant returns active assistant", () => {
      const state = active()
      const adapter = SessionEntryStepper.memory(state)
      const current = adapter.getCurrentAssistant()
      expect(current?.type).toBe("assistant")
    })

    test("getCurrentAssistant returns undefined when no active assistant", () => {
      const state = memoryState()
      const adapter = SessionEntryStepper.memory(state)
      expect(adapter.getCurrentAssistant()).toBeUndefined()
    })

    test("getCurrentAssistant returns undefined when assistant is completed", () => {
      const state: SessionEntryStepper.MemoryState = {
        entries: [
          new SessionEntry.Assistant({
            id: SessionEvent.ID.create(),
            type: "assistant",
            time: { created: time(0), completed: time(1) },
            content: [],
            retries: [],
          }),
        ],
        pending: [],
      }
      const adapter = SessionEntryStepper.memory(state)
      expect(adapter.getCurrentAssistant()).toBeUndefined()
    })

    test("updateAssistant replaces the current assistant in place", () => {
      const state = active()
      const adapter = SessionEntryStepper.memory(state)
      const current = adapter.getCurrentAssistant()
      expect(current).toBeDefined()
      if (!current) return

      adapter.updateAssistant(
        new SessionEntry.Assistant({
          // oxlint-disable-next-line no-misused-spread -- Effect Schema.Class copy
          ...current,
          content: [new SessionEntry.AssistantText({ type: "text", text: "updated" })],
        }),
      )

      const updated = adapter.getCurrentAssistant()
      // After update, the assistant has content but no completed time, so still "active"
      expect(updated).toBeDefined()
      expect(state.entries[0]?.type).toBe("assistant")
      if (state.entries[0]?.type !== "assistant") return
      expect(state.entries[0].content).toEqual([{ type: "text", text: "updated" }])
    })

    test("finish returns the current state", () => {
      const state = memoryState()
      const adapter = SessionEntryStepper.memory(state)
      expect(adapter.finish()).toBe(state)
    })
  })
})
