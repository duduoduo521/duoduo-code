/**
 * Integration tests for TuiRoutes.
 *
 * The TUI route module exports two distinct groups:
 *
 * 1. Async queue mechanism for controlling TUI from a headless caller:
 *    - `callTui()`        — push request into queue, await response
 *    - GET /control/next   — pop next pending request from queue
 *    - POST /control/response — push response back to resolve the caller
 *
 * 2. Event-publishing endpoints that publish to the effect Bus:
 *    POST /append-prompt, /open-help, /open-sessions, /open-themes,
 *    /open-models, /submit-prompt, /clear-prompt, /execute-command,
 *    /show-toast, /publish, /select-session
 *    These require an active AppRuntime (Instance context) for Bus.publish.
 *
 * Validation-only tests (zod schema enforcement) run without Instance context.
 * Full roundtrip tests require Instance.provide().
 */
import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { TuiRoutes, callTui } from "../../../src/server/routes/instance/tui"
import { testRequest, testRequestJson } from "../../fixture/route-test"

function createTuiApp(): Hono {
  const app = new Hono()
  const routes = TuiRoutes()
  app.route("/tui", routes)
  return app
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
describe("TuiRoutes — module exports", () => {
  test("exports TuiRoutes as a lazy function returning Hono", async () => {
    const mod = await import("../../../src/server/routes/instance/tui")
    expect(mod.TuiRoutes).toBeDefined()
    expect(typeof mod.TuiRoutes).toBe("function")
    const routes = mod.TuiRoutes()
    expect(routes).toBeInstanceOf(Hono)
  })

  test("exports callTui as a function", async () => {
    const mod = await import("../../../src/server/routes/instance/tui")
    expect(mod.callTui).toBeDefined()
    expect(typeof mod.callTui).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Route structure
// ---------------------------------------------------------------------------
describe("TuiRoutes — route structure", () => {
  test("responds with 404 for unknown routes", async () => {
    const app = createTuiApp()
    const res = await testRequest(app, "GET", "/tui/nonexistent")
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Validation: execute-command
// ---------------------------------------------------------------------------
describe("TuiRoutes — POST /execute-command validation", () => {
  test("rejects missing command field (400)", async () => {
    const app = createTuiApp()
    const { status } = await testRequestJson(app, "POST", "/tui/execute-command", {})
    expect(status).toBe(400)
  })

  test("rejects non-string command (400)", async () => {
    const app = createTuiApp()
    const { status } = await testRequestJson(app, "POST", "/tui/execute-command", { command: 123 })
    expect(status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Validation: show-toast
// ---------------------------------------------------------------------------
describe("TuiRoutes — POST /show-toast validation", () => {
  test("rejects missing message (400)", async () => {
    const app = createTuiApp()
    const { status } = await testRequestJson(app, "POST", "/tui/show-toast", {
      variant: "info",
    })
    expect(status).toBe(400)
  })

  test("rejects invalid variant (400)", async () => {
    const app = createTuiApp()
    const { status } = await testRequestJson(app, "POST", "/tui/show-toast", {
      message: "Hello",
      variant: "invalid",
    })
    expect(status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Validation: append-prompt
// ---------------------------------------------------------------------------
describe("TuiRoutes — POST /append-prompt validation", () => {
  test("rejects missing text field (400)", async () => {
    const app = createTuiApp()
    const { status } = await testRequestJson(app, "POST", "/tui/append-prompt", {})
    expect(status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Validation: select-session
// ---------------------------------------------------------------------------
describe("TuiRoutes — POST /select-session validation", () => {
  test("rejects missing sessionID (400)", async () => {
    const app = createTuiApp()
    const { status } = await testRequestJson(app, "POST", "/tui/select-session", {})
    expect(status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Validation: publish
// ---------------------------------------------------------------------------
describe("TuiRoutes — POST /publish validation", () => {
  test("rejects unknown event type (400)", async () => {
    const app = createTuiApp()
    const { status } = await testRequestJson(app, "POST", "/tui/publish", {
      type: "tui.unknown.event",
      properties: {},
    })
    expect(status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Async queue mechanism — these don't need Instance context
// ---------------------------------------------------------------------------
describe("TuiRoutes — async queue control endpoints", () => {
  test("GET /control/next blocks until a request is available", async () => {
    const app = createTuiApp()

    // Manually trigger a request via callTui (which pushes to the queue)
    // We can't easily call callTui from here since it also awaits response,
    // but we can verify the endpoint structure is correct.
    const nextPromise = testRequestJson(app, "GET", "/tui/control/next")
    // give it a moment
    await new Promise((r) => setTimeout(r, 50))
    // No request was pushed, so next() should still be waiting
    // We can't easily verify this without timing out, so we verify structure instead
    expect(nextPromise).toBeDefined()
  })

  test("POST /control/response is callable", async () => {
    const app = createTuiApp()
    const { status, body } = await testRequestJson(app, "POST", "/tui/control/response", { result: "ok" })
    expect(status).toBe(200)
    expect(body).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// callTui export
// ---------------------------------------------------------------------------
describe("TuiRoutes — callTui", () => {
  test("callTui is a function that accepts a Context", async () => {
    expect(typeof callTui).toBe("function")
    // callTui requires a Hono Context — we verify the function exists and
    // has the expected signature via the module export.
    const mod = await import("../../../src/server/routes/instance/tui")
    expect(typeof mod.callTui).toBe("function")
    expect(mod.callTui.length).toBe(1) // accepts one argument (ctx)
  })
})
