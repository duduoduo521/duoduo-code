import { Hono } from "hono"
import { getMimeType } from "hono/utils/mime"
import fs from "node:fs/promises"

// Web UI is always bundled at build time (script/build.ts generates duoduo-web-ui.gen.ts);
// there is no runtime fallback to a remote host.
// The artifact only exists after a production build, so resolution must stay
// LAZY: importing CLI command modules (serve/web/...) pulls this route in, and
// a top-level dynamic import would make module loading fail in dev/test where
// the artifact is absent. Resolution errors now surface only when a request
// is actually served.
const loadEmbeddedUI = () =>
  // @ts-expect-error - generated file at build time
  import("duoduo-web-ui.gen.ts").then((module) => module.default as Record<string, string>)
let embeddedUIPromise: Promise<Record<string, string>> | undefined
const embeddedUI = () => (embeddedUIPromise ??= loadEmbeddedUI())

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:"

export const UIRoutes = (): Hono =>
  new Hono().all("/*", async (c) => {
    const embeddedWebUI = await embeddedUI()
    const path = c.req.path

    const match = embeddedWebUI[path.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
    if (!match) return c.json({ error: "Not Found" }, 404)

    if (await fs.exists(match)) {
      const mime = getMimeType(match) ?? "text/plain"
      c.header("Content-Type", mime)
      if (mime.startsWith("text/html")) {
        c.header("Content-Security-Policy", DEFAULT_CSP)
      }
      return c.body(new Uint8Array(await fs.readFile(match)))
    } else {
      return c.json({ error: "Not Found" }, 404)
    }
  })
