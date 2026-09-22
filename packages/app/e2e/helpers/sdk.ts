/**
 * SDK helper for e2e tests — uses raw fetch() instead of @duoduo-ai/sdk/client
 * to avoid workspace dependency resolution issues at Playwright runtime.
 *
 * Reads the runtime info written by dev-server.ts and provides typed fetch
 * wrappers for the backend API.
 */
import { readFileSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "@playwright/test"
import type { RuntimeInfo } from "./dev-server"

const __dirname = dirname(fileURLToPath(import.meta.url))
const RUNTIME_INFO_PATH = resolve(__dirname, ".runtime-info.json")

let _info: RuntimeInfo | null = null

export function getRuntimeInfo(): RuntimeInfo {
  if (_info) return _info
  if (!existsSync(RUNTIME_INFO_PATH)) {
    throw new Error(`.runtime-info.json not found at ${RUNTIME_INFO_PATH}. Did global-setup run?`)
  }
  _info = JSON.parse(readFileSync(RUNTIME_INFO_PATH, "utf8"))
  return _info!
}

/** Build headers common to all backend requests (directory scope). */
function baseHeaders(): Record<string, string> {
  const info = getRuntimeInfo()
  return {
    "Content-Type": "application/json",
    "x-duoduo-directory": encodeURIComponent(info.projectDir),
  }
}

/** Throw on non-2xx responses with a descriptive error. */
function assertOk(res: Response, label: string) {
  if (!res.ok) {
    throw new Error(`${label} failed: ${res.status} ${res.statusText}`)
  }
}

// ─── Session API ────────────────────────────────────────────────

export interface SessionInfo {
  id: string
  slug?: string
  title?: string
  projectID?: string
  directory?: string
  parentID?: string
  [key: string]: unknown
}

/** Create a new session via the backend API. */
export async function createTestSession(title?: string): Promise<SessionInfo> {
  const info = getRuntimeInfo()
  const url = new URL("/session", info.backendUrl)
  url.searchParams.set("directory", info.projectDir)

  const body: Record<string, unknown> = {}
  if (title) body.title = title

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify(body),
  })
  assertOk(res, "createTestSession")
  return (await res.json()) as SessionInfo
}

/**
 * Wait until the session's Rust run loop is no longer running (the metrics
 * entry reports running:false or is gone). Bounded poll — a session that is
 * still streaming holds the project's single task slot, so a follow-up test's
 * first prompt would fail-fast 409 and get stuck in the queue.
 */
export async function waitForSessionIdle(sessionId: string, timeoutMs = 30_000): Promise<void> {
  const info = getRuntimeInfo()
  if (!info.smartLayerUrl) return
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(
        `${info.smartLayerUrl}/agent/metrics?session_id=${encodeURIComponent(sessionId)}`,
        { signal: AbortSignal.timeout(2_000) },
      )
      if (res.ok) {
        const data = (await res.json()) as { running?: boolean }
        if (!data.running) return
      }
    } catch {
      // transient — keep waiting
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** Delete a session by ID. */
export async function deleteTestSession(sessionId: string): Promise<void> {
  // Let the session's run loop wind down first: the backend now cancels the
  // generation subtree on delete (delete = stop + remove), but the Rust loop
  // exits asynchronously — deleting mid-stream would still race its final
  // bookkeeping writes into the per-project DB.
  await waitForSessionIdle(sessionId).catch(() => {})
  const info = getRuntimeInfo()
  const url = new URL(`/session/${sessionId}`, info.backendUrl)
  url.searchParams.set("directory", info.projectDir)

  const res = await fetch(url.toString(), {
    method: "DELETE",
    headers: baseHeaders(),
  })
  // 404 is fine — session may already be gone
  if (res.status === 404) return
  assertOk(res, `deleteTestSession(${sessionId})`)
}

/** List all sessions. */
export async function listSessions(): Promise<SessionInfo[]> {
  const info = getRuntimeInfo()
  const url = new URL("/session", info.backendUrl)
  url.searchParams.set("directory", info.projectDir)

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: baseHeaders(),
  })
  assertOk(res, "listSessions")
  const data = await res.json()
  return Array.isArray(data) ? data : (data?.sessions ?? [])
}

