import { For, Match, Show, Switch, batch, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Tabs } from "@duoduo-ai/ui/tabs"
import { IconButton } from "@duoduo-ai/ui/icon-button"
import { TooltipKeybind } from "@duoduo-ai/ui/tooltip"
import { ResizeHandle } from "@duoduo-ai/ui/resize-handle"
import { Mark } from "@duoduo-ai/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import type { SnapshotFileDiff, VcsFileDiff } from "@duoduo-ai/sdk/v2"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { ContextMenu } from "@duoduo-ai/ui/context-menu"
import { useDialog } from "@duoduo-ai/ui/context/dialog"

import FileTree, { getFileClipboard, clearFileClipboard } from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { showToast } from "@duoduo-ai/ui/toast"
import { copyToClipboard } from "@duoduo-ai/ui/utils/clipboard"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { createOpenSessionFileTab, createSessionTabs, getTabReorderIndex, type Sizing } from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { MemoryPanel } from "@/addons/memory/memory-panel"

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => (SnapshotFileDiff | VcsFileDiff)[]
  empty: () => string
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  reviewSnap: boolean
  size: Sizing
}) {
  const layout = useLayout()
  const platform = usePlatform()
  const settings = useSettings()
  const sync = useSync()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const sdk = useSDK()
  const { sessionKey, tabs, view } = useSessionLayout()

  const shown = createMemo(
    () =>
      platform.platform !== "desktop" ||
      import.meta.env.VITE_DUODUO_CHANNEL !== "beta" ||
      settings.general.showFileTree(),
  )

  const reviewOpen = createMemo(() => view().reviewPanel.opened())
  const fileOpen = createMemo(() => shown() && layout.fileTree.opened())
  const open = createMemo(() => reviewOpen() || fileOpen())
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    if (reviewOpen()) return `calc(100% - ${layout.session.width()}px)`
    return `${layout.fileTree.width()}px`
  })
  const treeWidth = createMemo(() => (fileOpen() ? `${layout.fileTree.width()}px` : "0px"))

  const diffFiles = createMemo(() => props.diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of props.diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  // ── Kobalte Tabs 受控组件循环修复 ──
  //
  // 问题：Kobalte 受控 Tabs 在 value prop 外部变更时，内部 effect 检测到
  // selectedKey 不在 DomCollection 中（新 Tabs.Trigger 还没注册），回退到第一个
  // tab 并通过 onChange 通知。onChange 传入的永远是回退值（如 "review"），
  // 不是用户点击的 tab 值，导致 active 被切回形成循环。
  //
  // 修复：完全弃用 Tabs 的 onChange（只接收回退值，无法用于用户交互），
  // 改用每个 Tabs.Trigger 的 onClick 来处理用户切换。点击时直接调用
  // openTab（文件树点击也走同一路径），openTab 内部同时调用 tabs().open()
  // 和 setActive()，确保 tab 列表和激活状态同步更新。
  // onChange 设为空函数，阻止 Kobalte 回退值影响 store。

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
    setActive: tabs().setActive,
  })

  const isRemote = createMemo(() => sync.project?.id.startsWith("remote:") ?? false)

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    // 审查标签固定显示：不再受 768px 宽度断点控制
    // SSH 远程项目不显示审查标签
    review: () => !isRemote(),
    hasReview: () => !isRemote(),
  })
  const contextOpen = tabState.contextOpen

  const memoryOpen = tabState.memoryOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab

  const fileTreeTab = () => layout.fileTree.tab()

  // ── File tree multi-select state ──
  const [selectedPaths, setSelectedPaths] = createSignal<Set<string>>(new Set())
  const [lastClickedPath, setLastClickedPath] = createSignal<string | null>(null)

  const clearFileTreeSelection = () => {
    setSelectedPaths(new Set<string>())
    setLastClickedPath(null)
  }

  const prompt = usePrompt()

  // 添加进对话时立刻转绝对路径（以文件树自身的根 sdk.directory 为基准），
  // 避免发送时用会话目录二次拼接导致路径错位。兼容 Unix "/"、Windows 盘符与 UNC。
  const toAbsolutePath = (p: string) => {
    if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\")) return p
    const root = (sdk.directory ?? "").replace(/[\\/]+$/, "")
    return root ? `${root}/${p}` : p
  }

  const handleAddToChat = (relativePath: string | string[]) => {
    const paths = Array.isArray(relativePath) ? relativePath : [relativePath]
    let added = 0
    for (const p of paths) {
      prompt.context.add({ type: "file", path: toAbsolutePath(p) })
      added++
    }
    if (added > 0) {
      showToast({ variant: "success", title: language.t("prompt.action.attachFile") })
    }
  }

  // Copy helper with a fallback for Tauri webviews where navigator.clipboard
  // is unavailable/blocked, so the copy action never silently fails.
  const copyPath = (text: string) => {
    void copyToClipboard(text).then((ok) =>
      ok
        ? showToast({ variant: "success", title: language.t("common.copied") })
        : showToast({ variant: "error", title: language.t("common.copyFailed") }),
    )
  }

  const handleCutFile = (relativePath: string | string[]) => {
    const paths = Array.isArray(relativePath) ? relativePath : [relativePath]
    const root = sdk.directory
    const text = paths
      .map((p) => {
        if (!root) return p
        const joined = `${root}/${p}`
        return /^[A-Za-z]:/.test(root) || root.includes("\\") ? joined.replace(/\//g, "\\") : joined
      })
      .join("\n")
    copyPath(text)
  }

  const handleCopyFile = (relativePath: string | string[]) => {
    const paths = Array.isArray(relativePath) ? relativePath : [relativePath]
    const root = sdk.directory
    const text = paths
      .map((p) => {
        if (!root) return p
        const joined = `${root}/${p}`
        return /^[A-Za-z]:/.test(root) || root.includes("\\") ? joined.replace(/\//g, "\\") : joined
      })
      .join("\n")
    copyPath(text)
  }

  const handlePasteFile = (targetDir: string) => {
    const clipboard = getFileClipboard()
    if (clipboard.paths.length === 0) return

    for (const sourcePath of clipboard.paths) {
      const fileName = sourcePath.split("/").pop() || sourcePath
      const newPath = targetDir ? `${targetDir}/${fileName}` : fileName

      if (sourcePath === newPath) continue
      if (targetDir.startsWith(sourcePath + "/")) continue

      if (clipboard.mode === "cut") {
        if (file.tree.node(newPath)) continue
        void file.rename(sourcePath, newPath)
      } else {
        void file.copy(sourcePath, newPath)
      }
    }

    if (clipboard.mode === "cut") {
      clearFileClipboard()
    }
  }

  const handleDeleteFile = (relativePath: string | string[]) => {
    const paths = Array.isArray(relativePath) ? relativePath : [relativePath]
    for (const p of paths) {
      void file.remove(p)
    }
  }

  const handleFileDrop = (sourcePath: string, targetDir: string) => {
    if (targetDir === sourcePath || targetDir.startsWith(sourcePath + "/")) return
    const fileName = sourcePath.split("/").pop() || sourcePath
    const newPath = targetDir ? `${targetDir}/${fileName}` : fileName
    if (sourcePath === newPath) return
    if (file.tree.node(newPath)) return
    void file.rename(sourcePath, newPath)
  }

  const handleFileTreeSelect = (path: string, ctrlKey: boolean, shiftKey: boolean) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)

      if (shiftKey && lastClickedPath() !== null) {
        // Shift+click: range select among siblings
        // We need to find both paths in the flattened visible nodes
        const allPaths = getAllVisiblePaths()
        const startIdx = allPaths.indexOf(lastClickedPath()!)
        const endIdx = allPaths.indexOf(path)
        if (startIdx !== -1 && endIdx !== -1) {
          const lo = Math.min(startIdx, endIdx)
          const hi = Math.max(startIdx, endIdx)
          for (let i = lo; i <= hi; i++) next.add(allPaths[i]!)
        } else {
          // One endpoint not in visible paths (e.g. parent collapsed):
          // fall back to single-select the clicked path
          next.clear()
          next.add(path)
        }
      } else if (ctrlKey) {
        // Ctrl/Cmd+click: toggle
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
      } else {
        // Plain click: single select
        next.clear()
        next.add(path)
      }

      return next
    })
    // Only update anchor on non-shift clicks
    if (!shiftKey) {
      setLastClickedPath(path)
    }
  }

  /** Flatten all visible file paths in tree order (depth-first) for Shift range selection */
  const getAllVisiblePaths = (): string[] => {
    const result: string[] = []
    const collect = (dir: string) => {
      const children = file.tree.children(dir)
      for (const child of children) {
        result.push(child.path)
        if (child.type === "directory" && (file.tree.state(child.path)?.expanded ?? false)) {
          collect(child.path)
        }
      }
    }
    collect("")
    return result
  }

  // Clear selection when switching file tree tabs
  createEffect(() => {
    fileTreeTab()
    clearFileTreeSelection()
  })

  // ── Tab context menu callbacks ──

  const closeOthers = (tab: string) => {
    const all = tabs().all()
    // Keep the target tab and non-file tabs (context, memory, etc.)
    const remaining = all.filter((t) => t === tab || !file.pathFromTab(t))
    batch(() => {
      tabs().setAll(remaining)
      tabs().setActive(tab)
    })
  }

  const closeToRight = (tab: string) => {
    const opened = openedTabs()
    const index = opened.indexOf(tab)
    if (index === -1) return
    const tabsToClose = new Set(opened.slice(index + 1))
    const all = tabs().all()
    const remaining = all.filter((t) => !tabsToClose.has(t))
    batch(() => {
      tabs().setAll(remaining)
      // If the active tab was closed, switch to the right-clicked tab
      const active = tabs().active()
      if (active && tabsToClose.has(active)) {
        tabs().setActive(tab)
      }
    })
  }

  const closeAll = () => {
    const all = tabs().all()
    // Keep non-file tabs
    const remaining = all.filter((t) => !file.pathFromTab(t))
    batch(() => {
      tabs().setAll(remaining)
      tabs().setActive(undefined)
    })
  }

  const copyAbsolutePath = (tab: string) => {
    const rel = file.pathFromTab(tab)
    if (!rel) return
    // Normalise separators for the current platform
    const root = sdk.directory
    const absolute = root + "/" + rel
    const normalised = /^[A-Za-z]:/.test(root) || root.includes("\\") ? absolute.replace(/\//g, "\\") : absolute
    copyPath(normalised)
  }

  const copyRelativePath = (tab: string) => {
    const rel = file.pathFromTab(tab)
    if (!rel) return
    copyPath(rel)
  }

  const revealInFileTree = (tab: string) => {
    const rel = file.pathFromTab(tab)
    if (!rel) return

    // Open the file tree panel if not already open
    if (!layout.fileTree.opened()) {
      layout.fileTree.open()
    }
    // Switch to "all" tab to ensure the file is visible
    layout.fileTree.setTab("all")

    // Expand all parent directories from root to the file's parent
    const parts = rel.split("/")
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/")
      file.tree.expand(dir)
    }
  }

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <aside
      id="review-panel"
      aria-label={language.t("session.panel.reviewAndFiles")}
      aria-hidden={!open()}
      inert={!open()}
      class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base"
      classList={{
        "pointer-events-none": !open(),
        "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
          !props.size.active() && !props.reviewSnap,
      }}
      style={{ width: panelWidth() }}
    >
      <div class="size-full flex border-l border-border-weaker-base">
        <div
          aria-hidden={!reviewOpen()}
          inert={!reviewOpen()}
          class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base"
          classList={{
            "pointer-events-none": !reviewOpen(),
          }}
        >
          <div class="size-full min-w-0 h-full bg-background-base">
            <DragDropProvider
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragOver={handleDragOver}
              collisionDetector={closestCenter}
            >
              <DragDropSensors />
              <ConstrainDragYAxis />
              <Tabs
                value={activeTab()}
                onChange={() => {}}
                data-scope="file-tabs"
                data-wrap-tabs={settings.general.tabWrapping() ? "true" : undefined}
              >
                <div
                  class="sticky top-0 shrink-0 flex items-start"
                  classList={{ "flex-wrap": settings.general.tabWrapping() }}
                >
                  <Tabs.List
                    ref={(el: HTMLDivElement) => {
                      const stop = createFileTabListSync({ el, contextOpen, activeTab })
                      onCleanup(stop)
                    }}
                    data-wrap-tabs={settings.general.tabWrapping() ? "true" : undefined}
                  >
                    <Show when={!isRemote()}>
                      <Tabs.Trigger value="review" onClick={() => openTab("review")}>
                        <div class="flex items-center gap-1.5">
                          <div>{language.t("session.tab.review")}</div>
                          <Show when={props.hasReview()}>
                            <div>{props.reviewCount()}</div>
                          </Show>
                        </div>
                      </Tabs.Trigger>
                    </Show>
                    <Show when={contextOpen()}>
                      <Tabs.Trigger
                        value="context"
                        onClick={() => openTab("context")}
                        closeButton={
                          <TooltipKeybind
                            title={language.t("common.closeTab")}
                            keybind={command.keybind("tab.close")}
                            placement="bottom"
                            gutter={10}
                          >
                            <IconButton
                              icon="close-small"
                              variant="ghost"
                              class="h-5 w-5"
                              onClick={() => tabs().close("context")}
                              aria-label={language.t("common.closeTab")}
                            />
                          </TooltipKeybind>
                        }
                        hideCloseButton
                        onMiddleClick={() => tabs().close("context")}
                      >
                        <div class="flex items-center gap-2">
                          <SessionContextUsage variant="indicator" />
                          <div>{language.t("session.tab.context")}</div>
                        </div>
                      </Tabs.Trigger>
                    </Show>

                    <Show when={memoryOpen()}>
                      <Tabs.Trigger
                        value="memory"
                        onClick={() => openTab("memory")}
                        closeButton={
                          <TooltipKeybind
                            title={language.t("common.closeTab")}
                            keybind={command.keybind("tab.close")}
                            placement="bottom"
                            gutter={10}
                          >
                            <IconButton
                              icon="close-small"
                              variant="ghost"
                              class="h-5 w-5"
                              onClick={() => tabs().close("memory")}
                              aria-label={language.t("common.closeTab")}
                            />
                          </TooltipKeybind>
                        }
                        hideCloseButton
                        onMiddleClick={() => tabs().close("memory")}
                      >
                        <div>{language.t("session.tab.memory")}</div>
                      </Tabs.Trigger>
                    </Show>
                    <SortableProvider ids={openedTabs()}>
                      <For each={openedTabs()}>
                        {(tab) => (
                          <SortableTab
                            tab={tab}
                            // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
                            onTabClose={tabs().close}
                            onTabSwitch={openTab}
                            onTabCloseOthers={closeOthers}
                            onTabCloseToRight={closeToRight}
                            onTabCloseAll={closeAll}
                            onCopyPath={copyAbsolutePath}
                            onCopyRelativePath={copyRelativePath}
                            onRevealInFileTree={revealInFileTree}
                          />
                        )}
                      </For>
                    </SortableProvider>
                    <div class="file-tab-add bg-background-stronger h-full w-11 shrink-0 sticky right-0 z-10 flex items-center justify-center">
                      <TooltipKeybind
                        title={language.t("command.file.open")}
                        keybind={command.keybind("file.open")}
                        class="flex items-center"
                      >
                        <IconButton
                          icon="plus-small"
                          variant="ghost"
                          iconSize="large"
                          class="!rounded-md"
                          onClick={() => {
                            void import("@/components/dialog-select-file").then((x) => {
                              dialog.show(() => <x.DialogSelectFile mode="files" onOpenFile={() => {}} />)
                            })
                          }}
                          aria-label={language.t("command.file.open")}
                        />
                      </TooltipKeybind>
                    </div>
                  </Tabs.List>
                </div>

                <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                  <Show when={activeTab() === "review"}>{props.reviewPanel()}</Show>
                </Tabs.Content>

                <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                  <Show when={activeTab() === "empty"}>
                    <ContextMenu>
                      <ContextMenu.Trigger class="h-full">
                        <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                          <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                            <Mark class="w-14 opacity-10" />
                            <div class="text-14-regular text-text-weak max-w-56">
                              {language.t("session.files.selectToOpen")}
                            </div>
                          </div>
                        </div>
                      </ContextMenu.Trigger>
                      <ContextMenu.Portal>
                        <ContextMenu.Content>
                          <ContextMenu.Item
                            onSelect={() => {
                              void import("@/components/dialog-select-file").then((x) => {
                                dialog.show(() => <x.DialogSelectFile mode="files" onOpenFile={() => {}} />)
                              })
                            }}
                          >
                            <ContextMenu.ItemLabel>{language.t("command.file.open")}</ContextMenu.ItemLabel>
                          </ContextMenu.Item>
                        </ContextMenu.Content>
                      </ContextMenu.Portal>
                    </ContextMenu>
                  </Show>
                </Tabs.Content>

                <Show when={contextOpen()}>
                  <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                    <Show when={activeTab() === "context"}>
                      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                        <SessionContextTab />
                      </div>
                    </Show>
                  </Tabs.Content>
                </Show>

                <Show when={memoryOpen()}>
                  <Tabs.Content value="memory" class="flex flex-col h-full overflow-hidden contain-strict">
                    <Show when={activeTab() === "memory"}>
                      <MemoryPanel />
                    </Show>
                  </Tabs.Content>
                </Show>

                <For each={openedTabs()}>
                  {(tab) => {
                    const isActive = createMemo(() => activeFileTab() === tab)
                    return (
                      <div style={{ display: isActive() ? "contents" : "none" }} inert={!isActive()}>
                        <FileTabContent tab={tab} />
                      </div>
                    )
                  }}
                </For>
              </Tabs>
              <DragOverlay>
                <Show when={store.activeDraggable} keyed>
                  {(tab) => {
                    const path = file.pathFromTab(tab)
                    return (
                      <div data-component="tabs-drag-preview">
                        <Show when={path}>{(p) => <FileVisual active path={p()} />}</Show>
                      </div>
                    )
                  }}
                </Show>
              </DragOverlay>
            </DragDropProvider>
          </div>
        </div>

        <Show when={shown()}>
          <div
            id="file-tree-panel"
            aria-hidden={!fileOpen()}
            inert={!fileOpen()}
            class="relative min-w-0 h-full shrink-0 overflow-hidden"
            classList={{
              "pointer-events-none": !fileOpen(),
              "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                !props.size.active(),
            }}
            style={{ width: treeWidth() }}
          >
            <div
              class="h-full flex flex-col overflow-hidden group/filetree"
              classList={{ "border-l border-border-weaker-base": reviewOpen() }}
            >
              <div class="bg-background-stronger px-3 py-0 h-full overflow-y-auto" data-scope="filetree">
                <Switch>
                  <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                  <Match when={true}>
                    <FileTree
                      path=""
                      class="pt-3"
                      showRoot
                      modified={diffFiles()}
                      kinds={kinds()}
                      active={file.pathFromTab(activeFileTab() ?? "")}
                      onFileClick={(node) => openTab(file.tab(node.path))}
                      _selectedPaths={selectedPaths()}
                      _lastClickedPath={lastClickedPath()}
                      _onSelect={handleFileTreeSelect}
                      _onClearSelection={clearFileTreeSelection}
                      onAddToChat={handleAddToChat}
                      onCutFile={handleCutFile}
                      onCopyFile={handleCopyFile}
                      onPasteFile={handlePasteFile}
                      onDeleteFile={handleDeleteFile}
                      onFileDrop={handleFileDrop}
                    />
                  </Match>
                </Switch>
              </div>
            </div>
            <Show when={fileOpen()}>
              <div onPointerDown={() => props.size.start()}>
                <ResizeHandle
                  direction="horizontal"
                  edge="start"
                  size={layout.fileTree.width()}
                  min={200}
                  max={480}
                  onResize={(width) => {
                    props.size.touch()
                    layout.fileTree.resize(width)
                  }}
                />
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </aside>
  )
}
