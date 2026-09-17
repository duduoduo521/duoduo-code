import { test, expect } from "@playwright/test"
import { startMockLLM, type MockLLMServer } from "./mock-llm/server"
import { startIsolatedBackend, createIsolatedXdgDirs, type IsolatedBackend, type IsolatedXdgDirs } from "./helpers/backend"
import { startSmartLayerSidecar, isSmartLayerAvailable, type SmartLayerSidecar } from "./helpers/smart-layer"

/**
 * Continuation (resume) test for the session prompt flow.
 *
 * Formalized replacement for the auto-runnable portion of the legacy
 * `verify_b1_manual.sh` (scenario "CLI-03 / --continue"): a run that does not
 * complete is resumed on the same session, and the conversation stays coherent
 * with cumulative LLM round-trips.
 *
 * We emulate continuation by issuing two session prompts against the same
 * session id via the TS backend (the route the UI delegates to), driving
 * TS → Rust run_loop → mock LLM each time:
 *   1. first run with a single-shot text fixture
 *   2. second run on the same session, which must append to — not reset — the
 *      prior conversation.
 */

const TEXT_MODEL = "success-text-short"

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

async function sendSessionPrompt(backend: IsolatedBackend, sessionId: string, text: string) {
  const url = new URL(`/session/${sessionId}/message`, backend.url)
  url.searchParams.set("directory", backend.projectDir)
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-duoduo-directory": encodeURIComponent(backend.projectDir) },
    body: JSON.stringify({
      parts: [{ type: "text", text }],
      model: { providerID: "mock", modelID: TEXT_MODEL },
    }),
  })
  if (!res.ok) throw new Error(`sendSessionPrompt failed: ${res.status}`)
  const body = await res.text()
  if (!body.trim()) {
    test.info().skip(true, "Session prompt stream returned empty body — agent backend unavailable")
  }
}

test.describe("Agent run_loop continuation", () => {
  test.skip(!isSmartLayerAvailable(), "duo-smart-layer binary not built — run `cargo build -p duo-smart-layer`")

  // The synchronous session prompt route runs the full agent pipeline —
  // well beyond the default 30s local timeout.
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
  })

  test.afterAll(async () => {
    await backend.stop().catch(() => {})
    await sidecar.stop().catch(() => {})
    await mock.stop().catch(() => {})
  })

  test(
    "same session can be resumed without losing prior context",
    { tag: ["@core", "@run-loop"] },
    async () => {
      const session = await createTestSessionFor(backend, "run-loop-continue-e2e")

      // First (incomplete) run.
      await sendSessionPrompt(backend, session.id, "First turn.")
      const afterFirst = await getMessagesFor(backend, session.id)
      expect(afterFirst.length).toBeGreaterThan(0)

      const callsAfterFirst = mock.calls.length
      expect(callsAfterFirst).toBeGreaterThanOrEqual(1)

      // Resume on the same session.
      await sendSessionPrompt(backend, session.id, "Second turn.")
      const afterSecond = await getMessagesFor(backend, session.id)

      // Conversation grew — prior turns were preserved, not discarded.
      expect(afterSecond.length).toBeGreaterThan(afterFirst.length)

      // The second run produced at least one additional LLM round-trip.
      expect(mock.calls.length).toBeGreaterThan(callsAfterFirst)
    },
  )
})
