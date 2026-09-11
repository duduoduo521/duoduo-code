import { useFile } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import { Collapsible } from "@duoduo-ai/ui/collapsible"
import { ContextMenu } from "@duoduo-ai/ui/context-menu"
import { FileIcon } from "@duoduo-ai/ui/file-icon"
import { Icon } from "@duoduo-ai/ui/icon"
import { Spinner } from "@duoduo-ai/ui/spinner"
import { Tooltip } from "@duoduo-ai/ui/tooltip"
import { showToast } from "@duoduo-ai/ui/toast"
import { remoteSyncStatus } from "@/utils/remote-resync"
import { DialogConfirm } from "@/components/dialog-confirm"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { Button } from "@duoduo-ai/ui/button"
import { TextField } from "@duoduo-ai/ui/text-field"
import {
  createEffect,
  createSignal,
  createMemo,
  For,
  Match,
  on,
  Show,
  splitProps,
  Switch,
  untrack,
  type ComponentProps,
  type ParentProps,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import type { FileNode } from "@duoduo-ai/sdk/v2"

type FileClipboard = {
  paths: string[]
  mode: "copy" | "cut"
}

const [fileClipboard, setFileClipboard] = createStore<FileClipboard>({ paths: [], mode: "copy" })

export function getFileClipboard() {
  return fileClipboard
}

export function clearFileClipboard() {
  setFileClipboard({ paths: [], mode: "copy" })
}

const MAX_DEPTH = 128
/** Maximum number of child nodes rendered per directory level.
 *  Prevents DOM explosion when a directory contains thousands of entries. */
const MAX_RENDER_NODES = 100

function pathToFileUrl(filepath: string): string {
  return `file://${encodeFilePath(filepath)}`
}

type Kind = "add" | "del" | "mix"

type Filter = {
  files: Set<string>
  dirs: Set<string>
}

export function shouldListRoot(input: { level: number; dir?: { loaded?: boolean; loading?: boolean } }) {
  if (input.level !== 0) return false
  if (input.dir?.loaded) return false
  if (input.dir?.loading) return false
  return true
}

export function shouldListExpanded(input: {
  level: number
  dir?: { expanded?: boolean; loaded?: boolean; loading?: boolean }
}) {
  if (input.level === 0) return false
  if (!input.dir?.expanded) return false
  if (input.dir.loaded) return false
  if (input.dir.loading) return false
  return true
}

export function dirsToExpand(input: {
  level: number
  filter?: { dirs: Set<string> }
  expanded: (dir: string) => boolean
}) {
  if (input.level !== 0) return []
  if (!input.filter) return []
  return [...input.filter.dirs].filter((dir) => !input.expanded(dir))
}

const kindLabel = (kind: Kind) => {
  if (kind === "add") return "A"
  if (kind === "del") return "D"
  return "M"
}

const kindTextColor = (kind: Kind) => {
  if (kind === "add") return "color: var(--icon-diff-add-base)"
  if (kind === "del") return "color: var(--icon-diff-delete-base)"
  return "color: var(--icon-diff-modified-base)"
}

const kindDotColor = (kind: Kind) => {
  if (kind === "add") return "background-color: var(--icon-diff-add-base)"
  if (kind === "del") return "background-color: var(--icon-diff-delete-base)"
  return "background-color: var(--icon-diff-modified-base)"
}

const visibleKind = (node: FileNode, kinds?: ReadonlyMap<string, Kind>, marks?: Set<string>) => {
  const kind = kinds?.get(node.path)
  if (!kind) return
  if (!marks?.has(node.path)) return
  return kind
}

const buildDragImage = (target: HTMLElement) => {
  const icon = target.querySelector('[data-component="file-icon"]') ?? target.querySelector("svg")
  const text = target.querySelector("span")
  if (!icon || !text) return

  const image = document.createElement("div")
  image.className =
    "flex items-center gap-x-2 px-2 py-1 bg-surface-raised-base rounded-md border border-border-base text-12-regular text-text-strong"
  image.style.position = "absolute"
  image.style.top = "-1000px"
  image.innerHTML = (icon as SVGElement).outerHTML + (text).outerHTML
  return image
}

const withFileDragImage = (event: DragEvent) => {
  const image = buildDragImage(event.currentTarget as HTMLElement)
  if (!image) return
  document.body.appendChild(image)
  event.dataTransfer?.setDragImage(image, 0, 12)
  setTimeout(() => document.body.removeChild(image), 0)
}

/**
 * Get the parent directory path from a relative file path.
 * e.g. "src/components/foo.ts" → "src/components"
 */
function parentDir(filePath: string): string {
  const idx = filePath.lastIndexOf("/")
  if (idx === -1) return ""
  return filePath.slice(0, idx)
}

const FileTreeNode = (
  p: ParentProps &
    ComponentProps<"div"> &
    ComponentProps<"button"> & {
      node: FileNode
      level: number
      active?: string
      selectedPaths?: Set<string>
      nodeClass?: string
      draggable: boolean
      kinds?: ReadonlyMap<string, Kind>
      marks?: Set<string>
      as?: "div" | "button"
      /** Callback when this node should be selected (e.g. right-click on unselected node) */
      onNodeSelect?: (path: string) => void
      /** Callbacks for file tree context menu actions */
      onCopyPath?: (path: string | string[]) => void
      onCopyRelativePath?: (path: string | string[]) => void
      onCopyFileContent?: (path: string) => void
      onRevealInFileManager?: (path: string) => void
      onNewFile?: (dir: string) => void
      onNewFolder?: (dir: string) => void
      onRefresh?: (path: string) => void
      onDelete?: (path: string | string[]) => void
      onRename?: (path: string) => void
      onAddToChat?: (path: string | string[]) => void
      onCutFile?: (path: string | string[]) => void
    },
) => {
  const language = useLanguage()
  const [local, rest] = splitProps(p, [
    "node",
    "level",
    "active",
    "selectedPaths",
    "nodeClass",
    "draggable",
    "kinds",
    "marks",
    "as",
    "onNodeSelect",
    "children",
    "class",
    "classList",
    "onCopyPath",
    "onCopyRelativePath",
    "onCopyFileContent",
    "onRevealInFileManager",
    "onNewFile",
    "onNewFolder",
    "onRefresh",
    "onDelete",
    "onRename",
    "onAddToChat",
    "onCutFile",
  ])
  const kind = () => visibleKind(local.node, local.kinds, local.marks)
  const active = () => !!kind() && !local.node.ignored
  const color = () => {
    const value = kind()
    if (!value) return
    return kindTextColor(value)
  }

  /** Whether this node is part of a multi-selection (2+ items) */
  const isMultiSelected = () =>
    !!local.selectedPaths && local.selectedPaths.size > 1 && local.selectedPaths.has(local.node.path)

  /** Get all selected paths as array, or just this node's path if not multi-selected */
  const getSelectedPaths = (): string[] => (isMultiSelected() ? Array.from(local.selectedPaths!) : [local.node.path])

  return (
    <ContextMenu>
      <ContextMenu.Trigger>
        <Dynamic
          component={local.as ?? "div"}
          classList={{
            "w-full min-w-0 h-6 flex items-center justify-start gap-x-1.5 rounded-md px-1.5 py-0 text-left hover:bg-surface-raised-base-hover active:bg-surface-base-active transition-colors cursor-pointer": true,
            "bg-surface-interactive-base":
              local.selectedPaths && local.selectedPaths.size > 0
                ? local.selectedPaths.has(local.node.path)
                : local.node.path === local.active,
            ...local.classList,
            [local.class ?? ""]: !!local.class,
            [local.nodeClass ?? ""]: !!local.nodeClass,
          }}
          style={`padding-left: ${8 + (local.level + 1) * 12 - 4}px`}
          draggable={local.draggable}
          onDragStart={(event: DragEvent) => {
            if (!local.draggable) return
            event.dataTransfer?.setData("application/x-duoduo-tree", local.node.path)
            event.dataTransfer?.setData("text/plain", `file:${local.node.path}`)
            event.dataTransfer?.setData("text/uri-list", pathToFileUrl(local.node.path))
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove"
            withFileDragImage(event)
          }}
          onContextMenu={(e: MouseEvent) => {
            // Right-click: if this node is not in current selection, select only it
            const selected = local.selectedPaths
            if (!selected || !selected.has(local.node.path)) {
              local.onNodeSelect?.(local.node.path)
            }
          }}
          {...rest}
        >
          {local.children}
          <span
            classList={{
              "flex-1 min-w-0 text-12-medium whitespace-nowrap truncate": true,
              "text-text-weaker": local.node.ignored,
              "text-text-weak": !local.node.ignored && !active(),
            }}
            style={active() ? color() : undefined}
          >
            {local.node.name}
          </span>
          {(() => {
            const value = kind()
            if (!value) return null
            if (local.node.type === "file") {
              return (
                <span class="shrink-0 w-4 text-center text-12-medium" style={kindTextColor(value)}>
                  {kindLabel(value)}
                </span>
              )
            }
            return <div class="shrink-0 size-1.5 mr-1.5 rounded-full" style={kindDotColor(value)} />
          })()}
        </Dynamic>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          <Switch>
            <Match when={local.node.type === "file"}>
              {/* ─── File context menu ─── */}
              <Show when={local.onAddToChat}>
                <ContextMenu.Item
                  onSelect={() => local.onAddToChat?.(isMultiSelected() ? getSelectedPaths() : local.node.path)}
                >
                  <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.addToChat")}</ContextMenu.ItemLabel>
                </ContextMenu.Item>
              </Show>
              <ContextMenu.Separator />
              <ContextMenu.Item
                onSelect={() => local.onCopyPath?.(isMultiSelected() ? getSelectedPaths() : local.node.path)}
              >
                <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.copyPath")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Item
                onSelect={() => local.onCopyRelativePath?.(isMultiSelected() ? getSelectedPaths() : local.node.path)}
              >
                <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.copyRelativePath")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={() => local.onCopyFileContent?.(local.node.path)}>
                <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.copyFileContent")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Separator />
              <Show when={local.onCutFile}>
                <ContextMenu.Item
                  onSelect={() => local.onCutFile?.(isMultiSelected() ? getSelectedPaths() : local.node.path)}
                >
                  <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.cut")}</ContextMenu.ItemLabel>
                </ContextMenu.Item>
              </Show>
              <ContextMenu.Item
                onSelect={() => local.onDelete?.(isMultiSelected() ? getSelectedPaths() : local.node.path)}
              >
                <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.delete")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={() => local.onRename?.(local.node.path)}>
                <ContextMenu.ItemLabel>{language.t("common.rename")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <Show when={local.onRevealInFileManager}>
                <ContextMenu.Item onSelect={() => local.onRevealInFileManager?.(local.node.path)}>
                  <ContextMenu.ItemLabel>
                    {language.t("contextMenu.fileTree.revealInFileManager")}
                  </ContextMenu.ItemLabel>
                </ContextMenu.Item>
              </Show>
            </Match>
            <Match when={local.node.type === "directory"}>
              {/* ─── Directory context menu ─── */}
              <ContextMenu.Item onSelect={() => local.onNewFile?.(local.node.path)}>
                <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.newFile")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={() => local.onNewFolder?.(local.node.path)}>
                <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.newFolder")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item
                onSelect={() => local.onCopyPath?.(isMultiSelected() ? getSelectedPaths() : local.node.path)}
              >
                <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.copyPath")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Item
                onSelect={() => local.onCopyRelativePath?.(isMultiSelected() ? getSelectedPaths() : local.node.path)}
              >
                <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.copyRelativePath")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Separator />
              <Show when={local.onRevealInFileManager}>
                <ContextMenu.Item onSelect={() => local.onRevealInFileManager?.(local.node.path)}>
                  <ContextMenu.ItemLabel>
                    {language.t("contextMenu.fileTree.revealInFileManager")}
                  </ContextMenu.ItemLabel>
                </ContextMenu.Item>
              </Show>
              <ContextMenu.Item onSelect={() => local.onRefresh?.(local.node.path)}>
                <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.refresh")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item
                onSelect={() => local.onDelete?.(isMultiSelected() ? getSelectedPaths() : local.node.path)}
              >
                <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.delete")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={() => local.onRename?.(local.node.path)}>
                <ContextMenu.ItemLabel>{language.t("common.rename")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
            </Match>
          </Switch>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}

export default function FileTree(props: {
  path: string
  class?: string
  showRoot?: boolean
  nodeClass?: string
  active?: string
  level?: number
  allowed?: readonly string[]
  modified?: readonly string[]
  kinds?: ReadonlyMap<string, Kind>
  draggable?: boolean
  onFileClick?: (file: FileNode) => void
  onAddToChat?: (path: string | string[]) => void
  onCutFile?: (path: string | string[]) => void
  onCopyFile?: (path: string | string[]) => void
  onPasteFile?: (targetDir: string) => void
  onDeleteFile?: (path: string | string[]) => void
  onFileDrop?: (sourcePath: string, targetDir: string) => void

  _filter?: Filter
  _marks?: Set<string>
  _deeps?: Map<string, number>
  _kinds?: ReadonlyMap<string, Kind>
  _chain?: readonly string[]
  _selectedPaths?: Set<string>
  _lastClickedPath?: string | null
  _onSelect?: (path: string, ctrlKey: boolean, shiftKey: boolean) => void
  _onClearSelection?: () => void
}) {
  const file = useFile()
  const language = useLanguage()
  const platform = usePlatform()
  const sdk = useSDK()
  const globalSync = useGlobalSync()

  const level = props.level ?? 0
  const showRootNode = () => props.showRoot === true
  const [rootExpanded, setRootExpanded] = createSignal(true)
  const projectRootName = () => {
    const dir = sdk.directory
    // SSH (Plan C) projects root the file tree at the local mirror, whose last
    // segment is the base64url-encoded remote path — meaningless to the user.
    // Prefer the real remote path's last segment, matching `displayName` in
    // pages/layout/helpers.ts.
    const [child] = globalSync.child(dir)
    const project = child?.project
      ? globalSync.data.project.find((p) => p.id === child.project)
      : undefined
    const source = project?.remote?.remotePath || dir
    return source.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? source
  }
  const draggable = () => props.draggable ?? true
  const [contextMenuDir, setContextMenuDir] = createSignal(props.path)

  const key = (p: string) =>
    file
      .normalize(p)
      .replace(/[\\/]+$/, "")
      .replaceAll("\\", "/")
  const chain = props._chain ? [...props._chain, key(props.path)] : [key(props.path)]

  const filter = createMemo(() => {
    if (props._filter) return props._filter

    const allowed = props.allowed
    if (!allowed) return

    const files = new Set(allowed)
    const dirs = new Set<string>()

    for (const item of allowed) {
      const parts = item.split("/")
      const parents = parts.slice(0, -1)
      for (const [idx] of parents.entries()) {
        const dir = parents.slice(0, idx + 1).join("/")
        if (dir) dirs.add(dir)
      }
    }

    return { files, dirs }
  })

  const marks = createMemo(() => {
    if (props._marks) return props._marks

    const out = new Set<string>()
    for (const item of props.modified ?? []) out.add(item)
    for (const item of props.kinds?.keys() ?? []) out.add(item)
    if (out.size === 0) return
    return out
  })

  const kinds = createMemo(() => {
    if (props._kinds) return props._kinds
    return props.kinds
  })

  const deeps = createMemo(() => {
    if (props._deeps) return props._deeps

    const out = new Map<string, number>()

    const root = props.path
    if (!(file.tree.state(root)?.expanded ?? false)) return out

    const seen = new Set<string>()
    const stack: { dir: string; lvl: number; i: number; kids: string[]; max: number }[] = []

    const push = (dir: string, lvl: number) => {
      const id = key(dir)
      if (seen.has(id)) return
      seen.add(id)

      const kids = file.tree
        .children(dir)
        .filter((node) => node.type === "directory" && (file.tree.state(node.path)?.expanded ?? false))
        .map((node) => node.path)

      stack.push({ dir, lvl, i: 0, kids, max: lvl })
    }

    push(root, level - 1)

    // Early-terminate: only traverse up to MAX_RENDER_NODES directories per level
    // to avoid expensive deep-tree walks when the tree is very large.
    let traversed = 0

    while (stack.length > 0) {
      const top = stack[stack.length - 1]!

      if (top.i < top.kids.length) {
        if (traversed >= MAX_RENDER_NODES) {
          // Flush remaining stack entries with their current max
          while (stack.length > 0) {
            const entry = stack.pop()!
            out.set(entry.dir, entry.max)
            const parent = stack[stack.length - 1]
            if (parent) parent.max = Math.max(parent.max, entry.max)
          }
          break
        }
        const next = top.kids[top.i]!
        top.i++
        traversed++
        push(next, top.lvl + 1)
        continue
      }

      out.set(top.dir, top.max)
      stack.pop()

      const parent = stack[stack.length - 1]
      if (!parent) continue
      parent.max = Math.max(parent.max, top.max)
    }

    return out
  })

  createEffect(() => {
    const current = filter()
    const dirs = dirsToExpand({
      level,
      filter: current,
      expanded: (dir) => untrack(() => file.tree.state(dir)?.expanded) ?? false,
    })
    for (const dir of dirs) file.tree.expand(dir)
  })

  createEffect(
    on(
      () => [props.path, sdk.directory] as const,
      ([path]) => {
        const dir = untrack(() => file.tree.state(path))
        if (!shouldListRoot({ level, dir })) return
        void file.tree.list(path)
      },
      { defer: false },
    ),
  )

  const nodes = createMemo(() => {
    const nodes = file.tree.children(props.path)
    const current = filter()
    if (!current) return nodes

    const parent = (path: string) => {
      const idx = path.lastIndexOf("/")
      if (idx === -1) return ""
      return path.slice(0, idx)
    }

    const leaf = (path: string) => {
      const idx = path.lastIndexOf("/")
      return idx === -1 ? path : path.slice(idx + 1)
    }

    const out = nodes.filter((node) => {
      if (node.type === "file") return current.files.has(node.path)
      return current.dirs.has(node.path)
    })

    const seen = new Set(out.map((node) => node.path))

    for (const dir of current.dirs) {
      if (parent(dir) !== props.path) continue
      if (seen.has(dir)) continue
      out.push({
        name: leaf(dir),
        path: dir,
        absolute: dir,
        type: "directory",
        ignored: false,
      })
      seen.add(dir)
    }

    for (const item of current.files) {
      if (parent(item) !== props.path) continue
      if (seen.has(item)) continue
      out.push({
        name: leaf(item),
        path: item,
        absolute: item,
        type: "file",
        ignored: false,
      })
      seen.add(item)
    }

    out.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    return out
  })

  /** Nodes to render, capped at MAX_RENDER_NODES to prevent DOM explosion.
   *  Returns empty only during the very first load; subsequent (watcher-forced)
   *  refreshes keep the previously loaded rows visible (stale-while-revalidate)
   *  so the tree does not flicker when external tools modify files. */
  const visibleNodes = createMemo(() => {
    // Only blank out on the initial load. Once a directory has been loaded,
    // a re-fetch keeps showing the existing rows until fresh data arrives.
    const state = file.tree.state(props.path)
    if (state?.loading && !state?.loaded) return { items: [], overflow: 0 }
    const all = nodes()
    if (all.length <= MAX_RENDER_NODES) return { items: all, overflow: 0 }
    return { items: all.slice(0, MAX_RENDER_NODES), overflow: all.length - MAX_RENDER_NODES }
  })

  // ─── Context menu action handlers ───

  /** Get the project root (absolute) directory from the SDK scope */
  const projectRoot = () => sdk.directory

  /** Resolve a relative path to an absolute path.
   *  On Windows the root may contain backslashes (e.g. D:\xxx),
   *  while the relativePath always uses forward slashes from the API.
   *  We normalise to the platform separator so the result is a valid
   *  native path that Explorer and other OS tools can consume. */
  const toAbsolutePath = (relativePath: string) => {
    const root = projectRoot()
    if (!root) return relativePath
    // If already absolute, return as-is
    if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) return relativePath
    const joined = `${root}/${relativePath}`
    // Detect Windows root (contains backslash or drive-letter colon)
    // and normalise all separators to backslash for native OS commands.
    if (/^[A-Za-z]:/.test(root) || root.includes("\\")) {
      return joined.replace(/\//g, "\\")
    }
    return joined
  }

  const handleCopyPath = (relativePath: string | string[]) => {
    const paths = Array.isArray(relativePath) ? relativePath : [relativePath]
    const text = paths.map((p) => toAbsolutePath(p)).join(", ")
    navigator.clipboard.writeText(text).then(
      () => showToast({ variant: "success", title: language.t("common.copied") }),
      () => showToast({ variant: "error", title: language.t("common.copyFailed") }),
    )
  }

  const handleCopyRelativePath = (relativePath: string | string[]) => {
    const paths = Array.isArray(relativePath) ? relativePath : [relativePath]
    const text = paths.join(", ")
    navigator.clipboard.writeText(text).then(
      () => showToast({ variant: "success", title: language.t("common.copied") }),
      () => showToast({ variant: "error", title: language.t("common.copyFailed") }),
    )
  }

  const handleCopyFileContent = (relativePath: string) => {
    // Load the file and copy its content to the clipboard
    void file.load(relativePath).then(() => {
      const state = file.get(relativePath)
      const content = state?.content?.content
      if (content) {
        navigator.clipboard.writeText(content).then(
          () => showToast({ variant: "success", title: language.t("common.copied") }),
          () => showToast({ variant: "error", title: language.t("common.copyFailed") }),
        )
      } else {
        showToast({ variant: "error", title: language.t("common.copyFailed") })
      }
    })
  }

  const handleRevealInFileManager = (relativePath: string) => {
    if (!platform.openPath) return
    const root = projectRoot()
    if (!root) {
      showToast({ variant: "error", title: "Project root not found" })
      return
    }
    const absolute = toAbsolutePath(relativePath)
    if (!absolute) {
      showToast({ variant: "error", title: "Invalid path" })
      return
    }
    platform.openPath(absolute).catch((e: unknown) => {
      console.warn("Failed to reveal in file manager:", e)
      showToast({ variant: "error", title: language.t("contextMenu.fileTree.revealInFileManager") + " failed" })
    })
  }

  const handleNewFile = (dir: string) => {
    dialog.show(() => (
      <DialogPromptCreate
        title={language.t("contextMenu.fileTree.newFile")}
        onConfirm={(name) => {
          const newPath = dir ? `${dir}/${name}` : name
          void file
            .save(newPath, "")
            .then((result) => {
              if (result.success) {
                void file.tree.refresh(dir || "").catch(() => {})
                showToast({ variant: "success", title: "File created" })
              } else {
                showToast({ variant: "error", title: "Failed to create file" })
              }
            })
            .catch(() => {
              showToast({ variant: "error", title: "Failed to create file" })
            })
        }}
      />
    ))
  }

  const handleNewFolder = (dir: string) => {
    dialog.show(() => (
      <DialogPromptCreate
        title={language.t("contextMenu.fileTree.newFolder")}
        onConfirm={(name) => {
          const newPath = dir ? `${dir}/${name}` : name
          // Create a real empty directory via /file/mkdir. The old flow wrote a
          // .gitkeep placeholder through the write endpoint (its only purpose was
          // to make the write call create the parent dir) — that leaked a junk
          // file into every project, including SSH mirrors where it got synced
          // to the server.
          void file
            .createDirectory(newPath)
            .then((result) => {
              if (result.success) {
                void file.tree.refresh(dir || "").catch(() => {})
                showToast({ variant: "success", title: "Folder created" })
              } else {
                showToast({ variant: "error", title: "Failed to create folder" })
              }
            })
            .catch(() => {
              showToast({ variant: "error", title: "Failed to create folder" })
            })
        }}
      />
    ))
  }

  const handleRefresh = (dir: string) => {
    void file.tree.refresh(dir || "").catch(() => {})
  }

  const handleCollapseAll = () => {
    // Collapse all directories except root
    const root = props.path
    const dirState = file.tree.state(root)
    if (!dirState?.children) return
    // Recursively collapse all expanded directories
    const collapseRecursive = (parentPath: string) => {
      const children = file.tree.children(parentPath)
      for (const child of children) {
        if (child.type === "directory") {
          collapseRecursive(child.path)
          file.tree.collapse(child.path)
        }
      }
    }
    collapseRecursive(root)
  }

  const handleRevealRootInFileManager = () => {
    if (!platform.openPath) return
    const root = projectRoot()
    if (!root) {
      showToast({ variant: "error", title: "Project root not found" })
      return
    }
    platform.openPath(root).catch((e: unknown) => {
      console.warn("Failed to reveal in file manager:", e)
      showToast({ variant: "error", title: language.t("contextMenu.fileTree.revealInFileManager") + " failed" })
    })
  }

  const handleOpenInTerminal = () => {
    const root = projectRoot()
    if (!root) {
      showToast({ variant: "error", title: "Project root not found" })
      return
    }
    if (!platform.openPath) {
      showToast({ variant: "error", title: language.t("contextMenu.fileTree.openInTerminal") + " not supported" })
      return
    }
    platform.openPath(root, "terminal").catch((e: unknown) => {
      console.warn("Failed to open terminal:", e)
      showToast({ variant: "error", title: language.t("contextMenu.fileTree.openInTerminal") + " failed" })
    })
  }

  const handleFindInFolder = () => {
    // Dispatch a custom event that the search panel can listen to
    const searchEvent = new CustomEvent("duoduo:find-in-folder", { detail: { path: props.path } })
    window.dispatchEvent(searchEvent)
  }

  const dialog = useDialog()

  const handleDelete = (relativePath: string | string[]) => {
    const paths = Array.isArray(relativePath) ? relativePath : [relativePath]
    const names = paths.map((p) => p.split("/").pop() || p)
    dialog.show(() => (
      <DialogConfirmDeleteFile
        name={names.join(", ")}
        count={paths.length}
        onConfirm={async () => {
          const results = await Promise.allSettled(paths.map((p) => file.remove(p)))
          const succeeded = results.filter((r) => r.status === "fulfilled" && (r.value as { success: boolean }).success)
          if (succeeded.length > 0) {
            showToast({ variant: "success", title: language.t("contextMenu.fileTree.deleteSuccess") })
          }
          // Clear selection after deletion
          props._onClearSelection?.()
        }}
      />
    ))
  }

  const handleRename = (relativePath: string) => {
    const oldName = relativePath.split("/").pop() || relativePath
    dialog.show(() => (
      <DialogPromptRename
        title={language.t("common.rename")}
        defaultValue={oldName}
        onConfirm={(newName) => {
          const parentDir = relativePath.includes("/") ? relativePath.substring(0, relativePath.lastIndexOf("/")) : ""
          const newPath = parentDir ? `${parentDir}/${newName}` : newName
          void file.rename(relativePath, newPath).then((result: { success: boolean }) => {
            if (result.success) {
              showToast({ variant: "success", title: language.t("contextMenu.fileTree.renameSuccess") })
            }
          })
        }}
      />
    ))
  }

  // For level > 0 (nested inside parent directory), render without ContextMenu wrapper
  // to avoid nested context menu conflicts. The root-level ContextMenu covers the entire area.
  const handleTreeKeyDown = (e: KeyboardEvent) => {
    if (level !== 0) return
    // A sync must also block the keyboard: `pointer-events-none` only stops
    // hit-testing — it neither removes focus from this (tabindex=0) element nor
    // suppresses key events, so Delete / Ctrl+V would still mutate the tree.
    if (remoteSyncStatus() !== undefined) return
    const mod = e.metaKey || e.ctrlKey
    const selectedPaths = props._selectedPaths
    if (!selectedPaths || selectedPaths.size === 0) return
    const paths = Array.from(selectedPaths)

    if (mod && e.key === "c") {
      e.preventDefault()
      setFileClipboard({ paths, mode: "copy" })
      props.onCopyFile?.(paths.length > 1 ? paths : paths[0]!)
      return
    }
    if (mod && e.key === "x") {
      e.preventDefault()
      setFileClipboard({ paths, mode: "cut" })
      props.onCutFile?.(paths.length > 1 ? paths : paths[0]!)
      return
    }
    if (mod && e.key === "v") {
      e.preventDefault()
      if (fileClipboard.paths.length > 0) {
        const target = paths.length === 1 ? paths[0]! : props.path
        const node = file.tree.node(target)
        const dir = node?.type === "directory" ? target : target.split("/").slice(0, -1).join("")
        props.onPasteFile?.(dir)
      }
      return
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return
      e.preventDefault()
      props.onDeleteFile?.(paths.length > 1 ? paths : paths[0]!)
      return
    }
  }

  const isLoading = () =>
    level === 0 && file.tree.state(props.path)?.loading && file.tree.children(props.path).length === 0

  /** Root-level listing failure (HTTP error, unreadable/missing directory). */
  const rootError = () => (level === 0 ? file.tree.state(props.path)?.error : undefined)

  /** Root successfully listed but contains no visible entries. */
  const isEmptyRoot = () =>
    level === 0 &&
    !rootError() &&
    !isLoading() &&
    file.tree.state(props.path)?.loaded === true &&
    file.tree.children(props.path).length === 0

  const treeContent = (
    <div
      data-component="filetree"
      class={`flex flex-col gap-0.5 ${level === 0 ? "flex-1 min-h-full" : ""} ${props.class ?? ""}`}
      classList={{ "pointer-events-none opacity-60": level === 0 && remoteSyncStatus() !== undefined }}
      aria-disabled={level === 0 && remoteSyncStatus() !== undefined}
      aria-busy={level === 0 && remoteSyncStatus() !== undefined}
      onClick={(e: MouseEvent) => {
        // Click on blank area (not on a node) clears selection
        if (
          (e.target as HTMLElement).closest("[data-scope=filetree]") &&
          (e.target as HTMLElement).dataset.scope !== "filetree"
        )
          return
        if (e.target === e.currentTarget) {
          props._onClearSelection?.()
        }
      }}
      onContextMenu={() => {
        setContextMenuDir(props.path)
      }}
      onKeyDown={handleTreeKeyDown}
      tabindex={level === 0 ? 0 : undefined}
    >
      <Show when={isLoading()}>
        <div class="flex items-center justify-center py-4 text-text-weak">
          <Spinner class="size-4" />
        </div>
      </Show>
      <Show when={level === 0 && remoteSyncStatus() !== undefined}>
        <Tooltip
          placement="bottom"
          value={language.t(remoteSyncStatus() === "pull" ? "remote.pulling" : "remote.pushing")}
        >
          <div class="flex items-center gap-2 px-2 py-1 text-12-regular text-text-weak">
            <Spinner class="size-3" style={{ color: "var(--icon-interactive-base)" }} />
            {language.t(remoteSyncStatus() === "pull" ? "remote.pulling" : "remote.pushing")}
          </div>
        </Tooltip>
      </Show>
      <Show when={rootError()} keyed>
        {(err) => (
          <div class="flex flex-col items-start gap-1 px-2 py-2">
            <span class="w-full text-12-regular text-text-weak break-all" title={err}>
              {language.t("file.tree.listFailed")} — {err}
            </span>
            <Button
              variant="ghost"
              size="small"
              onClick={() => {
                void file.tree.refresh(props.path).catch(() => {})
              }}
            >
              {language.t("contextMenu.fileTree.refresh")}
            </Button>
          </div>
        )}
      </Show>
      <Show when={isEmptyRoot()}>
        <div class="px-2 py-2 text-12-regular text-text-weak">{language.t("file.tree.empty")}</div>
      </Show>
      <Show when={showRootNode() && level === 0}>
        <button
          type="button"
          class="flex items-center gap-1 w-full px-2 py-1 rounded-md text-12-medium text-text-strong hover:bg-surface-panel cursor-pointer"
          onClick={() => setRootExpanded(!rootExpanded())}
        >
          <span class="size-4 flex items-center justify-center text-icon-weak">
            <Icon name={rootExpanded() ? "chevron-down" : "chevron-right"} size="small" />
          </span>
          <FileIcon node={{ path: "", type: "directory" }} class="size-4 text-icon-base" />
          <span class="truncate">{projectRootName()}</span>
        </button>
      </Show>
      <Show when={showRootNode() && level === 0 ? rootExpanded() : true}>
        <For each={visibleNodes().items}>
        {(node) => {
          const expanded = () => file.tree.state(node.path)?.expanded ?? false
          const deep = () => deeps().get(node.path) ?? -1
          const kind = () => visibleKind(node, kinds(), marks())
          const active = () => !!kind() && !node.ignored

          return (
            <Switch>
              <Match when={node.type === "directory"}>
                <div
                  onDragOver={(e: DragEvent) => {
                    e.preventDefault()
                    if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
                    const el = e.currentTarget as HTMLElement | null
                    el?.setAttribute("data-drag-over", "")
                  }}
                  onDragLeave={(e: DragEvent) => {
                    const el = e.currentTarget as HTMLElement | null
                    el?.removeAttribute("data-drag-over")
                  }}
                  onDrop={(e: DragEvent) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const el = e.currentTarget as HTMLElement | null
                    el?.removeAttribute("data-drag-over")
                    const source = e.dataTransfer?.getData("text/plain")?.replace(/^file:/, "")
                    if (source && source !== node.path) {
                      props.onFileDrop?.(source, node.path)
                    }
                  }}
                >
                  <Collapsible
                    variant="ghost"
                    class="w-full"
                    data-scope="filetree"
                    forceMount={false}
                    open={expanded()}
                    onOpenChange={(open) => {
                      // If Ctrl/Cmd is held, don't toggle expansion - let click handler manage selection
                      // This is handled by the onClick in FileTreeNode
                      if (open) file.tree.expand(node.path)
                      else file.tree.collapse(node.path)
                    }}
                  >
                    <Collapsible.Trigger>
                      <FileTreeNode
                        node={node}
                        level={level}
                        active={props.active}
                        selectedPaths={props._selectedPaths}
                        nodeClass={props.nodeClass}
                        draggable={draggable()}
                        kinds={kinds()}
                        marks={marks()}
                        onNodeSelect={(_path: string) => props._onSelect?.(_path, false, false)}
                        onClick={(e: MouseEvent) => {
                          const ctrlKey = e.ctrlKey || e.metaKey
                          const shiftKey = e.shiftKey
                          if (ctrlKey || shiftKey) {
                            e.preventDefault()
                            e.stopPropagation()
                            props._onSelect?.(node.path, ctrlKey, shiftKey)
                          } else {
                            // Plain click: also select the directory (VSCode behavior)
                            props._onSelect?.(node.path, false, false)
                          }
                        }}
                        onCopyPath={handleCopyPath}
                        onCopyRelativePath={handleCopyRelativePath}
                        onRevealInFileManager={platform.openPath ? handleRevealInFileManager : undefined}
                        onNewFile={handleNewFile}
                        onNewFolder={handleNewFolder}
                        onRefresh={handleRefresh}
                        onDelete={handleDelete}
                        onRename={handleRename}
                        onAddToChat={props.onAddToChat}
                        onCutFile={props.onCutFile}
                      >
                        <div class="size-4 flex items-center justify-center text-icon-weak">
                          <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
                        </div>
                      </FileTreeNode>
                    </Collapsible.Trigger>
                    <Collapsible.Content class="relative pt-0.5">
                      <div
                        classList={{
                          "absolute top-0 bottom-0 w-px pointer-events-none bg-border-weak-base opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none": true,
                          "group-hover/filetree:opacity-100": expanded() && deep() === level,
                          "group-hover/filetree:opacity-50": !(expanded() && deep() === level),
                        }}
                        style={`left: ${8 + (level + 1) * 12 + 4}px`}
                      />
                      <Show
                        when={level < MAX_DEPTH && !chain.includes(key(node.path))}
                        fallback={<div class="px-2 py-1 text-12-regular text-text-weak">...</div>}
                      >
                        <FileTree
                          path={node.path}
                          level={level + 1}
                          allowed={props.allowed}
                          modified={props.modified}
                          kinds={props.kinds}
                          active={props.active}
                          draggable={props.draggable}
                          onFileClick={props.onFileClick}
                          _filter={filter()}
                          _marks={marks()}
                          _deeps={deeps()}
                          _kinds={kinds()}
                          _chain={chain}
                          _selectedPaths={props._selectedPaths}
                          _lastClickedPath={props._lastClickedPath}
                          _onSelect={props._onSelect}
                          _onClearSelection={props._onClearSelection}
                          onAddToChat={props.onAddToChat}
                          onCutFile={props.onCutFile}
                          onCopyFile={props.onCopyFile}
                          onPasteFile={props.onPasteFile}
                          onDeleteFile={props.onDeleteFile}
                          onFileDrop={props.onFileDrop}
                        />
                      </Show>
                    </Collapsible.Content>
                  </Collapsible>
                </div>
              </Match>
              <Match when={node.type === "file"}>
                <FileTreeNode
                  node={node}
                  level={level}
                  active={props.active}
                  selectedPaths={props._selectedPaths}
                  nodeClass={props.nodeClass}
                  draggable={draggable()}
                  kinds={kinds()}
                  marks={marks()}
                  onNodeSelect={(_path: string) => props._onSelect?.(_path, false, false)}
                  as="button"
                  type="button"
                  onClick={(e: MouseEvent) => {
                    const ctrlKey = e.ctrlKey || e.metaKey
                    const shiftKey = e.shiftKey
                    if (ctrlKey || shiftKey) {
                      e.preventDefault()
                      props._onSelect?.(node.path, ctrlKey, shiftKey)
                    } else {
                      props._onSelect?.(node.path, false, false)
                      props.onFileClick?.(node)
                    }
                  }}
                  onCopyPath={handleCopyPath}
                  onCopyRelativePath={handleCopyRelativePath}
                  onCopyFileContent={handleCopyFileContent}
                  onRevealInFileManager={platform.openPath ? handleRevealInFileManager : undefined}
                  onDelete={handleDelete}
                  onRename={handleRename}
                  onAddToChat={props.onAddToChat}
                  onCutFile={props.onCutFile}
                >
                  <Switch>
                    <Match when={node.ignored}>
                      <FileIcon
                        node={node}
                        class="size-4 filetree-icon filetree-icon--mono"
                        style="color: var(--icon-weak-base)"
                        mono
                      />
                    </Match>
                    <Match when={active()}>
                      <FileIcon
                        node={node}
                        class="size-4 filetree-icon filetree-icon--mono"
                        style={kindTextColor(kind()!)}
                        mono
                      />
                    </Match>
                    <Match when={!node.ignored}>
                      <FileIcon node={node} class="size-4 filetree-icon filetree-icon--color" />
                    </Match>
                  </Switch>
                </FileTreeNode>
              </Match>
            </Switch>
          )
        }}
      </For>
      </Show>
      <Show when={visibleNodes().overflow > 0}>
        <div
          class="px-2 py-1 text-12-regular text-text-weak cursor-pointer hover:text-text-base hover:bg-surface-raised-base-hover rounded-md transition-colors"
          onClick={() => file.tree.expand(props.path)}
          title={`Expand to see all ${nodes().length} items`}
        >
          +{visibleNodes().overflow} more items
        </div>
      </Show>
    </div>
  )

  // At nested levels, just render the tree content directly,
  // letting the root-level ContextMenu handle right-clicks on blank areas.
  if (level > 0) return treeContent

  return (
    <ContextMenu>
      {/* `pointer-events-none` on the tree content makes hit-testing fall through
          to this trigger, so the context menu must be disabled explicitly while a
          sync runs — otherwise right-click still offers delete / rename. */}
      <ContextMenu.Trigger class="flex-1 min-h-full flex flex-col" disabled={remoteSyncStatus() !== undefined}>
        {treeContent}
        <div class="h-[35vh] shrink-0" />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={() => handleNewFile(contextMenuDir())}>
            <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.newFile")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item onSelect={() => handleNewFolder(contextMenuDir())}>
            <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.newFolder")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item onSelect={() => handleCopyPath(contextMenuDir())}>
            <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.copyPath")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item onSelect={() => handleRefresh(contextMenuDir())}>
            <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.refresh")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item onSelect={handleCollapseAll}>
            <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.collapseAll")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Separator />
          {/* oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound) */}
          <Show when={platform.openPath}>
            <ContextMenu.Item onSelect={handleRevealRootInFileManager}>
              <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.revealInFileManager")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
          </Show>
          <ContextMenu.Item onSelect={handleOpenInTerminal}>
            <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.openInTerminal")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item onSelect={handleFindInFolder}>
            <ContextMenu.ItemLabel>{language.t("contextMenu.fileTree.findInFolder")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}

function DialogConfirmDeleteFile(props: { name: string; count: number; onConfirm: () => Promise<void> }) {
  const language = useLanguage()
  const dialog = useDialog()
  const [loading, setLoading] = createSignal(false)

  const handleConfirm = async () => {
    setLoading(true)
    try {
      await props.onConfirm()
    } finally {
      setLoading(false)
      dialog.close()
    }
  }

  return (
    <DialogConfirm
      title={language.t("contextMenu.fileTree.delete")}
      danger
      busy={loading()}
      confirmLabel={language.t("common.delete")}
      message={
        props.count > 1
          ? language.t("contextMenu.fileTree.deleteConfirmMultiple", { count: props.count })
          : language.t("contextMenu.fileTree.deleteConfirm", { name: props.name })
      }
      onConfirm={handleConfirm}
      onCancel={() => dialog.close()}
    />
  )
}

function DialogPromptCreate(props: { title: string; onConfirm: (name: string) => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  const [name, setName] = createSignal("")

  const handleConfirm = () => {
    const value = name().trim()
    if (!value) return
    dialog.close()
    props.onConfirm(value)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      handleConfirm()
    }
  }

  return (
    <Dialog title={props.title} fit>
      <div class="flex flex-col gap-4 px-[var(--dialog-gutter)] pb-5 pt-4">
        <TextField value={name()} onChange={setName} onKeyDown={handleKeyDown} autofocus />
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" disabled={!name().trim()} onClick={handleConfirm}>
            {language.t("common.confirm")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function DialogPromptRename(props: { title: string; defaultValue: string; onConfirm: (name: string) => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  const [name, setName] = createSignal(props.defaultValue)

  const handleConfirm = () => {
    const value = name().trim()
    if (!value || value === props.defaultValue) return
    dialog.close()
    props.onConfirm(value)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      handleConfirm()
    }
  }

  const isInvalid = () => !name().trim() || name().includes("/")

  return (
    <Dialog title={props.title} fit>
      <div class="flex flex-col gap-4 px-[var(--dialog-gutter)] pb-5 pt-4">
        <TextField value={name()} onChange={setName} onKeyDown={handleKeyDown} autofocus />
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" disabled={isInvalid()} onClick={handleConfirm}>
            {language.t("common.confirm")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
