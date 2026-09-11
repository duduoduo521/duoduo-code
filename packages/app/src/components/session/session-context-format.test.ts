import { describe, expect, test } from "bun:test"
import { createSessionContextFormatter } from "./session-context-format"

describe("createSessionContextFormatter", () => {
  const formatter = createSessionContextFormatter("en")

  describe("number", () => {
    test("formats positive numbers with locale", () => {
      const result = formatter.number(1234)
      expect(result).toBe("1,234")
    })

    test("formats zero", () => {
      expect(formatter.number(0)).toBe("0")
    })

    test("returns dash for undefined", () => {
      expect(formatter.number(undefined)).toBe("—")
    })

    test("returns dash for null", () => {
      expect(formatter.number(null)).toBe("—")
    })

    test("formats large numbers", () => {
      const result = formatter.number(1000000)
      expect(result).toBe("1,000,000")
    })

    test("formats negative numbers", () => {
      const result = formatter.number(-500)
      expect(result).toBe("-500")
    })
  })

  describe("percent", () => {
    test("formats number with percent sign", () => {
      const result = formatter.percent(85)
      expect(result).toBe("85%")
    })

    test("formats zero percent", () => {
      expect(formatter.percent(0)).toBe("0%")
    })

    test("returns dash for undefined", () => {
      expect(formatter.percent(undefined)).toBe("—")
    })

    test("returns dash for null", () => {
      expect(formatter.percent(null)).toBe("—")
    })

    test("formats decimal percentages with locale", () => {
      const result = formatter.percent(99.5)
      expect(result).toBe("99.5%")
    })
  })

  describe("time", () => {
    test("returns dash for zero", () => {
      expect(formatter.time(0)).toBe("—")
    })

    test("returns dash for undefined", () => {
      expect(formatter.time(undefined)).toBe("—")
    })

    test("formats valid timestamp", () => {
      // 2024-01-15T10:30:00.000Z
      const ms = new Date("2024-01-15T10:30:00.000Z").getTime()
      const result = formatter.time(ms)
      expect(result).not.toBe("—")
      expect(result.length).toBeGreaterThan(0)
    })

    test("formats epoch timestamp", () => {
      const result = formatter.time(1705312200000)
      expect(result).not.toBe("—")
    })
  })

  describe("locale support", () => {
    test("respects different locale for number formatting", () => {
      // German locale uses different number formatting
      const deFormatter = createSessionContextFormatter("de")
      const result = deFormatter.number(1234)
      // German uses period as thousands separator or narrow no-break space
      expect(result).not.toBe("—")
    })
  })
})
