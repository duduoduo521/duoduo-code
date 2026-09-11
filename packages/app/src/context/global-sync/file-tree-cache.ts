import { createRoot } from "solid-js"
import { createFileTreeStore } from "@/context/file/tree-store"
import { createPathHelpers } from "@/context/file/path"
import type { DuoDuoClient } from "@duoduo-ai/sdk/v2/client"

export type FileTreeEntry = {
  store: ReturnType<typeof createFileTreeStore>
  pathHelpers: ReturnType<typeof createPathHelpers>
  dispose: () => void
}

const cache = new Map<string, FileTreeEntry>()

export function getOrCreateFileTree(directory: string, client: DuoDuoClient): FileTreeEntry {
  const existing = cache.get(directory)
  if (existing) return existing

  const pathHelpers = createPathHelpers(() => directory)

  let entry: FileTreeEntry

  const dispose = createRoot((rootDispose) => {
    const store = createFileTreeStore({
      scope: () => directory,
      normalizeDir: pathHelpers.normalizeDir,
      list: (dir: string) => client.file.list({ path: dir }).then((x) => x.data ?? []),
      onError: () => {
        // Global cache does not show toasts — the active FileProvider
        // handles error presentation for the current project.
      },
    })

    entry = { store, pathHelpers, dispose: rootDispose }
    return rootDispose
  })

  cache.set(directory, entry!)
  return entry!
}

export function getFileTree(directory: string): FileTreeEntry | undefined {
  return cache.get(directory)
}

export function disposeFileTree(directory: string): boolean {
  const entry = cache.get(directory)
  if (!entry) return false
  entry.dispose()
  cache.delete(directory)
  return true
}
