import { describe, expect, test } from "bun:test"
import { parseKeybind, matchKeybind, formatKeybind, upsertCommandRegistration } from "./command"
import type { Keybind } from "./command"

function makeKeyboardEvent(overrides: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: "k",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  })
}

describe("parseKeybind", () => {
  test("parses simple key", () => {
    const result = parseKeybind("k")
    expect(result).toHaveLength(1)
    expect(result[0]!.key).toBe("k")
    expect(result[0]!.ctrl).toBe(false)
    expect(result[0]!.meta).toBe(false)
    expect(result[0]!.shift).toBe(false)
    expect(result[0]!.alt).toBe(false)
  })

  test("parses ctrl+key", () => {
    const result = parseKeybind("ctrl+k")
    expect(result[0]!).toEqual({ key: "k", ctrl: true, meta: false, shift: false, alt: false })
  })

  test("parses control as alias for ctrl", () => {
    const result = parseKeybind("control+k")
    expect(result[0]!.ctrl).toBe(true)
  })

  test("parses meta+key", () => {
    const result = parseKeybind("meta+k")
    expect(result[0]!.meta).toBe(true)
  })

  test("parses cmd as alias for meta", () => {
    const result = parseKeybind("cmd+k")
    expect(result[0]!.meta).toBe(true)
  })

  test("parses command as alias for meta", () => {
    const result = parseKeybind("command+k")
    expect(result[0]!.meta).toBe(true)
  })

  test("parses alt+key", () => {
    const result = parseKeybind("alt+k")
    expect(result[0]!.alt).toBe(true)
  })

  test("parses option as alias for alt", () => {
    const result = parseKeybind("option+k")
    expect(result[0]!.alt).toBe(true)
  })

  test("parses shift+key", () => {
    const result = parseKeybind("shift+k")
    expect(result[0]!.shift).toBe(true)
  })

  test("parses complex combo", () => {
    const result = parseKeybind("ctrl+shift+k")
    expect(result[0]!).toEqual({ key: "k", ctrl: true, meta: false, shift: true, alt: false })
  })

  test("parses multiple combos separated by comma", () => {
    const result = parseKeybind("ctrl+k,ctrl+shift+k")
    expect(result).toHaveLength(2)
    expect(result[0]!.ctrl).toBe(true)
    expect(result[0]!.shift).toBe(false)
    expect(result[1]!.ctrl).toBe(true)
    expect(result[1]!.shift).toBe(true)
  })

  test("returns empty array for empty string", () => {
    expect(parseKeybind("")).toEqual([])
  })

  test("returns empty array for 'none'", () => {
    expect(parseKeybind("none")).toEqual([])
  })

  test("lowercases key", () => {
    const result = parseKeybind("K")
    expect(result[0]!.key).toBe("k")
  })

  test("trims whitespace around combos", () => {
    const result = parseKeybind(" ctrl+k , ctrl+shift+k ")
    expect(result).toHaveLength(2)
  })
})

describe("matchKeybind", () => {
  test("matches simple key", () => {
    const keybinds = parseKeybind("k")
    expect(matchKeybind(keybinds, makeKeyboardEvent({ key: "k" }))).toBe(true)
  })

  test("matches ctrl+key", () => {
    const keybinds = parseKeybind("ctrl+k")
    expect(matchKeybind(keybinds, makeKeyboardEvent({ key: "k", ctrlKey: true }))).toBe(true)
  })

  test("does not match when modifier missing", () => {
    const keybinds = parseKeybind("ctrl+k")
    expect(matchKeybind(keybinds, makeKeyboardEvent({ key: "k" }))).toBe(false)
  })

  test("does not match when extra modifier present", () => {
    const keybinds = parseKeybind("ctrl+k")
    expect(matchKeybind(keybinds, makeKeyboardEvent({ key: "k", ctrlKey: true, shiftKey: true }))).toBe(false)
  })

  test("matches any combo in list", () => {
    const keybinds = parseKeybind("ctrl+k,ctrl+shift+k")
    expect(matchKeybind(keybinds, makeKeyboardEvent({ key: "k", ctrlKey: true }))).toBe(true)
    expect(matchKeybind(keybinds, makeKeyboardEvent({ key: "k", ctrlKey: true, shiftKey: true }))).toBe(true)
  })

  test("normalizes special keys", () => {
    const keybinds = parseKeybind("comma")
    expect(matchKeybind(keybinds, makeKeyboardEvent({ key: "," }))).toBe(true)
  })

  test("matches space key", () => {
    const keybinds = parseKeybind("space")
    expect(matchKeybind(keybinds, makeKeyboardEvent({ key: " " }))).toBe(true)
  })

  test("matches plus key", () => {
    const keybinds = parseKeybind("plus")
    expect(matchKeybind(keybinds, makeKeyboardEvent({ key: "+" }))).toBe(true)
  })
})

describe("formatKeybind", () => {
  test("returns empty string for empty config", () => {
    expect(formatKeybind("")).toBe("")
    expect(formatKeybind("none")).toBe("")
  })

  test("formats simple key", () => {
    // On non-Mac, keys are joined with +
    const result = formatKeybind("k")
    expect(result).toMatch(/k/i)
  })

  test("formats ctrl+key", () => {
    const result = formatKeybind("ctrl+k")
    expect(result).toBeTruthy()
    expect(result.toLowerCase()).toContain("k")
  })

  test("formats arrow keys", () => {
    const result = formatKeybind("arrowup")
    expect(result).toContain("↑")
  })

  test("formats comma key", () => {
    const result = formatKeybind("comma")
    expect(result).toContain(",")
  })

  test("formats plus key", () => {
    const result = formatKeybind("plus")
    expect(result).toContain("+")
  })

  test("formats enter key", () => {
    const result = formatKeybind("enter")
    expect(result).toBeTruthy()
  })

  test("formats escape key", () => {
    const result = formatKeybind("escape")
    expect(result).toBeTruthy()
  })

  test("formats tab key", () => {
    const result = formatKeybind("tab")
    expect(result).toBeTruthy()
  })

  test("formats space key", () => {
    const result = formatKeybind("space")
    expect(result).toBeTruthy()
  })

  test("formats single character as uppercase", () => {
    const result = formatKeybind("a")
    expect(result).toBe("A")
  })

  test("formats multi-character key with capitalized first letter", () => {
    const result = formatKeybind("f5")
    expect(result).toBe("F5")
  })
})
