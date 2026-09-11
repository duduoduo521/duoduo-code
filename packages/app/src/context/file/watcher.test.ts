import { describe, expect, test } from "bun:test"
import { invalidateFromWatcher } from "./watcher"

describe("file watcher invalidation", () => {
  test("reloads open files and refreshes loaded parent on add", () => {
    const loads: string[] = []
    const refresh: string[] = []
    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/new.ts",
          event: "add",
        },
      },
      {
        normalize: (input) => input,
        hasFile: (path) => path === "src/new.ts",
        loadFile: (path) => loads.push(path),
        node: () => undefined,
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
        closeTab: () => {},
        closeTabsUnder: () => {},
        reloadOpenFiles: () => {},
      },
    )

    expect(loads).toEqual(["src/new.ts"])
    expect(refresh).toEqual(["src"])
  })

  test("reloads files that are open in tabs", () => {
    const loads: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/open.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        isOpen: (path) => path === "src/open.ts",
        loadFile: (path) => loads.push(path),
        node: () => ({
          path: "src/open.ts",
          type: "file",
          name: "open.ts",
          absolute: "/repo/src/open.ts",
          ignored: false,
        }),
        isDirLoaded: () => false,
        refreshDir: () => {},
        closeTab: () => {},
        closeTabsUnder: () => {},
        reloadOpenFiles: () => {},
      },
    )

    expect(loads).toEqual(["src/open.ts"])
  })

  test("refreshes only changed loaded directory nodes", () => {
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({ path: "src", type: "directory", name: "src", absolute: "/repo/src", ignored: false }),
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
        closeTab: () => {},
        closeTabsUnder: () => {},
        reloadOpenFiles: () => {},
      },
    )

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/file.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({
          path: "src/file.ts",
          type: "file",
          name: "file.ts",
          absolute: "/repo/src/file.ts",
          ignored: false,
        }),
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
        closeTab: () => {},
        closeTabsUnder: () => {},
        reloadOpenFiles: () => {},
      },
    )

    // Directory change refreshes "src" directly; file change refreshes its parent "src"
    expect(refresh).toEqual(["src", "src"])
  })

  test("ignores invalid or git watcher updates", () => {
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: ".git/index.lock",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => true,
        loadFile: () => {
          throw new Error("should not load")
        },
        node: () => undefined,
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
        closeTab: () => {},
        closeTabsUnder: () => {},
        reloadOpenFiles: () => {},
      },
    )

    invalidateFromWatcher(
      {
        type: "project.updated",
        properties: {},
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => undefined,
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
        closeTab: () => {},
        closeTabsUnder: () => {},
        reloadOpenFiles: () => {},
      },
    )

    expect(refresh).toEqual([])
  })

  test("refreshes parent directory on file change event", () => {
    const refresh: string[] = []

    // When Agent modifies an existing file (change event on a file path),
    // the parent directory should be refreshed so sibling changes appear.
    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/existing.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({
          path: "src/existing.ts",
          type: "file",
          name: "existing.ts",
          absolute: "/repo/src/existing.ts",
          ignored: false,
        }),
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
        closeTab: () => {},
        closeTabsUnder: () => {},
        reloadOpenFiles: () => {},
      },
    )

    expect(refresh).toEqual(["src"])
  })

  test("skips refresh when parent directory is not loaded", () => {
    const refresh: string[] = []

    // If the parent directory has never been expanded/loaded,
    // refreshing it would be wasted work — skip.
    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "deep/nested/file.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({
          path: "deep/nested/file.ts",
          type: "file",
          name: "file.ts",
          absolute: "/repo/deep/nested/file.ts",
          ignored: false,
        }),
        isDirLoaded: () => false,
        refreshDir: (path) => refresh.push(path),
        closeTab: () => {},
        closeTabsUnder: () => {},
        reloadOpenFiles: () => {},
      },
    )

    expect(refresh).toEqual([])
  })

  test("reloads all open files on root-level change event", () => {
    const loads: string[] = []
    const reloadCalls: number[] = []

    // Root-level change (path normalizes to root) triggers reloadOpenFiles
    // so that all open editor tabs get force-reloaded from disk.
    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "project-root",
          event: "change",
        },
      },
      {
        normalize: () => "",
        hasFile: () => false,
        loadFile: (path) => loads.push(path),
        node: () => undefined,
        isDirLoaded: () => true,
        refreshDir: () => {},
        closeTab: () => {},
        closeTabsUnder: () => {},
        reloadOpenFiles: () => reloadCalls.push(1),
      },
    )

    expect(reloadCalls).toEqual([1])
  })

  test("closes tab and refreshes parent on unlink", () => {
    const closedTabs: string[] = []
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/deleted.ts",
          event: "unlink",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => undefined,
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
        closeTab: (path) => closedTabs.push(path),
        closeTabsUnder: () => {},
        reloadOpenFiles: () => {},
      },
    )

    expect(closedTabs).toEqual(["src/deleted.ts"])
    expect(refresh).toEqual(["src"])
  })

  test("closes child tabs when a directory is unlinked", () => {
    const closedTabs: string[] = []
    const closedUnder: string[] = []
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/olddir",
          event: "unlink",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({ path: "src/olddir", type: "directory", name: "olddir", absolute: "/repo/src/olddir", ignored: false }),
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
        closeTab: (path) => closedTabs.push(path),
        closeTabsUnder: (dirPath) => closedUnder.push(dirPath),
        reloadOpenFiles: () => {},
      },
    )

    expect(closedTabs).toEqual(["src/olddir"])
    expect(closedUnder).toEqual(["src/olddir"])
    expect(refresh).toEqual(["src"])
  })

  test("reloads files that are open in tabs", () => {
    const loads: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/open.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        isOpen: (path) => path === "src/open.ts",
        loadFile: (path) => loads.push(path),
        node: () => ({
          path: "src/open.ts",
          type: "file",
          name: "open.ts",
          absolute: "/repo/src/open.ts",
          ignored: false,
        }),
        isDirLoaded: () => false,
        refreshDir: () => {},
        closeTab: () => {},
        reloadOpenFiles: () => {},
      },
    )

    expect(loads).toEqual(["src/open.ts"])
  })

  test("refreshes only changed loaded directory nodes", () => {
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({ path: "src", type: "directory", name: "src", absolute: "/repo/src", ignored: false }),
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
        closeTab: () => {},
        reloadOpenFiles: () => {},
      },
    )

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/file.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({
          path: "src/file.ts",
          type: "file",
          name: "file.ts",
          absolute: "/repo/src/file.ts",
          ignored: false,
        }),
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
        closeTab: () => {},
        reloadOpenFiles: () => {},
      },
    )

    // Directory change refreshes "src" directly; file change refreshes its parent "src"
    expect(refresh).toEqual(["src", "src"])
  })

  test("ignores invalid or git watcher updates", () => {
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: ".git/index.lock",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => true,
        loadFile: () => {
          throw new Error("should not load")
        },
        node: () => undefined,
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
        closeTab: () => {},
        reloadOpenFiles: () => {},
      },
    )

    invalidateFromWatcher(
      {
        type: "project.updated",
        properties: {},
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => undefined,
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
        closeTab: () => {},
        reloadOpenFiles: () => {},
      },
    )

    expect(refresh).toEqual([])
  })

  test("refreshes parent directory on file change event", () => {
    const refresh: string[] = []

    // When Agent modifies an existing file (change event on a file path),
    // the parent directory should be refreshed so sibling changes appear.
    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/existing.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({
          path: "src/existing.ts",
          type: "file",
          name: "existing.ts",
          absolute: "/repo/src/existing.ts",
          ignored: false,
        }),
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
        closeTab: () => {},
        reloadOpenFiles: () => {},
      },
    )

    expect(refresh).toEqual(["src"])
  })

  test("skips refresh when parent directory is not loaded", () => {
    const refresh: string[] = []

    // If the parent directory has never been expanded/loaded,
    // refreshing it would be wasted work — skip.
    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "deep/nested/file.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({
          path: "deep/nested/file.ts",
          type: "file",
          name: "file.ts",
          absolute: "/repo/deep/nested/file.ts",
          ignored: false,
        }),
        isDirLoaded: () => false,
        refreshDir: (path) => refresh.push(path),
        closeTab: () => {},
        reloadOpenFiles: () => {},
      },
    )

    expect(refresh).toEqual([])
  })

  test("reloads all open files on root-level change event", () => {
    const loads: string[] = []
    const reloadCalls: number[] = []

    // Root-level change (path normalizes to "") triggers reloadOpenFiles
    // so that all open editor tabs get force-reloaded from disk.
    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "project-root",
          event: "change",
        },
      },
      {
        normalize: () => "", // normalizes to root (empty string)
        hasFile: () => false,
        loadFile: (path) => loads.push(path),
        node: () => undefined,
        isDirLoaded: () => true,
        refreshDir: () => {},
        closeTab: () => {},
        reloadOpenFiles: () => reloadCalls.push(1),
      },
    )

    expect(reloadCalls).toEqual([1])
  })

  test("closes tab and refreshes parent on unlink", () => {
    const closedTabs: string[] = []
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/deleted.ts",
          event: "unlink",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => undefined,
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
        closeTab: (path) => closedTabs.push(path),
        reloadOpenFiles: () => {},
      },
    )

    expect(closedTabs).toEqual(["src/deleted.ts"])
    expect(refresh).toEqual(["src"])
  })
})
