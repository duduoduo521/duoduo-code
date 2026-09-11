import { test, expect } from "@playwright/test"
import { startMockLLM, type MockLLMServer } from "./mock-llm/server"
import { startIsolatedBackend, type IsolatedBackend } from "./helpers/backend"

/**
 * Integration test for the Smart Layer `/agent/run_loop` endpoint.
 *
 * This is the formalized replacement for the legacy, out-of-tree script
 * `test-runloop.ts` (which lived in the repo root and was never wired into
 * CI). It spins up its own isolated backend + an observable mock LLM so the
 * loop's round-trips can be asserted directly.
 *
 * Assertions:
 *   - the endpoint acknowledges with `status: "started"` + a `sessionId`
 *   - the session reaches idle without manual abort
 *   - at least one assistant message is produced
 *   - the mock LLM was invoked (proving the loop ran, not just echoed)
 *   - a tool-calling turn occurred (the `read` tool is requested by the fixture)
 */

const TOOL_MODEL = "mock/success-tool-read"

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
): Promise<{ status: string; sessionId: string }> {
  const res = await fetch(`${backendUrl}/agent/run_loop`, {
    method: "POST",
    headers: runLoopHeaders(projectDir),
    body: JSON.stringify({
      sessionID: sessionId,
      model,
      messages: [{ role: "user", content: "Read the README and tell me what this project is." }],
      tools: ["read", "grep", "glob", "task"],
      system_prompt: "You are DuoDuoCode, a coding agent. Use the read tool when needed.",
      intent_type: "question",
    }),
  })
  if (!res.ok) {
    throw new Error(`run_loop failed: ${res.status} ${res.statusText} ${await res.text()}`)
  }
  const data = (await res.json()) as { status?: string; sessionId?: string }
  return { status: data.status ?? "", sessionId: data.sessionId ?? sessionId }
}

test.describe("Agent run_loop integration", () => {
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
    "run_loop drives the agentic loop and invokes tools",
    { tag: ["@core", "@run-loop"] },
    async () => {
      const session = await createTestSessionFor(backend, "run-loop-e2e")
      expect(session.id).toBeTruthy()

      const started = await startRunLoop(backend.url, backend.projectDir, session.id, TOOL_MODEL)
      expect(started.status).toBe("started")
      expect(started.sessionId).toBe(session.id)

      await waitForSessionIdleFor(backend, session.id, 60_000)

      const messages = await getMessagesFor(backend, session.id)
      expect(Array.isArray(messages)).toBe(true)
      expect(messages.length).toBeGreaterThan(0)

      // The mock must have been hit at least once — otherwise the loop
      // never actually ran against the LLM.
      expect(mock.calls.length).toBeGreaterThanOrEqual(1)

      // The `success-tool-read` fixture requests the `read` tool, so the
      // loop must have issued at least one tool-calling LLM turn.
      const toolCalls = mock.calls.flatMap((c) => c.tools)
      expect(toolCalls).toContain("read")
    },
  )
})

// ─── Session helpers bound to a specific backend (sdk.ts targets the global one) ───

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
