/**
 * Integration tests for ProviderRoutes.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { ProviderRoutes } from "../../../src/server/routes/instance/provider"
import { createTestApp, testRequestJson } from "../../fixture/route-test"
import { createTestDir, setupTestLifecycle } from "../../fixture/test-runtime"

const app = createTestApp((app) => {
  const routes = ProviderRoutes()
  app.route("/provider", routes)
})

describe("ProviderRoutes", () => {
  setupTestLifecycle()

  test("GET /provider returns providers", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status, body } = await testRequestJson<{ all: unknown[]; default: unknown; connected: string[] }>(
            app,
            "GET",
            "/provider",
          )
          expect(status).toBe(200)
          expect(Array.isArray(body.all)).toBe(true)
          expect(typeof body.default).toBe("object")
          expect(Array.isArray(body.connected)).toBe(true)
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("GET /provider/auth returns auth methods", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status, body } = await testRequestJson<Record<string, unknown>>(app, "GET", "/provider/auth")
          expect(status).toBe(200)
          expect(typeof body).toBe("object")
          expect(body).toBeDefined()
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("POST /provider/:id/oauth/authorize with invalid provider returns 400", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status } = await testRequestJson(app, "POST", "/provider/bogus/oauth/authorize", {
            method: "none",
            inputs: {},
          })
          expect(status).toBe(400)
        },
      })
    } finally {
      await td.dispose()
    }
  })
})
