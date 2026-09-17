import { createEffect, createMemo, createSignal, Match, onCleanup, Show, Switch } from "solid-js"
import { ContextMenu } from "@duoduo-ai/ui/context-menu"
import { Tabs } from "@duoduo-ai/ui/tabs"
import { IconButton } from "@duoduo-ai/ui/icon-button"
import { Tooltip } from "@duoduo-ai/ui/tooltip"
import { showToast } from "@duoduo-ai/ui/toast"
import { CodeMirrorEditor, EditorSelection, openSearchPanel } from "@duoduo-ai/ui/codemirror-editor"
import type { EditorView } from "@duoduo-ai/ui/codemirror-editor"
import { Markdown } from "@duoduo-ai/ui/markdown"
import { FilePreview } from "@duoduo-ai/ui/file-preview"
import { useFile } from "@/context/file"
import { usePreviewContent } from "@/context/file/usePreviewContent"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { useSDK } from "@/context/sdk"
import { useGlobalSync } from "@/context/global-sync"
import { Terminal } from "@/components/terminal"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { syncRemote, remoteSyncStatus } from "@/utils/remote-resync"
import { errorMessage } from "@/context/file/error-message"
import { setActiveEditor, clearActiveEditorViewIf } from "@/pages/session/active-editor"
import { getCapability } from "@duoduo-ai/shared/util/preview-capability"
import type { FileContent } from "@duoduo-ai/sdk/v2"

/**
 * FileTabContent renders a single file tab using CodeMirror 6 as the
 * sole editor/viewer. No separate "editing mode" — the editor IS the view.
 *
 * Features:
 * - Direct inline editing (no overlay/overlay toggle)
 * - Auto-save with configurable debounce (respects settings.general.autoSave)
 * - Dirty state indicator in the tab title
 * - Ctrl+S / Cmd+S manual save
 * - Ctrl+F / Cmd+F search (built into CodeMirror)
 * - Lazy language loading for syntax highlighting
 * - Virtualized rendering (handles 100K+ lines)
 */

// Guard: rendering very large Markdown synchronously (incl. Shiki highlighting)
// can freeze the UI. Beyond this size we show a notice instead of the preview.
const MARKDOWN_PREVIEW_MAX_CHARS = 500_000

