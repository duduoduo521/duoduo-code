/**
 * Integration tests for QuestionRoutes.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { QuestionRoutes } from "../../../src/server/routes/instance/question"
import { createTestApp, testRequestJson } from "../../fixture/route-test"
import { createTestDir, setupTestLifecycle } from "../../fixture/test-runtime"

const app = createTestApp((app) => {
  const routes = QuestionRoutes()
  app.route("/question", routes)
})

describe("QuestionRoutes", () => {
  setupTestLifecycle()

  test("GET /question returns questions", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status, body } = await testRequestJson<unknown[]>(app, "GET", "/question")
          expect(status).toBe(200)
          expect(Array.isArray(body)).toBe(true)
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("POST /question/:id/reply with invalid requestID returns 400", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status } = await testRequestJson(app, "POST", "/question/bogus/reply", {
            answers: [],
          })
          expect(status).toBe(400)
        },
      })
    } finally {
      await td.dispose()
    }
  })

  test("POST /question/:id/reject with invalid requestID returns 400", async () => {
    const td = await createTestDir()
    try {
      await Instance.provide({
        directory: td.path,
        fn: async () => {
          const { status } = await testRequestJson(app, "POST", "/question/bogus/reject")
          expect(status).toBe(400)
        },
      })
    } finally {
      await td.dispose()
    }
  })
})
