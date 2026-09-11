import { createSignal } from "solid-js"
import type { EditorView } from "@duoduo-ai/ui/codemirror-editor"

/**
 * Global singleton signal that tracks the EditorView of the currently
 * active file-tab editor. Any component that needs to drive editor
 * actions (e.g. the "file.find" command) reads from here.
 *
 * The signal lives outside the component tree so that the command
 * system (which is also outside the tree) can access it without
 * prop-drilling.
 */

const [activeEditorView, setActiveEditorView] = createSignal<EditorView | undefined>(undefined)

export { activeEditorView }

/**
 * Register an EditorView as the active one.
 * Clears the previous view if it matches.
 *
 * NOTE: This is a plain setter — it does NOT call onCleanup().
 * onCleanup() must only be called during a component's synchronous
 * initialization phase. Since `handleEditorReady` is invoked as an
 * async callback (after CodeMirror mounts), calling onCleanup() there
 * corrupts SolidJS's reactive owner context and freezes the entire UI.
 *
 * Instead, cleanup is handled in the FileTabContent component itself
 * via an onCleanup that calls clearActiveEditorViewIf(view).
 */
export function setActiveEditor(view: EditorView) {
  setActiveEditorView(view)
}

/**
 * Clear the active editor signal only if it still points to `view`.
 * Safe to call from a component's onCleanup.
 */
export function clearActiveEditorViewIf(view: EditorView) {
  setActiveEditorView((prev) => (prev === view ? undefined : prev))
}
