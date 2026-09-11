import { describe, expect, test, vi } from "bun:test"
import { createScrollPersistence, type SessionScroll } from "./layout-scroll"

function createMock(opts?: Partial<Parameters<typeof createScrollPersistence>[0]>) {
  const flushed: Array<{ key: string; scroll: Record<string, SessionScroll> }> = []
  const snapshots: Record<string, Record<string, SessionScroll>> = {}

  const persistence = createScrollPersistence({
    debounceMs: 0, // immediate flush for testing
    getSnapshot: (key) => snapshots[key],
    onFlush: (key, scroll) => flushed.push({ key, scroll }),
    ...opts,
  })

  return { persistence, flushed, snapshots }
}

describe("createScrollPersistence", () => {
  test("debounces persisted scroll writes", () => {
    vi.useFakeTimers()
    try {
      const snapshot = {
        session: {
          review: { x: 0, y: 0 },
        },
      } as Record<string, Record<string, { x: number; y: number }>>
      const writes: Array<Record<string, { x: number; y: number }>> = []
      const scroll = createScrollPersistence({
        debounceMs: 10,
        getSnapshot: (sessionKey) => snapshot[sessionKey],
        onFlush: (sessionKey, next) => {
          snapshot[sessionKey] = next
          writes.push(next)
        },
      })

      for (const i of Array.from({ length: 30 }, (_, n) => n + 1)) {
        scroll.setScroll("session", "review", { x: 0, y: i })
      }

      vi.advanceTimersByTime(9)
      expect(writes).toHaveLength(0)

      vi.advanceTimersByTime(1)

      expect(writes).toHaveLength(1)
      expect(writes[0]?.review).toEqual({ x: 0, y: 30 })

      scroll.setScroll("session", "review", { x: 0, y: 30 })
      vi.advanceTimersByTime(20)

      expect(writes).toHaveLength(1)
      scroll.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test("reseeds empty cache after persisted snapshot loads", () => {
    const snapshot = {
      session: {},
    } as Record<string, Record<string, { x: number; y: number }>>

    const scroll = createScrollPersistence({
      getSnapshot: (sessionKey) => snapshot[sessionKey],
      onFlush: () => {},
    })

    expect(scroll.scroll("session", "review")).toBeUndefined()

    snapshot.session = {
      review: { x: 12, y: 34 },
    }

    expect(scroll.scroll("session", "review")).toEqual({ x: 12, y: 34 })
    scroll.dispose()
  })

  test("setScroll stores position and flushes", () => {
    const { persistence, flushed } = createMock()
    persistence.setScroll("session1", "tab1", { x: 5, y: 15 })
    persistence.flush("session1")
    expect(flushed.length).toBe(1)
    expect(flushed[0]!.key).toBe("session1")
    expect(flushed[0]!.scroll.tab1).toEqual({ x: 5, y: 15 })
  })

  test("setScroll does not mark dirty when position unchanged", () => {
    const { persistence, flushed, snapshots } = createMock()
    snapshots["session1"] = { tab1: { x: 5, y: 15 } }
    persistence.setScroll("session1", "tab1", { x: 5, y: 15 })
    persistence.flush("session1")
    expect(flushed.length).toBe(0)
  })

  test("setScroll updates existing position", () => {
    const { persistence, flushed } = createMock()
    persistence.setScroll("session1", "tab1", { x: 0, y: 0 })
    persistence.setScroll("session1", "tab1", { x: 100, y: 200 })
    persistence.flush("session1")
    expect(flushed.length).toBe(1)
    expect(flushed[0]!.scroll.tab1).toEqual({ x: 100, y: 200 })
  })

  test("flush does nothing when no dirty keys", () => {
    const { persistence, flushed } = createMock()
    persistence.flush("session1")
    expect(flushed.length).toBe(0)
  })

  test("flushAll flushes all dirty keys", () => {
    const { persistence, flushed } = createMock()
    persistence.setScroll("s1", "t1", { x: 1, y: 1 })
    persistence.setScroll("s2", "t2", { x: 2, y: 2 })
    persistence.flushAll()
    expect(flushed.length).toBe(2)
    const keys = flushed.map((f) => f.key).sort()
    expect(keys).toEqual(["s1", "s2"])
  })

  test("drop removes cached data and pending timers", () => {
    const { persistence, flushed } = createMock()
    persistence.setScroll("s1", "t1", { x: 1, y: 1 })
    persistence.drop(["s1"])
    persistence.flushAll()
    expect(flushed.length).toBe(0)
  })

  test("drop with empty array does nothing", () => {
    const { persistence, flushed } = createMock()
    persistence.setScroll("s1", "t1", { x: 1, y: 1 })
    persistence.drop([])
    persistence.flushAll()
    expect(flushed.length).toBe(1)
  })

  test("seed does not overwrite existing cache", () => {
    const { persistence, snapshots } = createMock()
    persistence.setScroll("s1", "tab1", { x: 5, y: 5 })
    snapshots["s1"] = { tab1: { x: 10, y: 20 } }
    persistence.seed("s1")
    expect(persistence.scroll("s1", "tab1")).toEqual({ x: 5, y: 5 })
  })

  test("dispose cleans up all timers and data", () => {
    const { persistence, flushed } = createMock()
    persistence.setScroll("s1", "t1", { x: 1, y: 1 })
    persistence.dispose()
    persistence.flushAll()
    expect(flushed.length).toBe(0)
  })

  test("multiple tabs in same session", () => {
    const { persistence, flushed } = createMock()
    persistence.setScroll("s1", "tab1", { x: 10, y: 20 })
    persistence.setScroll("s1", "tab2", { x: 30, y: 40 })
    persistence.flush("s1")
    expect(flushed.length).toBe(1)
    expect(flushed[0]!.scroll.tab1).toEqual({ x: 10, y: 20 })
    expect(flushed[0]!.scroll.tab2).toEqual({ x: 30, y: 40 })
  })

  test("scroll returns undefined when no data exists", () => {
    const { persistence } = createMock()
    expect(persistence.scroll("session1", "tab1")).toBeUndefined()
  })
})
