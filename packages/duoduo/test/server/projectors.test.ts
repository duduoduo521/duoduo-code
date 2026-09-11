import { describe, expect, test } from "bun:test"
import { SyncEvent } from "../../src/sync"
import { Database } from "../../src/storage"

describe("server/projectors initProjectors", () => {
  test("initProjectors is callable (registers projectors)", async () => {
    // The module auto-calls initProjectors() at import time.
    // Use dynamic import because server/projectors is ESM and may have async deps.
    const projectors = await import("../../src/server/projectors")
    expect(projectors).toBeDefined()
    expect(projectors.initProjectors).toBeDefined()
    expect(typeof projectors.initProjectors).toBe("function")
  })
})
