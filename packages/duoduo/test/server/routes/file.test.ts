/**
 * Integration tests for FileRoutes.
 */
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Instance } from "../../../src/project/instance"
import { FileRoutes } from "../../../src/server/routes/instance/file"
import { createTestApp, testRequest, testRequestJson } from "../../fixture/route-test"
import { createTestDir, setupTestLifecycle } from "../../fixture/test-runtime"

const app = createTestApp((app) => {
  const routes = FileRoutes()
  app.route("/files", routes)
})

describe("FileRoutes", () => {
  setupTestLifecycle()

  test("GET /files/file/status returns file status", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status, body } = await testRequestJson<unknown[]>(app, "GET", "/files/file/status")
          expect(status).toBe(200)
          expect(Array.isArray(body)).toBe(true)
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("GET /files/file requires path param", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status } = await testRequestJson(app, "GET", "/files/file")
          expect(status).toBe(400)
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("GET /files/find requires pattern param", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status } = await testRequestJson(app, "GET", "/files/find")
          expect(status).toBe(400)
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("POST /files/file/mkdir creates real empty nested directories", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status, body } = await testRequestJson<{ success: boolean; created: boolean }>(
            app,
            "POST",
            "/files/file/mkdir",
            { path: "a/b/c" },
          )
          expect(status).toBe(200)
          expect(body.success).toBe(true)
          expect(body.created).toBe(true)
          // A real empty directory — no .gitkeep placeholder inside.
          expect(fs.existsSync(path.join(td.path, "a", "b", "c"))).toBe(true)
          expect(fs.readdirSync(path.join(td.path, "a", "b", "c"))).toEqual([])

          // Idempotent: creating an existing directory reports created=false.
          const second = await testRequestJson<{ success: boolean; created: boolean }>(
            app,
            "POST",
            "/files/file/mkdir",
            { path: "a/b/c" },
          )
          expect(second.status).toBe(200)
          expect(second.body.success).toBe(true)
          expect(second.body.created).toBe(false)
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("POST /files/file/mkdir rejects a path that exists as a file", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          fs.writeFileSync(path.join(td.path, "occupied.txt"), "x")
          // HTTPException from the bare test app has no JSON body — assert status only.
          const res = await testRequest(app, "POST", "/files/file/mkdir", { path: "occupied.txt" })
          expect(res.status).toBe(409)
        },
      })
    } finally {
      await td.dispose()
    }
  })
})
