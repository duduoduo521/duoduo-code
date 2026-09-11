import { describe, expect, test } from "bun:test"
import { terminalTabLabel } from "./terminal-label"
import { isDefaultTitle } from "@/context/terminal-title"

describe("terminalTabLabel", () => {
  const t = (key: string, vars?: Record<string, string | number | boolean>) => {
    if (vars) return `${key}:${JSON.stringify(vars)}`
    return key
  }

  test("returns custom title when provided and not default", () => {
    expect(terminalTabLabel({ title: "My Server", titleNumber: 1, t })).toBe("My Server")
  })

  test("returns numbered title when title is default", () => {
    expect(terminalTabLabel({ title: "Terminal 1", titleNumber: 1, t })).toBe('terminal.title.numbered:{"number":1}')
  })

  test("returns numbered title when title is undefined", () => {
    expect(terminalTabLabel({ title: undefined, titleNumber: 3, t })).toBe('terminal.title.numbered:{"number":3}')
  })

  test("returns numbered title when titleNumber is 0", () => {
    expect(terminalTabLabel({ title: "Custom", titleNumber: 0, t })).toBe("Custom")
  })

  test("returns generic terminal title when no title and no number", () => {
    expect(terminalTabLabel({ title: undefined, titleNumber: 0, t })).toBe("terminal.title")
  })

  test("returns generic terminal title when title is empty and no number", () => {
    expect(terminalTabLabel({ title: "", titleNumber: 0, t })).toBe("terminal.title")
  })

  test("returns title as-is when titleNumber is undefined", () => {
    expect(terminalTabLabel({ title: "Custom Title", titleNumber: undefined, t })).toBe("Custom Title")
  })

  test("returns default title for Chinese default title", () => {
    expect(terminalTabLabel({ title: "终端 2", titleNumber: 2, t })).toBe('terminal.title.numbered:{"number":2}')
  })

  test("returns numbered title for positive number with empty title", () => {
    expect(terminalTabLabel({ title: "", titleNumber: 5, t })).toBe('terminal.title.numbered:{"number":5}')
  })
})
