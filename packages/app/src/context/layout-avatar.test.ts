import { describe, expect, test } from "bun:test"
import { getAvatarColors } from "./layout"

describe("getAvatarColors", () => {
  test("returns CSS variables for valid color key", () => {
    const result = getAvatarColors("pink")
    expect(result.background).toBe("var(--avatar-background-pink)")
    expect(result.foreground).toBe("var(--avatar-text-pink)")
  })

  test("returns CSS variables for mint", () => {
    const result = getAvatarColors("mint")
    expect(result.background).toBe("var(--avatar-background-mint)")
    expect(result.foreground).toBe("var(--avatar-text-mint)")
  })

  test("returns default colors for undefined key", () => {
    const result = getAvatarColors(undefined)
    expect(result.background).toBe("var(--surface-info-base)")
    expect(result.foreground).toBe("var(--text-base)")
  })

  test("returns default colors for unknown key", () => {
    const result = getAvatarColors("unknown-color")
    expect(result.background).toBe("var(--surface-info-base)")
    expect(result.foreground).toBe("var(--text-base)")
  })

  test("returns CSS variables for all valid keys", () => {
    for (const key of [
      "pink",
      "mint",
      "orange",
      "purple",
      "cyan",
      "lime",
      "rose",
      "amber",
      "teal",
      "blue",
      "violet",
      "emerald",
    ]) {
      const result = getAvatarColors(key)
      expect(result.background).toBe(`var(--avatar-background-${key})`)
      expect(result.foreground).toBe(`var(--avatar-text-${key})`)
    }
  })

  test("returns default for empty string", () => {
    const result = getAvatarColors("")
    expect(result.background).toBe("var(--surface-info-base)")
    expect(result.foreground).toBe("var(--text-base)")
  })
})
