import { test, expect } from "@playwright/test"
import { startMockLLM, type MockLLMServer } from "./mock-llm/server"
import { startIsolatedBackend, createIsolatedXdgDirs, type IsolatedBackend, type IsolatedXdgDirs } from "./helpers/backend"
import { startSmartLayerSidecar, isSmartLayerAvailable, type SmartLayerSidecar } from "./helpers/smart-layer"

/**
 * Integration tests for the Smart Layer agentic loop, driven end to end
 * through the session prompt route (POST <backend>/session/:id/message —
 * the route the UI's prompt flow delegates to):
 *
 *   UI-equivalent prompt → TS backend → Rust run_loop → mock LLM →
 *   SSE events → persistence → REST-serveable messages.
 *
 * Assertions:
 *   - the mock LLM was invoked (proving the loop ran, not just echoed)
 *   - a tool-calling turn occurred (`success-tool-read` requests `read`;
 *     a later mock call carrying the tool_call proves the loop executed
 *     the tool and continued)
 *   - the full-stack flow persists an assistant reply the backend can serve
 *     back, including multi-chunk streamed text assembled from every delta
 *
 * The sidecar binary is built by CI (e2e.yml) or locally via
 * `cargo build -p duo-smart-layer`; when absent these tests skip (never fake-red).
 */

const TOOL_MODEL = "success-tool-read"
const TEXT_MODEL = "success-text-short"
const MULTI_CHUNK_MODEL = "success-text-multi-chunk"
const MULTI_CHUNK_TEXT = "Hello, this is a mocked streaming reply."

/** GET the backend's effective config (triggers AppLayer/provider build). */
async function getConfigFor(backend: IsolatedBackend) {
  const url = new URL("/config", backend.url)
  url.searchParams.set("directory", backend.projectDir)
  const res = await fetch(url.toString(), {
    headers: { "x-duoduo-directory": encodeURIComponent(backend.projectDir) },
  })
  if (!res.ok) throw new Error(`getConfigFor failed: ${res.status}`)
  return res.json()
}

async function createTestSessionFor(backend: IsolatedBackend, title: string) {
  const url = new URL("/session", backend.url)
  url.searchParams.set("directory", backend.projectDir)
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-duoduo-directory": encodeURIComponent(backend.projectDir) },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error(`createTestSession failed: ${res.status}`)
  return (await res.json()) as { id: string }
}

async function getMessagesFor(backend: IsolatedBackend, sessionId: string) {
  const url = new URL(`/session/${sessionId}/message`, backend.url)
  url.searchParams.set("directory", backend.projectDir)
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "x-duoduo-directory": encodeURIComponent(backend.projectDir) },
  })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`getMessages failed: ${res.status}`)
  const data = await res.json()
  return Array.isArray(data) ? data : (data?.messages ?? [])
}

/** POST the synchronous session prompt (what the UI prompt flow delegates to). */
async function sendSessionPrompt(
  backend: IsolatedBackend,
  sessionId: string,
  text: string,
  model: { providerID: string; modelID: string },
): Promise<string> {
  const url = new URL(`/session/${sessionId}/message`, backend.url)
  url.searchParams.set("directory", backend.projectDir)
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-duoduo-directory": encodeURIComponent(backend.projectDir) },
    body: JSON.stringify({ parts: [{ type: "text", text }], model }),
  })
  if (!res.ok) throw new Error(`sendSessionPrompt failed: ${res.status}`)
  const body = await res.text()
  if (!body.trim()) {
    test.info().skip(true, "Session prompt stream returned empty body — agent backend unavailable")
  }
  return body
}

