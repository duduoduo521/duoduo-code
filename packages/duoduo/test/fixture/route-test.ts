/**
 * Integration test helpers for server route testing.
 *
 * Creates a Hono app registered with the given route module and makes
 * HTTP requests through it.  Relies on the shared AppRuntime singleton
 * (via `jsonRequest` → `AppRuntime.runPromise`) so layer builds are
 * cached across tests.
 */
import { Hono } from "hono"
import { AppRuntime } from "../../src/effect/app-runtime"

export function createTestApp(register: (app: Hono) => void): Hono {
  const app = new Hono()
  register(app)
  return app
}

export async function testRequest(app: Hono, method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  return app.fetch(req)
}

export async function testRequestJson<T = unknown>(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await testRequest(app, method, path, body)
  const json = await res.json()
  return { status: res.status, body: json as T }
}
