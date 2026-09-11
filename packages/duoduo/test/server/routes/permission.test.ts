/**
 * Integration tests for PermissionRoutes.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { PermissionRoutes } from "../../../src/server/routes/instance/permission"
import { createTestApp, testRequestJson } from "../../fixture/route-test"
import { createTestDir, setupTestLifecycle } from "../../fixture/test-runtime"

const app = createTestApp((app) => {
  const routes = PermissionRoutes()
  app.route("/permission", routes)
})

describe("PermissionRoutes", () => {
  setupTestLifecycle()

  test("GET /permission returns permissions", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status, body } = await testRequestJson<unknown[]>(app, "GET", "/permission")
          expect(status).toBe(200)
          expect(Array.isArray(body)).toBe(true)
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("POST /permission/:id/reply with invalid requestID returns 400", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status } = await testRequestJson(app, "POST", "/permission/bogus/reply", {
            reply: "approved",
          })
          expect(status).toBe(400)
        },
      })
    } finally {
      await td.dispose()
    }
  })
})
