import { describe, expect, test } from "bun:test"

// Testing pure helper functions from bootstrap.ts that are not exported
// We replicate the logic here for testing since they are file-scoped

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

function projectID(directory: string, projects: { worktree: string; sandboxes?: string[]; id: string }[]) {
  return projects.find((project) => project.worktree === directory || project.sandboxes?.includes(directory))?.id
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => item.reason)
}

describe("groupBySession", () => {
  test("groups items by sessionID", () => {
    const items = [
      { id: "1", sessionID: "s1" },
      { id: "2", sessionID: "s1" },
      { id: "3", sessionID: "s2" },
    ]
    const result = groupBySession(items)
    expect(result["s1"]).toHaveLength(2)
    expect(result["s2"]).toHaveLength(1)
  })

  test("skips items without id", () => {
    const items = [
      { id: "", sessionID: "s1" },
      { id: "2", sessionID: "s1" },
    ]
    const result = groupBySession(items)
    expect(result["s1"]).toHaveLength(1)
  })

  test("skips items without sessionID", () => {
    const items = [
      { id: "1", sessionID: "" },
      { id: "2", sessionID: "s1" },
    ]
    const result = groupBySession(items)
    expect(result["s1"]).toHaveLength(1)
  })

  test("returns empty object for empty input", () => {
    expect(groupBySession([])).toEqual({})
  })
})

describe("projectID", () => {
  test("finds project by worktree", () => {
    const projects = [
      { worktree: "/project-a", id: "p1", sandboxes: [] },
      { worktree: "/project-b", id: "p2", sandboxes: [] },
    ]
    expect(projectID("/project-a", projects)).toBe("p1")
  })

  test("finds project by sandbox directory", () => {
    const projects = [
      { worktree: "/project-a", id: "p1", sandboxes: ["/sandbox-1"] },
    ]
    expect(projectID("/sandbox-1", projects)).toBe("p1")
  })

  test("returns undefined when no match", () => {
    const projects = [
      { worktree: "/project-a", id: "p1", sandboxes: [] },
    ]
    expect(projectID("/unknown", projects)).toBeUndefined()
  })

  test("returns undefined for empty projects list", () => {
    expect(projectID("/any", [])).toBeUndefined()
  })
})

describe("errors", () => {
  test("extracts reasons from rejected promises", () => {
    const list: PromiseSettledResult<unknown>[] = [
      { status: "fulfilled", value: "ok" },
      { status: "rejected", reason: "err1" },
      { status: "rejected", reason: new Error("err2") },
    ]
    const result = errors(list)
    expect(result).toHaveLength(2)
    expect(result[0]).toBe("err1")
  })

  test("returns empty array when all fulfilled", () => {
    const list: PromiseSettledResult<unknown>[] = [
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: 2 },
    ]
    expect(errors(list)).toEqual([])
  })

  test("returns empty array for empty input", () => {
    expect(errors([])).toEqual([])
  })
})
