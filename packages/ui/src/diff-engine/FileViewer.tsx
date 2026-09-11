import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { type LineSelection, normalizeSelection, lineIndexFromElement } from "./selection"
import { highlightLines } from "./highlight"
import type { LineAnnotation } from "./types"
import { useCodeFind, type CodeFind } from "./find"
import { FileSearchBar } from "../components/file-search"

// ---------------------------------------------------------------------------
// Virtual scroll line threshold
// ---------------------------------------------------------------------------

const VIRTUALIZE_LINE_THRESHOLD = 1000

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FileViewerProps<T = unknown> {
  /** File text content */
  contents: string
  /** Language for syntax highlighting (defaults to "text") */
  lang?: string
  /** File name (used for language inference fallback) */
  name?: string
  /** Hide line numbers when true */
  disableLineNumbers?: boolean
  /** Current line selection */
  selectedLines?: LineSelection | null
  /** Commented line ranges */
  commentedLines?: LineSelection[]
  /** Enable line selection interaction */
  enableLineSelection?: boolean
  /** Fires during drag selection */
  onLineSelected?: (sel: LineSelection | null) => void
  /** Fires when drag ends */
  onLineSelectionEnd?: (sel: LineSelection | null) => void
  /** Fires when drag ends on a line-number column */
  onLineNumberSelectionEnd?: (sel: LineSelection | null) => void
  /** Fires after syntax highlighting completes */
  onRendered?: () => void
  /** Per-line annotations */
  annotations?: LineAnnotation<T>[]
  /** CSS class on root container */
  class?: string
  /** Conditional class map on root container */
  classList?: Record<string, boolean>
  /** Search control (if not provided, an internal instance is created) */
  search?: CodeFind
}

// ---------------------------------------------------------------------------
// Internal line model
// ---------------------------------------------------------------------------

interface FileLine {
  /** 0-based index */
  index: number
  /** Raw text content (no newline) */
  content: string
  /** 1-based line number */
  lineNumber: number
}

// ---------------------------------------------------------------------------
// FileViewer
// ---------------------------------------------------------------------------

