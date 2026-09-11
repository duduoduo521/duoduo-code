import { describe, expect, test } from "bun:test"
import {
  workspaceKey,
  sortedRootSessions,
  latestRootSession,
  hasProjectPermissions,
  childSessionOnPath,
  displayName,
  errorMessage,
  effectiveWorkspaceOrder,
} from "./helpers"
import type { Session } from "@duoduo-ai/sdk/v2/client"

const makeSession = (overrides: Partial<Session> & { id: string; directory: string }): Session =>
  ({
    time: { created: 0, updated: 0 },
    ...overrides,
  }) as Session

describe("workspaceKey", () => {
  test("normalizes backslashes to forward slashes", () => {
    expect(workspaceKey("C:\\Users\\test")).toBe("C:/Users/test")
  })

  test("normalizes Windows drive letter to uppercase", () => {
    expect(workspaceKey("c:/Users/test")).toBe("C:/Users/test")
  })

  test("strips trailing slashes", () => {
    expect(workspaceKey("/home/user/")).toBe("/home/user")
  })

  test("preserves root path /", () => {
    expect(workspaceKey("/")).toBe("/")
  })

  test("preserves root path with multiple slashes", () => {
    expect(workspaceKey("///")).toBe("/")
  })

  test("preserves Windows drive root C:/", () => {
    expect(workspaceKey("C:/")).toBe("C:/")
  })

  test("handles lowercase Windows drive root", () => {
    expect(workspaceKey("c:/")).toBe("C:/")
  })

  test("strips trailing slashes from regular path", () => {
    expect(workspaceKey("/home/user///")).toBe("/home/user")
  })

  test("handles mixed separators", () => {
    expect(workspaceKey("C:\\Users/test\\project")).toBe("C:/Users/test/project")
  })
})

describe("sortedRootSessions", () => {
  const now = 100000

  test("sorts recent sessions first", () => {
    const store = {
      session: [
        makeSession({ id: "old", directory: "/project", time: { created: 1000, updated: 2000 } }),
        makeSession({ id: "recent", directory: "/project", time: { created: 1000, updated: now - 30000 } }),
      ],
      path: { directory: "/project" },
    }
    const sorted = sortedRootSessions(store, now)
    expect(sorted[0]!.id).toBe("recent")
  })

  test("filters out child sessions (with parentID)", () => {
    const store = {
      session: [
        makeSession({ id: "root", directory: "/project" }),
        makeSession({ id: "child", directory: "/project", parentID: "root" } as any),
      ],
      path: { directory: "/project" },
    }
    const sorted = sortedRootSessions(store, now)
    expect(sorted).toHaveLength(1)
    expect(sorted[0]!.id).toBe("root")
  })

  test("filters out archived sessions", () => {
    const store = {
      session: [
        makeSession({ id: "active", directory: "/project" }),
        makeSession({ id: "archived", directory: "/project", time: { created: 0, updated: 0, archived: 1 } } as any),
      ],
      path: { directory: "/project" },
    }
    const sorted = sortedRootSessions(store, now)
    expect(sorted).toHaveLength(1)
    expect(sorted[0]!.id).toBe("active")
  })

  test("filters out sessions from different directory", () => {
    const store = {
      session: [makeSession({ id: "a", directory: "/project-a" }), makeSession({ id: "b", directory: "/project-b" })],
      path: { directory: "/project-a" },
    }
    const sorted = sortedRootSessions(store, now)
    expect(sorted).toHaveLength(1)
    expect(sorted[0]!.id).toBe("a")
  })
})

describe("latestRootSession", () => {
  const now = 100000

  test("returns the most recently updated session across stores", () => {
    const stores = [
      {
        session: [makeSession({ id: "old", directory: "/a", time: { created: 0, updated: 1000 } })],
        path: { directory: "/a" },
      },
      {
        session: [makeSession({ id: "new", directory: "/b", time: { created: 0, updated: now - 1000 } })],
        path: { directory: "/b" },
      },
    ]
    const result = latestRootSession(stores, now)
    expect(result?.id).toBe("new")
  })

  test("returns undefined when no sessions exist", () => {
    const result = latestRootSession([], now)
    expect(result).toBeUndefined()
  })
})

