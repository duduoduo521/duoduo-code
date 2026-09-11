import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import type { DuoDuoClient } from "@duoduo-ai/sdk/v2/client"
import { bootstrapDirectory } from "./bootstrap"
import type { State } from "./types"

// ─────────────────────────────────────────────────────────────────────────────
// Regression tests for the provider-list refresh race in bootstrapDirectory.
//
// Before the fix, the provider query went through queryClient.ensureQueryData,
// which dedupes to an in-flight query. The rev guard then dropped that same
// query's result the moment a newer bootstrap round started. Combined, a slow
// (>500ms, e.g. while the server re-probes local inference services)
// provider.list resolved into the void and the child provider store never
// updated — the "connected providers list / model picker doesn't refresh
// after connecting the built-in deepseek provider" bug.
//
// After the fix every bootstrap round issues its own provider.list request;
// the rev guard keeps only the newest result.
// ─────────────────────────────────────────────────────────────────────────────

type ProviderPayload = {
  all: Array<{ id: string; name: string; models: Record<string, { name: string }> }>
  connected: string[]
  default: Record<string, never>
}

const STALE: ProviderPayload = {
  all: [{ id: "openai", name: "OpenAI", models: {} }],
  connected: ["openai"],
  default: {},
}

const FRESH: ProviderPayload = {
  all: [
    { id: "openai", name: "OpenAI", models: {} },
    { id: "deepseek", name: "DeepSeek", models: { "deepseek-v4-flash": { name: "DeepSeek V4 Flash" } } },
  ],
  connected: ["openai", "deepseek"],
  default: {},
}

function waitFor(check: () => boolean, timeoutMs: number, label: string) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (check()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for: ${label}`))
      setTimeout(tick, 10)
    }
    tick()
  })
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function makeHarness(opts: {
  delays: number[] // provider.list round-trip delay per call, in ms
  payloads: ProviderPayload[] // provider.list payload per call
}) {
  let call = 0
  const calls: number[] = []

  // Minimal SDK stub: every endpoint resolves immediately with empty data,
  // except provider.list whose latency/payload is scripted per call.
  const sdk = {
    provider: {
      list: () => {
        const index = call++
        calls.push(index)
        const delay = opts.delays[index] ?? 0
        const payload = opts.payloads[index] ?? STALE
        return new Promise((resolve) => {
          setTimeout(() => resolve({ data: payload }), delay)
        })
      },
    },
    config: { get: async () => ({ data: {} }) },
    session: { status: async () => ({ data: {} }) },
    project: { current: async () => ({ data: { id: "p1" } }) },
    app: { agents: async () => ({ data: [] }) },
    path: { get: async () => ({ data: { directory: "/project" } }) },
    vcs: { get: async () => ({ data: undefined }) },
    command: { list: async () => ({ data: [] }) },
    permission: { list: async () => ({ data: [] }) },
    question: { list: async () => ({ data: [] }) },
    mcp: { status: async () => ({ data: {} }) },
    lsp: { client: { post: async () => ({ data: { scheduled: 0 } }) } },
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test stub, only the endpoints above are exercised
  } as unknown as DuoDuoClient

  const [store, setStore] = createStore({
    status: "complete",
    provider: { all: [], connected: [], default: {} },
    config: {},
    session: [],
    permission: {},
    question: {},
  } as unknown as State) as [Store<State>, SetStoreFunction<State>]
  const queryClient = new QueryClient()

  const input = () => ({
    directory: "/project",
    sdk,
    store,
    setStore,
    vcsCache: {
      store: { value: undefined },
      setStore: () => {},
      ready: () => true,
    },
    loadSessions: () => {},
    translate: (key: string) => key,
    global: {
      config: {},
      path: { directory: "/project", home: "/home", state: "/state", config: "/config", worktree: "/project" },
      project: [],
      provider: { all: [], connected: [], default: {} },
    },
    queryClient,
  })

  return { store, input, calls }
}

describe("bootstrapDirectory provider refresh race", () => {
  test("a newer bootstrap round updates the store even while an older round is in flight", async () => {
    // Round 1: slow (300ms) and stale. Round 2 (starts 20ms later): fast and fresh.
    const h = makeHarness({ delays: [300, 10], payloads: [STALE, FRESH] })

    void bootstrapDirectory(h.input())
    await sleep(20)
    void bootstrapDirectory(h.input())

    // The fresh result from round 2 must land in the store.
    await waitFor(() => h.store.provider_ready === true, 2000, "provider_ready after second round")
    expect(h.store.provider.connected).toContain("deepseek")
    expect(h.calls).toEqual([0, 1])
  })

  test("a stale response arriving after a newer round does not clobber the store", async () => {
    const h = makeHarness({ delays: [300, 10], payloads: [STALE, FRESH] })

    void bootstrapDirectory(h.input())
    await sleep(20)
    void bootstrapDirectory(h.input())

    await waitFor(() => h.store.provider_ready === true, 2000, "provider_ready after second round")
    // Wait well past round 1's 300ms resolution so the stale payload arrives late.
    await sleep(400)

    // The rev guard must drop round 1's stale payload: deepseek stays connected.
    expect(h.store.provider.connected).toContain("deepseek")
    expect(h.store.provider.connected).not.toContain("__stale_marker__")
    expect(
      h.store.provider.all.some((p) => p.id === "deepseek"),
    ).toBe(true)
  })

  test("a single fast round still populates the store", async () => {
    const h = makeHarness({ delays: [5], payloads: [FRESH] })

    void bootstrapDirectory(h.input())

    await waitFor(() => h.store.provider_ready === true, 2000, "provider_ready after single round")
    expect(h.store.provider.connected).toContain("deepseek")
  })
})
