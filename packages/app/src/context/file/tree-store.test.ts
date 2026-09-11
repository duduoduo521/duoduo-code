import { describe, expect, test } from "bun:test"
import { createFileTreeStore } from "./tree-store"
import type { FileNode } from "@duoduo-ai/sdk/v2"

const makeNode = (path: string, type: "file" | "directory" = "file"): FileNode => ({
  path,
  type,
  name: path.split("/").pop() ?? path,
  absolute: `/${path}`,
  ignored: false,
})

const noop = () => {}

describe("createFileTreeStore", () => {
  function createStore() {
    const scope = () => "test-scope"
    const normalizeDir = (input: string) => input.replace(/\/+$/, "") || ""
    const errors: string[] = []

    const store = createFileTreeStore({
      scope,
      normalizeDir,
      list: async (dir) => {
        if (dir === "error-dir") throw new Error("list failed")
        if (dir === "src") return [makeNode("src/index.ts"), makeNode("src/utils.ts")]
        if (dir === "nested") return [makeNode("nested/deep", "directory"), makeNode("nested/file.ts")]
        return []
      },
      onError: (msg) => errors.push(msg),
    })

    return { store, errors }
  }

  describe("initial state", () => {
    test("root dir is expanded by default", () => {
      const { store } = createStore()
      expect(store.dirState("")?.expanded).toBe(true)
    })

    test("unknown dir is undefined", () => {
      const { store } = createStore()
      expect(store.dirState("unknown")).toBeUndefined()
    })

    test("children of unloaded dir is empty", () => {
      const { store } = createStore()
      expect(store.children("src")).toEqual([])
    })

    test("isLoaded returns false for unloaded dir", () => {
      const { store } = createStore()
      expect(store.isLoaded("src")).toBe(false)
    })

    test("node returns undefined for unknown path", () => {
      const { store } = createStore()
      expect(store.node("unknown")).toBeUndefined()
    })
  })

  describe("expandDir", () => {
    test("marks dir as expanded", async () => {
      const { store } = createStore()
      // oxlint-disable-next-line await-thenable -- vitest matcher is awaitable (thenable)
      await store.expandDir("src")
      expect(store.dirState("src")?.expanded).toBe(true)
    })

    test("loads children", async () => {
      const { store } = createStore()
      // oxlint-disable-next-line await-thenable -- vitest matcher is awaitable (thenable)
      await store.expandDir("src")
      expect(store.isLoaded("src")).toBe(true)
      expect(store.children("src")).toHaveLength(2)
    })

    test("populates node entries", async () => {
      const { store } = createStore()
      // oxlint-disable-next-line await-thenable -- vitest matcher is awaitable (thenable)
      await store.expandDir("src")
      expect(store.node("src/index.ts")).toBeDefined()
      expect(store.node("src/utils.ts")).toBeDefined()
    })
  })

  describe("collapseDir", () => {
    test("marks dir as collapsed", async () => {
      const { store } = createStore()
      // oxlint-disable-next-line await-thenable -- vitest matcher is awaitable (thenable)
      await store.expandDir("src")
      store.collapseDir("src")
      expect(store.dirState("src")?.expanded).toBe(false)
    })

    test("keeps loaded data", async () => {
      const { store } = createStore()
      // oxlint-disable-next-line await-thenable -- vitest matcher is awaitable (thenable)
      await store.expandDir("src")
      store.collapseDir("src")
      expect(store.isLoaded("src")).toBe(true)
      expect(store.children("src")).toHaveLength(2)
    })
  })

  describe("listDir", () => {
    test("deduplicates in-flight requests", async () => {
      const { store } = createStore()
      const p1 = store.listDir("src")
      const p2 = store.listDir("src")
      await Promise.all([p1, p2])
      expect(store.children("src")).toHaveLength(2)
    })

    test("skips already loaded dir", async () => {
      const { store } = createStore()
      await store.listDir("src")
      // Second call should resolve immediately
      await store.listDir("src")
      expect(store.children("src")).toHaveLength(2)
    })

    test("handles error from list", async () => {
      const { store, errors } = createStore()
      await store.listDir("error-dir")
      expect(store.dirState("error-dir")?.error).toBeDefined()
      expect(errors.length).toBeGreaterThan(0)
    })

    test("force reloads when force option is set", async () => {
      let listCount = 0
      const scope = () => "test-scope"
      const normalizeDir = (input: string) => input.replace(/\/+$/, "") || ""

      const store = createFileTreeStore({
        scope,
        normalizeDir,
        list: async (dir) => {
          listCount++
          return [makeNode("src/a.ts")]
        },
        onError: noop,
      })

      await store.listDir("src")
      expect(listCount).toBe(1)
      await store.listDir("src", { force: true })
      expect(listCount).toBe(2)
    })
  })

  describe("reset", () => {
    test("clears all nodes and dirs", async () => {
      const { store } = createStore()
      // oxlint-disable-next-line await-thenable -- vitest matcher is awaitable (thenable)
      await store.expandDir("src")
      expect(store.children("src")).toHaveLength(2)

      store.reset()
      expect(store.node("src/index.ts")).toBeUndefined()
      expect(store.dirState("src")).toBeUndefined()
      expect(store.children("src")).toEqual([])
    })

    test("preserves root dir as expanded", () => {
      const { store } = createStore()
      store.reset()
      expect(store.dirState("")?.expanded).toBe(true)
    })
  })

  describe("children", () => {
    test("returns nodes in order", async () => {
      const { store } = createStore()
      // oxlint-disable-next-line await-thenable -- vitest matcher is awaitable (thenable)
      await store.expandDir("src")
      const kids = store.children("src")
      expect(kids.map((n) => n.path)).toEqual(["src/index.ts", "src/utils.ts"])
    })
  })

  describe("force refresh reference stability", () => {
    function createMutableStore() {
      let payload: FileNode[] = [makeNode("src/a.ts"), makeNode("src/b.ts")]
      const store = createFileTreeStore({
        scope: () => "test-scope",
        normalizeDir: (input) => input.replace(/\/+$/, "") || "",
        list: async () => payload,
        onError: noop,
      })
      return { store, setPayload: (next: FileNode[]) => (payload = next) }
    }

    test("keeps stable references for unchanged nodes across force reload", async () => {
      const { store } = createMutableStore()
      await store.listDir("src")
      const before = store.node("src/a.ts")

      await store.listDir("src", { force: true })
      const after = store.node("src/a.ts")

      // reconcile must preserve the identity of unchanged rows so the keyed
      // <For> in file-tree.tsx performs no DOM work (no flicker).
      expect(after).toBe(before)
    })

    test("updates changed fields and drops removed nodes on force reload", async () => {
      const { store, setPayload } = createMutableStore()
      await store.listDir("src")

      setPayload([makeNode("src/a.ts", "directory")])
      await store.listDir("src", { force: true })

      expect(store.node("src/a.ts")?.type).toBe("directory")
      expect(store.node("src/b.ts")).toBeUndefined()
      expect(store.children("src").map((n) => n.path)).toEqual(["src/a.ts"])
    })
  })

  describe("scope change", () => {
    test("ignores results from stale scope", async () => {
      let currentScope = "scope-a"
      const normalizeDir = (input: string) => input.replace(/\/+$/, "") || ""

      const store = createFileTreeStore({
        scope: () => currentScope,
        normalizeDir,
        list: async () => [makeNode("file.ts")],
        onError: noop,
      })

      // Start loading, then change scope before it resolves
      const promise = store.listDir("")
      currentScope = "scope-b"
      await promise

      // Results from scope-a should be ignored
      expect(store.children("")).toEqual([])
    })
  })
})
