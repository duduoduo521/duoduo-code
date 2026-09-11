import { describe, expect, test } from "bun:test"
import { MAX_DIR_STORES, DIR_IDLE_TTL_MS, SESSION_RECENT_WINDOW, SESSION_RECENT_LIMIT } from "./types"

describe("global-sync constants", () => {
  test("MAX_DIR_STORES is 30", () => {
    expect(MAX_DIR_STORES).toBe(30)
  })

  test("DIR_IDLE_TTL_MS is 20 minutes", () => {
    expect(DIR_IDLE_TTL_MS).toBe(20 * 60 * 1000)
    expect(DIR_IDLE_TTL_MS).toBe(1_200_000)
  })

  test("SESSION_RECENT_WINDOW is 4 hours", () => {
    expect(SESSION_RECENT_WINDOW).toBe(4 * 60 * 60 * 1000)
    expect(SESSION_RECENT_WINDOW).toBe(14_400_000)
  })

  test("SESSION_RECENT_LIMIT is 50", () => {
    expect(SESSION_RECENT_LIMIT).toBe(50)
  })
})