export function FileViewer<T = unknown>(props: FileViewerProps<T>) {
  let containerRef!: HTMLDivElement

  // Parse contents into FileLine[]
  const fileLines = createMemo<FileLine[]>(() => {
    const text = props.contents
    if (!text) return []
    const raw = text.split("\n")
    // If the file ends with \n, the split produces an empty trailing entry — drop it
    if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop()
    return raw.map((content, index) => ({ index, content, lineNumber: index + 1 }))
  })

  // Highlighted HTML per 0-based line index
  const [highlightedHtml, setHighlightedHtml] = createSignal<Map<number, string>>(new Map())
  const [highlightReady, setHighlightReady] = createSignal(false)

  // Selection drag state
  let dragStart: number | undefined
  let dragEnd: number | undefined
  let dragMoved = false
  let dragFromNumberColumn = false
  let internalSelection: LineSelection | null = null

  const effectiveLang = () => props.lang ?? "text"

  // Virtual scroll: whether the file exceeds the line threshold
  const virtualize = () => fileLines().length > VIRTUALIZE_LINE_THRESHOLD

  // Search (internal or externally provided)
  const find: CodeFind = props.search ?? useCodeFind(() => containerRef)

  // -------------------------------------------------------------------------
  // Syntax highlighting
  // -------------------------------------------------------------------------

  createEffect(() => {
    const lines = fileLines()
    const lang = effectiveLang()
    if (lines.length === 0) {
      setHighlightReady(true)
      return
    }

    setHighlightReady(false)

    const codeLines = lines.map((l) => l.content)

    highlightLines(codeLines, lang)
      .then((map) => {
        setHighlightedHtml(map)
        setHighlightReady(true)
      })
      .catch(() => {
        const fallback = new Map<number, string>()
        for (const line of lines) {
          fallback.set(line.index, escapeHtml(line.content))
        }
        setHighlightedHtml(fallback)
        setHighlightReady(true)
      })
  })

  // Notify rendered when highlight is ready
  createEffect(() => {
    if (highlightReady()) {
      props.onRendered?.()
    }
  })

  // Refresh search when highlighted HTML changes
  createEffect(() => {
    if (highlightReady() && find.open()) {
      find.refresh()
    }
  })

  // -----------------------------------------------------------------------
  // Selection rendering
  //
  // Use requestAnimationFrame to ensure the DOM has been fully updated
  // by SolidJS's reactive system before querying [data-line-index].
  // -----------------------------------------------------------------------

  createEffect(() => {
    const sel = props.selectedLines ?? internalSelection
    const lineCount = fileLines().length
    if (!containerRef) return
    requestAnimationFrame(() => renderFileSelectionInDom(containerRef, sel, lineCount))
  })

  // Commented lines rendering
  createEffect(() => {
    const ranges = props.commentedLines ?? []
    if (!containerRef) return

    requestAnimationFrame(() => {
      // Clear previous
      const marked = containerRef.querySelectorAll("[data-comment-selected]")
      for (const el of marked) {
        if (el instanceof HTMLElement) el.removeAttribute("data-comment-selected")
      }

      const lineCount = fileLines().length
      for (const range of ranges) {
        const norm = normalizeSelection(range)
        for (let i = norm.start; i <= norm.end; i++) {
          if (i < 0 || i >= lineCount) continue
          const row = containerRef.querySelector(`[data-line-index="${i}"]`)
          if (row instanceof HTMLElement) row.setAttribute("data-comment-selected", "")
        }
      }
    })
  })

  // -------------------------------------------------------------------------
  // Mouse handlers for line selection
  // -------------------------------------------------------------------------

  const resolveHit = (event: MouseEvent): { lineIndex: number; numberColumn: boolean } | undefined => {
    const path = event.composedPath()
    let numberColumn = false
    for (const item of path) {
      if (!(item instanceof HTMLElement)) continue
      if (item.dataset.columnNumber != null) numberColumn = true
      const idx = lineIndexFromElement(item)
      if (idx !== undefined) {
        return { lineIndex: idx, numberColumn }
      }
    }
    return
  }

  const handleMouseDown = (event: MouseEvent) => {
    if (!props.enableLineSelection) return
    if (event.button !== 0) return

    const hit = resolveHit(event)
    // Only start line selection when clicking the number column.
    // Clicking the code content must fall through to the browser's native
    // text selection (same behaviour as a textarea).
    if (!hit || !hit.numberColumn) return

    dragStart = hit.lineIndex
    dragEnd = hit.lineIndex
    dragMoved = false
    dragFromNumberColumn = true

    // Register a document-level mouseup so we catch the release even if the
    // pointer leaves the container during the drag.
    const onDocMouseUp = () => {
      handleMouseUp()
      document.removeEventListener("mouseup", onDocMouseUp)
    }
    document.addEventListener("mouseup", onDocMouseUp)

    event.preventDefault()
  }

  const handleMouseMove = (event: MouseEvent) => {
    if (!props.enableLineSelection) return
    if (dragStart === undefined) return

    const hit = resolveHit(event)
    if (!hit) return

    dragEnd = hit.lineIndex
    dragMoved = true

    const sel = buildDragSelection()
    if (sel) {
      internalSelection = sel
      renderFileSelectionInDom(containerRef, sel, fileLines().length)
    }
  }

  const handleMouseUp = () => {
    if (!props.enableLineSelection) return
    if (dragStart === undefined) return

    let sel: LineSelection | null = null
    if (!dragMoved) {
      sel = { start: dragStart, end: dragStart }
    } else {
      sel = buildDragSelection()
    }

    internalSelection = sel
    renderFileSelectionInDom(containerRef, sel, fileLines().length)
    props.onLineSelected?.(sel)
    props.onLineSelectionEnd?.(sel)

    if (dragFromNumberColumn) {
      props.onLineNumberSelectionEnd?.(sel)
    }

    dragStart = undefined
    dragEnd = undefined
    dragMoved = false
    dragFromNumberColumn = false
  }

  const buildDragSelection = (): LineSelection | null => {
    if (dragStart === undefined || dragEnd === undefined) return null
    return { start: dragStart, end: dragEnd }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div
      data-component="file-viewer"
      data-file
      ref={containerRef}
      tabindex={0}
      class={props.class}
      classList={props.classList}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onPointerDown={find.onPointerDown}
      onFocus={find.onFocus}
      onKeyDown={find.onKeyDown}
    >
      <For each={fileLines()}>
        {(line) => (
          <FileRow
            line={line}
            html={() => highlightedHtml().get(line.index) ?? escapeHtml(line.content)}
            disableLineNumbers={props.disableLineNumbers}
            annotation={props.annotations?.find((a) => a.lineNumber === line.lineNumber)}
            virtualize={virtualize()}
          />
        )}
      </For>
      <Show when={find.open()}>
        <FileSearchBar
          pos={find.pos}
          query={find.query}
          index={find.index}
          count={find.count}
          setInput={find.setInput}
          onInput={find.setQuery}
          onKeyDown={find.onInputKeyDown}
          onClose={find.close}
          onPrev={() => find.next(-1)}
          onNext={() => find.next(1)}
        />
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Single row
// ---------------------------------------------------------------------------

function FileRow<T>(props: {
  line: FileLine
  html: () => string
  disableLineNumbers?: boolean
  annotation?: LineAnnotation<T>
  virtualize?: boolean
}) {
  // See DiffViewer.tsx — update innerHTML imperatively to avoid destroying
  // the active text selection on every reactive update.
  let codeSpan: HTMLSpanElement | undefined
  let lastHtml = ""
  createEffect(() => {
    const html = props.html()
    if (!codeSpan) return
    if (html === lastHtml) return
    codeSpan.innerHTML = html
    lastHtml = html
  })

  return (
    <div
      class="file-row"
      classList={{ "file-row-virtualized": !!props.virtualize }}
      data-line={props.line.lineNumber}
      data-line-index={props.line.index}
    >
      <Show when={!props.disableLineNumbers}>
        <div class="file-line-number" data-column-number>
          {props.line.lineNumber}
        </div>
      </Show>
      <div class="file-line-content" data-code>
        <span ref={codeSpan} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Selection rendering (single-side variant — no DiffSide)
// ---------------------------------------------------------------------------

function renderFileSelectionInDom(container: HTMLElement, sel: LineSelection | null, lineCount: number): void {
  // Clear previous
  const selected = container.querySelectorAll("[data-selected-line]")
  for (const el of selected) {
    if (el instanceof HTMLElement) el.removeAttribute("data-selected-line")
  }

  if (!sel) return

  const norm = normalizeSelection(sel)
  for (let i = norm.start; i <= norm.end; i++) {
    if (i < 0 || i >= lineCount) continue
    const row = container.querySelector(`[data-line-index="${i}"]`)
    if (row instanceof HTMLElement) {
      row.setAttribute("data-selected-line", "")
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
