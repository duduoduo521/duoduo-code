import { onCleanup, onMount, createEffect, on } from "solid-js"
import {
  EditorView,
  keymap,
  ViewUpdate,
  rectangularSelection,
  highlightSpecialChars,
  scrollPastEnd,
} from "@codemirror/view"
import { EditorState, Compartment, type Extension, EditorSelection } from "@codemirror/state"
import { search, highlightSelectionMatches, selectNextOccurrence, openSearchPanel } from "@codemirror/search"
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete"
import { bracketMatching, indentOnInput } from "@codemirror/language"
import {
  createBaseExtensions,
  closeBracketsCompartment,
  bracketMatchingCompartment,
  indentOnInputCompartment,
  highlightSpecialCharsCompartment,
  closeBracketsKeymapCompartment,
} from "../codemirror/extensions"
import { resolveLanguageExtension } from "../codemirror/languages"

// Re-export for consumers that need direct CM6 access
export type { EditorView } from "@codemirror/view"
export { EditorSelection, openSearchPanel }

export interface CodeMirrorEditorProps {
  /** Current editor content */
  value: string
  /** Called when content changes */
  onValueChange: (value: string) => void
  /** File path (used for language detection) */
  filePath?: string
  /** Called on Ctrl+S / Cmd+S */
  onSave: () => void
  /** Whether auto-save is enabled. When true, saves after debounce on content change. */
  autoSave?: boolean
  /** Debounce delay in ms for auto-save (default: 1000) */
  autoSaveDelay?: number
  /**
   * Increment this value after a successful save to notify the editor
   * that the current content should be considered "saved" (dirty = false).
   * This is needed because props.value may not change after save (content
   * already matches what's in the editor), so the createEffect won't fire.
   */
  savedRevision?: number
  /** Called when dirty state changes (content differs from last saved) */
  onDirtyChange?: (dirty: boolean) => void
  /** Whether the editor is read-only (default: false) */
  readOnly?: boolean
  /** Tab size in spaces (default: 4) */
  tabSize?: number
  /** Whether to enable line wrapping (default: false) */
  lineWrapping?: boolean
  /** Current editor font size in pixels */
  fontSize?: number
  /** Called when font size should change (e.g., Ctrl+Wheel) */
  onFontSizeChange?: (size: number) => void
  /** Additional CSS class */
  class?: string
  /** Called once after the EditorView is created and mounted */
  onEditorReady?: (view: EditorView) => void
}

/**
 * CodeMirror 6 editor component for SolidJS.
 *
 * Integrates with the project's CSS variable theme system.
 * Features:
 * - Search (Ctrl+F / Cmd+F, Ctrl+H / Cmd+H for replace)
 * - Highlight selection matches
 * - Ctrl+D select next occurrence (multi-cursor)
 * - Rectangular selection (Alt+drag)
 * - Auto-close brackets
 * - Special character highlighting
 * - Virtualized rendering (handles 100K+ lines)
 * - Line numbers, active line highlight
 * - Ctrl+S save / auto-save with configurable debounce
 * - Dirty state tracking
 * - Lazy language loading based on file extension
 * - Configurable tabSize, readOnly, lineWrapping
 * - CSS variable-based theme (follows app theme automatically)
 */
