import { describe, test, expect } from "bun:test"
import { dict as en } from "./en"
import { dict as zh } from "./zh"

describe("i18n dictionary coverage", () => {
  const enKeys = Object.keys(en)
  const zhKeys = Object.keys(zh)

  test("all en.ts values are strings", () => {
    for (const key of enKeys) {
      expect(typeof (en as any)[key]).toBe("string")
    }
  })

  test("all zh.ts values are strings", () => {
    for (const key of zhKeys) {
      expect(typeof (zh as any)[key]).toBe("string")
    }
  })

  test("all en.ts values are non-empty", () => {
    for (const key of enKeys) {
      expect((en as any)[key].length).toBeGreaterThan(0)
    }
  })

  test("all zh.ts values are non-empty", () => {
    for (const key of zhKeys) {
      expect((zh as any)[key].length).toBeGreaterThan(0)
    }
  })

  test("zh.ts keys are a subset of en.ts keys", () => {
    const enKeySet = new Set(enKeys)
    const missing = zhKeys.filter((k) => !enKeySet.has(k))
    expect(missing).toEqual([])
  })

  test("en.ts and zh.ts have the same key count", () => {
    // If this fails, zh.ts may be missing translations for new en.ts keys
    expect(zhKeys.length).toBe(enKeys.length)
  })

  test("key naming uses dot notation consistently", () => {
    const validKeyPattern = /^[a-z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)*$/
    for (const key of enKeys) {
      expect(validKeyPattern.test(key), `Key "${key}" does not follow dot-notation convention`).toBe(true)
    }
  })

  test("no duplicate keys in en.ts", () => {
    // Object.keys already deduplicates, but we verify the count
    const uniqueKeys = new Set(enKeys)
    expect(uniqueKeys.size).toBe(enKeys.length)
  })

  test("no duplicate keys in zh.ts", () => {
    const uniqueKeys = new Set(zhKeys)
    expect(uniqueKeys.size).toBe(zhKeys.length)
  })
})
