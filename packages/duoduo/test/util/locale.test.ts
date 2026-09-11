import { describe, expect, test } from "bun:test"
import * as Locale from "../../src/util/locale"

describe("util.locale", () => {
  describe("titlecase", () => {
    test("capitalizes first letter of each word", () => {
      expect(Locale.titlecase("hello world")).toBe("Hello World")
    })

    test("handles already capitalized text", () => {
      expect(Locale.titlecase("Hello World")).toBe("Hello World")
    })

    test("handles single word", () => {
      expect(Locale.titlecase("hello")).toBe("Hello")
    })

    test("handles empty string", () => {
      expect(Locale.titlecase("")).toBe("")
    })
  })

  describe("number", () => {
    test("returns number as string for values under 1000", () => {
      expect(Locale.number(42)).toBe("42")
      expect(Locale.number(999)).toBe("999")
    })

    test("formats thousands with K suffix", () => {
      expect(Locale.number(1000)).toBe("1.0K")
      expect(Locale.number(1500)).toBe("1.5K")
      expect(Locale.number(999999)).toBe("1000.0K")
    })

    test("formats millions with M suffix", () => {
      expect(Locale.number(1000000)).toBe("1.0M")
      expect(Locale.number(2500000)).toBe("2.5M")
    })
  })

  describe("duration", () => {
    test("formats milliseconds", () => {
      expect(Locale.duration(100)).toBe("100ms")
      expect(Locale.duration(999)).toBe("999ms")
    })

    test("formats seconds", () => {
      expect(Locale.duration(1000)).toBe("1.0s")
      expect(Locale.duration(5500)).toBe("5.5s")
    })

    test("formats minutes and seconds", () => {
      expect(Locale.duration(60000)).toBe("1m 0s")
      expect(Locale.duration(90000)).toBe("1m 30s")
    })

    test("formats hours and minutes", () => {
      expect(Locale.duration(3600000)).toBe("1h 0m")
      expect(Locale.duration(5400000)).toBe("1h 30m")
    })

    test("formats days and hours for very large durations", () => {
      expect(Locale.duration(86400000)).toBe("0d 24h")
    })
  })

  describe("truncate", () => {
    test("returns string as-is when shorter than limit", () => {
      expect(Locale.truncate("hello", 10)).toBe("hello")
    })

    test("returns string as-is when equal to limit", () => {
      expect(Locale.truncate("hello", 5)).toBe("hello")
    })

    test("truncates with ellipsis when over limit", () => {
      expect(Locale.truncate("hello world", 8)).toBe("hello w…")
    })
  })

  describe("truncateMiddle", () => {
    test("returns string as-is when shorter than maxLength", () => {
      expect(Locale.truncateMiddle("hello", 10)).toBe("hello")
    })

    test("returns string as-is when equal to maxLength", () => {
      expect(Locale.truncateMiddle("hello", 5)).toBe("hello")
    })

    test("truncates in the middle with ellipsis", () => {
      const result = Locale.truncateMiddle("a very long string that needs truncation", 20)
      expect(result).toContain("…")
      expect(result.length).toBe(20)
    })

    test("uses default maxLength of 35", () => {
      const long = "a".repeat(40)
      const result = Locale.truncateMiddle(long)
      expect(result.length).toBe(35)
      expect(result).toContain("…")
    })
  })

  describe("pluralize", () => {
    test("uses singular template when count is 1", () => {
      expect(Locale.pluralize(1, "{} item", "{} items")).toBe("1 item")
    })

    test("uses plural template when count is not 1", () => {
      expect(Locale.pluralize(0, "{} item", "{} items")).toBe("0 items")
      expect(Locale.pluralize(2, "{} item", "{} items")).toBe("2 items")
      expect(Locale.pluralize(100, "{} item", "{} items")).toBe("100 items")
    })
  })
})
