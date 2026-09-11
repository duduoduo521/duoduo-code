import { describe, expect, test } from "bun:test"
import { getRelativeTime } from "./time"

describe("getRelativeTime", () => {
  const t = (key: string, params?: Record<string, string | number>) => {
    if (params) return `${key}:${JSON.stringify(params)}`
    return key
  }

  function dateFromSecondsAgo(seconds: number) {
    return new Date(Date.now() - seconds * 1000).toISOString()
  }

  test("returns justNow for less than 60 seconds ago", () => {
    const result = getRelativeTime(dateFromSecondsAgo(30), t)
    expect(result).toBe("common.time.justNow")
  })

  test("returns justNow for 0 seconds ago", () => {
    const result = getRelativeTime(dateFromSecondsAgo(0), t)
    expect(result).toBe("common.time.justNow")
  })

  test("returns minutesAgo for 1-59 minutes ago", () => {
    const result = getRelativeTime(dateFromSecondsAgo(5 * 60), t)
    expect(result).toBe('common.time.minutesAgo.short:{"count":5}')
  })

  test("returns hoursAgo for 1-23 hours ago", () => {
    const result = getRelativeTime(dateFromSecondsAgo(3 * 3600), t)
    expect(result).toBe('common.time.hoursAgo.short:{"count":3}')
  })

  test("returns daysAgo for 24+ hours ago", () => {
    const result = getRelativeTime(dateFromSecondsAgo(2 * 86400), t)
    expect(result).toBe('common.time.daysAgo.short:{"count":2}')
  })

  test("boundary: 59 seconds → justNow", () => {
    const result = getRelativeTime(dateFromSecondsAgo(59), t)
    expect(result).toBe("common.time.justNow")
  })

  test("boundary: 60 seconds → 1 minute", () => {
    const result = getRelativeTime(dateFromSecondsAgo(60), t)
    expect(result).toBe('common.time.minutesAgo.short:{"count":1}')
  })

  test("boundary: 59 minutes 59 seconds → 59 minutes", () => {
    const result = getRelativeTime(dateFromSecondsAgo(59 * 60 + 59), t)
    expect(result).toBe('common.time.minutesAgo.short:{"count":59}')
  })

  test("boundary: 60 minutes → 1 hour", () => {
    const result = getRelativeTime(dateFromSecondsAgo(3600), t)
    expect(result).toBe('common.time.hoursAgo.short:{"count":1}')
  })

  test("boundary: 23 hours 59 minutes → 23 hours", () => {
    const result = getRelativeTime(dateFromSecondsAgo(23 * 3600 + 59 * 60), t)
    expect(result).toBe('common.time.hoursAgo.short:{"count":23}')
  })

  test("boundary: 24 hours → 1 day", () => {
    const result = getRelativeTime(dateFromSecondsAgo(86400), t)
    expect(result).toBe('common.time.daysAgo.short:{"count":1}')
  })

  test("passes correct count to custom translator", () => {
    const calls: Array<{ key: string; params?: Record<string, string | number> }> = []
    const mockT = (key: string, params?: Record<string, string | number>) => {
      calls.push({ key, params })
      return key
    }
    getRelativeTime(dateFromSecondsAgo(90), mockT)
    expect(calls).toEqual([{ key: "common.time.minutesAgo.short", params: { count: 1 } }])
  })
})
