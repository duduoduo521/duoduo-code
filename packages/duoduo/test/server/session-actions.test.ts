import { afterEach, describe, expect, mock, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { SessionRoutes } from "../../src/server/routes/instance/session"
import { Session as SessionNs } from "../../src/session"
import type { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util"
import { createTestApp } from "../fixture/route-test"
import { tmpdir } from "../fixture/fixture"
import { disposeAllWithTimeout } from "../lib/dispose"

void Log.init({ print: false })

const app = createTestApp((app) => {
  app.route("/session", SessionRoutes())
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
  mock.restore()
  await disposeAllWithTimeout()
})

describe("session action routes", () => {
  test("abort route returns success", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})

        const res = await app.request(`/session/${session.id}/abort`, { method: "POST" })

        expect(res.status).toBe(200)
        expect(await res.json()).toBe(true)

        await svc.remove(session.id)
      },
    })
  })
})
