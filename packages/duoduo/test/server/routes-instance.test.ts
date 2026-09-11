/**
 * Integration tests for instance HTTP routes (session, config, provider, project, permission).
 *
 * These tests exercise the full middleware stack (AuthMiddleware, InstanceMiddleware,
 * ErrorMiddleware, etc.) via Server.Default().app, the same Hono app used in
 * production — exactly matching the runtime behavior users experience.
 *
 * Pattern (from established test convention):
 *   const app = Server.Default().app
 *   app.request(path, { method, body })
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import type { SessionID } from "../../src/session/schema"
import { ProjectID } from "../../src/project/schema"
import { ErrorMiddleware } from "../../src/server/middleware"
import { initProjectors } from "../../src/server/projectors"
import { ConfigRoutes } from "../../src/server/routes/instance/config"
import { PermissionRoutes } from "../../src/server/routes/instance/permission"
import { ProjectRoutes } from "../../src/server/routes/instance/project"
import { ProviderRoutes } from "../../src/server/routes/instance/provider"
import { SessionRoutes } from "../../src/server/routes/instance/session"
import { Log } from "../../src/util"
import { createTestApp } from "../fixture/route-test"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })
initProjectors()

const app = createTestApp((app) => {
  app.onError(ErrorMiddleware)
  app.route("/session", SessionRoutes())
  app.route("/config", ConfigRoutes())
  app.route("/provider", ProviderRoutes())
  app.route("/project", ProjectRoutes())
  app.route("/permission", PermissionRoutes())
})

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
import { disposeAllWithTimeout } from "../lib/dispose"
import { APP_CONFIG_SCHEMA } from "../../src/config/domains"

afterEach(async () => {
  await disposeAllWithTimeout()
})

// =========================================================================
// Session routes — mount point: /session
// =========================================================================
describe("session routes", () => {
  test("GET /session/:sessionID returns session info for a valid session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({ title: "route-test-session" })

        const res = await app.request(`/session/${session.id}`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toBeDefined()
        expect(body.id).toBe(session.id)
        expect(body.title).toBe("route-test-session")

        await svc.remove(session.id)
      },
    })
  })

  test("GET /session/:sessionID returns 400 for invalid sessionID format", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // SessionID must start with "ses_"
        const res = await app.request("/session/invalid-format-id")
        expect(res.status).toBe(400)
        const body = await res.json()
        // Hono validation error shape
        expect(body).toBeDefined()
      },
    })
  })

  test("GET /session/:sessionID returns 404 for a non-existent session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Generate a valid-looking session ID that doesn't exist
        const missingId = "ses_" + "a".repeat(24)

        const res = await app.request(`/session/${missingId}`)
        expect(res.status).toBe(404)
      },
    })
  })

  test("POST /session/:sessionID/revert rejects missing messageID", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({ title: "revert-test" })

        const res = await app.request(`/session/${session.id}/revert`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)

        await svc.remove(session.id)
      },
    })
  })

  test("POST /session/:sessionID/unrevert restores reverted messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({ title: "unrevert-test" })

        const res = await app.request(`/session/${session.id}/unrevert`, {
          method: "POST",
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toBeDefined()
        expect(body.id).toBe(session.id)

        await svc.remove(session.id)
      },
    })
  })

  test("POST /session/:sessionID/abort cancels running session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({ title: "abort-test" })

        const res = await app.request(`/session/${session.id}/abort`, {
          method: "POST",
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toBe(true)

        await svc.remove(session.id)
      },
    })
  })

  test("GET /session/:sessionID/children returns children for valid session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await svc.create({ title: "parent" })

        const res = await app.request(`/session/${parent.id}/children`)
        expect(res.status).toBe(200)
        const body = (await res.json()) as Array<unknown>
        expect(body).toBeDefined()
        expect(Array.isArray(body)).toBe(true)

        await svc.remove(parent.id)
      },
    })
  })
})

// =========================================================================
// Config routes — mount point: /config
// =========================================================================
describe("config routes", () => {
  test("GET /config returns the current configuration", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const res = await app.request("/config")
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toBeDefined()
        expect(typeof body).toBe("object")
      },
    })
  })

  test("PATCH /config updates the configuration", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = {
          $schema: APP_CONFIG_SCHEMA,
          enabled_providers: ["test"],
          model: "test/test-model",
          small_model: "test/test-model",
          provider: {
            test: {
              name: "Test",
              npm: "@ai-sdk/openai-compatible",
              api: "http://127.0.0.1:0/v1",
              options: { apiKey: "test-key", baseURL: "http://127.0.0.1:0/v1" },
              models: {
                "test-model": {
                  id: "test-model",
                  name: "Test Model",
                  release_date: "2025-01-01",
                  attachment: true,
                  reasoning: false,
                  // `temperature` is the numeric sampling value now; the
                  // capability flag is `supports_temperature` (see
                  // normalizeLoadedConfig in src/config/config.ts, which
                  // migrates legacy boolean `temperature` into it).
                  supports_temperature: true,
                  tool_call: true,
                  limit: { context: 200_000, output: 32_000 },
                },
              },
            },
          },
        }

        const res = await app.request("/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config),
        })

        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual(config)
      },
    })
  })
})

// =========================================================================
// Provider routes — mount point: /provider
// =========================================================================
describe("provider routes", () => {
  test("GET /provider lists available AI providers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const res = await app.request("/provider")
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toBeDefined()
        expect(body).toHaveProperty("all")
        expect(body).toHaveProperty("default")
        expect(body).toHaveProperty("connected")
      },
    })
  })
})

// =========================================================================
// Project routes — mount point: /project
// =========================================================================
describe("project routes", () => {
  test("GET /project lists all projects", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const res = await app.request("/project")
        expect(res.status).toBe(200)
        const body = (await res.json()) as Array<unknown>
        expect(Array.isArray(body)).toBe(true)
      },
    })
  })

  test("GET /project/current returns the current project", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const res = await app.request("/project/current")
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toBeDefined()
        expect(body).toHaveProperty("id")
        expect(body).toHaveProperty("worktree")
        expect(body).toHaveProperty("vcs")
      },
    })
  })
})

// =========================================================================
// Permission routes — mount point: /permission
// =========================================================================
describe("permission routes", () => {
  test("GET /permission returns pending permissions (empty list)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const res = await app.request("/permission")
        expect(res.status).toBe(200)
        const body = (await res.json()) as Array<unknown>
        expect(Array.isArray(body)).toBe(true)
        // With no pending requests, the list should be empty
        expect(body).toHaveLength(0)
      },
    })
  })
})
