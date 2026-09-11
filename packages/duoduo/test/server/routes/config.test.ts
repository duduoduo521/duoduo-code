/**
 * Integration tests for ConfigRoutes.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { ConfigRoutes } from "../../../src/server/routes/instance/config"
import { createTestApp, testRequestJson } from "../../fixture/route-test"
import { createTestDir, setupTestLifecycle } from "../../fixture/test-runtime"

const app = createTestApp((app) => {
  const routes = ConfigRoutes()
  app.route("/config", routes)
})

describe("ConfigRoutes", () => {
  setupTestLifecycle()

  test("GET /config returns config", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status, body } = await testRequestJson<Record<string, unknown>>(app, "GET", "/config")
          expect(status).toBe(200)
          expect(typeof body).toBe("object")
          // Config is always an object (possibly empty)
          expect(body).toBeDefined()
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("GET /config/providers returns provider list", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status, body } = await testRequestJson<{ providers: unknown[]; default: unknown }>(
            app,
            "GET",
            "/config/providers",
          )
          expect(status).toBe(200)
          expect(Array.isArray(body.providers)).toBe(true)
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("PATCH /config rejects invalid body", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status } = await testRequestJson(app, "PATCH", "/config", {
            autoupdate: "not-a-boolean",
          })
          expect(status).toBe(400)
        },
      })
    } finally {
      await td.dispose()
    }
  })
})
