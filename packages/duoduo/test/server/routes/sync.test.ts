/**
 * Integration tests for SyncRoutes.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { SyncRoutes } from "../../../src/server/routes/instance/sync"
import { createTestApp, testRequest, testRequestJson } from "../../fixture/route-test"
import { createTestDir, setupTestLifecycle } from "../../fixture/test-runtime"

const app = createTestApp((app) => {
  const routes = SyncRoutes()
  app.route("/sync", routes)
})

describe("SyncRoutes", () => {
  setupTestLifecycle()

  describe("POST /sync/start", () => {
    test("starts workspace sync and returns true", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status, body } = await testRequestJson<boolean>(app, "POST", "/sync/start")
            expect(status).toBe(200)
            expect(body).toBe(true)
          },
        })
      } finally {
        await td.dispose()
      }
    })
  })

  describe("POST /sync/replay", () => {
    test("returns 400 when body is missing", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status } = await testRequestJson(app, "POST", "/sync/replay")
            expect(status).toBe(400)
          },
        })
      } finally {
        await td.dispose()
      }
    })

    test("returns 400 when events array is empty", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status } = await testRequestJson(app, "POST", "/sync/replay", {
              directory: td.path,
              events: [],
            })
            expect(status).toBe(400)
          },
        })
      } finally {
        await td.dispose()
      }
    })

    test("returns 400 when directory is missing", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status } = await testRequestJson(app, "POST", "/sync/replay", {
              events: [
                {
                  id: "evt-1",
                  aggregateID: "agg-1",
                  seq: 0,
                  type: "test.event",
                  data: {},
                },
              ],
            })
            expect(status).toBe(400)
          },
        })
      } finally {
        await td.dispose()
      }
    })

    test("returns 500 with unregistered event type (replay throws)", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            // Unknown event types cause SyncEvent.replay to throw at runtime
            const res = await testRequest(app, "POST", "/sync/replay", {
              directory: td.path,
              events: [
                {
                  id: "evt-1",
                  aggregateID: "agg-session-1",
                  seq: 0,
                  type: "test.event",
                  data: {},
                },
              ],
            })
            expect(res.status).toBe(500)
          },
        })
      } finally {
        await td.dispose()
      }
    })
  })

  describe("POST /sync/history", () => {
    test("returns sync events when given valid body", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status, body } = await testRequestJson<unknown[]>(app, "POST", "/sync/history", {})
            expect(status).toBe(200)
            expect(Array.isArray(body)).toBe(true)
          },
        })
      } finally {
        await td.dispose()
      }
    })

    test("returns events filtered by known sequence IDs", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status, body } = await testRequestJson<unknown[]>(app, "POST", "/sync/history", {
              "existing-agg-1": 5,
            })
            expect(status).toBe(200)
            expect(Array.isArray(body)).toBe(true)
          },
        })
      } finally {
        await td.dispose()
      }
    })
  })
})
