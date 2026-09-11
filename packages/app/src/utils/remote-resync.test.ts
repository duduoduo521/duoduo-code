import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

// ---------------------------------------------------------------------------
// `utils/remote-resync.tsx` is the single entry point behind the titlebar, file
// tabs and re-sync actions. It is hook-free and takes its context as arguments,
// so it can be driven directly with fakes — no component tree required.
// ---------------------------------------------------------------------------

interface Toast {
  variant: string
  title: string
  description?: string
}

let toasts: Toast[] = []
let dialogRender: (() => unknown) | undefined
let dialogClosed = 0

// This package builds with `jsx: "preserve"` (Solid + vite). Under `bun test` the
// JSX falls back to React classic, i.e. `React.createElement(...)`. Provide a
// data-only implementation that never invokes components: the dialog body then
// comes back as a plain tree we can walk to reach the buttons and fire their
// handlers — no renderer, no DOM, no change to production code.
interface El {
  type: unknown
  props: Record<string, unknown>
}
;(globalThis as unknown as { React: unknown }).React = {
  createElement(type: unknown, props: unknown, ...children: unknown[]): El {
    return {
      type,
      props: { ...((props as Record<string, unknown>) ?? {}), children: children.length <= 1 ? children[0] : children },
    }
  },
  Fragment: Symbol("Fragment"),
}

function collect(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (node && typeof node === "object" && "type" in node && "props" in node) {
    const el = node as El
    out.push(el)
    collect(el.props.children, out)
  }
  return out
}

mock.module("@duoduo-ai/ui/toast", () => ({
  showToast: (opts: Toast) => {
    toasts.push(opts)
  },
}))
// Return `props.children`: the dialog body is then a plain DOM node we can query.
mock.module("@duoduo-ai/ui/dialog", () => ({
  Dialog: (props: { children?: unknown }) => props.children,
}))
// Type-only imports in the module under test still resolve at runtime; stub them
// so loading this test never pulls in the real contexts.
mock.module("@/context/sdk", () => ({ useSDK: () => ({}) }))
mock.module("@/context/global-sync", () => ({ useGlobalSync: () => ({}) }))
mock.module("@duoduo-ai/ui/context/dialog", () => ({ useDialog: () => ({}) }))

let syncRemote: typeof import("./remote-resync").syncRemote
let remoteSyncStatus: typeof import("./remote-resync").remoteSyncStatus
let getRemoteProjectID: typeof import("./remote-resync").getRemoteProjectID

/** The exact deps shape `syncRemote` asks for, derived from its signature. */
type Deps = Parameters<typeof import("./remote-resync").syncRemote>[1]

beforeAll(async () => {
  const mod = await import("./remote-resync")
  syncRemote = mod.syncRemote
  remoteSyncStatus = mod.remoteSyncStatus
  getRemoteProjectID = mod.getRemoteProjectID
})

interface Call {
  op: "push" | "pull"
  projectID: string
  force: boolean
}

type Handler = (args: { projectID: string; force: boolean }) => Promise<unknown>

function harness(opts: {
  /** `null` models a directory whose record carries no project id. */
  project?: string | null
  push?: Handler
  pull?: Handler
} = {}) {
  const calls: Call[] = []
  const sdk = {
    directory: "/proj",
    createClient: (_opts: unknown) => ({
      project: {
        pushRemote: async (args: { projectID: string; force: boolean }) => {
          calls.push({ op: "push", ...args })
          return opts.push ? opts.push(args) : { data: { ok: true, conflicts: [] } }
        },
        pullRemote: async (args: { projectID: string; force: boolean }) => {
          calls.push({ op: "pull", ...args })
          return opts.pull ? opts.pull(args) : { data: { ok: true, conflicts: [] } }
        },
      },
    }),
  }
  const project = opts.project === undefined ? "remote:p1" : opts.project
  const globalSync = {
    child: () => [{ project }],
  }
  const language = { t: (key: string) => key }
  const dialog = {
    show: (render: () => unknown) => {
      dialogRender = render
    },
    close: () => {
      dialogClosed++
    },
  }
  // The fakes are structurally narrower than the real SDK / global-sync values,
  // so the cast is the point of the harness — the module under test only ever
  // touches `directory`, `createClient`, `child`, `t`, `show` and `close`.
  const deps = { sdk, globalSync, language, dialog } as unknown as Deps
  return { calls, deps }
}

/**
 * Evaluate the dialog body captured by `dialog.show` and return its buttons in
 * DOM order: [0] cancel, [1] overwrite local with remote, [2] overwrite remote
 * with local.
 *
 * Buttons are identified by carrying an `onClick` handler rather than by
 * `type === "button"`: the production dialog renders the `<Button>` component
 * (so the element's type is the component itself, never the literal tag), and
 * no other element in the dialog body carries an onClick.
 */
function dialogButtons(): El[] {
  if (!dialogRender) throw new Error("no dialog was shown")
  return collect(dialogRender()).filter(
    (el) => typeof el.props.onClick === "function",
  )
}

function click(el: El): void {
  const onClick = el.props.onClick as (() => void) | undefined
  if (!onClick) throw new Error("element has no onClick")
  onClick()
}

beforeEach(() => {
  toasts = []
  dialogRender = undefined
  dialogClosed = 0
})

