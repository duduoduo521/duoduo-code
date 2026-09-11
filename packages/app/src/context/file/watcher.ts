import type { FileNode } from "@duoduo-ai/sdk/v2"

type WatcherEvent = {
  type: string
  properties: unknown
}

type WatcherOps = {
  normalize: (input: string) => string
  hasFile: (path: string) => boolean
  isOpen?: (path: string) => boolean
  loadFile: (path: string) => void
  node: (path: string) => FileNode | undefined
  isDirLoaded: (path: string) => boolean
  refreshDir: (path: string) => void
  reloadOpenFiles: () => void
  closeTab?: (path: string) => void
  closeTabsUnder?: (dirPath: string) => void
}

export function invalidateFromWatcher(event: WatcherEvent, ops: WatcherOps) {
  if (event.type !== "file.watcher.updated") return
  const props =
    typeof event.properties === "object" && event.properties ? (event.properties as Record<string, unknown>) : undefined
  const rawPath = typeof props?.file === "string" ? props.file : undefined
  const kind = typeof props?.event === "string" ? props.event : undefined
  if (!rawPath) return
  if (!kind) return

  const path = ops.normalize(rawPath)
  if (path == null) return
  if (path && path.startsWith(".git/")) return

  if (ops.hasFile(path) || ops.isOpen?.(path)) {
    ops.loadFile(path)
  }

  if (kind === "change") {
    const dir = (() => {
      // Root path normalizes to "" — always refresh root
      if (path === "") return ""
      // If the path itself is a loaded directory, refresh it directly
      const node = ops.node(path)
      if (node?.type === "directory") return path
      // File change: refresh the parent directory so newly created sibling
      // files (e.g. from Agent writes) appear in the tree.
      return path.split("/").slice(0, -1).join("/")
    })()
    if (!ops.isDirLoaded(dir)) return
    ops.refreshDir(dir)

    // Root-level change means a bulk refresh (e.g., pipeline completed).
    // Reload all open files so editor content stays in sync with disk.
    if (path === "") {
      ops.reloadOpenFiles()
    }
    return
  }
  if (kind !== "add" && kind !== "unlink") return

  const parent = path.split("/").slice(0, -1).join("/")
  if (!ops.isDirLoaded(parent)) return

  if (kind === "unlink") {
    ops.closeTab?.(path)
    const node = ops.node(path)
    if (node?.type === "directory") {
      ops.closeTabsUnder?.(path)
    }
  }

  ops.refreshDir(parent)
}
