import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { dict as zh } from "./zh"

// Keys introduced by the recent fixes:
// - problem 2: showThinking setting row
// - problem 5: message retry action label
// (problem 8 projectTaskBusy toast keys removed: the 409 fail-fast path now
//  queues the prompt instead of toasting, so the keys had no consumer left)
const newKeys = [
  "settings.general.row.showThinking.title",
  "settings.general.row.showThinking.description",
  "ui.message.retryMessage",
] as const

describe("i18n fixes coverage", () => {
  for (const key of newKeys) {
    test(`"${key}" is defined and non-empty in both locales`, () => {
      expect(zh[key], `zh missing ${key}`).toBeDefined()
      expect(en[key], `en missing ${key}`).toBeDefined()
      expect(String(zh[key]).length, `zh empty ${key}`).toBeGreaterThan(0)
      expect(String(en[key]).length, `en empty ${key}`).toBeGreaterThan(0)
    })
  }

  test("zh and en differ for the translated strings", () => {
    for (const key of newKeys) {
      expect(zh[key], `${key} should be translated`).not.toBe(en[key])
    }
  })
})
