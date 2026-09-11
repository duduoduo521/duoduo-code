import { beforeAll, describe, expect, mock, test } from "bun:test"

let shouldListRoot: typeof import("./file-tree").shouldListRoot
let shouldListExpanded: typeof import("./file-tree").shouldListExpanded
let dirsToExpand: typeof import("./file-tree").dirsToExpand

beforeAll(async () => {
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@/context/file", () => ({
    useFile: () => ({
      tree: {
        state: () => undefined,
        list: () => Promise.resolve(),
        children: () => [],
        expand: () => {},
        collapse: () => {},
      },
    }),
  }))
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@duoduo-ai/ui/collapsible", () => ({
    Collapsible: {
      Trigger: (props: { children?: unknown }) => props.children,
      Content: (props: { children?: unknown }) => props.children,
    },
  }))
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@duoduo-ai/ui/context-menu", () => ({
    ContextMenu: Object.assign((props: { children?: unknown }) => props.children, {
      Trigger: (props: { children?: unknown }) => props.children,
      Content: (props: { children?: unknown }) => props.children,
      Item: (props: { children?: unknown }) => props.children,
      Separator: () => null,
    }),
  }))
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@duoduo-ai/ui/dialog", () => ({ Dialog: (props: { children?: unknown }) => props.children }))
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@duoduo-ai/ui/button", () => ({ Button: (props: { children?: unknown }) => props.children }))
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@duoduo-ai/ui/text-field", () => ({ TextField: (props: { children?: unknown }) => props.children }))
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@duoduo-ai/ui/spinner", () => ({ Spinner: () => null }))
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@duoduo-ai/ui/file-icon", () => ({ FileIcon: () => null }))
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@duoduo-ai/ui/icon", () => ({ Icon: () => null }))
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@duoduo-ai/ui/toast", () => ({ showToast: () => undefined }))
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@duoduo-ai/ui/tooltip", () => ({ Tooltip: (props: { children?: unknown }) => props.children }))
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@duoduo-ai/ui/context/dialog", () => ({ useDialog: () => ({ show: () => undefined }) }))
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@/context/platform", () => ({ usePlatform: () => ({}) }))
  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
  mock.module("@/context/sdk", () => ({ useSDK: () => ({}) }))
  const mod = await import("./file-tree")
  shouldListRoot = mod.shouldListRoot
  shouldListExpanded = mod.shouldListExpanded
  dirsToExpand = mod.dirsToExpand
})

describe("file tree fetch discipline", () => {
  test("root lists on mount unless already loaded or loading", () => {
    expect(shouldListRoot({ level: 0 })).toBe(true)
    expect(shouldListRoot({ level: 0, dir: { loaded: true } })).toBe(false)
    expect(shouldListRoot({ level: 0, dir: { loading: true } })).toBe(false)
    expect(shouldListRoot({ level: 1 })).toBe(false)
  })

  test("nested dirs list only when expanded and stale", () => {
    expect(shouldListExpanded({ level: 1 })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: false } })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true } })).toBe(true)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true, loaded: true } })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true, loading: true } })).toBe(false)
    expect(shouldListExpanded({ level: 0, dir: { expanded: true } })).toBe(false)
  })

  test("allowed auto-expand picks only collapsed dirs", () => {
    const expanded = new Set<string>()
    const filter = { dirs: new Set(["src", "src/components"]) }

    const first = dirsToExpand({
      level: 0,
      filter,
      expanded: (dir) => expanded.has(dir),
    })

    expect(first).toEqual(["src", "src/components"])

    for (const dir of first) expanded.add(dir)

    const second = dirsToExpand({
      level: 0,
      filter,
      expanded: (dir) => expanded.has(dir),
    })

    expect(second).toEqual([])
    expect(dirsToExpand({ level: 1, filter, expanded: () => false })).toEqual([])
  })
})
