/**
 * Integration tests for PtyRoutes.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { PtyRoutes } from "../../../src/server/routes/instance/pty"
import { createTestApp, testRequestJson } from "../../fixture/route-test"
import { createTestDir, setupTestLifecycle } from "../../fixture/test-runtime"

const mockUpgrade = ((_c: unknown) => ({})) as any
const routes = PtyRoutes(mockUpgrade)

const app = createTestApp((app) => {
  app.route("/pty", routes)
})

describe("PtyRoutes", () => {
  setupTestLifecycle()

  test("GET /pty returns empty list", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status, body } = await testRequestJson<unknown[]>(app, "GET", "/pty")
          expect(status).toBe(200)
          expect(Array.isArray(body)).toBe(true)
          expect(body).toHaveLength(0)
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("GET /pty/:id with invalid id returns 400", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status } = await testRequestJson(app, "GET", "/pty/not-a-valid-id")
          expect(status).toBe(400)
        },
      })
    } finally {
      await td.dispose()
    }
  })
})
