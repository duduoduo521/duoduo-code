import { describe, expect, test } from "bun:test"
import { getSessionKey, getTabReorderIndex } from "./helpers"

describe("getSessionKey", () => {
  test("combines dir and id with slash", () => {
    expect(getSessionKey("dir/a", "123")).toBe("dir/a/123")
  })

  test("returns dir only when id is undefined", () => {
    expect(getSessionKey("dir/a", undefined)).toBe("dir/a")
  })

  test("returns dir only when id is empty string", () => {
    expect(getSessionKey("dir/a", "")).toBe("dir/a")
  })

  test("returns empty string when both dir and id are undefined", () => {
    expect(getSessionKey(undefined, undefined)).toBe("")
  })

  test("returns empty string when dir is undefined and id is empty", () => {
    expect(getSessionKey(undefined, "")).toBe("")
  })

  test("returns dir with slash when id is provided", () => {
    expect(getSessionKey("project", "session-1")).toBe("project/session-1")
  })

  test("handles dir with trailing content", () => {
    expect(getSessionKey("dir/sub", "abc")).toBe("dir/sub/abc")
  })
})

describe("getTabReorderIndex", () => {
  test("returns target index for valid reorder", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "c")).toBe(2)
  })

  test("returns target index when moving forward", () => {
    expect(getTabReorderIndex(["a", "b", "c", "d"], "b", "d")).toBe(3)
  })

  test("returns target index when moving backward", () => {
    expect(getTabReorderIndex(["a", "b", "c", "d"], "d", "a")).toBe(0)
  })

  test("returns undefined when from is not in tabs", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "missing", "c")).toBeUndefined()
  })

  test("returns undefined when to is not in tabs", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "missing")).toBeUndefined()
  })

  test("returns undefined when from and to are the same", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "a")).toBeUndefined()
  })

  test("returns undefined for empty tabs array", () => {
    expect(getTabReorderIndex([], "a", "b")).toBeUndefined()
  })

  test("returns undefined for single element tabs", () => {
    expect(getTabReorderIndex(["a"], "a", "a")).toBeUndefined()
  })

  test("handles adjacent tab reorder", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "b")).toBe(1)
  })
})
