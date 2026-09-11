import { describe, expect, test } from "bun:test"

// Testing cleanInput from dialog-select-directory.tsx
// This function is not exported, so we replicate the logic here

function cleanInput(value: string) {
  const first = (value ?? "").split(/\r?\n/)[0] ?? ""
  return first.replace(/[\u0000-\u001F\u007F]/g, "").trim()
}

describe("cleanInput", () => {
  test("returns trimmed input for normal string", () => {
    expect(cleanInput("hello")).toBe("hello")
  })

  test("trims whitespace", () => {
    expect(cleanInput("  hello  ")).toBe("hello")
  })

  test("takes only first line", () => {
    expect(cleanInput("hello\nworld")).toBe("hello")
    expect(cleanInput("hello\r\nworld")).toBe("hello")
  })

  test("removes control characters", () => {
    expect(cleanInput("hello\tworld")).toBe("helloworld")
    expect(cleanInput("hello\u0000world")).toBe("helloworld")
    expect(cleanInput("hello\u001Fworld")).toBe("helloworld")
    expect(cleanInput("hello\u007Fworld")).toBe("helloworld")
  })

  test("handles empty string", () => {
    expect(cleanInput("")).toBe("")
  })

  test("handles string that is only whitespace", () => {
    expect(cleanInput("   ")).toBe("")
  })

  test("handles string that is only newlines", () => {
    expect(cleanInput("\n\n")).toBe("")
  })
})
