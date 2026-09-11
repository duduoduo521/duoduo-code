import { describe, test, expect } from "bun:test"
import { mergeSessionMessages, type DbMessage } from "../../src/cli/cmd/tui/context/sync-merge"
import type { Message, Part } from "@duoduo-ai/sdk/v2"

// Minimal stand-ins carrying only the fields the merge reads. We are
// testing the merge *decision* (keep live vs clobber with DB), not the
// SDK schemas — so runtime shapes are not validated here.
const msg = (id: string, created: number): Message =>
  ({ id, time: { created } } as unknown as Message)

const part = (id: string, content = ""): Part =>
  ({ id, content } as unknown as Part)

describe("mergeSessionMessages — live content must survive a lagging DB snapshot", () => {
  test("keeps in-memory text part when DB snapshot is missing it (regression)", () => {
    const mid = "msg_assistant1"
    const memMsgs = [msg(mid, 100)]
    const memParts = new Map<string, Part[]>([
      [mid, [part("r1", "thinking…"), part("t1", "the final answer")]],
    ])
    // DB snapshot taken the instant `session.status` idle fired: only the
    // reasoning part has landed; the text part ("t1") is not committed
    // yet. This is exactly the stale snapshot that used to wipe the reply
    // and leave only "thinking".
    const dbMsgs: DbMessage[] = [
      { info: msg(mid, 100), parts: [part("r1", "thinking…")] },
    ]

    const { messages, parts } = mergeSessionMessages(dbMsgs, memMsgs, memParts)

    expect(messages.map((m) => (m as any).id)).toContain(mid)
    const merged = parts.get(mid)!
    expect(merged.map((p) => (p as any).id)).toEqual(["r1", "t1"])
    expect((merged.find((p) => (p as any).id === "t1") as any).content).toBe("the final answer")
  })

  test("backfills DB-only parts that memory never received", () => {
    const mid = "msg_assistant2"
    const memMsgs = [msg(mid, 200)]
    const memParts = new Map<string, Part[]>([
      [mid, [part("t1", "answer text")]],
    ])
    const dbMsgs: DbMessage[] = [
      { info: msg(mid, 200), parts: [part("r1", "thinking…"), part("t1", "answer text")] },
    ]

    const { parts } = mergeSessionMessages(dbMsgs, memMsgs, memParts)
    const merged = parts.get(mid)!
    // text from memory wins; reasoning backfilled from DB, no duplicates.
    expect(merged.map((p) => (p as any).id).sort()).toEqual(["r1", "t1"])
  })

  test("cold-load: message only in DB uses DB parts", () => {
    const mid = "msg_only_db"
    const memMsgs: Message[] = []
    const memParts = new Map<string, Part[]>()
    const dbMsgs: DbMessage[] = [
      { info: msg(mid, 300), parts: [part("t1", "from db only")] },
    ]

    const { messages, parts } = mergeSessionMessages(dbMsgs, memMsgs, memParts)
    expect(messages.map((m) => (m as any).id)).toContain(mid)
    expect((parts.get(mid)![0] as any).content).toBe("from db only")
  })

  test("memory-only message (not yet persisted) is preserved", () => {
    const mid = "msg_only_mem"
    const memMsgs = [msg(mid, 50)]
    const memParts = new Map<string, Part[]>([
      [mid, [part("t1", "unsaved stream")]],
    ])
    const dbMsgs: DbMessage[] = []

    const { messages, parts } = mergeSessionMessages(dbMsgs, memMsgs, memParts)
    expect(messages.map((m) => (m as any).id)).toContain(mid)
    expect((parts.get(mid)![0] as any).content).toBe("unsaved stream")
  })

  test("db part with same id as a live part does not duplicate it", () => {
    const mid = "msg_assistant3"
    const memMsgs = [msg(mid, 400)]
    const memParts = new Map<string, Part[]>([
      [mid, [part("t1", "live text")]],
    ])
    const dbMsgs: DbMessage[] = [
      { info: msg(mid, 400), parts: [part("t1", "stale db text")] },
    ]

    const { parts } = mergeSessionMessages(dbMsgs, memMsgs, memParts)
    const merged = parts.get(mid)!
    expect(merged.map((p) => (p as any).id)).toEqual(["t1"])
    // live content wins, not the stale DB copy
    expect((merged[0] as any).content).toBe("live text")
  })
})
