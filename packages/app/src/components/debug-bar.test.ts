import { describe, expect, test } from "bun:test"

// Testing pure helper functions from debug-bar.tsx that are not exported
// We replicate the logic here for testing since they are file-scoped

const ms = (n?: number, d = 0) => {
  if (n === undefined || Number.isNaN(n)) return
  return `${n.toFixed(d)}ms`
}

const time = (n?: number) => {
  if (n === undefined || Number.isNaN(n)) return
  return `${Math.round(n)}`
}

const mb = (n?: number) => {
  if (n === undefined || Number.isNaN(n)) return
  const v = n / 1024 / 1024
  return `${v >= 1024 ? v.toFixed(0) : v.toFixed(1)}MB`
}

const bad = (n: number | undefined, limit: number, low = false) => {
  if (n === undefined || Number.isNaN(n)) return false
  return low ? n < limit : n > limit
}

const session = (path: string) => path.includes("/session")

describe("ms", () => {
  test("formats number with ms suffix", () => {
    expect(ms(123.456)).toBe("123ms")
  })

  test("formats with specified decimal places", () => {
    expect(ms(123.456, 2)).toBe("123.46ms")
  })

  test("returns undefined for undefined input", () => {
    expect(ms(undefined)).toBeUndefined()
  })

  test("returns undefined for NaN input", () => {
    expect(ms(NaN)).toBeUndefined()
  })

  test("formats zero", () => {
    expect(ms(0)).toBe("0ms")
  })

  test("formats small values", () => {
    expect(ms(0.5, 1)).toBe("0.5ms")
  })
})

describe("time", () => {
  test("rounds and formats number", () => {
    expect(time(123.7)).toBe("124")
  })

  test("returns undefined for undefined input", () => {
    expect(time(undefined)).toBeUndefined()
  })

  test("returns undefined for NaN input", () => {
    expect(time(NaN)).toBeUndefined()
  })

  test("formats zero", () => {
    expect(time(0)).toBe("0")
  })

  test("rounds down", () => {
    expect(time(123.4)).toBe("123")
  })
})

describe("mb", () => {
  test("formats bytes as MB with one decimal for < 1024MB", () => {
    expect(mb(1024 * 1024 * 1.5)).toBe("1.5MB")
  })

  test("formats bytes as MB with no decimals for >= 1024MB", () => {
    expect(mb(1024 * 1024 * 1500)).toBe("1500MB")
  })

  test("returns undefined for undefined input", () => {
    expect(mb(undefined)).toBeUndefined()
  })

  test("returns undefined for NaN input", () => {
    expect(mb(NaN)).toBeUndefined()
  })

  test("formats zero", () => {
    expect(mb(0)).toBe("0.0MB")
  })

  test("formats small value", () => {
    // 512KB = 0.5MB
    expect(mb(512 * 1024)).toBe("0.5MB")
  })
})

describe("bad", () => {
  test("returns false for undefined input", () => {
    expect(bad(undefined, 100)).toBe(false)
  })

  test("returns false for NaN input", () => {
    expect(bad(NaN, 100)).toBe(false)
  })

  test("returns true when value exceeds limit (high mode)", () => {
    expect(bad(200, 100)).toBe(true)
  })

  test("returns false when value does not exceed limit (high mode)", () => {
    expect(bad(50, 100)).toBe(false)
  })

  test("returns false when value equals limit (high mode)", () => {
    expect(bad(100, 100)).toBe(false)
  })

  test("returns true when value is below limit (low mode)", () => {
    expect(bad(30, 50, true)).toBe(true)
  })

  test("returns false when value is at or above limit (low mode)", () => {
    expect(bad(50, 50, true)).toBe(false)
    expect(bad(70, 50, true)).toBe(false)
  })
})

describe("session", () => {
  test("returns true for session path", () => {
    expect(session("/project/session")).toBe(true)
  })

  test("returns true for session path with ID", () => {
    expect(session("/project/session/abc123")).toBe(true)
  })

  test("returns false for non-session path", () => {
    expect(session("/project")).toBe(false)
  })

  test("returns false for root path", () => {
    expect(session("/")).toBe(false)
  })
})
