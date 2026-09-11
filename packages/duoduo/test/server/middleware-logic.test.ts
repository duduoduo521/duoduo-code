import { describe, expect, mock, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { Hono } from "hono"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { APP_CORS_HOST } from "../../src/config/domains"
import { CompressionMiddleware, CorsMiddleware } from "../../src/server/middleware"

// ─── CORS origin matching ───
// Exercised through the real `CorsMiddleware` mounted on a Hono app, so the
// assertions cover the shipped middleware instead of a copy of its logic.

const corsApp = new Hono()
corsApp.use("*", CorsMiddleware({ cors: ["https://custom.example.com"] }))
corsApp.get("/", (c) => c.text("ok"))

async function allowOrigin(origin: string | undefined): Promise<string | null> {
  const res = await corsApp.request("/", {
    headers: origin ? { origin } : {},
  })
  return res.headers.get("access-control-allow-origin")
}

describe("ServerMiddleware.Cors.originLogic", () => {
  test("allows http://localhost with port", async () => {
    expect(await allowOrigin("http://localhost:3000")).toBe("http://localhost:3000")
    expect(await allowOrigin("http://localhost:8080")).toBe("http://localhost:8080")
  })

  test("rejects http://localhost without port", async () => {
    expect(await allowOrigin("http://localhost")).toBeNull()
  })

  test("allows http://127.0.0.1 with port", async () => {
    expect(await allowOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000")
  })

  test("allows the tauri origins", async () => {
    expect(await allowOrigin("tauri://localhost")).toBe("tauri://localhost")
    expect(await allowOrigin("http://tauri.localhost")).toBe("http://tauri.localhost")
    expect(await allowOrigin("https://tauri.localhost")).toBe("https://tauri.localhost")
  })

  test("allows APP_CORS_HOST subdomains", async () => {
    expect(await allowOrigin(`https://app.${APP_CORS_HOST}`)).toBe(`https://app.${APP_CORS_HOST}`)
    expect(await allowOrigin(`https://a.b.c.${APP_CORS_HOST}`)).toBe(`https://a.b.c.${APP_CORS_HOST}`)
  })

  test("allows APP_CORS_HOST root domain", async () => {
    // `^https:\/\/([a-z0-9-]+\.)*<host>$` matches the bare host because the
    // subdomain group can repeat zero times.
    expect(await allowOrigin(`https://${APP_CORS_HOST}`)).toBe(`https://${APP_CORS_HOST}`)
  })

  test("rejects unrelated https origins", async () => {
    expect(await allowOrigin("https://evil.example.com")).toBeNull()
  })

  test("rejects http origins that are not localhost", async () => {
    expect(await allowOrigin("http://example.com")).toBeNull()
  })

  test("allows custom CORS origins", async () => {
    expect(await allowOrigin("https://custom.example.com")).toBe("https://custom.example.com")
  })

  test("returns no CORS header when no origin is sent", async () => {
    expect(await allowOrigin(undefined)).toBeNull()
  })
})

// ─── Compression skip logic ───

// The body is served with an explicit Content-Type: hono's `compress()` only
// compresses a response whose type is compressible, and `c.text()` does not
// surface one through `app.request()` in this runtime.
const BODY = "x".repeat(4096)
const compressApp = new Hono()
compressApp.use("*", CompressionMiddleware)
compressApp.all("/*", (c) => {
  c.header("Content-Type", "text/plain; charset=UTF-8")
  c.header("Content-Length", String(BODY.length))
  return c.body(BODY)
})

async function contentEncoding(pathname: string, method: "GET" | "POST" = "GET"): Promise<string | null> {
  const res = await compressApp.request(pathname, {
    method,
    headers: { "accept-encoding": "gzip" },
  })
  return res.headers.get("content-encoding")
}

describe("ServerMiddleware.Compression.skipLogic", () => {
  test("skips /event", async () => {
    expect(await contentEncoding("/event")).toBeNull()
  })

  test("skips /global/event", async () => {
    expect(await contentEncoding("/global/event")).toBeNull()
  })

  test("skips POST /session/:id/message", async () => {
    expect(await contentEncoding("/session/abc123/message", "POST")).toBeNull()
  })

  test("skips POST /session/:id/prompt_async", async () => {
    expect(await contentEncoding("/session/ses_456/prompt_async", "POST")).toBeNull()
  })

  test("does NOT skip regular API paths", async () => {
    expect(await contentEncoding("/provider")).toBe("gzip")
    expect(await contentEncoding("/session")).toBe("gzip")
  })
})

// ─── Instance directory resolution ───
// The real `InstanceMiddleware` is driven with a minimal Hono context and its
// collaborators stubbed, so the precedence chain and the decode step are the
// production code paths.

const provided: string[] = []

mock.module("@/project/instance", () => ({
  Instance: {
    provide(opts: { directory: string; fn: () => Promise<Response> }) {
      provided.push(opts.directory)
      return opts.fn()
    },
  },
}))
mock.module("@/project/bootstrap", () => ({ InstanceBootstrap: {} }))
mock.module("@/effect/app-runtime", () => ({ AppRuntime: { runPromise: () => Promise.resolve(undefined) } }))
mock.module("@/control-plane/workspace-context", () => ({
  WorkspaceContext: {
    provide(opts: { fn: () => Promise<Response> }) {
      return opts.fn()
    },
  },
}))

const importInstanceMiddleware = () =>
  import(`../../src/server/routes/instance/middleware.ts?t=${Date.now()}-${Math.random()}`)

type Ctx = {
  query?: string
  header?: string
}

async function resolveDirectory(ctx: Ctx): Promise<string> {
  const { InstanceMiddleware } = await importInstanceMiddleware()
  provided.length = 0
  let nextCalled = false
  const c = {
    req: {
      query: (key: string) => (key === "directory" ? ctx.query : undefined),
      header: (key: string) => (key === "x-duoduo-directory" ? ctx.header : undefined),
    },
  }
  await (InstanceMiddleware() as any)(c, async () => {
    nextCalled = true
    return new Response("ok")
  })
  expect(nextCalled).toBe(true)
  return provided[0]!
}

describe("ServerMiddleware.Instance.directoryResolution", () => {
  test("uses the query directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "duoduo-mw-"))
    expect(await resolveDirectory({ query: dir })).toBe(AppFileSystem.resolve(dir))
  })

  test("falls back to the header directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "duoduo-mw-"))
    expect(await resolveDirectory({ header: dir })).toBe(AppFileSystem.resolve(dir))
  })

  test("query takes precedence over header", async () => {
    const query = await fs.mkdtemp(path.join(os.tmpdir(), "duoduo-mw-query-"))
    const header = await fs.mkdtemp(path.join(os.tmpdir(), "duoduo-mw-header-"))
    expect(await resolveDirectory({ query, header })).toBe(AppFileSystem.resolve(query))
  })

  test("DUO_FIXED_DIRECTORY takes precedence over query and header", async () => {
    const fixed = await fs.mkdtemp(path.join(os.tmpdir(), "duoduo-mw-fixed-"))
    const query = await fs.mkdtemp(path.join(os.tmpdir(), "duoduo-mw-query-"))
    const previous = process.env.DUO_FIXED_DIRECTORY
    process.env.DUO_FIXED_DIRECTORY = fixed
    try {
      expect(await resolveDirectory({ query })).toBe(AppFileSystem.resolve(fixed))
    } finally {
      if (previous === undefined) delete process.env.DUO_FIXED_DIRECTORY
      else process.env.DUO_FIXED_DIRECTORY = previous
    }
  })

  test("falls back to process.cwd() when nothing is supplied", async () => {
    expect(await resolveDirectory({})).toBe(AppFileSystem.resolve(process.cwd()))
  })

  test("decodes URI-encoded directory", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "duoduo-mw-"))
    const withSpace = path.join(base, "my project")
    await fs.mkdir(withSpace)
    expect(await resolveDirectory({ query: encodeURIComponent(withSpace) })).toBe(AppFileSystem.resolve(withSpace))
  })

  test("keeps a raw value when decoding throws (malformed percent-encoding)", async () => {
    const raw = "/path/with/%E0%A4%A"
    expect(await resolveDirectory({ query: raw })).toBe(AppFileSystem.resolve(raw))
  })
})
