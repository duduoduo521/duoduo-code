import { describe, expect, test } from "bun:test"
import { defaultTitle, isDefaultTitle, titleNumber } from "./terminal-title"

describe("defaultTitle", () => {
  test("generates default terminal title for number 1", () => {
    expect(defaultTitle(1)).toBe("Terminal 1")
  })

  test("generates default terminal title for number 5", () => {
    expect(defaultTitle(5)).toBe("Terminal 5")
  })

  test("generates default terminal title for number 0", () => {
    expect(defaultTitle(0)).toBe("Terminal 0")
  })

  test("generates default terminal title for large number", () => {
    expect(defaultTitle(100)).toBe("Terminal 100")
  })
})

describe("isDefaultTitle", () => {
  test("returns true for English default title", () => {
    expect(isDefaultTitle("Terminal 1", 1)).toBe(true)
  })

  test("returns true for Chinese default title", () => {
    expect(isDefaultTitle("终端 1", 1)).toBe(true)
  })

  test("returns true for Arabic default title", () => {
    expect(isDefaultTitle("محطة طرفية 1", 1)).toBe(true)
  })

  test("returns true for Russian default title", () => {
    expect(isDefaultTitle("Терминал 1", 1)).toBe(true)
  })

  test("returns true for Japanese default title", () => {
    expect(isDefaultTitle("ターミナル 1", 1)).toBe(true)
  })

  test("returns true for Korean default title", () => {
    expect(isDefaultTitle("터미널 1", 1)).toBe(true)
  })

  test("returns true for Thai default title", () => {
    expect(isDefaultTitle("เทอร์มินัล 1", 1)).toBe(true)
  })

  test("returns true for Traditional Chinese default title", () => {
    expect(isDefaultTitle("終端機 1", 1)).toBe(true)
  })

  test("returns false for custom title", () => {
    expect(isDefaultTitle("My Custom Title", 1)).toBe(false)
  })

  test("returns false when number doesn't match", () => {
    expect(isDefaultTitle("Terminal 1", 2)).toBe(false)
  })

  test("returns true for Terminal 3 with number 3", () => {
    expect(isDefaultTitle("Terminal 3", 3)).toBe(true)
  })

  test("returns false for empty string", () => {
    expect(isDefaultTitle("", 1)).toBe(false)
  })
})

describe("titleNumber", () => {
  test("returns 1 for Terminal 1 with max 5", () => {
    expect(titleNumber("Terminal 1", 5)).toBe(1)
  })

  test("returns 3 for Terminal 3 with max 10", () => {
    expect(titleNumber("Terminal 3", 10)).toBe(3)
  })

  test("returns undefined for custom title", () => {
    expect(titleNumber("My Custom Title", 10)).toBeUndefined()
  })

  test("returns undefined when number exceeds max", () => {
    expect(titleNumber("Terminal 6", 5)).toBeUndefined()
  })

  test("returns undefined for empty string", () => {
    expect(titleNumber("", 10)).toBeUndefined()
  })

  test("returns correct number for Chinese default title", () => {
    expect(titleNumber("终端 2", 5)).toBe(2)
  })
})
