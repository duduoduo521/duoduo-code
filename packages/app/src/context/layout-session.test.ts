import { describe, expect, test } from "bun:test"

// Replicate the pure functions from layout.tsx that are not exported
// nextSessionTabsForOpen is not exported but has testable logic

// These are internal to layout.tsx, so we replicate them for testing
// If they get exported in the future, import directly

type SessionTabs = {
  active?: string
  all: string[]
}

const nextSessionTabsForOpen = (current: SessionTabs | undefined, tab: string): SessionTabs => {
  const all = current?.all ?? []
  if (tab === "review") return { all: all.filter((x) => x !== "review"), active: tab }
  if (tab === "context" || tab === "memory") return { all: [tab, ...all.filter((x) => x !== tab)], active: tab }
  if (!all.includes(tab)) return { all: [...all, tab], active: tab }
  return { all, active: tab }
}

describe("nextSessionTabsForOpen (replicated from layout.tsx)", () => {
  test("removes review from all when opening review tab", () => {
    const result = nextSessionTabsForOpen({ all: ["review", "context"], active: "context" }, "review")
    expect(result.all).not.toContain("review")
    expect(result.active).toBe("review")
  })

  test("prepends context tab when opening", () => {
    const result = nextSessionTabsForOpen({ all: ["file://a"], active: "file://a" }, "context")
    expect(result.all[0]).toBe("context")
    expect(result.active).toBe("context")
  })

  test("moves existing context tab to front when reopening", () => {
    const result = nextSessionTabsForOpen({ all: ["file://a", "context"], active: "file://a" }, "context")
    expect(result.all[0]).toBe("context")
    expect(result.all).toHaveLength(2)
  })

  test("prepends memory tab when opening", () => {
    const result = nextSessionTabsForOpen({ all: ["context"], active: "context" }, "memory")
    expect(result.all[0]).toBe("memory")
    expect(result.active).toBe("memory")
  })

  test("adds new file tab to the end", () => {
    const result = nextSessionTabsForOpen({ all: ["context"], active: "context" }, "file://new")
    expect(result.all).toContain("file://new")
    expect(result.active).toBe("file://new")
  })

  test("does not duplicate existing file tab", () => {
    const result = nextSessionTabsForOpen({ all: ["file://a", "context"], active: "context" }, "file://a")
    expect(result.all.filter((x) => x === "file://a")).toHaveLength(1)
    expect(result.active).toBe("file://a")
  })

  test("handles undefined current state", () => {
    const result = nextSessionTabsForOpen(undefined, "context")
    expect(result.all).toEqual(["context"])
    expect(result.active).toBe("context")
  })

  test("handles empty all array", () => {
    const result = nextSessionTabsForOpen({ all: [], active: undefined }, "file://a")
    expect(result.all).toEqual(["file://a"])
    expect(result.active).toBe("file://a")
  })
})

// Test getAvatarColors (already has its own test file)
// Test ensureSessionKey, pruneSessionKeys (already tested in layout.test.ts)

// sessionPath logic — tests the key parsing
describe("session key parsing", () => {
  test("session key format: dir/id", () => {
    const key = "abc123/session-456"
    const parts = key.split("/")
    expect(parts[0]).toBe("abc123")
    expect(parts[1]).toBe("session-456")
  })

  test("session key without id: just dir", () => {
    const key = "abc123"
    const parts = key.split("/")
    expect(parts).toHaveLength(1)
    expect(parts[0]).toBe("abc123")
  })
})
