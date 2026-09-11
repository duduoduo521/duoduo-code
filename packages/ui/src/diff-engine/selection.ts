import type { DiffLine, DiffSide } from "./compute"

export type { DiffSide }

// ---------------------------------------------------------------------------
// Selection types — no single-side constraint, each line carries its own side
// ---------------------------------------------------------------------------

export interface LineSelection {
  start: number
  end: number
  /** Alias for startSide — kept for backward compat with app-level SelectedLineRange */
  side?: DiffSide
  startSide?: DiffSide
  endSide?: DiffSide
}

export function normalizeSelection(sel: LineSelection): LineSelection {
  if (sel.start <= sel.end) return sel
  // Swap start/end and their corresponding sides
  const startSide = sel.endSide ?? sel.startSide
  const endSide = sel.startSide ?? sel.endSide
  return {
    start: sel.end,
    end: sel.start,
    startSide,
    endSide,
  }
}

export function isLineInRange(line: DiffLine, sel: LineSelection | null): boolean {
  if (!sel) return false
  const norm = normalizeSelection(sel)
  if (line.index < norm.start || line.index > norm.end) return false
  // Side-agnostic if selection has no side info
  if (!norm.startSide && !norm.endSide) return true
  if (line.index === norm.start && norm.startSide && line.side !== norm.startSide) return false
  if (line.index === norm.end && norm.endSide && line.side !== norm.endSide) return false
  return true
}

export function lineSideFromElement(el: HTMLElement): DiffSide | undefined {
  const row = el.closest("[data-line-type]")
  if (!(row instanceof HTMLElement)) return
  const type = row.getAttribute("data-line-type")
  if (type === "change-deletion" || type === "deletion") return "deletions"
  if (type === "change-addition" || type === "addition") return "additions"
  // context, hunk-header, no-newline → default to additions
  return "additions"
}

export function lineIndexFromElement(el: HTMLElement): number | undefined {
  const row = el.closest("[data-line-index]")
  if (!(row instanceof HTMLElement)) return
  const raw = row.getAttribute("data-line-index")
  if (!raw) return
  const value = parseInt(raw, 10)
  return Number.isNaN(value) ? undefined : value
}

/**
 * Read the current text selection inside the diff viewer container
 * and resolve it to a LineSelection. Works with normal DOM — no Shadow DOM.
 */
export function readTextSelection(container: HTMLElement): LineSelection | undefined {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed) return

  const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : undefined
  if (!range) return

  const startNode = range.startContainer
  const endNode = range.endContainer
  if (!container.contains(startNode) || !container.contains(endNode)) return

  const startEl = startNode instanceof HTMLElement ? startNode : startNode.parentElement
  const endEl = endNode instanceof HTMLElement ? endNode : endNode.parentElement
  if (!startEl || !endEl) return

  const startIndex = lineIndexFromElement(startEl)
  const endIndex = lineIndexFromElement(endEl)
  if (startIndex === undefined || endIndex === undefined) return

  const result: LineSelection = { start: startIndex, end: endIndex }
  const ss = lineSideFromElement(startEl)
  const es = lineSideFromElement(endEl)
  if (ss) result.startSide = ss
  if (es) result.endSide = es
  return result
}

/**
 * Mark lines in the container as selected/unselected via data attribute.
 * Unlike @pierre/diffs which uses Shadow DOM + InteractionManager.renderSelection(),
 * this operates directly on regular DOM — fast, reliable, styleable with CSS.
 */
export function renderSelectionInDom(container: HTMLElement, sel: LineSelection | null, lines: DiffLine[]): void {
  // Clear previous
  const selected = container.querySelectorAll("[data-selected-line]")
  for (const el of selected) {
    if (el instanceof HTMLElement) el.removeAttribute("data-selected-line")
  }

  if (!sel) return

  const norm = normalizeSelection(sel)
  for (let i = norm.start; i <= norm.end; i++) {
    if (i < 0 || i >= lines.length) continue
    const row = container.querySelector(`[data-line-index="${i}"]`)
    if (row instanceof HTMLElement) {
      row.setAttribute("data-selected-line", "")
    }
  }
}