describe("hasProjectPermissions", () => {
  test("returns false for undefined", () => {
    expect(hasProjectPermissions(undefined)).toBe(false)
  })

  test("returns false for empty object", () => {
    expect(hasProjectPermissions({})).toBe(false)
  })

  test("returns false when all arrays are empty", () => {
    expect(hasProjectPermissions({ a: [] })).toBe(false)
  })

  test("returns true when any array has items", () => {
    expect(hasProjectPermissions({ a: ["item"] })).toBe(true)
  })

  test("uses include filter", () => {
    expect(hasProjectPermissions({ a: [1, 2, 3] }, (x) => x === 2)).toBe(true)
    expect(hasProjectPermissions({ a: [1, 2, 3] }, (x) => x === 99)).toBe(false)
  })
})

describe("childSessionOnPath", () => {
  test("returns undefined when activeID matches rootID", () => {
    const sessions = [makeSession({ id: "root", directory: "/a" })]
    expect(childSessionOnPath(sessions, "root", "root")).toBeUndefined()
  })

  test("returns undefined when activeID is undefined", () => {
    const sessions = [makeSession({ id: "root", directory: "/a" })]
    expect(childSessionOnPath(sessions, "root", undefined)).toBeUndefined()
  })

  test("returns child session directly under root", () => {
    const sessions = [
      makeSession({ id: "root", directory: "/a" }),
      makeSession({ id: "child", directory: "/a", parentID: "root" } as any),
    ]
    const result = childSessionOnPath(sessions, "root", "child")
    expect(result?.id).toBe("child")
  })

  test("returns the direct child of root on the path to activeID", () => {
    const sessions = [
      makeSession({ id: "root", directory: "/a" }),
      makeSession({ id: "child", directory: "/a", parentID: "root" } as any),
      makeSession({ id: "grandchild", directory: "/a", parentID: "child" } as any),
    ]
    // grandchild's parent is child, child's parent is root → returns child (direct child of root)
    const result = childSessionOnPath(sessions, "root", "grandchild")
    expect(result?.id).toBe("child")
  })

  test("returns undefined when no path to root", () => {
    const sessions = [
      makeSession({ id: "root", directory: "/a" }),
      makeSession({ id: "orphan", directory: "/a", parentID: "other" } as any),
    ]
    expect(childSessionOnPath(sessions, "root", "orphan")).toBeUndefined()
  })
})

describe("displayName", () => {
  test("returns name when present", () => {
    expect(displayName({ name: "My Project", worktree: "/path/to/dir" })).toBe("My Project")
  })

  test("falls back to worktree filename", () => {
    expect(displayName({ worktree: "/path/to/my-dir" })).toBe("my-dir")
  })

  test("prefers name over worktree", () => {
    expect(displayName({ name: "Custom", worktree: "/other" })).toBe("Custom")
  })

  test("handles empty name", () => {
    expect(displayName({ name: "", worktree: "/path/to/dir" })).toBe("dir")
  })
})

describe("errorMessage", () => {
  test("extracts data.message from object", () => {
    expect(errorMessage({ data: { message: "API error" } }, "fallback")).toBe("API error")
  })

  test("returns Error message", () => {
    expect(errorMessage(new Error("something went wrong"), "fallback")).toBe("something went wrong")
  })

  test("returns fallback for unknown type", () => {
    expect(errorMessage(42, "fallback")).toBe("fallback")
  })

  test("returns fallback for null", () => {
    expect(errorMessage(null, "fallback")).toBe("fallback")
  })
})

describe("effectiveWorkspaceOrder", () => {
  test("returns local first when no persisted order", () => {
    const result = effectiveWorkspaceOrder("/local", ["/a", "/b"])
    expect(result[0]!).toBe("/local")
    expect(result).toHaveLength(3)
  })

  test("excludes local from dirs even if present", () => {
    const result = effectiveWorkspaceOrder("/local", ["/local", "/a"])
    expect(result).toEqual(["/local", "/a"])
  })

  test("follows persisted order for known dirs", () => {
    const result = effectiveWorkspaceOrder("/local", ["/a", "/b", "/c"], ["/c", "/a"])
    expect(result).toEqual(["/local", "/c", "/a", "/b"])
  })

  test("appends unknown dirs after persisted order", () => {
    const result = effectiveWorkspaceOrder("/local", ["/a", "/b", "/c"], ["/c"])
    expect(result).toEqual(["/local", "/c", "/a", "/b"])
  })

  test("deduplicates by workspaceKey", () => {
    // /a and /a/ should resolve to same key
    const result = effectiveWorkspaceOrder("/local", ["/a", "/a/"])
    expect(result).toHaveLength(2) // local + one of /a
  })
})