export function FileTabContent(props: { tab: string }) {
  const file = useFile()
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const sdk = useSDK()
  const globalSync = useGlobalSync()
  const dialog = useDialog()

  const remoteProjectID = createMemo(() => {
    const [child] = globalSync.child(sdk.directory)
    return child?.project
  })
  const isRemote = createMemo(() => remoteProjectID()?.startsWith("remote:") ?? false)
  const [sshPtyId, setSshPtyId] = createSignal<string | null>(null)

  const openSshTerminal = async () => {
    const projectID = remoteProjectID()
    if (!projectID) return
    try {
      const res = await sdk.client.pty.create({
        ssh: { projectID },
        title: "SSH",
      })
      if (!res.data) return
      setSshPtyId(res.data.id)
      dialog.show(() => (
        <Dialog title={language.t("remote.sshTerminal")} size="x-large">
          <div class="h-[70vh] w-full">
            <Show when={sshPtyId()}>
              <Terminal pty={{ id: sshPtyId()!, title: "SSH", titleNumber: 1 }} />
            </Show>
          </div>
        </Dialog>
      ))
    } catch (e) {
      showToast({
        variant: "error",
        title: language.t("remote.sshFailed"),
        description: errorMessage(e, language.t("remote.sshFailed")),
      })
    }
  }


  // ─── File state ───

  const path = createMemo(() => file.pathFromTab(props.tab) ?? "")
  const state = createMemo(() => {
    const p = path()
    if (!p) return
    return file.get(p)
  })
  const contents = createMemo(() => state()?.content?.content ?? "")

  // ─── Editor content (tracks live editor state, separate from file context) ───

  const [editorContent, setEditorContent] = createSignal(contents())

  // Revision counter: incremented after each successful save so that
  // CodeMirrorEditor can reset its internal dirty state even when
  // props.value doesn't change (saved content equals editor content).
  const [savedRevision, setSavedRevision] = createSignal(0)

  // Monotonically increasing version counter to prevent stale async loads
  // from overwriting the editor after a save. Each save increments this;
  // the contents() sync effect checks that the load version is still current
  // before applying external content changes.
  let saveVersion = 0

  // Sync editorContent when contents() changes externally (file reload, tab switch).
  // Without this, saveFile() would use stale editorContent after disk refresh.
  //
  // IMPORTANT: After a successful save, file.save() fires a void load(force:true)
  // which asynchronously updates contents(). We must NOT let that late-arriving
  // load overwrite the editor — the user just saved and the editor already has
  // the correct content. The saveVersion guard ensures that only loads initiated
  // BEFORE the most recent save are applied.
  createEffect(() => {
    const latest = contents()
    // Only sync when not dirty — if dirty, the user has unsaved edits
    // and we should not overwrite with disk content.
    // Also skip if the contents change came from a post-save reload — the
    // editor already has the right content and we must not reset dirty state.
    if (!dirty() && saveVersion === 0) {
      setEditorContent(latest)
    }
  })

  // ─── Dirty state ───

  const [dirty, setDirty] = createSignal(false)

  // ─── Saving state ───

  const [saving, setSaving] = createSignal(false)

  // ─── Save logic ───

  const saveFile = async () => {
    const p = path()
    if (!p) return
    // Guard: preview-only files (pdf/doc/xls/image/svg) have no editable
    // source in the editor channel — never save an empty payload over them.
    const cap0 = getCapability(p)
    if (cap0?.previewable && !cap0.textBased) return
    // Guard: don't save if the file hasn't finished loading yet.
    // This prevents spurious "save failed" errors when opening a file
    // (e.g. auto-save firing before the content has been fetched).
    if (!state()?.loaded) return
    // Use editorContent() — the live editor state — not contents() from file context
    const content = editorContent()

    // Bump saveVersion BEFORE setting saving state so that the createEffect
    // syncing contents() will ignore the post-save async reload.
    const thisSaveVersion = ++saveVersion

    setSaving(true)
    try {
      const result = await file.save(p, content)
      // Discard if another save started while we were in-flight
      if (thisSaveVersion !== saveVersion) return

      if (result.success) {
        // Reset dirty state and bump revision so CodeMirrorEditor
        // resets its internal dirty tracking (lastSavedContent).
        // We cannot rely solely on CM6's props.value sync to reset dirty,
        // because if the saved content equals what's already in the editor,
        // the createEffect won't fire (no diff detected) and dirty stays true.
        setDirty(false)
        setEditorContent(content)
        setSavedRevision((r) => r + 1)

        // After a successful save, the post-save load(force:true) inside
        // file.save() will asynchronously update contents(). When it lands,
        // we want to acknowledge it (reset saveVersion) so that future
        // external changes (e.g. Agent edits) are properly synced.
        // We schedule a microtask to ensure the load has had a chance to
        // propagate before we reset.
        queueMicrotask(() => {
          if (thisSaveVersion === saveVersion) {
            saveVersion = 0
          }
        })


      } else {
        // Save returned success:false without throwing.
        // file.save()'s .catch handler shows the specific error toast when SDK throws,
        // but this branch covers the rare case where the response is 200 yet success is false.
        saveVersion = thisSaveVersion - 1
        showToast({
          variant: "error",
          title: language.t("toast.file.saveFailed.title") ?? "Save failed",
          description: result.error,
          copyText: result.error,
        })
      }
    } catch {
      // Save threw — revert saveVersion so external loads can still sync.
      // The specific error toast is already shown by file.save()'s .catch handler.
      if (thisSaveVersion === saveVersion) saveVersion = thisSaveVersion - 1
    } finally {
      if (thisSaveVersion === saveVersion || saveVersion === 0) {
        setSaving(false)
      }
    }
  }

  // ─── Auto-save integration ───

  const autoSaveEnabled = () => settings.general.autoSave()

  // Markdown files always use line wrapping regardless of the global setting,
  // because markdown without wrapping is nearly unreadable.
  const lineWrappingEnabled = () => {
    const p = path() ?? ""
    const ext = p.split(".").pop()?.toLowerCase() ?? ""
    if (ext === "md" || ext === "markdown") return true
    return settings.general.lineWrapping()
  }

  // Capability-based dispatch (replaces the old md-only check).
  // - preview-only  (pdf/doc/xls/image/svg): render <FilePreview> without CodeMirror.
  // - text-based    (md/csv/json): keep CodeMirror + source/preview/split toggle.
  const cap = createMemo(() => getCapability(path() ?? ""))
  const isPreviewOnly = () => !!cap()?.previewable && !cap()?.textBased
  const isTextBasedPreview = () => !!cap()?.previewable && !!cap()?.textBased
  const isMarkdown = () => cap()?.kind === "markdown"

  // Byte reader for the preview channel (pdf/doc/xls/image/svg via base64).
  const previewReader = usePreviewContent()
  // For text-based preview files the text is already in the editable store,
  // so reuse it instead of re-fetching through the SDK.
  const readFromStore = (_p: string): Promise<FileContent | undefined> =>
    Promise.resolve(state()?.content)

  // Preview view mode for text-based preview files.
  const [viewMode, setViewMode] = createSignal<"source" | "preview" | "split">("source")
  const isSplit = () => viewMode() === "split"
  const showPreview = () => isTextBasedPreview() && viewMode() !== "source"

  const previewLabels = () => ({
    loadingLabel: language.t("file.preview.loading") ?? "Loading preview…",
    errorLabel: language.t("file.preview.error") ?? "Failed to load preview.",
    unsupportedLabel: language.t("file.preview.unsupported") ?? "Preview not supported.",
  })

  const handleValueChange = (value: string) => {
    // Store the live editor content so saveFile can access it
    setEditorContent(value)
  }

  const handleSave = () => {
    // Don't guard on dirty() here — the dirty signal may be out of sync
    // with CM6's internal dirty state (e.g. after an async watcher reload
    // resets dirty to false while the editor still has unsaved edits).
    // Instead, let saveFile be called and rely on the HTTP write being
    // idempotent (writing the same content is harmless) and on the
    // saving() guard to prevent concurrent saves.
    if (saving()) return
    void saveFile()
  }

  const handleDirtyChange = (isDirty: boolean) => {
    setDirty(isDirty)
  }

  // ─── Cleanup: save unsaved content on unmount (tab switch/close) ───

  onCleanup(() => {
    if (!dirty()) return
    const p = path()
    if (!p) return
    const content = editorContent()
    // Fire-and-forget save — component is unmounting so we can't await.
    // This prevents data loss when the user switches tabs with unsaved edits.
    file.save(p, content).catch(() => {
      // Silently fail — we're unmounting and can't show toast
    })
  })

  // ─── EditorView ref ───

  const [editorView, setEditorView] = createSignal<EditorView | undefined>(undefined)

  const handleEditorReady = (view: EditorView) => {
    setEditorView(view)
    // Register as the active editor so the command system can drive
    // actions like file.find (Ctrl+F / Cmd+F).
    // NOTE: We do NOT call onCleanup here — it must run during the
    // component's sync init phase. Cleanup is handled below.
    setActiveEditor(view)
  }

  // Clean up the active-editor signal when this tab unmounts.
  // This onCleanup is called during the component's synchronous
  // initialization phase, so it registers correctly with SolidJS.
  onCleanup(() => {
    const view = editorView()
    if (view) clearActiveEditorViewIf(view)
  })

  // ─── Context menu helpers ───

  const copyPath = () => {
    const p = path()
    if (!p) return
    navigator.clipboard.writeText(p).then(
      () => showToast({ variant: "success", title: language.t("common.copied") }),
      () => showToast({ variant: "error", title: language.t("common.copyFailed") }),
    )
  }

  // --- CM6-based context menu helpers ---

  const hasCmSelection = () => {
    const view = editorView()
    if (!view) return false
    return view.state.selection.main.from !== view.state.selection.main.to
  }

  const cmCopy = () => {
    const view = editorView()
    if (!view) return
    // Use CM6's built-in copy which handles selections correctly
    document.execCommand("copy")
  }

  const cmCut = () => {
    const view = editorView()
    if (!view) return
    // Copy first, then delete selection
    document.execCommand("copy")
    view.dispatch(
      view.state.changeByRange((range) => {
        if (range.empty) return { range }
        return {
          changes: { from: range.from, to: range.to, insert: "" },
          range: EditorSelection.cursor(range.from),
        }
      }),
    )
  }

  const cmPaste = async () => {
    const view = editorView()
    if (!view) return
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return
      view.dispatch(
        view.state.changeByRange((range) => ({
          changes: { from: range.from, to: range.to, insert: text },
          range: EditorSelection.cursor(range.from + text.length),
        })),
      )
    } catch {
      showToast({ variant: "error", title: language.t("common.copyFailed") })
    }
  }

  const cmSelectAll = () => {
    const view = editorView()
    if (!view) return
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, view.state.doc.length)]),
    })
  }

  const cmFind = () => {
    const view = editorView()
    if (!view) return
    openSearchPanel(view)
  }

  const copyFileContent = () => {
    const content = editorContent()
    if (!content) return
    navigator.clipboard.writeText(content).then(
      () => showToast({ variant: "success", title: language.t("common.copied") }),
      () => showToast({ variant: "error", title: language.t("common.copyFailed") }),
    )
  }

  // ─── Render ───

  return (
    <Tabs.Content value={props.tab} forceMount class="relative h-full">
      <ContextMenu>
        <ContextMenu.Trigger class="h-full">
          <div class="h-full flex flex-col">
            <div class="flex items-center justify-between px-2 py-1 shrink-0">
              <Show when={isTextBasedPreview()}>
                <div class="flex items-center gap-1">
                  <Tooltip value={language.t("file.view.source")}>
                    <IconButton
                      icon="code"
                      variant="ghost"
                      size="normal"
                      aria-label={language.t("file.view.source")}
                      data-selected={viewMode() === "source" ? "" : undefined}
                      onClick={() => setViewMode("source")}
                    />
                  </Tooltip>
                  <Tooltip value={language.t("file.view.preview")}>
                    <IconButton
                      icon="eye"
                      variant="ghost"
                      size="normal"
                      aria-label={language.t("file.view.preview")}
                      data-selected={viewMode() === "preview" ? "" : undefined}
                      onClick={() => setViewMode("preview")}
                    />
                  </Tooltip>
                  <Tooltip value={language.t("file.view.split")}>
                    <IconButton
                      icon="layout-left"
                      variant="ghost"
                      size="normal"
                      aria-label={language.t("file.view.split")}
                      data-selected={viewMode() === "split" ? "" : undefined}
                      onClick={() => setViewMode("split")}
                    />
                  </Tooltip>
                </div>
              </Show>
              <Show when={isRemote()}>
                <Tooltip value={language.t("remote.pull")}>
                  <IconButton
                    icon="arrow-down-to-line"
                    variant="ghost"
                    size="normal"
                    aria-label={language.t("remote.pull")}
                    disabled={remoteSyncStatus() !== undefined}
                    onClick={() => void syncRemote("pull", { sdk, language, globalSync, dialog })}
                  />
                </Tooltip>
                <Tooltip value={language.t("remote.sshTerminal")}>
                  <IconButton
                    icon="terminal"
                    variant="ghost"
                    size="normal"
                    aria-label={language.t("remote.sshTerminal")}
                    class="ml-auto"
                    onClick={openSshTerminal}
                  />
                </Tooltip>
                <Tooltip value={language.t("remote.push")}>
                  <IconButton
                    icon="arrow-up"
                    variant="ghost"
                    size="normal"
                    aria-label={language.t("remote.push")}
                    disabled={remoteSyncStatus() !== undefined}
                    onClick={() => void syncRemote("push", { sdk, language, globalSync, dialog })}
                  />
                </Tooltip>
              </Show>
            </div>

            <div class="flex-1 min-h-0 flex flex-col" classList={{ "flex-row": isSplit() }}>
              <div
                class="flex-1 min-h-0"
                classList={{ hidden: isTextBasedPreview() && viewMode() === "preview", "w-1/2": isSplit() }}
              >
                <Switch
                  fallback={
                    <div class="flex items-center justify-center h-full px-6 py-4 text-text-weak">
                      {language.t("common.loading")}...
                    </div>
                  }
                >
                  {/* Preview-only binaries (pdf/doc/xls/image/svg) render here,
                      no CodeMirror mounted. Bytes come from the independent
                      preview channel via props.read. */}
                  <Match when={isPreviewOnly()}>
                    <FilePreview
                      path={path()}
                      read={previewReader}
                      loadingLabel={previewLabels().loadingLabel}
                      errorLabel={previewLabels().errorLabel}
                      unsupportedLabel={previewLabels().unsupportedLabel}
                    />
                  </Match>
                  <Match when={state()?.loaded}>
                    <CodeMirrorEditor
                      value={contents()}
                      onValueChange={handleValueChange}
                      filePath={path()}
                      onSave={handleSave}
                      autoSave={autoSaveEnabled()}
                      autoSaveDelay={1000}
                      savedRevision={savedRevision()}
                      onDirtyChange={handleDirtyChange}
                      onEditorReady={handleEditorReady}
                      lineWrapping={lineWrappingEnabled()}
                      fontSize={settings.appearance.fontSize()}
                      onFontSizeChange={(size) => settings.appearance.setFontSize(size)}
                      class="h-full"
                    />
                  </Match>
                  <Match when={state()?.error}>
                    {(err) => <div class="flex items-center justify-center h-full px-6 py-4 text-text-weak">{err()}</div>}
                  </Match>
                </Switch>
              </div>

              <Show when={showPreview()}>
                <div class="flex-1 min-h-0 overflow-y-auto p-4" classList={{ "w-1/2": isSplit() }}>
                  <Switch>
                    <Match when={isMarkdown()}>
                      <Show
                        when={contents().length <= MARKDOWN_PREVIEW_MAX_CHARS}
                        fallback={
                          <div class="text-text-weak text-13-regular p-2">
                            {language.t("file.preview.tooLarge") ?? "Preview is disabled for large files."}
                          </div>
                        }
                      >
                        <Markdown text={contents()} cacheKey={path()} class="duoduo-markdown" />
                      </Show>
                    </Match>
                    {/* csv/json: reuse the already-loaded text from the store
                        (no extra SDK round-trip). */}
                    <Match when={cap()?.kind === "csv" || cap()?.kind === "json"}>
                      <FilePreview
                        path={path()}
                        read={readFromStore}
                        loadingLabel={previewLabels().loadingLabel}
                        errorLabel={previewLabels().errorLabel}
                        unsupportedLabel={previewLabels().unsupportedLabel}
                      />
                    </Match>
                  </Switch>
                </div>
              </Show>
            </div>

            {/* Saving indicator */}
            <Show when={saving()}>
              <div class="absolute top-2 right-2 px-2 py-1 rounded bg-surface-raised-base text-11-regular text-text-weak shadow-sm">
                {language.t("common.saving")}...
              </div>
            </Show>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content>
            {/* ─── Edit operations ─── */}
            <Show when={hasCmSelection()}>
              <ContextMenu.Item onSelect={cmCut}>
                <ContextMenu.ItemLabel>{language.t("contextMenu.editor.cut")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={cmCopy}>
                <ContextMenu.ItemLabel>{language.t("contextMenu.editor.copy")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
            </Show>
            <ContextMenu.Item onSelect={cmPaste}>
              <ContextMenu.ItemLabel>{language.t("contextMenu.editor.paste")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <ContextMenu.Separator />
            {/* ─── Selection ─── */}
            <ContextMenu.Item onSelect={cmSelectAll}>
              <ContextMenu.ItemLabel>{language.t("contextMenu.editor.selectAll")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <ContextMenu.Separator />
            {/* ─── Find ─── */}
            <ContextMenu.Item onSelect={cmFind}>
              <ContextMenu.ItemLabel>{language.t("contextMenu.editor.find")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <ContextMenu.Separator />
            {/* ─── File operations ─── */}
            <ContextMenu.Item onSelect={copyPath}>
              <ContextMenu.ItemLabel>{language.t("session.header.open.copyPath")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <Show when={!isPreviewOnly()}>
              <ContextMenu.Item onSelect={copyFileContent}>
                <ContextMenu.ItemLabel>{language.t("session.header.open.copyFileContent")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
            </Show>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu>
    </Tabs.Content>
  )
}
