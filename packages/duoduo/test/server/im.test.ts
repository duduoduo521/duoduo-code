import { describe, expect, test } from "bun:test"

// Replicate the maskSecret function from im.ts for direct unit testing
function maskSecret(value: string): string {
  if (value.length <= 8) return "••••••••"
  return value.slice(0, 4) + "••••" + value.slice(-4)
}

describe("maskSecret", () => {
  test("masks short values (<=8 chars) completely", () => {
    expect(maskSecret("")).toBe("••••••••")
    expect(maskSecret("a")).toBe("••••••••")
    expect(maskSecret("abcd")).toBe("••••••••")
    expect(maskSecret("12345678")).toBe("••••••••")
  })

  test("masks values longer than 8 chars with first 4 and last 4 visible", () => {
    expect(maskSecret("123456789")).toBe("1234••••6789")
    expect(maskSecret("abcdefghijk")).toBe("abcd••••hijk")
  })

  test("preserves first 4 and last 4 characters of app ID", () => {
    const appId = "cli_a5f3e2b1c4d5e6f7"
    const masked = maskSecret(appId)
    expect(masked.startsWith("cli_")).toBe(true)
    expect(masked.endsWith("e6f7")).toBe(true)
    expect(masked).toContain("••••")
  })

  test("handles exactly 9 characters", () => {
    expect(maskSecret("123456789")).toBe("1234••••6789")
  })

  test("handles typical secret lengths", () => {
    const longSecret = "sk-1234567890abcdefghijklmnopqrstuvwxyz"
    const masked = maskSecret(longSecret)
    expect(masked.startsWith("sk-1")).toBe(true)
    expect(masked.endsWith("wxyz")).toBe(true)
  })
})