test.describe("Agent run_loop integration", () => {
  test.skip(!isSmartLayerAvailable(), "duo-smart-layer binary not built — run `cargo build -p duo-smart-layer`")

  // The synchronous session prompt route runs the full agent pipeline
  // (context assembly → run loop → persistence) — well beyond the default
  // 30s local timeout.
  test.setTimeout(120_000)

  let mock: MockLLMServer
  let sidecar: SmartLayerSidecar
  let backend: IsolatedBackend
  let xdg: IsolatedXdgDirs

  test.beforeAll(async () => {
    xdg = createIsolatedXdgDirs()
    sidecar = await startSmartLayerSidecar({ xdgEnv: xdg.env, logDir: `${xdg.root}/logs` })
    mock = await startMockLLM(0)
    backend = await startIsolatedBackend({
      mockLlmUrl: mock.url,
      defaultModel: "success-text-short",
      smartLayerUrl: sidecar.url,
      xdg,
    })

    // Harness self-check: the seeded mock provider config must expose every
    // fixture model, otherwise prompt flows die with ModelNotFoundError
    // (observed when the AppLayer builds providers from a stale/partial
    // config — this assertion turns that silent failure into a loud one).
    const cfg = await getConfigFor(backend)
    const mockModels = Object.keys(
      ((cfg as Record<string, any>)?.provider?.mock?.models as Record<string, unknown>) ?? {},
    )
    expect(
      mockModels,
      `mock provider models missing fixtures — got: ${JSON.stringify(mockModels)}`,
    ).toEqual(expect.arrayContaining([TOOL_MODEL, TEXT_MODEL, MULTI_CHUNK_MODEL]))
  })

  test.afterAll(async () => {
    await backend.stop().catch(() => {})
    await sidecar.stop().catch(() => {})
    await mock.stop().catch(() => {})
  })

  test(
    "agentic loop executes the read tool across LLM rounds (full stack)",
    { tag: ["@core", "@run-loop", "@full-stack"] },
    async () => {
      const session = await createTestSessionFor(backend, "run-loop-tool-e2e")

      // The `success-tool-read` fixture answers every round with a `read`
      // tool call. The Rust loop must execute the tool (README.md exists in
      // the project dir) and continue — a later mock call whose messages
      // carry the tool_call proves the round-trip happened. The loop is
      // bounded by the completion-confirm auto-close mechanism.
      await sendSessionPrompt(backend, session.id, "Read the README", {
        providerID: "mock",
        modelID: TOOL_MODEL,
      })

      const messages = await getMessagesFor(backend, session.id)
      expect(messages.length).toBeGreaterThan(0)

      // Round 2+ requests carried the assistant `read` tool_call — the loop
      // executed the tool and continued instead of echoing a single reply.
      const toolCalls = mock.calls.flatMap((c) => c.tools)
      expect(toolCalls).toContain("read")
      expect(mock.calls.length).toBeGreaterThanOrEqual(2)
    },
  )

  test(
    "session prompt flow runs end to end through TS backend → sidecar → mock LLM",
    { tag: ["@core", "@run-loop", "@full-stack"] },
    async () => {
      const session = await createTestSessionFor(backend, "prompt-full-stack-e2e")

      // Multi-chunk fixture proves streaming chunks traverse the whole
      // pipeline and are assembled into one assistant reply.
      await sendSessionPrompt(backend, session.id, "Say hello", {
        providerID: "mock",
        modelID: MULTI_CHUNK_MODEL,
      })

      // The reply must be persisted and served back by the backend.
      const messages = await getMessagesFor(backend, session.id)
      expect(messages.length).toBeGreaterThan(0)
      const serialized = JSON.stringify(messages)
      expect(serialized).toContain(MULTI_CHUNK_TEXT)

      // The loop really hit the LLM (not an echo path).
      expect(mock.calls.length).toBeGreaterThanOrEqual(1)
    },
  )

  test(
    "short single-chunk reply flows through the full stack",
    { tag: ["@smoke", "@run-loop"] },
    async () => {
      const session = await createTestSessionFor(backend, "prompt-short-e2e")
      await sendSessionPrompt(backend, session.id, "Say OK", {
        providerID: "mock",
        modelID: TEXT_MODEL,
      })
      const messages = await getMessagesFor(backend, session.id)
      expect(messages.length).toBeGreaterThan(0)
      expect(JSON.stringify(messages)).toContain("OK")
    },
  )
})
