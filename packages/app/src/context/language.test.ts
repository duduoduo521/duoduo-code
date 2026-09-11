import { describe, expect, test } from "bun:test"
import { normalizeLocale } from "@/i18n/core"

describe("normalizeLocale", () => {
  test("returns 'en' for 'en'", () => {
    expect(normalizeLocale("en")).toBe("en")
  })

  test("returns 'zh' for 'zh'", () => {
    expect(normalizeLocale("zh")).toBe("zh")
  })

  test("returns 'en' for unsupported locale", () => {
    expect(normalizeLocale("fr")).toBe("en")
  })

  test("returns 'en' for empty string", () => {
    expect(normalizeLocale("")).toBe("en")
  })

  test("returns 'en' for 'ja'", () => {
    expect(normalizeLocale("ja")).toBe("en")
  })

  test("returns 'en' for 'de'", () => {
    expect(normalizeLocale("de")).toBe("en")
  })
})

describe("resolveTemplate (inline logic)", () => {
  // Testing the resolveTemplate logic from the language context
  function resolveTemplate(template: string, params?: Record<string, string | number | boolean>): string {
    if (!params) return template
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const value = params[key]
      return value !== undefined && value !== null ? String(value) : `{{${key}}}`
    })
  }

  test("returns template as-is when no params", () => {
    expect(resolveTemplate("Hello world")).toBe("Hello world")
  })

  test("replaces single placeholder", () => {
    expect(resolveTemplate("Hello {{name}}", { name: "World" })).toBe("Hello World")
  })

  test("replaces multiple placeholders", () => {
    expect(resolveTemplate("{{a}} and {{b}}", { a: "X", b: "Y" })).toBe("X and Y")
  })

  test("leaves unreferenced placeholders intact", () => {
    expect(resolveTemplate("Hello {{name}}", {})).toBe("Hello {{name}}")
  })

  test("handles numeric values", () => {
    expect(resolveTemplate("Count: {{n}}", { n: 42 })).toBe("Count: 42")
  })

  test("handles boolean values", () => {
    expect(resolveTemplate("Active: {{active}}", { active: true })).toBe("Active: true")
  })

  test("handles null/undefined by keeping placeholder", () => {
    expect(resolveTemplate("Val: {{x}}", { x: undefined as any })).toBe("Val: {{x}}")
  })
})
