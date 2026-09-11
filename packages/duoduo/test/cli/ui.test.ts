import { describe, expect, test } from "bun:test"
import { Style, CancelledError } from "../../src/cli/ui"

describe("cli.ui.Style", () => {
  test("TEXT_HIGHLIGHT is a cyan ANSI escape", () => {
    expect(Style.TEXT_HIGHLIGHT).toBe("\x1b[96m")
  })

  test("TEXT_HIGHLIGHT_BOLD contains cyan and bold codes", () => {
    expect(Style.TEXT_HIGHLIGHT_BOLD).toContain("\x1b[96m")
    expect(Style.TEXT_HIGHLIGHT_BOLD).toContain("\x1b[1m")
  })

  test("TEXT_DIM is a dark gray escape", () => {
    expect(Style.TEXT_DIM).toBe("\x1b[90m")
  })

  test("TEXT_NORMAL resets formatting", () => {
    expect(Style.TEXT_NORMAL).toBe("\x1b[0m")
  })

  test("TEXT_NORMAL_BOLD is just bold", () => {
    expect(Style.TEXT_NORMAL_BOLD).toBe("\x1b[1m")
  })

  test("TEXT_WARNING is bright yellow", () => {
    expect(Style.TEXT_WARNING).toBe("\x1b[93m")
  })

  test("TEXT_DANGER is bright red", () => {
    expect(Style.TEXT_DANGER).toBe("\x1b[91m")
  })

  test("TEXT_SUCCESS is bright green", () => {
    expect(Style.TEXT_SUCCESS).toBe("\x1b[92m")
  })

  test("TEXT_INFO is bright blue", () => {
    expect(Style.TEXT_INFO).toBe("\x1b[94m")
  })

  test("all style constants start with escape sequence", () => {
    const styles = Object.values(Style)
    for (const s of styles) {
      expect(s).toContain("\x1b[")
    }
  })
})

describe("cli.ui.CancelledError", () => {
  test("CancelledError has correct name", () => {
    const err = new CancelledError()
    expect(err.name).toBe("UICancelledError")
  })

  test("CancelledError is an instance of Error", () => {
    const err = new CancelledError()
    expect(err).toBeInstanceOf(Error)
  })
})
