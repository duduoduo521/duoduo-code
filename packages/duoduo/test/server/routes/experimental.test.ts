/**
 * Integration tests for ExperimentalRoutes.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { ExperimentalRoutes } from "../../../src/server/routes/instance/experimental"
import { createTestApp, testRequestJson } from "../../fixture/route-test"
import { createTestDir, setupTestLifecycle } from "../../fixture/test-runtime"

const app = createTestApp((app) => {
  const routes = ExperimentalRoutes()
  app.route("/experimental", routes)
})

describe("ExperimentalRoutes", () => {
  setupTestLifecycle()

  describe("GET /experimental/tool/ids", () => {
    test("returns list of tool IDs", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status, body } = await testRequestJson<string[]>(app, "GET", "/experimental/tool/ids")
            expect(status).toBe(200)
            expect(Array.isArray(body)).toBe(true)
          },
        })
      } finally {
        await td.dispose()
      }
    })
  })

  describe("GET /experimental/tool", () => {
    test("returns 400 when query params are missing", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status } = await testRequestJson(app, "GET", "/experimental/tool")
            expect(status).toBe(400)
          },
        })
      } finally {
        await td.dispose()
      }
    })

    test("returns 200 when provider/model are empty (z.string() accepts empty)", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            // Empty strings pass z.string() validation, so this returns 200
            const { status } = await testRequestJson(app, "GET", "/experimental/tool?provider=&model=")
            expect(status).toBe(200)
          },
        })
      } finally {
        await td.dispose()
      }
    })
  })

  describe("GET /experimental/session", () => {
    test("returns list of sessions", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status, body } = await testRequestJson<unknown[]>(app, "GET", "/experimental/session")
            expect(status).toBe(200)
            expect(Array.isArray(body)).toBe(true)
          },
        })
      } finally {
        await td.dispose()
      }
    })
  })

  describe("GET /experimental/resource", () => {
    test("returns MCP resources", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status, body } = await testRequestJson<Record<string, unknown>>(
              app,
              "GET",
              "/experimental/resource",
            )
            expect(status).toBe(200)
            expect(typeof body).toBe("object")
          },
        })
      } finally {
        await td.dispose()
      }
    })
  })

  describe("GET /experimental/worktree", () => {
    test("returns list of sandbox worktrees", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status, body } = await testRequestJson<string[]>(app, "GET", "/experimental/worktree")
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
