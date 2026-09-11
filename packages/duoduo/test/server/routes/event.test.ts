/**
 * Integration tests for EventRoutes.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { EventRoutes } from "../../../src/server/routes/instance/event"
import { createTestApp, testRequest } from "../../fixture/route-test"
import { createTestDir, setupTestLifecycle } from "../../fixture/test-runtime"

const app = createTestApp((app) => {
  const routes = EventRoutes()
  app.route("/", routes)
})

describe("EventRoutes", () => {
  setupTestLifecycle()

  test("GET /event returns 200 with SSE headers", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const res = await testRequest(app, "GET", "/event")
          expect(res.status).toBe(200)
          expect(res.headers.get("content-type")).toMatch(/text\/event-stream/)
          // streamSSE may override Cache-Control to "no-cache"
          expect(res.headers.get("x-accel-buffering")).toBe("no")
        },
      })
    } finally {
      await td.dispose()
    }
  })
})
