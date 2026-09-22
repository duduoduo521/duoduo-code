import { EditorView, layer, RectangleMarker, type LayerMarker } from "@codemirror/view"
import { EditorSelection } from "@codemirror/state"
import type { Extension } from "@codemirror/state"

/**
 * Secondary selection visualization.
 *
 * Why this file exists
 * --------------------
 * The base extension set deliberately removes CodeMirror's `drawSelection()`
 * so the editor uses the browser's native ::selection rendering for the
 * primary selection range — this gives a textarea/VSCode-like UX with zero
 * frame lag and no off-by-N highlighting glitches.
 *
 * However, the browser's Selection API can only render ONE range at a time.
 * That breaks two CM6 features:
 *
 *   1. Multi-cursor (Ctrl+D / selectNextOccurrence) — only the primary
 *      cursor blinks; the rest are invisible.
 *   2. Rectangular selection (Alt+drag) — internally a fan-out of N parallel
 *      ranges; only the first row shows.
 *
 * This module restores visualization for the *non-primary* ranges using
 * CM6's official `layer()` API + `RectangleMarker.forRange()`. The primary
 * range continues to use native ::selection. Same color is used on both
 * sides so they look identical.
 *
 * IMPORTANT (lesson learned the hard way)
 * ---------------------------------------
 * Do NOT inject any extra DOM children into the layer container. CM6's
 * internal LayerView.draw() reconciles `this.drawn` (initial value: [])
 * against the live DOM and accesses `this.drawn[oldI].constructor`,
 * which throws TypeError when an extra child precedes the first real
 * marker batch. That kills the entire layer render — including all
 * subsequent rectangle pieces, which is exactly why earlier "debug
 * probe" attempts produced the symptom "only one rectangle drawn".
 */

const SELECTION_CLASS = "cm-secondarySelection"
const CURSOR_CLASS = "cm-secondaryCursor"

/**
 * Layer that paints background rectangles for every NON-primary range.
 * Empty ranges (cursors) are skipped here — they're handled by the cursor
 * layer below.
 */
const secondarySelectionLayer = layer({
  above: false,
  class: "cm-secondarySelectionLayer",
  update(update) {
    return update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged
  },
  markers(view) {
    const out: LayerMarker[] = []
    const ranges = view.state.selection.ranges
    const main = view.state.selection.mainIndex
    for (let i = 0; i < ranges.length; i++) {
      if (i === main) continue
      const range = ranges[i]
      if (range!.empty) continue
      for (const marker of RectangleMarker.forRange(view, SELECTION_CLASS, range!)) {
        out.push(marker)
      }
    }
    return out
  },
})

/**
 * Layer that paints a blinking caret for every NON-primary cursor.
 * Used by both multi-cursor (Ctrl+D) and rectangular selection (Alt+drag).
 */
const secondaryCursorLayer = layer({
  above: true,
  class: "cm-secondaryCursorLayer",
  update(update) {
    return update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged
  },
  markers(view) {
    const out: LayerMarker[] = []
    const ranges = view.state.selection.ranges
    const main = view.state.selection.mainIndex
    for (let i = 0; i < ranges.length; i++) {
      if (i === main) continue
      const range = ranges[i]
      // Build an empty cursor range at this range's head, then let
      // RectangleMarker.forRange() do the coordinate math (matches CM6's
      // built-in cursor layer exactly, incl. bidi / line-wrap edge cases).
      const cursor = range!.empty ? range : EditorSelection.cursor(range!.head, range!.assoc || 1)
      for (const marker of RectangleMarker.forRange(view, CURSOR_CLASS, cursor!)) {
        out.push(marker)
      }
    }
    return out
  },
})

/**
 * Theme: secondary selection background + secondary caret.
 * Selection color matches the native ::selection in theme.ts so the visual
 * is uniform across primary (native) and secondary (drawn) ranges.
 */
const secondarySelectionTheme = EditorView.theme({
  [`.${SELECTION_CLASS}`]: {
    // Same source as the primary ::selection (see --cm-selection-bg, which
    // carries a static fallback for engines without color-mix()).
    backgroundColor: "var(--cm-selection-bg)",
  },
  [`.${CURSOR_CLASS}`]: {
    width: "1.5px !important",
    backgroundColor: "var(--text-interactive-base, #388bfd)",
    animation: "cm-secondary-cursor-blink 1.06s steps(2) infinite",
  },
  "@keyframes cm-secondary-cursor-blink": {
    "0%, 50%": { opacity: "1" },
    "50.01%, 100%": { opacity: "0" },
  },
})

/**
 * The complete extension: drop this into `createBaseExtensions()` to restore
 * multi-cursor + rectangular selection visualization while keeping native
 * ::selection for the primary range.
 */
export const secondarySelection: Extension = [secondarySelectionLayer, secondaryCursorLayer, secondarySelectionTheme]
