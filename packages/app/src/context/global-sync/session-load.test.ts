import { describe, expect, test } from "bun:test"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./session-load"

describe("estimateRootSessionTotal", () => {
  test("returns count when not limited", () => {
    expect(estimateRootSessionTotal({ count: 5, limit: 10, limited: false })).toBe(5)
  })

  test("returns count when count < limit", () => {
    expect(estimateRootSessionTotal({ count: 3, limit: 10, limited: true })).toBe(3)
  })

  test("returns count + 1 when count >= limit and limited", () => {
    expect(estimateRootSessionTotal({ count: 10, limit: 10, limited: true })).toBe(11)
  })

  test("returns count + 1 when count > limit", () => {
    expect(estimateRootSessionTotal({ count: 15, limit: 10, limited: true })).toBe(16)
  })

  test("handles zero count", () => {
    expect(estimateRootSessionTotal({ count: 0, limit: 10, limited: true })).toBe(0)
  })

  test("handles zero limit", () => {
    expect(estimateRootSessionTotal({ count: 0, limit: 0, limited: true })).toBe(0)
  })
})

describe("loadRootSessionsWithFallback", () => {
  test("returns limited result on success", async () => {
    const mockData = [{ id: "s1" }, { id: "s2" }]
    const list = async (query: { directory: string; roots: true; limit?: number }) => {
      expect(query.limit).toBe(10)
      return { data: mockData }
    }

    const result = await loadRootSessionsWithFallback({
      directory: "/project",
      limit: 10,
      list: list as any,
    })

    expect(result.data).toEqual(mockData as any)
    expect(result.limit).toBe(10 as any)
    expect(result.limited).toBe(true as any)
  })

  test("falls back to unlimited when limit query fails", async () => {
    const mockData = [{ id: "s1" }]
    const list = async (query: { directory: string; roots: true; limit?: number }) => {
      if (query.limit) throw new Error("limit not supported")
      return { data: mockData }
    }

    const result = await loadRootSessionsWithFallback({
      directory: "/project",
      limit: 10,
      list: list as any,
    })

    expect(result.data).toEqual(mockData as any)
    expect(result.limit).toBe(10 as any)
    expect(result.limited).toBe(false as any)
  })

  test("passes directory to list call", async () => {
    let receivedDir: string | undefined
    const list = async (query: { directory: string; roots: true; limit?: number }) => {
      receivedDir = query.directory
      return { data: [] }
    }

    await loadRootSessionsWithFallback({
      directory: "/my/project",
      limit: 5,
      list: list as any,
    })

    expect(receivedDir).toBe("/my/project")
  })
})
