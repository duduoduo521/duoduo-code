import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "@duoduo-ai/ui/context"
import { showToast } from "@duoduo-ai/ui/toast"
import { useParams } from "@solidjs/router"
import { getFilename } from "@duoduo-ai/shared/util/path"
import { getCapability } from "@duoduo-ai/shared/util/preview-capability"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useGlobalSync } from "./global-sync"
import { createPathHelpers } from "./file/path"
import {
  approxBytes,
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  hasFileContent,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
} from "./file/content-cache"
import { createFileViewCache } from "./file/view-cache"
import { invalidateFromWatcher } from "./file/watcher"
import {
  selectionFromLines,
  type FileState,
  type FileSelection,
  type FileViewState,
  type SelectedLineRange,
} from "./file/types"

export type { FileSelection, SelectedLineRange, FileViewState, FileState }
export { selectionFromLines }
export {
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
}

import { errorMessage } from "./file/error-message"

// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const { use: useFile, provider: FileProvider } = createSimpleContext({
  name: "File",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const globalSync = useGlobalSync()
    useSync()
    const params = useParams()
    const language = useLanguage()
    const layout = useLayout()

    const scope = createMemo(() => sdk.directory)
    const path = createPathHelpers(scope)
    const tabs = layout.tabs(() => `${params.dir}${params.id ? "/" + params.id : ""}`)

    const inflight = new Map<string, Promise<void>>()
    // 代次守卫：force 重载不被去重拦截，但只有最新一次读取能写回 store，
    // 避免并发两次读时陈旧（空）结果覆盖新内容。
    const loadSeq = new Map<string, number>()
    const [store, setStore] = createStore<{
      file: Record<string, FileState>
    }>({
      file: {},
    })

    // File tree is sourced from the global cache keyed by directory.
    // Switching projects switches the cache entry — no data is lost.
    const activeTreeEntry = createMemo(() => globalSync.fileTree(scope()))
    const activeTree = createMemo(() => activeTreeEntry().store)

    const contentDir = createMemo(() => scope())

    const evictContent = (keep?: Set<string>) => {
      evictContentLru(contentDir(), keep, (target) => {
        if (!store.file[target]) return
        setStore(
          "file",
          target,
          produce((draft) => {
            draft.content = undefined
            draft.loaded = false
            draft.loading = false
          }),
        )
      })
    }

    // When the project scope changes, clear per-project file content state.
    // The file tree is retained in the global cache — no tree.reset() needed.
    createEffect(() => {
      scope()
      inflight.clear()
      setStore("file", reconcile({}))
    })

    const viewCache = createFileViewCache()
    const view = createMemo(() => viewCache.load(scope(), params.id))

    const ensure = (file: string) => {
      if (!file) return
      if (store.file[file]) return
      setStore("file", file, { path: file, name: getFilename(file) })
    }

    const setLoading = (file: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = true
          draft.error = undefined
        }),
      )
    }

    const setLoaded = (file: string, content: FileState["content"]) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loaded = true
          draft.loading = false
          draft.content = content
          draft.stale = false
          draft.loadedAt = Date.now()
        }),
      )
    }

    // Deduplicate error toasts: same file+title should not reappear within 5s.
    // This prevents Agent mode from flooding toasts when watcher events
    // repeatedly trigger load failures on the same file.
    const recentErrorToasts = new Map<string, number>()
    const ERROR_TOAST_DEDUP_MS = 5000

    function dedupedErrorToast(key: string, title: string, description?: string) {
      const now = Date.now()
      const last = recentErrorToasts.get(key)
      if (last && now - last < ERROR_TOAST_DEDUP_MS) return
      recentErrorToasts.set(key, now)
      showToast({
        variant: "error",
        title,
        description,
        copyText: description,
      })
    }

    // Periodically prune stale entries from the dedup map
    const dedupTimer = setInterval(() => {
      const now = Date.now()
      for (const [k, t] of recentErrorToasts) {
        if (now - t >= ERROR_TOAST_DEDUP_MS) recentErrorToasts.delete(k)
      }
    }, ERROR_TOAST_DEDUP_MS)
    onCleanup(() => clearInterval(dedupTimer))

    const setLoadError = (file: string, message: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = false
          draft.error = message
        }),
      )
      dedupedErrorToast(`load:${file}`, language.t("toast.file.loadFailed.title"), message)
    }

    const load = (input: string, options?: { force?: boolean }) => {
      const file = path.normalize(input)
      if (!file) return Promise.resolve()

      const directory = scope()
      const key = `${directory}\n${file}`
      ensure(file)

      const current = store.file[file]
      if (!options?.force && current?.loaded) return Promise.resolve()

      // 代次：每次 load 自增；force 不被去重拦截，但只有最新代次能写回。
      const seq = (loadSeq.get(key) ?? 0) + 1
      loadSeq.set(key, seq)

      if (!options?.force) {
        const pending = inflight.get(key)
        if (pending) return pending
      }

      setLoading(file)

      // P2: preview-only binaries (pdf/doc/xls/image/svg) bypass the
      // editable-text load entirely — <FilePreview> fetches their bytes
      // independently via props.read, so we must NOT pull them through
      // the store/LRU/CodeMirror path. Skip the backend read here to
      // avoid a wasteful base64 encode + transfer; just flag as loaded.
      const capEarly = getCapability(file)
      if (capEarly?.previewable && !capEarly.textBased) {
        setStore(
          "file",
          file,
          produce((draft) => {
            draft.loaded = true
            draft.loading = false
            draft.content = undefined
            draft.stale = false
            draft.loadedAt = Date.now()
          }),
        )
        return Promise.resolve()
      }

      // P2-1: Send read and readDiff requests in parallel so diff info
      // arrives sooner (no extra RTT waiting for read to resolve first).
      const contentPromise = sdk.client.file.read({ path: file })
      const diffPromise = sdk.client.file.readDiff({ path: file }).catch(() => null as any)

      const promise = contentPromise
        .then((x) => {
          if (scope() !== directory) {
            const currentEntry = store.file[file]
            if (currentEntry?.loading) {
              setStore(
                "file",
                file,
                produce((draft) => {
                  draft.loading = false
                }),
              )
            }
            return
          }
          const content = x.data

          if (loadSeq.get(key) !== seq) return
          setLoaded(file, content)

          if (!content) return
          touchFileContent(contentDir(), file, approxBytes(content))
          evictContent(new Set([file]))
        })
        .catch((e) => {
          if (scope() !== directory) {
            const currentEntry = store.file[file]
            if (currentEntry?.loading) {
              setStore(
                "file",
                file,
                produce((draft) => {
                  draft.loading = false
                }),
              )
            }
            return
          }
          if (loadSeq.get(key) === seq) {
            setLoadError(file, errorMessage(e, language.t("error.chain.unknown")))
          }
        })
        .finally(() => {
          if (loadSeq.get(key) === seq) inflight.delete(key)
        })

      // Diff is loaded asynchronously — failure is silently ignored;
      // content is already visible from the contentPromise above.
      // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
      diffPromise.then((x) => {
        if (scope() !== directory || !x?.data) return
        setStore(
          "file",
          file,
          produce((draft) => {
            if (draft.content && x.data) {
              draft.content.diff = x.data.diff
              draft.content.patch = x.data.patch
            }
          }),
        )
      })

      inflight.set(key, promise)
      return promise
    }

    const search = (query: string, dirs: "true" | "false") =>
      sdk.client.find.files({ query, dirs }).then(
        (x) => (x.data ?? []).map(path.normalize),
        () => [],
      )

    const save = (input: string, content: string) => {
      const file = path.normalize(input)
      if (!file) return Promise.resolve({ success: false, error: "Invalid file path" } as const)

      return sdk.client.file
        .write({ path: file, content })
        .then((x) => {
          const result = x.data
          if (result?.success) {
            // Force reload file content cache after write
            void load(file, { force: true })
            return { success: true as const, path: result.path }
          }
          return { success: false as const, error: "Write failed" }
        })
        .catch((e) => {
          console.error("[file] save failed", { path: file, error: e })
          const message = errorMessage(e, language.t("error.chain.unknown"))
          dedupedErrorToast(`save:${file}`, language.t("toast.file.saveFailed.title"), message)
          return { success: false as const, error: message }
        })
    }

    const createDirectory = (input: string) => {
      const dir = path.normalize(input)
      if (!dir) return Promise.resolve({ success: false, error: "Invalid directory path" } as const)

      return sdk.client.file
        .mkdir({ path: dir })
        .then((x) => {
          const result = x.data
          if (result?.success) {
            return { success: true as const, path: result.path }
          }
          return { success: false as const, error: "Failed to create directory" }
        })
        .catch((e: any) => {
          console.error("[file] mkdir failed", { path: dir, error: e })
          const message = errorMessage(e, language.t("error.chain.unknown"))
          return { success: false as const, error: message }
        })
    }

    const remove = (input: string) => {
      const filePath = path.normalize(input)
      if (!filePath) {
        showToast({ variant: "error", title: language.t("contextMenu.fileTree.deleteFailed"), description: "Invalid file path" })
        return Promise.resolve({ success: false, error: "Invalid file path" } as const)
      }

      return (sdk.client as any).client
        .delete({
          url: "/file",
          query: { path: filePath },
        })
        .then((x: any) => {
          const result = x.data
          if (result?.success) {
            const lastSlash = filePath.lastIndexOf("/")
            const parentDir = lastSlash > 0 ? filePath.substring(0, lastSlash) : ""
            void activeTree().listDir(parentDir, { force: true })
            tabs.close(path.tab(filePath))
            return { success: true as const, path: result.path }
          }
          // Rejected without an exception (HTTP 200 + success:false) — the
          // catch below never runs, so surface it here. All callers (single
          // and multi-select delete) get exactly one toast per failure.
          showToast({ variant: "error", title: language.t("contextMenu.fileTree.deleteFailed"), description: "Delete failed" })
          return { success: false as const, error: "Delete failed" }
        })
        .catch((e: any) => {
          console.error("[file] delete failed", { path: filePath, error: e })
          const message = errorMessage(e, language.t("error.chain.unknown"))
          showToast({ variant: "error", title: language.t("contextMenu.fileTree.deleteFailed"), description: message })
          return { success: false as const, error: message }
        })
    }

    const rename = (oldPath: string, newPath: string) => {
      const resolvedOldPath = path.normalize(oldPath)
      const resolvedNewPath = path.normalize(newPath)
      if (!resolvedOldPath || !resolvedNewPath) {
        showToast({ variant: "error", title: language.t("common.renameFailed"), description: "Invalid file path" })
        return Promise.resolve({ success: false, error: "Invalid file path" } as const)
      }

      return (sdk.client as any).client
        .patch({
          url: "/file/rename",
          body: { oldPath: resolvedOldPath, newPath: resolvedNewPath },
          headers: { "content-type": "application/json" },
        })
        .then((x: any) => {
          const result = x.data
          if (result?.success) {
            const lastSlash = resolvedOldPath.lastIndexOf("/")
            const parentDir = lastSlash > 0 ? resolvedOldPath.substring(0, lastSlash) : ""
            void activeTree().listDir(parentDir, { force: true })
            return { success: true as const, oldPath: result.oldPath, newPath: result.newPath }
          }
          // Rejected without an exception (HTTP 200 + success:false) — the
          // catch below never runs, so surface it here. All callers get
          // exactly one toast per failure.
          showToast({ variant: "error", title: language.t("common.renameFailed"), description: "Rename failed" })
          return { success: false as const, error: "Rename failed" }
        })
        .catch((e: any) => {
          console.error("[file] rename failed", { oldPath: resolvedOldPath, newPath: resolvedNewPath, error: e })
          const message = errorMessage(e, language.t("error.chain.unknown"))
          showToast({ variant: "error", title: language.t("common.renameFailed"), description: message })
          return { success: false as const, error: message }
        })
    }

    // Throttle watcher-triggered invalidations per path to avoid rapid re-fetches
    const invalidateThrottleMap = new Map<string, number>()
    const INVALIDATE_THROTTLE_MS = 300

    const throttledInvalidate = (key: string, fn: () => void) => {
      const now = Date.now()
      const last = invalidateThrottleMap.get(key) ?? 0
      if (now - last < INVALIDATE_THROTTLE_MS) return
      invalidateThrottleMap.set(key, now)
      fn()
    }

    const stop = sdk.event.listen((e) => {
      if (e.details.type === "file.watcher.unavailable") {
        showToast({
          title: language.t("file.watcher.unavailable.title"),
          description: language.t("file.watcher.unavailable.description"),
        })
        return
      }
      invalidateFromWatcher(e.details, {
        normalize: path.normalize,
        hasFile: (file) => Boolean(store.file[file]),
        isOpen: (file) => tabs.all().some((tab) => path.pathFromTab(tab) === file),
        loadFile: (file) => {
          // All open tabs get immediate reload so external editor changes
          // are visible in real time.  The backend flushEvents debounce (100ms)
          // already coalesces rapid events, so no frontend throttle is needed.
          void load(file, { force: true })
        },
        node: activeTree().node,
        isDirLoaded: activeTree().isLoaded,
        refreshDir: (dir) => throttledInvalidate(`dir:${dir}`, () => void activeTree().listDir(dir, { force: true })),
        reloadOpenFiles: () => {
          const openTabs = tabs.all()
          for (const tab of openTabs) {
            const file = path.pathFromTab(tab)
            if (!file) continue
            void load(file, { force: true })
          }
        },
        closeTab: (file) => tabs.close(path.tab(file)),
        closeTabsUnder: (dirPath) => {
          const prefix = dirPath + "/"
          const openTabs = tabs.all()
          for (const tab of openTabs) {
            const file = path.pathFromTab(tab)
            if (file && (file === dirPath || file.startsWith(prefix))) {
              tabs.close(path.tab(file))
            }
          }
        },
      })
    })

    // When the page becomes visible again (user switches back from another
    // tab or window), mark all open files as stale. This catches changes
    // that occurred while SSE events may have been throttled or lost.
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return
      const openTabs = tabs.all()
      const activeTab = tabs.active()
      const activePath = activeTab ? path.pathFromTab(activeTab) : undefined
      batch(() => {
        for (const tab of openTabs) {
          const file = path.pathFromTab(tab)
          if (!file) continue
          if (file === activePath) continue // active tab will reload via watcher
          if (store.file[file]?.loaded) {
            setStore("file", file, "stale", true)
          }
        }
      })
    }
    document.addEventListener("visibilitychange", handleVisibility)
    onCleanup(() => document.removeEventListener("visibilitychange", handleVisibility))

    const get = (input: string) => {
      const file = path.normalize(input)
      const state = store.file[file]
      const content = state?.content
      if (!content) return state
      if (hasFileContent(contentDir(), file)) {
        touchFileContent(contentDir(), file)
        return state
      }
      touchFileContent(contentDir(), file, approxBytes(content))
      return state
    }

    function withPath(input: string, action: (file: string) => unknown) {
      return action(path.normalize(input))
    }
    const scrollTop = (input: string) => withPath(input, (file) => view().scrollTop(file))
    const scrollLeft = (input: string) => withPath(input, (file) => view().scrollLeft(file))
    const selectedLines = (input: string) => withPath(input, (file) => view().selectedLines(file))
    const setScrollTop = (input: string, top: number) => withPath(input, (file) => view().setScrollTop(file, top))
    const setScrollLeft = (input: string, left: number) => withPath(input, (file) => view().setScrollLeft(file, left))
    const setSelectedLines = (input: string, range: SelectedLineRange | null) =>
      withPath(input, (file) => view().setSelectedLines(file, range))

    onCleanup(() => {
      stop()
      viewCache.clear()
    })

    return {
      ready: () => view().ready(),
      normalize: path.normalize,
      tab: path.tab,
      pathFromTab: path.pathFromTab,
      tree: {
        list: (dir: string, opts?: { force?: boolean }) => activeTree().listDir(dir, opts),
        refresh: (input: string) => activeTree().listDir(input, { force: true }),
        state: (input: string) => activeTree().dirState(input),
        children: (input: string) => activeTree().children(input),
        node: (path: string) => activeTree().node(path),
        expand: (input: string) => activeTree().expandDir(input),
        collapse: (input: string) => activeTree().collapseDir(input),
        toggle(input: string) {
          const tree = activeTree()
          if (tree.dirState(input)?.expanded) {
            tree.collapseDir(input)
            return
          }
          tree.expandDir(input)
        },
      },
      get,
      load,
      save,
      createDirectory,
      remove,
      rename,
      copy: (sourcePath: string, destinationPath: string) => {
        const resolvedSource = path.normalize(sourcePath)
        const resolvedDest = path.normalize(destinationPath)
        if (!resolvedSource || !resolvedDest)
          return Promise.resolve({ success: false, error: "Invalid file path" } as const)

        return (sdk.client as any).client
          .post({
            url: "/file/copy",
            body: JSON.stringify({ sourcePath: resolvedSource, destinationPath: resolvedDest }),
            headers: { "content-type": "application/json" },
          })
          .then((x: any) => {
            const result = x.data
            if (result?.success) {
              const lastSlash = resolvedDest.lastIndexOf("/")
              const parentDir = lastSlash > 0 ? resolvedDest.substring(0, lastSlash) : ""
              void activeTree().listDir(parentDir, { force: true })
              return { success: true as const, sourcePath: result.sourcePath, destinationPath: result.destinationPath }
            }
            return { success: false as const, error: "Copy failed" }
          })
          .catch((e: any) => {
            console.error("[file] copy failed", { sourcePath: resolvedSource, destinationPath: resolvedDest, error: e })
            const message = errorMessage(e, language.t("error.chain.unknown"))
            showToast({ variant: "error", title: "Copy failed", description: message })
            return { success: false as const, error: message }
          })
      },
      scrollTop,
      scrollLeft,
      setScrollTop,
      setScrollLeft,
      selectedLines,
      setSelectedLines,
      searchFiles: (query: string) => search(query, "false"),
      searchFilesAndDirectories: (query: string) => search(query, "true"),
    }
  },
})
