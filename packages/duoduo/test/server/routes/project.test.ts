/**
 * Integration tests for ProjectRoutes.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { ProjectRoutes } from "../../../src/server/routes/instance/project"
import { createTestApp, testRequestJson } from "../../fixture/route-test"
import { createTestDir, setupTestLifecycle } from "../../fixture/test-runtime"

const app = createTestApp((app) => {
  const routes = ProjectRoutes()
  app.route("/project", routes)
})

describe("ProjectRoutes", () => {
  setupTestLifecycle()

  test("GET /project returns project list", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status, body } = await testRequestJson<unknown[]>(app, "GET", "/project")
          expect(status).toBe(200)
          expect(Array.isArray(body)).toBe(true)
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("GET /project/current returns current project info", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status, body } = await testRequestJson<Record<string, unknown>>(app, "GET", "/project/current")
          expect(status).toBe(200)
          expect(typeof body).toBe("object")
          expect(body).toBeDefined()
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("PATCH /project/:id with invalid body type returns 400", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          // String body fails JSON validator (expects object)
          const { status } = await testRequestJson(app, "PATCH", "/project/global", "invalid")
          expect(status).toBe(400)
        },
      })
    } finally {
      await td.dispose()
    }
  })
})
