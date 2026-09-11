import { createSortable, useDragDropContext } from "@thisbeyond/solid-dnd"
import type { Transformer } from "@thisbeyond/solid-dnd"
import { createRoot, onCleanup, type JSXElement } from "solid-js"

// Sortable is declared but not exported by @thisbeyond/solid-dnd.
// Derive the type from createSortable's return value instead.
type Sortable = ReturnType<typeof createSortable>

type DragEvent = { draggable?: { id?: unknown } }

const isDragEvent = (event: unknown): event is DragEvent => {
  if (typeof event !== "object" || event === null) return false
  return "draggable" in event
}

export const getDraggableId = (event: unknown): string | undefined => {
  if (!isDragEvent(event)) return undefined
  const draggable = event.draggable
  if (!draggable) return undefined
  return typeof draggable.id === "string" ? draggable.id : undefined
}

const createTransformer = (id: string, axis: "x" | "y"): Transformer => ({
  id,
  order: 100,
  callback: (transform) => (axis === "x" ? { ...transform, x: 0 } : { ...transform, y: 0 }),
})

const createAxisConstraint = (axis: "x" | "y", transformerId: string) => (): JSXElement => {
  const context = useDragDropContext()
  if (!context) return null
  // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
  const [, { onDragStart, onDragEnd, addTransformer, removeTransformer }] = context
  const transformer = createTransformer(transformerId, axis)
  const dispose = createRoot((dispose) => {
    onDragStart((event) => {
      const id = getDraggableId(event)
      if (!id) return
      addTransformer("draggables", id, transformer)
    })
    onDragEnd((event) => {
      const id = getDraggableId(event)
      if (!id) return
      const [state] = context
      if (!state.draggables[id]) return
      removeTransformer("draggables", id, transformer.id)
    })
    return dispose
  })
  onCleanup(dispose)
  return null
}

export const ConstrainDragXAxis = createAxisConstraint("x", "constrain-x-axis")

export const ConstrainDragYAxis = createAxisConstraint("y", "constrain-y-axis")

// ---------------------------------------------------------------------------
// Safe createSortable wrapper
// ---------------------------------------------------------------------------

/**
 * Pattern for warnings emitted by `@thisbeyond/solid-dnd` when it tries to
 * remove a droppable/draggable/transformer that has already been removed from
 * its internal registry.
 *
 * Root cause: `createSortable` registers three `onCleanup` callbacks:
 *   1. `removeDraggable(id)` – marks for deferred deletion via `queueMicrotask`
 *   2. `removeDroppable(id)` – marks for deferred deletion via `queueMicrotask`
 *   3. `removeTransformer("droppables", id, "sortableOffset")` – synchronous
 *
 * Because (1) and (2) schedule *deferred* deletions while (3) runs
 * synchronously, a race can occur: the microtask from an earlier
 * `removeDroppable` / `removeDraggable` call may execute between SolidJS
 * cleanup phases, deleting the droppable before `removeTransformer` gets a
 * chance to run. The library then warns about a "nonexistent" item.
 *
 * These warnings are harmless — they merely indicate a redundant removal
 * attempt — but they clutter the console and alarm developers.
 */
const DND_CLEANUP_WARNING =
  /Cannot (add|remove) transformer (from|to) nonexistent|Cannot remove nonexistent (droppable|draggable|sensor)|Cannot remove from .* nonexistent transformer/

/** Reference-counted console.warn suppression for concurrent sortables. */
let _suppressCount = 0
let _originalWarn: ((...args: unknown[]) => void) | null = null

function suppressDndWarnings() {
  if (_suppressCount === 0) {
    _originalWarn = console.warn.bind(console)
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === "string" && DND_CLEANUP_WARNING.test(args[0])) {
        return // suppress the harmless DnD cleanup warning
      }
      _originalWarn!(...args)
    }
  }
  _suppressCount++
}

function restoreDndWarnings() {
  _suppressCount--
  if (_suppressCount <= 0) {
    _suppressCount = 0
    if (_originalWarn !== null) {
      console.warn = _originalWarn
      _originalWarn = null
    }
  }
}

/**
 * A drop-in replacement for `createSortable` that suppresses harmless cleanup
 * warnings from `@thisbeyond/solid-dnd`.
 *
 * **Why this exists:** When a sortable component unmounts (e.g. a project is
 * closed from the sidebar), the library's internal `onCleanup` callbacks
 * (`removeDraggable`, `removeDroppable`, `removeTransformer`) can race with
 * each other due to the library's `queueMicrotask`-based deferred deletion.
 * This results in console warnings like:
 *
 * ```
 * Cannot remove transformer from nonexistent droppable with id: D:\project
 * Cannot remove nonexistent droppable with id: D:\project
 * Cannot remove nonexistent draggable with id: D:\project
 * Cannot remove from droppable with id D:\project, nonexistent transformer with id: sortableOffset
 * ```
 *
 * These are benign — the items are already gone — so we suppress them during
 * the cleanup phase only.
 *
 * **How it works:**
 * 1. Registers an `onCleanup` *before* calling `createSortable`, so it runs
 *    **first** (SolidJS FIFO cleanup order).
 * 2. In that cleanup, temporarily overrides `console.warn` to filter out DnD
 *    cleanup warnings, then schedules a microtask to restore it.
 * 3. Uses a reference counter so concurrent cleanups of multiple sortables
 *    don't prematurely restore `console.warn`.
 *
 * @param id    Sortable identifier (same as you'd pass to `createSortable`)
 * @param data  Optional data payload (same as you'd pass to `createSortable`)
 * @returns     The sortable directive object, identical to `createSortable`'s return
 */
export function createSafeSortable(id: string | number, data?: Record<string, unknown>): Sortable {
  // IMPORTANT: Register our onCleanup BEFORE calling createSortable.
  // SolidJS runs onCleanup callbacks in FIFO order, so ours will execute
  // before the library's own removeDraggable / removeDroppable / removeTransformer
  // callbacks. This ensures console.warn is overridden in time.
  onCleanup(() => {
    suppressDndWarnings()
    // Restore after all pending microtasks (including the library's deferred
    // cleanupDroppable / cleanupDraggable microtasks) have drained.
    // Using setTimeout(0) instead of queueMicrotask ensures we wait until
    // *all* microtasks have completed before restoring console.warn.
    setTimeout(restoreDndWarnings, 0)
  })

  return createSortable(id, data)
}
