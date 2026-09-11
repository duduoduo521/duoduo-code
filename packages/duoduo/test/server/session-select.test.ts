import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Session as SessionNs } from "../../src/session"
import type { SessionID } from "../../src/session/schema"
import { ErrorMiddleware } from "../../src/server/middleware"
import { Log } from "../../src/util"
import { Instance } from "../../src/project/instance"
import { TuiRoutes } from "../../src/server/routes/instance/tui"
import { createTestApp } from "../fixture/route-test"
import { tmpdir } from "../fixture/fixture"
import { disposeAllWithTimeout } from "../lib/dispose"

void Log.init({ print: false })

const app = createTestApp((app) => {
  app.onError(ErrorMiddleware)
  app.route("/tui", TuiRoutes())
})

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  remove(id: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
}

afterEach(async () => {
  await disposeAllWithTimeout()
})

describe("tui.selectSession endpoint", () => {
  test("should return 200 when called with valid session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})

        const response = await app.request("/tui/select-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toBe(true)

        await svc.remove(session.id)
      },
    })
  })

  test("should return 404 when session does not exist", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const nonExistentSessionID = "ses_nonexistent123"

        const response = await app.request("/tui/select-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: nonExistentSessionID }),
        })

        expect(response.status).toBe(404)
      },
    })
  })

  test("should return 400 when session ID format is invalid", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const invalidSessionID = "invalid_session_id"

        const response = await app.request("/tui/select-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: invalidSessionID }),
        })

        expect(response.status).toBe(400)
      },
    })
  })
})
