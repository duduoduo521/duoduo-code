import { test, expect } from "@playwright/test"
import { startMockLLM, type MockLLMServer } from "./mock-llm/server"
import { startIsolatedBackend, type IsolatedBackend } from "./helpers/backend"

/**
 * Continuation (resume) test for the Smart Layer run loop.
 *
 * Formalized replacement for the auto-runnable portion of the legacy
 * `verify_b1_manual.sh` (scenario "CLI-03 / --continue": a run that does not
 * complete is resumed on the same session, and the conversation stays
 * coherent with cumulative LLM round-trips).
 *
 * We emulate continuation by issuing two `run_loop` requests against the same
 * session id (the `--continue` semantics the CLI expresses over the wire):
 *   1. first run with a single-shot text fixture
 *   2. second run on the same session, which must append to — not reset — the
 *      prior conversation.
 */

const TEXT_MODEL = "mock/success-text-short"

function runLoopHeaders(projectDir: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-duoduo-directory": encodeURIComponent(projectDir),
  }
}

async function startRunLoop(
  backendUrl: string,
  projectDir: string,
  sessionId: string,
  model: string,
  userMessage: string,
): Promise<void> {
  const res = await fetch(`${backendUrl}/agent/run_loop`, {
    method: "POST",
    headers: runLoopHeaders(projectDir),
    body: JSON.stringify({
      sessionID: sessionId,
      model,
      messages: [{ role: "user", content: userMessage }],
      system_prompt: "You are DuoDuoCode, a coding agent.",
      intent_type: "question",
    }),
  })
  if (!res.ok) {
    throw new Error(`run_loop failed: ${res.status} ${res.statusText} ${await res.text()}`)
  }
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

async function waitForSessionIdleFor(backend: IsolatedBackend, sessionId: string, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const url = new URL("/session/status", backend.url)
    url.searchParams.set("directory", backend.projectDir)
    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: { "x-duoduo-directory": encodeURIComponent(backend.projectDir) },
        signal: AbortSignal.timeout(2_000),
      })
      if (res.ok) {
        const data = await res.json()
        if (!data) break
        if (data.type === "idle" || data.status === "idle") break
        if (Array.isArray(data)) {
          const ours = data.find((s: { id?: string; sessionID?: string; type?: string; status?: string }) => s.id === sessionId || s.sessionID === sessionId)
          if (!ours || ours.type === "idle" || ours.status === "idle") break
        }
      }
    } catch {
      // backend transient — keep polling
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

test.describe("Agent run_loop continuation", () => {
  let mock: MockLLMServer
  let backend: IsolatedBackend

  test.beforeAll(async () => {
    mock = await startMockLLM(0)
    backend = await startIsolatedBackend({ mockLlmUrl: mock.url, defaultModel: "success-text-short" })
  })

  test.afterAll(async () => {
    await backend.stop().catch(() => {})
    await mock.stop().catch(() => {})
  })

  test(
    "same session can be resumed without losing prior context",
    { tag: ["@core", "@run-loop"] },
    async () => {
      const session = await createTestSessionFor(backend, "run-loop-continue-e2e")

      // First (incomplete) run.
      await startRunLoop(backend.url, backend.projectDir, session.id, TEXT_MODEL, "First turn.")
      await waitForSessionIdleFor(backend, session.id, 60_000)
      const afterFirst = await getMessagesFor(backend, session.id)
      expect(afterFirst.length).toBeGreaterThan(0)

      const callsAfterFirst = mock.calls.length
      expect(callsAfterFirst).toBeGreaterThanOrEqual(1)

      // Resume on the same session.
      await startRunLoop(backend.url, backend.projectDir, session.id, TEXT_MODEL, "Second turn.")
      await waitForSessionIdleFor(backend, session.id, 60_000)
      const afterSecond = await getMessagesFor(backend, session.id)

      // Conversation grew — prior turns were preserved, not discarded.
      expect(afterSecond.length).toBeGreaterThan(afterFirst.length)

      // The second run produced at least one additional LLM round-trip.
      expect(mock.calls.length).toBeGreaterThan(callsAfterFirst)
    },
  )
})