export function CodeMirrorEditor(props: CodeMirrorEditorProps) {
  let containerRef: HTMLDivElement | undefined

  // Compartments for reconfigurable extensions
  const languageCompartment = new Compartment()
  const readOnlyCompartment = new Compartment()
  const tabSizeCompartment = new Compartment()
  const lineWrappingCompartment = new Compartment()

  // Track the EditorView instance
  let editorView: EditorView | undefined

  // Flag to prevent feedback loop when updating from props
  let updatingFromProps = false

  // Track the last saved content for dirty state detection
  let lastSavedContent = props.value
  let dirty = false

  // Guard: after savedRevision increments, CM6 resets lastSavedContent to
  // the current editor content. Shortly after, props.value may also change
  // (from the post-save async reload in file context). If we let the
  // props.value effect run immediately after savedRevision, it would
  // compare the new props.value (server content) against the editor content
  // and potentially overwrite/reset dirty incorrectly. This flag delays
  // the props.value sync for one reactive cycle.
  let skipNextValueSync = false

  // Auto-save debounce timer
  let autoSaveTimer: ReturnType<typeof setTimeout> | undefined

  // Pending requestAnimationFrame ID for scroll restoration cleanup
  let pendingRafId: number | undefined

  // Ctrl+Wheel zoom handler reference (for cleanup)
  let wheelHandler: ((event: WheelEvent) => void) | undefined

  // Monotonic counter to discard stale async language loads (race condition fix)
  let languageLoadId = 0

  function clearAutoSaveTimer() {
    if (autoSaveTimer !== undefined) {
      clearTimeout(autoSaveTimer)
      autoSaveTimer = undefined
    }
  }

  function clearPendingRaf() {
    if (pendingRafId !== undefined) {
      cancelAnimationFrame(pendingRafId)
      pendingRafId = undefined
    }
  }

  function scheduleAutoSave() {
    clearAutoSaveTimer()
    if (!props.autoSave) return
    const delay = props.autoSaveDelay ?? 1000
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = undefined
      props.onSave()
    }, delay)
  }

  /**
   * Update dirty state. Uses length comparison (O(1)) as a fast path
   * before falling back to full string comparison (O(n)).
   */
  function updateDirtyState(content: string) {
    const next = content.length !== lastSavedContent.length || content !== lastSavedContent
    if (next !== dirty) {
      dirty = next
      props.onDirtyChange?.(next)
    }
  }

  /**
   * Handle document changes: notify parent, track dirty state, auto-save.
   */
  function handleDocChange(update: ViewUpdate) {
    if (update.docChanged && !updatingFromProps) {
      if (editorView?.composing) return
      const content = update.state.doc.toString()
      props.onValueChange(content)
      updateDirtyState(content)
      scheduleAutoSave()
    }
  }

  /**
   * Build the full extension set for the editor.
   * Called once during onMount; dynamic changes use compartment reconfigure.
   */
  function buildExtensions(): Extension[] {
    return [
      ...createBaseExtensions(),

      // Compartments (initially configured from props, reconfigurable at runtime)
      languageCompartment.of([]),
      readOnlyCompartment.of(EditorState.readOnly.of(props.readOnly ?? false)),
      tabSizeCompartment.of(EditorState.tabSize.of(props.tabSize ?? 4)),
      lineWrappingCompartment.of(props.lineWrapping ? EditorView.lineWrapping : []),

      // Allow multiple selections (required for Ctrl+D / selectNextOccurrence)
      EditorState.allowMultipleSelections.of(true),

      // Search: Ctrl+F to open, Ctrl+H for replace
      search({ top: true }),
      highlightSelectionMatches(),

      // Rectangular selection (Alt+drag) — already in createBaseExtensions()
      // rectangularSelection(),

      // Scroll past end so the last line can be scrolled to center of viewport
      scrollPastEnd(),

      // Highlight special / invisible characters — already in createBaseExtensions() via Compartment
      // highlightSpecialChars(),

      // Document change listener
      EditorView.updateListener.of(handleDocChange),

      // Key bindings
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            clearAutoSaveTimer()
            props.onSave()
            return true
          },
        },
        {
          key: "Mod-d",
          run: selectNextOccurrence,
        },
      ]),
    ]
  }

  onMount(() => {
    if (!containerRef) return

    lastSavedContent = props.value
    dirty = false

    const state = EditorState.create({
      doc: props.value,
      extensions: buildExtensions(),
    })

    editorView = new EditorView({
      state,
      parent: containerRef,
    })

    // IME composition: disable bracket/editing extensions during composition
    // to prevent interference with CJK input methods (e.g., Chinese punctuation).
    //
    // On Windows, some IMEs (Microsoft Pinyin, Sogou, QQ Pinyin) input CJK
    // punctuation directly via keydown without triggering compositionstart/end.
    // We use keydown(keyCode===229) as a fallback to detect IME activity.
    const contentDOM = editorView.contentDOM
    let imeActive = false

    const disableImeExtensions = () => {
      if (imeActive) return
      imeActive = true
      editorView?.dispatch({
        effects: [
          closeBracketsCompartment.reconfigure([]),
          bracketMatchingCompartment.reconfigure([]),
          indentOnInputCompartment.reconfigure([]),
          highlightSpecialCharsCompartment.reconfigure([]),
          closeBracketsKeymapCompartment.reconfigure([]),
        ],
      })
    }

    const enableImeExtensions = () => {
      if (!imeActive) return
      imeActive = false
      requestAnimationFrame(() => {
        editorView?.dispatch({
          effects: [
            closeBracketsCompartment.reconfigure(closeBrackets()),
            bracketMatchingCompartment.reconfigure(bracketMatching()),
            indentOnInputCompartment.reconfigure(indentOnInput()),
            highlightSpecialCharsCompartment.reconfigure(highlightSpecialChars()),
            closeBracketsKeymapCompartment.reconfigure(keymap.of([...closeBracketsKeymap])),
          ],
        })
      })
    }

    // Standard composition events (macOS / Linux / some Windows IMEs)
    contentDOM.addEventListener("compositionstart", disableImeExtensions)
    contentDOM.addEventListener("compositionend", enableImeExtensions)

    // Windows fallback: keyCode 229 indicates IME is processing the input.
    // Many Windows IMEs input CJK punctuation without compositionstart/end,
    // so we detect them via keydown(229) + keyup recovery.
    contentDOM.addEventListener(
      "keydown",
      (event: KeyboardEvent) => {
        if (event.isComposing || event.keyCode === 229) {
          disableImeExtensions()
        }
      },
      true, // capture phase — runs before CodeMirror's keymap processing
    )
    contentDOM.addEventListener("keyup", (event: KeyboardEvent) => {
      if (!event.isComposing && event.keyCode !== 229) {
        enableImeExtensions()
      }
    })
    // Also re-enable when focus leaves the editor during IME
    contentDOM.addEventListener("blur", enableImeExtensions)

    // Notify parent that the editor is ready
    props.onEditorReady?.(editorView)

    // Focus the editor after mount
    editorView.focus()

    // Ctrl+Wheel zoom
    wheelHandler = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const currentSize = props.fontSize ?? 14
      const delta = event.deltaY < 0 ? 1 : -1
      const nextSize = Math.min(32, Math.max(8, currentSize + delta))
      if (nextSize !== currentSize) {
        props.onFontSizeChange?.(nextSize)
      }
    }
    containerRef.addEventListener("wheel", wheelHandler, { passive: false })
  })

  onCleanup(() => {
    if (wheelHandler && containerRef) {
      containerRef.removeEventListener("wheel", wheelHandler)
      wheelHandler = undefined
    }
    clearAutoSaveTimer()
    clearPendingRaf()
    editorView?.destroy()
    editorView = undefined
  })

  /**
   * Update editor content when props.value changes externally
   * (e.g., after file reload from disk).
   *
   * IMPORTANT: If the editor is dirty (user has unsaved edits), we skip
   * the external update to prevent overwriting the user's work.
   *
   * Also skips immediately after a save (savedRevision bump) because
   * the post-save async load will cause props.value to change, but the
   * editor already has the correct content.
   */
  createEffect(() => {
    const currentValue = props.value
    if (!editorView) return

    // Skip one cycle after savedRevision bump to avoid overwriting
    // editor content with the post-save async reload result
    if (skipNextValueSync) {
      skipNextValueSync = false
      return
    }

    // If dirty, the user has unsaved edits — do NOT overwrite them
    if (dirty) return

    const editorContent = editorView.state.doc.toString()
    if (currentValue !== editorContent) {
      updatingFromProps = true
      // Preserve scroll position across content replacement
      const scrollTop = editorView.scrollDOM.scrollTop
      editorView.dispatch({
        changes: {
          from: 0,
          to: editorContent.length,
          insert: currentValue,
        },
      })
      // Restore scroll position after dispatch (cancel any previous pending RAF)
      clearPendingRaf()
      pendingRafId = requestAnimationFrame(() => {
        pendingRafId = undefined
        if (editorView) {
          editorView.scrollDOM.scrollTop = scrollTop
        }
      })
      updatingFromProps = false
      lastSavedContent = currentValue
      dirty = false
      props.onDirtyChange?.(false)
    }
  })

  /**
   * When savedRevision increments, mark the current editor content as saved.
   * Uses on() to only react to changes (not initial render).
   * Fix: explicitly check for undefined/null to allow revision 0 as a valid value.
   *
   * Also sets skipNextValueSync to prevent the props.value effect from
   * overwriting the editor content with the post-save async reload result.
   */
  createEffect(
    on(
      () => props.savedRevision,
      (revision) => {
        if (revision === undefined || revision === null || !editorView) return
        lastSavedContent = editorView.state.doc.toString()
        if (dirty) {
          dirty = false
          props.onDirtyChange?.(false)
        }
        // Prevent the next props.value change (from post-save async reload)
        // from overwriting the editor content
        skipNextValueSync = true
      },
    ),
  )

  /**
   * Load language extension when filePath changes.
   * Uses a monotonic counter to discard stale async results (race condition fix).
   */
  createEffect(() => {
    const filePath = props.filePath
    if (!filePath || !editorView) return
    // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
    loadLanguage(filePath)
  })

  /**
   * Reactively update readOnly when prop changes.
   */
  createEffect(() => {
    const readOnly = props.readOnly ?? false
    if (!editorView) return
    editorView.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
    })
  })

  /**
   * Reactively update tabSize when prop changes.
   */
  createEffect(() => {
    const tabSize = props.tabSize ?? 4
    if (!editorView) return
    editorView.dispatch({
      effects: tabSizeCompartment.reconfigure(EditorState.tabSize.of(tabSize)),
    })
  })

  /**
   * Reactively toggle line wrapping when prop changes.
   */
  createEffect(() => {
    const wrapping = props.lineWrapping ?? false
    if (!editorView) return
    editorView.dispatch({
      effects: lineWrappingCompartment.reconfigure(wrapping ? EditorView.lineWrapping : []),
    })
  })

  /**
   * Load a language extension asynchronously.
   * Increments languageLoadId before the async call and checks it after
   * to discard results from stale loads (e.g., user switched files quickly).
   */
  async function loadLanguage(filePath: string) {
    if (!editorView) return

    const currentLoadId = ++languageLoadId

    const extension = await resolveLanguageExtension(filePath)

    // Discard if another load was triggered while we were waiting
    if (currentLoadId !== languageLoadId) return
    // Editor may have been destroyed during async
    if (!editorView) return

    editorView.dispatch({
      effects: languageCompartment.reconfigure(extension ?? []),
    })
  }

  return (
    <div
      ref={containerRef}
      class={props.class}
      style={{
        width: "100%",
        height: "100%",
        "min-height": "0",
        overflow: "visible",
      }}
    />
  )
}