/** Get a single session by ID. */
export async function getSession(sessionId: string): Promise<SessionInfo | undefined> {
  const info = getRuntimeInfo()
  const url = new URL(`/session/${sessionId}`, info.backendUrl)
  url.searchParams.set("directory", info.projectDir)

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: baseHeaders(),
  })
  if (res.status === 404) return undefined
  assertOk(res, `getSession(${sessionId})`)
  return (await res.json()) as SessionInfo
}

/** Get messages for a session. */
export async function getMessages(sessionId: string): Promise<unknown[]> {
  const info = getRuntimeInfo()
  const url = new URL(`/session/${sessionId}/message`, info.backendUrl)
  url.searchParams.set("directory", info.projectDir)

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: baseHeaders(),
  })
  if (res.status === 404) return []
  assertOk(res, `getMessages(${sessionId})`)
  const data = await res.json()
  return Array.isArray(data) ? data : (data?.messages ?? [])
}

/** Send a prompt to a session (synchronous — waits for full response). */
export async function sendPrompt(
  sessionId: string,
  text: string,
  model?: { providerID: string; modelID: string },
  extra?: Record<string, unknown>,
): Promise<{ info: unknown; parts: unknown[] }> {
  const info = getRuntimeInfo()
  const url = new URL(`/session/${sessionId}/message`, info.backendUrl)
  url.searchParams.set("directory", info.projectDir)

  const body: Record<string, unknown> = {
    ...extra,
    parts: [{ type: "text", text }],
  }
  if (model) body.model = model

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify(body),
  })
  assertOk(res, `sendPrompt(${sessionId})`)
  const bodyText = await res.text()
  if (!bodyText.trim()) {
    // POST /session/:id/message 是 stream 路由：成功时最后才写入 JSON；
    // agent 后端（Rust smart-layer 侧车）缺失时 Effect.fail → 200 + 空 body。
    // E2E 隔离环境不构建 Rust 侧车，prompt 流在此类环境不可测——跳过而非假红。
    test.info().skip(
      true,
      "Agent backend (Rust smart-layer) unavailable in this environment; prompt flows require the Rust run-loop sidecar",
    )
  }
  return JSON.parse(bodyText) as { info: unknown; parts: unknown[] }
}

/** Abort a running session. */
export async function abortSession(sessionId: string): Promise<void> {
  const info = getRuntimeInfo()
  const url = new URL(`/session/${sessionId}/abort`, info.backendUrl)
  url.searchParams.set("directory", info.projectDir)

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: baseHeaders(),
  })
  assertOk(res, `abortSession(${sessionId})`)
}

// ─── Config API ─────────────────────────────────────────────────

/** Get the current global config. */
export async function getConfig(): Promise<Record<string, unknown>> {
  const info = getRuntimeInfo()
  const url = new URL("/config", info.backendUrl)
  url.searchParams.set("directory", info.projectDir)

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: baseHeaders(),
  })
  assertOk(res, "getConfig")
  return (await res.json()) as Record<string, unknown>
}

/** Update the global config (partial merge). */
export async function updateConfig(patch: Record<string, unknown>): Promise<void> {
  const info = getRuntimeInfo()
  const url = new URL("/config", info.backendUrl)
  url.searchParams.set("directory", info.projectDir)

  const res = await fetch(url.toString(), {
    method: "PATCH",
    headers: baseHeaders(),
    body: JSON.stringify(patch),
  })
  assertOk(res, "updateConfig")
}

// ─── Mock LLM introspection ─────────────────────────────────────

/** Number of chat-completions calls the mock LLM has served so far. */
export async function getMockCallCount(): Promise<number> {
  const info = getRuntimeInfo()
  const res = await fetch(`${info.mockLlmUrl}/debug/calls`)
  assertOk(res, "getMockCallCount")
  return ((await res.json()) as { count: number }).count
}

// ─── Health ─────────────────────────────────────────────────────

/** Check backend health. */
export async function healthCheck(): Promise<{ healthy: boolean; version: string }> {
  const info = getRuntimeInfo()
  const res = await fetch(`${info.backendUrl}/global/health`)
  assertOk(res, "healthCheck")
  return (await res.json()) as { healthy: boolean; version: string }
}
