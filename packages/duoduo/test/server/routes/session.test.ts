/**
 * Integration tests for SessionRoutes.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { SessionRoutes } from "../../../src/server/routes/instance/session"
import { createTestApp, testRequestJson } from "../../fixture/route-test"
import { createTestDir, setupTestLifecycle } from "../../fixture/test-runtime"

const app = createTestApp((app) => {
  const routes = SessionRoutes()
  app.route("/session", routes)
})

describe("SessionRoutes", () => {
  setupTestLifecycle()

  test("GET /session returns empty list", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status, body } = await testRequestJson<unknown[]>(app, "GET", "/session")
          expect(status).toBe(200)
          expect(Array.isArray(body)).toBe(true)
          expect(body).toHaveLength(0)
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("GET /session with directory filter still returns 200", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status, body } = await testRequestJson<unknown[]>(
            app,
            "GET",
            `/session?directory=${encodeURIComponent(td.path)}`,
          )
          expect(status).toBe(200)
          expect(Array.isArray(body)).toBe(true)
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("POST /session with empty body creates session", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status, body } = await testRequestJson<Record<string, unknown>>(app, "POST", "/session", {})
          expect(status).toBe(200)
          expect(typeof body).toBe("object")
          expect(body).toHaveProperty("id")
          expect(body).toHaveProperty("title")
        },
      })
    } finally {
      await td.dispose()
    }
  })
})
