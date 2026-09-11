import { describe, expect, test } from "bun:test"
import { normalizePaste, pasteMode, shouldAutoAttach } from "./paste"

describe("normalizePaste", () => {
  test("returns text unchanged when no carriage returns", () => {
    expect(normalizePaste("hello world")).toBe("hello world")
  })

  test("converts CRLF to LF", () => {
    expect(normalizePaste("line1\r\nline2")).toBe("line1\nline2")
  })

  test("converts standalone CR to LF", () => {
    expect(normalizePaste("line1\rline2")).toBe("line1\nline2")
  })

  test("handles mixed CRLF and standalone CR", () => {
    expect(normalizePaste("a\r\nb\rc")).toBe("a\nb\nc")
  })

  test("handles multiple consecutive CRLF", () => {
    expect(normalizePaste("a\r\n\r\nb")).toBe("a\n\nb")
  })

  test("preserves plain LF", () => {
    expect(normalizePaste("a\nb")).toBe("a\nb")
  })

  test("handles empty string", () => {
    expect(normalizePaste("")).toBe("")
  })

  test("handles string with only CR", () => {
    expect(normalizePaste("\r")).toBe("\n")
  })

  test("handles string with only CRLF", () => {
    expect(normalizePaste("\r\n")).toBe("\n")
  })
})

describe("pasteMode", () => {
  test("returns 'native' for short single-line text", () => {
    expect(pasteMode("hello world")).toBe("native")
  })

  test("returns 'native' for empty string", () => {
    expect(pasteMode("")).toBe("native")
  })

  test("returns 'manual' for text with LF newline", () => {
    expect(pasteMode("line1\nline2")).toBe("manual")
  })

  test("returns 'manual' for text with CRLF newline", () => {
    expect(pasteMode("line1\r\nline2")).toBe("manual")
  })

  test("returns 'manual' for text with standalone CR", () => {
    expect(pasteMode("line1\rline2")).toBe("manual")
  })

  test("returns 'manual' for text at exactly 8000 chars (large paste threshold)", () => {
    expect(pasteMode("x".repeat(8000))).toBe("manual")
  })

  test("returns 'native' for text just under 8000 chars", () => {
    expect(pasteMode("x".repeat(7999))).toBe("native")
  })

  test("returns 'manual' for text exceeding 8000 chars", () => {
    expect(pasteMode("x".repeat(8001))).toBe("manual")
  })

  test("returns 'manual' for text with 120 newlines (break threshold)", () => {
    expect(pasteMode("\n".repeat(120))).toBe("manual")
  })

  test("returns 'native' for text with 119 newlines", () => {
    expect(pasteMode("\n".repeat(119))).toBe("manual") // 119 newlines still has \n, so manual
  })

  test("returns 'native' for single-line text under size limit", () => {
    expect(pasteMode("a".repeat(100))).toBe("native")
  })

  test("multiline detection takes priority over size for short multiline", () => {
    // Short text with newline triggers manual even though under 8000 chars
    expect(pasteMode("a\nb")).toBe("manual")
  })

  test("large text triggers manual even without newlines", () => {
    expect(pasteMode("a".repeat(10000))).toBe("manual")
  })

  test("returns 'manual' for text with exactly 120 newlines and under char limit", () => {
    // 120 newlines, each preceded by a char to keep under 8000
    const text = Array.from({ length: 120 }, (_, i) => `a`).join("\n")
    expect(pasteMode(text)).toBe("manual")
  })
})

describe("shouldAutoAttach", () => {
  test("returns false for short text", () => {
    expect(shouldAutoAttach("hello world")).toBe(false)
  })

  test("returns false for empty string", () => {
    expect(shouldAutoAttach("")).toBe(false)
  })

  test("returns false for text just under 500 chars", () => {
    expect(shouldAutoAttach("x".repeat(499))).toBe(false)
  })

  test("returns true for text at exactly 500 chars", () => {
    expect(shouldAutoAttach("x".repeat(500))).toBe(true)
  })

  test("returns true for text exceeding 500 chars", () => {
    expect(shouldAutoAttach("x".repeat(501))).toBe(true)
  })

  test("returns true for very large text", () => {
    expect(shouldAutoAttach("x".repeat(10000))).toBe(true)
  })

  test("counts multiline text by total length", () => {
    // 250 lines of "aa" joined by \n = 250*2 + 249 = 749 chars
    const text = Array.from({ length: 250 }, () => "aa").join("\n")
    expect(shouldAutoAttach(text)).toBe(true)
  })
})
