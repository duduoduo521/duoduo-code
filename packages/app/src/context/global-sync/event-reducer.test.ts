import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { applyDirectoryEvent, preserveToolMetadata } from "./event-reducer"
import type { Part } from "@duoduo-ai/sdk/v2/client"
import type { State } from "./types"
import type { Store, SetStoreFunction } from "solid-js/store"

const toolPart = (over: Record<string, unknown>): Part =>
  ({
    type: "tool",
    id: "p1",
    messageID: "m1",
    ...over,
  }) as unknown as Part

describe("preserveToolMetadata", () => {
  test("keeps existing metadata when incoming is empty", () => {
    const existing = toolPart({ state: { metadata: { subSession: "abc" } } })
    const incoming = toolPart({ state: { metadata: {} } })
    preserveToolMetadata(existing, incoming)
    expect((incoming as { state: { metadata: Record<string, unknown> } }).state.metadata).toEqual({
      subSession: "abc",
    })
  })

  test("does not merge existing into a non-empty incoming (incoming wins)", () => {
    const existing = toolPart({ state: { metadata: { a: 1 } } })
    const incoming = toolPart({ state: { metadata: { b: 2 } } })
    preserveToolMetadata(existing, incoming)
    // Incoming already has metadata, so it is left as-is (no clobber, no merge).
    expect((incoming as { state: { metadata: Record<string, unknown> } }).state.metadata).toEqual({
      b: 2,
    })
  })

  test("does not clobber existing metadata when incoming already has values", () => {
    const existing = toolPart({ state: { metadata: { subSession: "old" } } })
    const incoming = toolPart({ state: { metadata: { subSession: "new" } } })
    preserveToolMetadata(existing, incoming)
    expect((incoming as { state: { metadata: Record<string, unknown> } }).state.metadata).toEqual({
      subSession: "new",
    })
  })

  test("keeps empty metadata when neither side has any", () => {
    const existing = toolPart({ state: {} })
    const incoming = toolPart({ state: { metadata: {} } })
    preserveToolMetadata(existing, incoming)
    expect((incoming as { state: { metadata: Record<string, unknown> } }).state.metadata).toEqual({})
  })

  test("is a no-op for non-tool parts", () => {
    const incoming = { type: "text", id: "p1", messageID: "m1", state: {} } as unknown as Part
    preserveToolMetadata(undefined, incoming)
    expect((incoming as { state: Record<string, unknown> }).state).toEqual({})
  })
})

function makeStore(): [Store<State>, SetStoreFunction<State>] {
  const [store, setStore] = createStore<State>({ part: {} } as unknown as State)
  return [store, setStore]
}

function textPart(over: Record<string, unknown>): Part {
  return {
    type: "text",
    id: "part1",
    messageID: "m1",
    sessionID: "s1",
    state: {},
    ...over,
  } as unknown as Part
}

function call(store: Store<State>, setStore: SetStoreFunction<State>, event: { type: string; properties?: unknown }) {
  applyDirectoryEvent({
    event,
    store,
    setStore,
    push: () => {},
    directory: "",
    loadLsp: () => {},
    refreshMcp: () => {},
  })
}

describe("message.part.updated + message.part.delta", () => {
  test("updated creates placeholder part, delta appends text content", () => {
    const [store, setStore] = makeStore()
    call(store, setStore, {
      type: "message.part.updated",
      properties: { part: textPart({ text: "Hel" }) },
    })
    call(store, setStore, {
      type: "message.part.delta",
      properties: { messageID: "m1", partID: "part1", field: "text", delta: "lo" },
    })
    const part = store.part["m1"]!.find((p) => p.id === "part1")!
    expect((part as { text: string }).text).toBe("Hello")
  })

  test("multiple deltas accumulate in order", () => {
    const [store, setStore] = makeStore()
    call(store, setStore, { type: "message.part.updated", properties: { part: textPart({ text: "" }) } })
    for (const d of ["a", "b", "c"]) {
      call(store, setStore, {
        type: "message.part.delta",
        properties: { messageID: "m1", partID: "part1", field: "text", delta: d },
      })
    }
    const part = store.part["m1"]!.find((p) => p.id === "part1")!
    expect((part as { text: string }).text).toBe("abc")
  })

  test("late delta after finalize (time.end) is ignored", () => {
    const [store, setStore] = makeStore()
    call(store, setStore, {
      type: "message.part.updated",
      properties: { part: textPart({ text: "done", time: { end: 123 } }) },
    })
    call(store, setStore, {
      type: "message.part.delta",
      properties: { messageID: "m1", partID: "part1", field: "text", delta: "EXTRA" },
    })
    const part = store.part["m1"]!.find((p) => p.id === "part1")!
    expect((part as { text: string }).text).toBe("done")
  })

  test("delta for aborted session is filtered out", () => {
    const [store, setStore] = makeStore()
    call(store, setStore, { type: "message.part.updated", properties: { part: textPart({ text: "" }) } })
    applyDirectoryEvent({
      event: {
        type: "message.part.delta",
        properties: { messageID: "m1", partID: "part1", field: "text", delta: "should-drop" },
      },
      store,
      setStore,
      push: () => {},
      directory: "",
      loadLsp: () => {},
      refreshMcp: () => {},
      isAborted: (sessionID: string) => sessionID === "s1",
    })
    const part = store.part["m1"]!.find((p) => p.id === "part1")!
    expect((part as { text: string }).text).toBe("")
  })

  test("updated preserves tool metadata from existing part", () => {
    const [store, setStore] = makeStore()
    // first updated with metadata
    call(store, setStore, {
      type: "message.part.updated",
      properties: { part: { type: "tool", id: "t1", messageID: "m1", sessionID: "s1", state: { metadata: { subSession: "abc" } } } as unknown as Part },
    })
    // second updated with empty metadata (simulating Rust completed/error state)
    call(store, setStore, {
      type: "message.part.updated",
      properties: { part: { type: "tool", id: "t1", messageID: "m1", sessionID: "s1", state: { metadata: {} } } as unknown as Part },
    })
    const part = store.part["m1"]!.find((p) => p.id === "t1") as unknown as { state: { metadata: Record<string, unknown> } }
    expect(part.state.metadata).toEqual({ subSession: "abc" })
  })

  test("delta for unknown partID is a no-op (no crash)", () => {
    const [store, setStore] = makeStore()
    expect(() =>
      call(store, setStore, {
        type: "message.part.delta",
        properties: { messageID: "mX", partID: "nope", field: "text", delta: "z" },
      }),
    ).not.toThrow()
    expect(store.part["mX"]).toBeUndefined()
  })
})