describe("getRemoteProjectID", () => {
  test("accepts only remote projects", () => {
    const { deps } = harness({ project: "remote:p1" })
    expect(getRemoteProjectID(deps.sdk as never, deps.globalSync as never)).toBe("remote:p1")
  })

  test("rejects local projects and missing ids", () => {
    const local = harness({ project: "local:p1" })
    expect(getRemoteProjectID(local.deps.sdk, local.deps.globalSync)).toBeUndefined()
    const none = harness({ project: null })
    expect(getRemoteProjectID(none.deps.sdk, none.deps.globalSync)).toBeUndefined()
  })
})

describe("syncRemote — happy path", () => {
  test("push reports success with the push copy", async () => {
    const { calls, deps } = harness()
    await syncRemote("push", deps)

    expect(calls).toEqual([{ op: "push", projectID: "remote:p1", force: false }])
    expect(toasts).toEqual([
      { variant: "success", title: "remote.pushSuccess", description: "remote.pushSuccessDesc" },
    ])
    expect(remoteSyncStatus()).toBeUndefined()
  })

  test("pull reports success with the pull copy", async () => {
    const { calls, deps } = harness()
    await syncRemote("pull", deps)

    expect(calls).toEqual([{ op: "pull", projectID: "remote:p1", force: false }])
    expect(toasts).toEqual([
      { variant: "success", title: "remote.pullSuccess", description: "remote.pullSuccessDesc" },
    ])
  })

  test("a non-remote project is a no-op", async () => {
    const { calls, deps } = harness({ project: "local:p1" })
    await syncRemote("push", deps)
    expect(calls).toEqual([])
    expect(toasts).toEqual([])
  })
})

describe("syncRemote — error reporting (Bug 1)", () => {
  test("unwraps the parsed error body thrown by the SDK client", async () => {
    // createDuoDuoClient pins throwOnError, so a 400 arrives as the parsed JSON
    // body — a plain object, never an Error. It must not render [object Object].
    const { deps } = harness({
      push: async () => {
        throw { error: "Failed to push to remote: permission denied" }
      },
    })
    await syncRemote("push", deps)

    expect(toasts).toEqual([
      {
        variant: "error",
        title: "remote.pushFailed",
        description: "Failed to push to remote: permission denied",
      },
    ])
    expect(remoteSyncStatus()).toBeUndefined()
  })

  test("falls back when the body carries no message", async () => {
    const { deps } = harness({ pull: async () => Promise.reject({}) })
    await syncRemote("pull", deps)
    expect(toasts[0]?.description).toBe("common.requestFailed")
  })
})

describe("syncRemote — conflict dialog (3h)", () => {
  test("'overwrite local with remote' runs a forced PULL", async () => {
    const { calls, deps } = harness({ pull: async () => ({ data: { ok: true, conflicts: ["a.txt"] } }) })
    await syncRemote("pull", deps)

    const buttons = dialogButtons()
    expect(buttons.length).toBe(3)
    click(buttons[1]!) // "以远端为准拉取覆盖"

    expect(dialogClosed).toBe(1)
    expect(calls).toEqual([
      { op: "pull", projectID: "remote:p1", force: false },
      { op: "pull", projectID: "remote:p1", force: true },
    ])
  })

  test("'overwrite remote with local' runs a forced PUSH", async () => {
    const { calls, deps } = harness({ push: async () => ({ data: { ok: true, conflicts: ["a.txt"] } }) })
    await syncRemote("push", deps)

    click(dialogButtons()[2]!) // "以本地为准推回"

    expect(calls).toEqual([
      { op: "push", projectID: "remote:p1", force: false },
      { op: "push", projectID: "remote:p1", force: true },
    ])
  })

  test("cancel closes the dialog without running another sync", async () => {
    const { calls, deps } = harness({ pull: async () => ({ data: { ok: true, conflicts: ["a.txt"] } }) })
    await syncRemote("pull", deps)

    click(dialogButtons()[0]!) // "取消"

    expect(dialogClosed).toBe(1) // dismissed, but no direction was chosen
    expect(calls).toEqual([{ op: "pull", projectID: "remote:p1", force: false }])
  })

  test("no dialog is shown when there are no conflicts", async () => {
    const { deps } = harness({ push: async () => ({ data: { ok: true, conflicts: [] } }) })
    await syncRemote("push", deps)
    expect(dialogRender).toBeUndefined()
    expect(toasts[0]?.variant).toBe("success")
  })
})

describe("syncRemote — single flight", () => {
  test("a second sync is ignored while one is in flight", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { calls, deps } = harness({
      push: async () => {
        await gate
        return { data: { ok: true, conflicts: [] } }
      },
    })

    // Not awaited on purpose: the second call must observe the busy signal.
    const first = syncRemote("push", deps)
    expect(remoteSyncStatus()).toBe("push")
    await syncRemote("pull", deps) // must be dropped by the guard
    expect(remoteSyncStatus()).toBe("push")

    release!()
    await first

    expect(calls).toEqual([{ op: "push", projectID: "remote:p1", force: false }])
    expect(remoteSyncStatus()).toBeUndefined()
  })

  test("the busy signal is cleared after a failure", async () => {
    const { deps } = harness({
      pull: async () => {
        throw new Error("network down")
      },
    })
    await syncRemote("pull", deps)
    expect(remoteSyncStatus()).toBeUndefined()
    expect(toasts[0]?.description).toBe("network down")
  })
})
