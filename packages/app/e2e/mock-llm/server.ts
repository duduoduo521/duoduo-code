/**
 * Mock LLM server for e2e testing.
 *
 * Listens on `127.0.0.1:4097` by default, exposes an OpenAI-compatible
 * `/v1/chat/completions` endpoint that streams a fixture file from
 * `./fixtures/<model>.sse`, where `<model>` is extracted from the
 * request body's `model` field. The IDE's mock provider is configured
 * to send a model id matching the scenario fixture (e.g.
 * `success-text-short`, `error-401-html-gateway`).
 *
 * Fixture file directives (lines starting with `#`):
 *   `# status: NNN`        — HTTP status code (default 200)
 *   `# content-type: TYPE` — Content-Type header (default text/event-stream)
 *   `# delay-ms: N`        — milliseconds delay between SSE events (default 0)
 *   `# truncate-after: N`  — destroy socket after N data lines without [DONE]
 *
 * All other `#` lines (comments) are stripped from the response.
 *
 * Placeholder substitution (applied to the fixture body before serving):
 *   `{{EXTERNAL_PATH}}`    — an absolute path OUTSIDE the e2e project
 *                            directory on the CURRENT platform (Windows:
 *                            `C:/Windows/System32/drivers/etc/hosts`;
 *                            POSIX: `/etc/hosts`). A path hardcoded for one
 *                            platform is relative on the others (e.g.
 *                            `C:/...` resolves INSIDE the project on
 *                            Linux/macOS), which silently breaks specs that
 *                            depend on the external-directory permission ask.
 *
 * IMPLEMENTATION NOTE (2026-09-17): this server intentionally does NOT use
 * the `fetch`-style `Request`/`Response`/`ReadableStream` abstraction. The
 * previous implementation built a `Response` around a `ReadableStream` and
 * pumped it via `res.body.getReader()` — under the Bun runtime the first
 * `reader.next()` NEVER resolves (Bun Response/ReadableStream interop bug),
 * so every chat-completions request hung until the client timed out. Plain
 * `node:http` (writeHead + sequential `res.write`) works identically under
 * BOTH Bun and Node, which is required because the harness starts this
 * server under Bun while Playwright spec `beforeAll` hooks import it under
 * Node.
 */
import { existsSync, readFileSync } from "node:fs"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = resolve(__dirname, "fixtures")

interface FixturePlan {
  status: number
  contentType: string
  delayMs: number
  truncateAfter: number | null
  body: string
}

