import { describe, expect, test } from "bun:test"
import { kgRetryDelayMs } from "../../src/file/watcher"

// 7-6: the KG incremental sync retries forever with exponential backoff —
// 2s base, doubling per consecutive failure, capped at 60s. The old fixed
// budget DROPPED the pending updates when exhausted, leaving the graph stale
// while the snapshot hash already looked fresh.
describe("file.watcher KG retry backoff", () => {
  test("starts at the 2s base delay", () => {
    expect(kgRetryDelayMs(0)).toBe(2000)
  })

  test("doubles per consecutive failure until the cap", () => {
    expect(kgRetryDelayMs(1)).toBe(4000)
    expect(kgRetryDelayMs(2)).toBe(8000)
    expect(kgRetryDelayMs(3)).toBe(16000)
    expect(kgRetryDelayMs(4)).toBe(32000)
    // 2^5 × 2s = 64s exceeds the cap, so the cap applies from here on.
    expect(kgRetryDelayMs(5)).toBe(60_000)
  })

  test("caps at 60s and never exceeds it however long the outage lasts", () => {
    expect(kgRetryDelayMs(6)).toBe(60_000)
    expect(kgRetryDelayMs(7)).toBe(60_000)
    expect(kgRetryDelayMs(100)).toBe(60_000)
  })
})
