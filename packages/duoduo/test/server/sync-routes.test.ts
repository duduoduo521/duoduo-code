import { describe, expect, test } from "bun:test"

describe("server/sync routes module", () => {
  test("SyncRoutes is lazily defined", async () => {
    const syncModule = await import("../../src/server/routes/instance/sync")
    expect(syncModule.SyncRoutes).toBeDefined()
  })
})
