/**
 * Mock LLM server for e2e testing.
 *
 * Listens on `127.0.0.1:4097`, exposes an OpenAI-compatible
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
 *   `# truncate-after: N`  — close socket after N data lines without [DONE]
 *
 * All other `#` lines (comments) are stripped from the response.
 */
import { existsSync, readFileSync } from "node:fs"
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
  const lines = text.split("\n")
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

async function extractScenario(req: Request): Promise<string> {
  const url = new URL(req.url)
  // Path-based override: /v1/chat/completions/<scenario>
  const tail = url.pathname.replace(/^\/v1\/chat\/completions\/?/, "")
  if (tail) return tail
  // Body-based: model field
  if (req.body) {
    try {
      const body = (await req.clone().json()) as { model?: string }
      if (body.model) return body.model
    } catch {
      // ignore
    }
  }
  return "success-text-short"
}

async function buildResponse(scenario: string): Promise<Response> {
  const fixturePath = resolve(FIXTURES_DIR, `${scenario}.sse`)
  if (!existsSync(fixturePath)) {
    return new Response(`fixture not found: ${scenario}`, {
      status: 404,
      headers: { "content-type": "text/plain" },
    })
  }

  const text = readFileSync(fixturePath, "utf8")
  const plan = parseFixture(text)

  // Non-streaming responses (errors, plain text/HTML/JSON bodies)
  if (!plan.contentType.startsWith("text/event-stream")) {
    return new Response(plan.body, {
      status: plan.status,
      headers: { "content-type": plan.contentType },
    })
  }

  // Streaming SSE responses with optional delay/truncation
  const events = plan.body.split(/\n\n/).filter((e) => e.trim().length > 0)
  const truncateAfter = plan.truncateAfter
  const delayMs = plan.delayMs

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      let dataCount = 0
      try {
        for (const evt of events) {
          if (evt.startsWith("data:")) dataCount++
          controller.enqueue(encoder.encode(evt + "\n\n"))
          if (truncateAfter !== null && dataCount >= truncateAfter) {
            controller.error(new Error("simulated mid-stream truncation"))
            return
          }
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })

  return new Response(stream, {
    status: plan.status,
    headers: {
      "content-type": plan.contentType,
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  })
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
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)

      // Health check
      if (url.pathname === "/health") {
        return new Response("ok", { status: 200 })
      }

      // Models list (some clients probe this)
      if (url.pathname === "/v1/models") {
        const ids = ["success-text-short", "success-text-multi-chunk", "success-text-markdown"]
        return Response.json({
          object: "list",
          data: ids.map((id) => ({ id, object: "model", created: 1700000000, owned_by: "mock" })),
        })
      }

      // Chat completions
      if (url.pathname.startsWith("/v1/chat/completions")) {
        const scenario = await extractScenario(req)
        const body = await req.clone().json().catch(() => ({})) as { model?: string; messages?: Array<Record<string, unknown>> }
        const { count, tools } = countToolCalls(body)
        calls.push({ scenario, model: body.model ?? null, toolCallCount: count, tools, at: Date.now() })
        return buildResponse(scenario)
      }

      return new Response("not found", { status: 404 })
    },
  })

  return {
    port: server.port,
    url: `http://127.0.0.1:${server.port}`,
    calls,
    async stop() {
      await server.stop(true)
    },
  }
}

// Allow running standalone for debugging: `bun run e2e/mock-llm/server.ts`
if (import.meta.main) {
  const s = await startMockLLM(Number(process.env.MOCK_LLM_PORT ?? 4097))
  // eslint-disable-next-line no-console
  console.log(`[mock-llm] listening on ${s.url}`)
}
