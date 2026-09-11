import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt } from "@/context/prompt"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const createdClients: string[] = []
const createdSessions: string[] = []
const enabledAutoAccept: Array<{ sessionID: string; directory: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: string[] = []
const syncedDirectories: string[] = []

let params: { id?: string } = {}
let selected = "/repo/worktree-a"

/**
 * `handleSubmit` fires `sendFollowupDraft` without awaiting it, so the
 * optimistic message lands one or more microtasks later. Poll instead of
 * asserting immediately — a fixed `setTimeout` would be a race.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    session: {
      create: async () => {
        createdSessions.push(directory)
        return {
          data: {
            id: `session-${createdSessions.length}`,
            title: `New session ${createdSessions.length}`,
          },
        }
      },
      shell: async () => {
        sentShell.push(directory)
        return { data: undefined }
      },
      prompt: async () => ({ data: undefined }),
      promptAsync: async () => ({ data: undefined }),
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
  }))

  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@duoduo-ai/sdk/v2/client", () => ({
    createDuoduoClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@duoduo-ai/ui/toast", () => ({
    showToast: () => 0,
  }))

  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@duoduo-ai/shared/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@/context/permission", () => ({
    usePermission: () => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ sessionID, directory })
      },
    }),
  }))

  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@/context/prompt", () => ({
    usePrompt: () => ({
      current: () => promptValue,
      reset: () => undefined,
      set: () => undefined,
      context: {
        add: () => undefined,
        remove: () => undefined,
        items: () => [],
      },
    }),
  }))

  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        directory: "/repo/main",
        client: rootClient,
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return sdk
    },
  }))

  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@/context/sync", () => ({
    useSync: () => ({
      data: { command: [] },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@/context/global-sync", () => ({
    useGlobalSync: () => ({
      // `sendFollowupDraft` calls this on the optimistic path; without it
      // `setBusy()` throws before `optimistic.add()` and the message never
      // lands, which used to make this look like a submit bug.
      clearAborted: () => undefined,
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
      locale: () => "en",
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  enabledAutoAccept.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  params = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("prompt submit worktree selection", () => {
  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sentShell).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("adds the optimistic user message for an existing session", async () => {
    params = { id: "session-1" }

    const submit = createPromptSubmit({
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await waitFor(() => optimistic.length > 0)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toEqual([{ id: "session-1", title: "New session 1" }])
    expect(optimisticSeeded).toEqual([true])
  })
})
