/**
 * Integration tests for McpRoutes.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { McpRoutes } from "../../../src/server/routes/instance/mcp"
import { createTestApp, testRequestJson } from "../../fixture/route-test"
import { createTestDir, setupTestLifecycle } from "../../fixture/test-runtime"

const app = createTestApp((app) => {
  const routes = McpRoutes()
  app.route("/mcp", routes)
})

describe("McpRoutes", () => {
  setupTestLifecycle()

  test("GET /mcp returns status object", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status, body } = await testRequestJson<Record<string, unknown>>(app, "GET", "/mcp")
          expect(status).toBe(200)
          expect(typeof body).toBe("object")
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("POST /mcp with invalid body returns 400", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status } = await testRequestJson(app, "POST", "/mcp", {})
          expect(status).toBe(400)
        },
      })
    } finally {
      await td.dispose()
    }
  })
})