function parseFixture(text: string): FixturePlan {
  // Normalize CRLF → LF: fixtures checked out with core.autocrlf or written
  // on Windows carry \r\n, which would otherwise (a) break the `# directive`
  // regex via a trailing \r and (b) glue all SSE events into one because the
  // event splitter matches "\n\n" only.
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const plan: FixturePlan = {
    status: 200,
    contentType: "text/event-stream",
    delayMs: 0,
    truncateAfter: null,
    body: "",
  }
  const bodyLines: string[] = []
  for (const line of lines) {
    const m = line.match(/^#\s*(status|content-type|delay-ms|truncate-after):\s*(.+?)\s*$/i)
    if (m) {
      const key = m[1].toLowerCase()
      const value = m[2]
      if (key === "status") plan.status = Number(value)
      else if (key === "content-type") plan.contentType = value
      else if (key === "delay-ms") plan.delayMs = Number(value)
      else if (key === "truncate-after") plan.truncateAfter = Number(value)
      continue
    }
    if (line.startsWith("#")) continue
    bodyLines.push(line)
  }
  plan.body = bodyLines.join("\n")
  return plan
}

async function extractScenario(req: IncomingMessage, rawBody: Buffer): Promise<string> {
  const url = new URL(req.url ?? "/", "http://mock.local")
  // Path-based override: /v1/chat/completions/<scenario>
  const tail = url.pathname.replace(/^\/v1\/chat\/completions\/?/, "")
  if (tail) return tail
  // Body-based: model field
  if (rawBody.length > 0) {
    try {
      const body = JSON.parse(rawBody.toString("utf8")) as { model?: string }
      if (body.model) return body.model
    } catch {
      // ignore
    }
  }
  return "success-text-short"
}

/**
 * Stream the fixture for `scenario` directly onto the node response.
 *
 * Non-streaming fixtures (errors, plain text/HTML/JSON bodies) are written
 * in one shot. Streaming fixtures write SSE events sequentially with the
 * optional per-event delay; `truncate-after` destroys the socket mid-stream
 * to simulate a dropped connection.
 */
/** Platform-appropriate absolute path outside any e2e project directory. */
function externalPath(): string {
  return process.platform === "win32" ? "C:/Windows/System32/drivers/etc/hosts" : "/etc/hosts"
}

async function serveFixture(scenario: string, nodeRes: ServerResponse): Promise<void> {
  const fixturePath = resolve(FIXTURES_DIR, `${scenario}.sse`)
  if (!existsSync(fixturePath)) {
    nodeRes.writeHead(404, { "content-type": "text/plain" })
    nodeRes.end(`fixture not found: ${scenario}`)
    return
  }

  const plan = parseFixture(readFileSync(fixturePath, "utf8"))
  plan.body = plan.body.replaceAll("{{EXTERNAL_PATH}}", externalPath())

  // Non-streaming responses (errors, plain text/HTML/JSON bodies)
  if (!plan.contentType.startsWith("text/event-stream")) {
    nodeRes.writeHead(plan.status, { "content-type": plan.contentType })
    nodeRes.end(plan.body)
    return
  }

  // Streaming SSE responses with optional delay/truncation
  const events = plan.body
    .split(/\r?\n\r?\n/)
    .map((e) => e.replace(/\r/g, ""))
    .filter((e) => e.trim().length > 0)
  nodeRes.writeHead(plan.status, {
    "content-type": plan.contentType,
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  })

  let dataCount = 0
  for (const evt of events) {
    if (evt.startsWith("data:")) dataCount++
    nodeRes.write(evt + "\n\n")
    if (plan.truncateAfter !== null && dataCount >= plan.truncateAfter) {
      // Simulated mid-stream truncation: destroy the socket without [DONE].
      nodeRes.destroy()
      return
    }
    if (plan.delayMs > 0) await new Promise((r) => setTimeout(r, plan.delayMs))
  }
  nodeRes.end()
}

export interface MockLLMCall {
  /** The scenario/fixture that served this request (model or path override). */
  scenario: string
  /** The model id from the request body, if any. */
  model: string | null
  /** Number of tool_calls present in the (last) assistant message of this request. */
  toolCallCount: number
  /** Names of the tools the LLM asked to invoke, if any. */
  tools: string[]
  /** Epoch ms when the request was received. */
  at: number
}

export interface MockLLMServer {
  port: number
  url: string
  stop: () => Promise<void>
  /**
   * Recorded `/v1/chat/completions` calls. Primarily used by run-loop tests
   * to assert the agentic loop actually drove the LLM across multiple steps
   * (and invoked tools) rather than finishing after a single round-trip.
   */
  calls: MockLLMCall[]
}

/**
 * Count tool_calls requested across assistant messages in a chat completion
 * request body. Mirrors how the real provider adapter would surface them.
 */
function countToolCalls(body: { messages?: Array<Record<string, unknown>> }): { count: number; tools: string[] } {
  let count = 0
  const tools: string[] = []
  for (const m of body.messages ?? []) {
    const tcs = m.tool_calls
    if (Array.isArray(tcs)) {
      for (const tc of tcs) {
        const fn = (tc as { function?: { name?: string } }).function
        if (fn?.name) {
          count++
          tools.push(fn.name)
        }
      }
    }
  }
  return { count, tools }
}

export async function startMockLLM(port = 4097): Promise<MockLLMServer> {
  const calls: MockLLMCall[] = []

  const server: Server = createServer((nodeReq, nodeRes) => {
    const chunks: Buffer[] = []
    nodeReq.on("data", (c: Buffer) => chunks.push(c))
    nodeReq.on("error", () => {})
    nodeReq.on("end", async () => {
      const rawBody = Buffer.concat(chunks)
      try {
        const url = new URL(nodeReq.url ?? "/", "http://mock.local")

        // Health check
        if (url.pathname === "/health") {
          nodeRes.writeHead(200, { "content-type": "text/plain" })
          nodeRes.end("ok")
          return
        }

        // Debug: number of chat-completions calls recorded so far (used by
        // stop/interrupt specs to assert the agent loop actually cancelled).
        if (url.pathname === "/debug/calls") {
          nodeRes.writeHead(200, { "content-type": "application/json" })
          nodeRes.end(JSON.stringify({ count: calls.length }))
          return
        }

        // Models list (some clients probe this)
        if (url.pathname === "/v1/models") {
          const ids = ["success-text-short", "success-text-multi-chunk", "success-text-markdown"]
          nodeRes.writeHead(200, { "content-type": "application/json" })
          nodeRes.end(
            JSON.stringify({
              object: "list",
              data: ids.map((id) => ({ id, object: "model", created: 1700000000, owned_by: "mock" })),
            }),
          )
          return
        }

        // Chat completions
        if (url.pathname.startsWith("/v1/chat/completions")) {
          const scenario = await extractScenario(nodeReq, rawBody)
          let body: { model?: string; messages?: Array<Record<string, unknown>> } = {}
          if (rawBody.length > 0) {
            body = JSON.parse(rawBody.toString("utf8"))
          }
          const { count, tools } = countToolCalls(body)
          const round = calls.filter((c) => c.scenario === scenario).length
          calls.push({ scenario, model: body.model ?? null, toolCallCount: count, tools, at: Date.now() })
          // Tool-call fixtures answer EVERY round with the same tool call — a
          // static fixture cannot "conclude" like a real model would, so the
          // agentic loop would spin forever (observed: 2217 rounds until the
          // client timed out). From the SECOND round of a tool-call scenario
          // on, serve the plain-text fixture instead: round 1 exercises the
          // tool round-trip, later rounds let the loop finish naturally.
          const effScenario =
            scenario.startsWith("success-tool-") && round >= 1 ? "success-text-short" : scenario
          await serveFixture(effScenario, nodeRes)
          return
        }

        nodeRes.writeHead(404, { "content-type": "text/plain" })
        nodeRes.end("not found")
      } catch (err) {
        try {
          nodeRes.writeHead(500, { "content-type": "text/plain" })
          nodeRes.end(String(err))
        } catch {
          // socket already gone
        }
      }
    })
  })

  const listenPort = await new Promise<number>((resolvePort, rejectPort) => {
    server.once("error", rejectPort)
    server.listen(port, "127.0.0.1", () => {
      resolvePort((server.address() as { port: number }).port)
    })
  })

  return {
    port: listenPort,
    url: `http://127.0.0.1:${listenPort}`,
    calls,
    async stop() {
      await new Promise<void>((resolveStop) => server.close(() => resolveStop()))
    },
  }
}

// Allow running standalone for debugging: `bun run e2e/mock-llm/server.ts`
if (import.meta.main) {
  const s = await startMockLLM(Number(process.env.MOCK_LLM_PORT ?? 4097))
  // eslint-disable-next-line no-console
  console.log(`[mock-llm] listening on ${s.url}`)
}
