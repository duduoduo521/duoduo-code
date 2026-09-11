import { describe, expect, test } from "bun:test"
import { getSessionKey, shouldFocusTerminalOnKeyDown, getTabReorderIndex } from "./helpers"

describe("getSessionKey", () => {
  test("combines dir and id", () => {
    expect(getSessionKey("abc", "123")).toBe("abc/123")
  })

  test("omits id when undefined", () => {
    expect(getSessionKey("abc", undefined)).toBe("abc")
  })

  test("handles empty dir and id", () => {
    expect(getSessionKey("", "123")).toBe("/123")
  })

  test("handles both undefined", () => {
    expect(getSessionKey(undefined, undefined)).toBe("")
  })

  test("handles dir only", () => {
    expect(getSessionKey("my-dir", undefined)).toBe("my-dir")
  })
})

describe("shouldFocusTerminalOnKeyDown", () => {
  test("returns false for modifier keys", () => {
    expect(shouldFocusTerminalOnKeyDown({ key: "Alt", ctrlKey: false, metaKey: false, altKey: false })).toBe(false)
    expect(shouldFocusTerminalOnKeyDown({ key: "Control", ctrlKey: false, metaKey: false, altKey: false })).toBe(false)
    expect(shouldFocusTerminalOnKeyDown({ key: "Meta", ctrlKey: false, metaKey: false, altKey: false })).toBe(false)
    expect(shouldFocusTerminalOnKeyDown({ key: "Shift", ctrlKey: false, metaKey: false, altKey: false })).toBe(false)
  })

  test("returns false when ctrl is held", () => {
    expect(shouldFocusTerminalOnKeyDown({ key: "a", ctrlKey: true, metaKey: false, altKey: false })).toBe(false)
  })

  test("returns false when meta is held", () => {
    expect(shouldFocusTerminalOnKeyDown({ key: "a", ctrlKey: false, metaKey: true, altKey: false })).toBe(false)
  })

  test("returns false when alt is held", () => {
    expect(shouldFocusTerminalOnKeyDown({ key: "a", ctrlKey: false, metaKey: false, altKey: true })).toBe(false)
  })

  test("returns true for regular key without modifiers", () => {
    expect(shouldFocusTerminalOnKeyDown({ key: "a", ctrlKey: false, metaKey: false, altKey: false })).toBe(true)
  })

  test("returns true for Enter without modifiers", () => {
    expect(shouldFocusTerminalOnKeyDown({ key: "Enter", ctrlKey: false, metaKey: false, altKey: false })).toBe(true)
  })

  test("returns true for Escape without modifiers", () => {
    expect(shouldFocusTerminalOnKeyDown({ key: "Escape", ctrlKey: false, metaKey: false, altKey: false })).toBe(true)
  })
})

describe("getTabReorderIndex", () => {
  test("returns target index for valid reorder", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "c")).toBe(2)
  })

  test("returns undefined when from is not in list", () => {
    expect(getTabReorderIndex(["a", "b"], "x", "a")).toBeUndefined()
  })

  test("returns undefined when to is not in list", () => {
    expect(getTabReorderIndex(["a", "b"], "a", "x")).toBeUndefined()
  })

  test("returns undefined when from and to are same", () => {
    expect(getTabReorderIndex(["a", "b"], "a", "a")).toBeUndefined()
  })

  test("returns 0 when reordering to first position", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "c", "a")).toBe(0)
  })

  test("returns correct index for middle reorder", () => {
    expect(getTabReorderIndex(["a", "b", "c", "d"], "a", "c")).toBe(2)
  })
})
