import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { computeDiff, type DiffLine, type DiffResult, type DiffSide } from "./compute"
import {
  type LineSelection,
  normalizeSelection,
  renderSelectionInDom,
  lineIndexFromElement,
  lineSideFromElement,
} from "./selection"
import { wordDiffForSide, type WordDiffPart } from "./word-diff"
import { highlightLines } from "./highlight"
import { useCodeFind, type CodeFind } from "./find"
import { FileSearchBar } from "../components/file-search"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DiffViewerProps {
  /** Old file content */
  before: string
  /** New file content */
  after: string
  /** Language for syntax highlighting (inferred from filename if not set) */
  lang?: string
  /** Diff style: "unified" (single column) or "split" (side-by-side) */
  diffStyle?: "unified" | "split"
  /** Show line numbers */
  disableLineNumbers?: boolean
  /** Enable word-diff for changed lines */
  wordDiff?: boolean
  /** Max line length for word-diff (skip if longer) */
  maxWordDiffLength?: number
  /** Current line selection */
  selectedLines?: LineSelection | null
  /** Commented line ranges */
  commentedLines?: LineSelection[]
  /** Enable line selection interaction */
  enableLineSelection?: boolean
  /** Callbacks */
  onLineSelected?: (sel: LineSelection | null) => void
  onLineSelectionEnd?: (sel: LineSelection | null) => void
  onLineNumberSelectionEnd?: (sel: LineSelection | null) => void
  onRendered?: () => void
  class?: string
  classList?: Record<string, boolean>
  /** Search control (if not provided, an internal instance is created) */
  search?: CodeFind
}

// ---------------------------------------------------------------------------
// DiffViewer
// ---------------------------------------------------------------------------

export function DiffViewer(props: DiffViewerProps) {
  console.warn("[frontend] dv-start", props.before?.length, props.after?.length)
  let containerRef!: HTMLDivElement

  // Compute the diff
  const diffResult = createMemo<DiffResult>(() => computeDiff(props.before, props.after))
  const diffLines = () => diffResult().lines

  // Split (side-by-side) layout: pair deletions (left) with additions (right)
  // within each hunk, keeping context lines on both sides.
  type SplitEntry =
    | { kind: "row"; left: DiffLine | null; right: DiffLine | null }
    | { kind: "header"; line: DiffLine }

  const splitEntries = createMemo<SplitEntry[]>(() => {
    const lines = diffLines()
    const entries: SplitEntry[] = []
    let oldBuf: DiffLine[] = []
    let newBuf: DiffLine[] = []
    const flush = () => {
      const n = Math.max(oldBuf.length, newBuf.length)
      for (let i = 0; i < n; i++) {
        entries.push({ kind: "row", left: oldBuf[i] ?? null, right: newBuf[i] ?? null })
      }
      oldBuf = []
      newBuf = []
    }
    for (const line of lines) {
      if (line.type === "hunk-header") {
        entries.push({ kind: "header", line })
        continue
      }
      if (line.type === "no-newline") continue
      if (line.type === "context") {
        flush()
        entries.push({ kind: "row", left: line, right: line })
      } else if (line.type === "deletion") {
        oldBuf.push(line)
      } else if (line.type === "addition") {
        newBuf.push(line)
      }
    }
    flush()
    return entries
  })

  // One grid cell of the split view (wraps DiffCellBody with the shared
  // highlight/word-diff plumbing).
  const SplitCell = (cellProps: { line: DiffLine | null; wordDiff: boolean; disableLineNumbers?: boolean }) => {
    return (
      <Show when={cellProps.line} fallback={<div class="diff-row diff-split-empty" />}>
        {(line) => (
          <DiffCellBody
            line={line()}
            html={() => highlightedHtml().get(line().index) ?? escapeHtml(line().content)}
            wordDiff={cellProps.wordDiff}
            renderWordDiff={(l, h) => renderWordDiff(l, h)}
            disableLineNumbers={cellProps.disableLineNumbers}
          />
        )}
      </Show>
    )
  }

  // Highlighted HTML per line
  const [highlightedHtml, setHighlightedHtml] = createSignal<Map<number, string>>(new Map())
  const [highlightReady, setHighlightReady] = createSignal(false)

  // Selection state
  let dragStart: number | undefined
  let dragEnd: number | undefined
  let dragMoved = false
  let dragSide: DiffSide | undefined
  let dragEndSide: DiffSide | undefined
  let dragFromNumberColumn = false
  let internalSelection: LineSelection | null = null

  const effectiveLang = () => props.lang ?? "text"
  const maxWordDiffLen = () => props.maxWordDiffLength ?? 1000

  // Search (internal or externally provided)
  const find: CodeFind = props.search ?? useCodeFind(() => containerRef)

  // -------------------------------------------------------------------------
  // Syntax highlighting
  // -------------------------------------------------------------------------

  createEffect(() => {
    const lines = diffLines()
    const lang = effectiveLang()
    if (lines.length === 0) return

    setHighlightReady(false)

    const codeLines = lines.filter((l) => l.type !== "hunk-header" && l.type !== "no-newline").map((l) => l.content)

    // Build index mapping: filtered index -> original DiffLine index
    const indexMap = new Map<number, number>()
    let filteredIdx = 0
    for (const line of lines) {
      if (line.type !== "hunk-header" && line.type !== "no-newline") {
        indexMap.set(filteredIdx, line.index)
        filteredIdx++
      }
    }

    highlightLines(codeLines, lang)
      .then((map) => {
        const remapped = new Map<number, string>()
        for (const [idx, html] of map) {
          const originalIdx = indexMap.get(idx)
          if (originalIdx !== undefined) remapped.set(originalIdx, html)
        }
        setHighlightedHtml(remapped)
        setHighlightReady(true)
      })
      .catch(() => {
        // Fallback: no highlighting
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
    const lines = diffLines()
    if (!containerRef) return
    requestAnimationFrame(() => renderSelectionInDom(containerRef, sel, lines))
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

      const lines = diffLines()
      for (const range of ranges) {
        const norm = normalizeSelection(range)
        for (let i = norm.start; i <= norm.end; i++) {
          if (i < 0 || i >= lines.length) continue
          const row = containerRef.querySelector(`[data-line-index="${i}"]`)
          if (row instanceof HTMLElement) row.setAttribute("data-comment-selected", "")
        }
      }
    })
  })

  // -----------------------------------------------------------------------
  // Mouse handlers for line selection
  //
  // CRITICAL: Only the line-number column triggers line selection.
  // Clicking / dragging in the code content area must NOT be intercepted
  // so the browser's native text selection (::selection) works normally,
  // giving the same experience as a textarea.
  // -----------------------------------------------------------------------

  const resolveHit = (event: MouseEvent): { lineIndex: number; side: DiffSide; numberColumn: boolean } | undefined => {
    const path = event.composedPath()
    let numberColumn = false
    for (const item of path) {
      if (!(item instanceof HTMLElement)) continue
      if (item.dataset.columnNumber != null) numberColumn = true
      const idx = lineIndexFromElement(item)
      const side = lineSideFromElement(item)
      if (idx !== undefined && side !== undefined) {
        return { lineIndex: idx, side, numberColumn }
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
    dragSide = hit.side
    dragEndSide = hit.side
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
    dragEndSide = hit.side
    dragMoved = true

    const sel = buildDragSelection()
    if (sel) {
      internalSelection = sel
      renderSelectionInDom(containerRef, sel, diffLines())
    }
  }

  const handleMouseUp = () => {
    if (!props.enableLineSelection) return
    if (dragStart === undefined) return

    let sel: LineSelection | null = null
    if (!dragMoved) {
      sel = { start: dragStart, end: dragStart, startSide: dragSide, endSide: dragSide }
    } else {
      sel = buildDragSelection()
    }

    internalSelection = sel
    renderSelectionInDom(containerRef, sel, diffLines())
    props.onLineSelected?.(sel)
    props.onLineSelectionEnd?.(sel)

    if (dragFromNumberColumn) {
      props.onLineNumberSelectionEnd?.(sel)
    }

    dragStart = undefined
    dragEnd = undefined
    dragMoved = false
    dragSide = undefined
    dragEndSide = undefined
    dragFromNumberColumn = false
  }

  const buildDragSelection = (): LineSelection | null => {
    if (dragStart === undefined || dragEnd === undefined) return null
    return {
      start: dragStart,
      end: dragEnd,
      startSide: dragSide,
      endSide: dragEndSide,
    }
  }

  // -------------------------------------------------------------------------
  // Word-diff rendering
  // -------------------------------------------------------------------------

  const renderWordDiff = (line: DiffLine, html: string): string => {
    if (!props.wordDiff) return html
    if (line.type !== "addition" && line.type !== "deletion") return html

    const lines = diffLines()
    // Find paired line in the same hunk
    const paired = findPairedLine(lines, line)
    if (!paired) return html

    if (line.content.length > maxWordDiffLen() || paired.content.length > maxWordDiffLen()) {
      return html
    }

    const oldContent = line.side === "deletions" ? line.content : paired.content
    const newContent = line.side === "additions" ? line.content : paired.content
    const parts = wordDiffForSide(oldContent, newContent, line.side)

    // Merge word-diff markers into the syntax-highlighted HTML.
    // We extract plain text segments from the highlighted HTML, align them
    // with the word-diff parts, and wrap changed segments with
    // <span data-diff-span> while preserving the original highlighting spans.
    return mergeWordDiffIntoHighlightedHtml(html, parts)
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div
      data-component="diff-viewer"
      data-diff
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
      <Show
        when={props.diffStyle === "split"}
        fallback={
          <For each={diffLines()}>
            {(line) => (
              <DiffRow
                line={line}
                html={() => highlightedHtml().get(line.index) ?? escapeHtml(line.content)}
                wordDiff={props.wordDiff ?? false}
                renderWordDiff={(l, h) => renderWordDiff(l, h)}
                disableLineNumbers={props.disableLineNumbers}
              />
            )}
          </For>
        }
      >
        <div class="diff-viewer-split">
          <For each={splitEntries()}>
            {(entry) =>
              entry.kind === "header" ? (
                <div
                  class="diff-row diff-hunk-header diff-split-header"
                  data-line-index={entry.line.index}
                  data-line-type="hunk-header"
                  data-hunk={entry.line.hunkIndex}
                >
                  <div class="diff-hunk-header-content">{entry.line.content}</div>
                </div>
              ) : (
                <>
                  <SplitCell line={entry.left} wordDiff={props.wordDiff ?? false} disableLineNumbers={props.disableLineNumbers} />
                  <SplitCell line={entry.right} wordDiff={props.wordDiff ?? false} disableLineNumbers={props.disableLineNumbers} />
                </>
              )
            }
          </For>
        </div>
      </Show>
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

function diffLineTypeClass(line: DiffLine): string {
  switch (line.type) {
    case "addition":
      return "diff-line-addition"
    case "deletion":
      return "diff-line-deletion"
    case "context":
      return "diff-line-context"
    case "hunk-header":
      return "diff-hunk-header"
    case "no-newline":
      return "diff-no-newline"
  }
  return ""
}

function diffLineTypeAttr(line: DiffLine): string {
  switch (line.type) {
    case "addition":
      return "change-addition"
    case "deletion":
      return "change-deletion"
    case "context":
      return "context"
    case "hunk-header":
      return "hunk-header"
    case "no-newline":
      return "no-newline"
  }
  return ""
}

/**
 * Renders the inner body of a single diff line. Shared by the unified layout
 * (one row per line) and the split layout (one grid cell per side).
 */
function DiffCellBody(props: {
  line: DiffLine
  html: () => string
  wordDiff: boolean
  renderWordDiff: (line: DiffLine, html: string) => string
  disableLineNumbers?: boolean
}) {
  const displayHtml = createMemo(() => {
    const raw = props.html()
    if (!props.wordDiff) return raw
    return props.renderWordDiff(props.line, raw)
  })

  // Hold a ref to the inner span so we can imperatively update innerHTML.
  // Using a SolidJS reactive `innerHTML` prop would re-write the DOM on every
  // dependency change, which destroys any active text selection (Selection
  // ranges are anchored to specific text nodes). We update only when the
  // string actually changes.
  let codeSpan: HTMLSpanElement | undefined
  let lastHtml = ""
  createEffect(() => {
    const html = displayHtml()
    if (!codeSpan) return
    if (html === lastHtml) return
    codeSpan.innerHTML = html
    lastHtml = html
  })

  return (
    <div
      class={`diff-row ${diffLineTypeClass(props.line)}`}
      data-line-index={props.line.index}
      data-line-type={diffLineTypeAttr(props.line)}
      data-hunk={props.line.hunkIndex}
    >
      <Show when={!props.disableLineNumbers}>
        <div class="diff-line-number diff-line-number-old" data-column-number>
          {props.line.oldLineNumber ?? ""}
        </div>
        <div class="diff-line-number diff-line-number-new" data-column-number>
          {props.line.newLineNumber ?? ""}
        </div>
      </Show>
      <div class="diff-indicator">
        <Show when={props.line.type === "addition"}>+</Show>
        <Show when={props.line.type === "deletion"}>-</Show>
      </div>
      <div class="diff-line-content" data-code data-content>
        <span ref={codeSpan} />
      </div>
    </div>
  )
}

function DiffRow(props: {
  line: DiffLine
  html: () => string
  wordDiff: boolean
  renderWordDiff: (line: DiffLine, html: string) => string
  disableLineNumbers?: boolean
}) {
  return (
    <Show
      when={props.line.type !== "hunk-header"}
      fallback={
        <div
          class="diff-row diff-hunk-header"
          data-line-index={props.line.index}
          data-line-type="hunk-header"
          data-hunk={props.line.hunkIndex}
        >
          <div class="diff-hunk-header-content">{props.line.content}</div>
        </div>
      }
    >
      <DiffCellBody {...props} />
    </Show>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findPairedLine(lines: DiffLine[], line: DiffLine): DiffLine | undefined {
  // Find the opposite-side line in the same hunk, paired by offset within the hunk.
  // E.g. for 3 deletions + 3 additions: del[0]↔add[0], del[1]↔add[1], del[2]↔add[2]
  const targetType = line.type === "addition" ? "deletion" : "addition"
  let sameOffset = 0
  let targetOffset = 0
  let foundSelf = false
  for (const other of lines) {
    if (other.hunkIndex !== line.hunkIndex) continue
    if (other.type === line.type) {
      if (other === line) foundSelf = true
      if (!foundSelf) sameOffset++
    } else if (other.type === targetType) {
      if (foundSelf && targetOffset === sameOffset) return other
      targetOffset++
    }
  }
  // Fallback: return first opposite-type line in the same hunk
  for (const other of lines) {
    if (other.hunkIndex !== line.hunkIndex) continue
    if (other.type === targetType) return other
  }
  return
}

/**
 * Merge word-diff markers into syntax-highlighted HTML.
 *
 * Strategy: walk through the highlighted HTML extracting text-node content
 * and tag boundaries. Build a flat "text chunk" list where each chunk
 * carries its surrounding HTML context (prefix tags + suffix close tags).
 * Then align the concatenated plain text with the word-diff parts and
 * wrap changed chunks with <span data-diff-span data-diff-add/remove>.
 */
function mergeWordDiffIntoHighlightedHtml(html: string, parts: WordDiffPart[]): string {
  // 1. Parse the highlighted HTML into text segments with their tag context.
  const segments = parseHighlightedSegments(html)

  // 2. Build the plain text and a char-offset → segment-index map.
  let plainText = ""
  const charToSeg: number[] = [] // charToSeg[i] = segment index for plainText[i]
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si]
    for (let ci = 0; ci < seg!.text.length; ci++) {
      charToSeg.push(si)
    }
    plainText += seg!.text
  }

  // 3. Walk word-diff parts and mark which character ranges are added/removed.
  //    We use a per-character flag array.
  const charFlags = new Uint8Array(plainText.length) // 0=unchanged, 1=added, 2=removed
  let offset = 0
  for (const part of parts) {
    const len = part.value.length
    if (part.added) {
      for (let i = offset; i < offset + len; i++) charFlags[i] = 1
    } else if (part.removed) {
      for (let i = offset; i < offset + len; i++) charFlags[i] = 2
    }
    offset += len
  }

  // 4. Rebuild HTML: for each segment, split its text into runs of same flag
  //    and wrap changed runs with <span data-diff-span>.
  let result = ""
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si]
    result += seg!.prefix // opening tags before this text

    if (seg!.text.length === 0) {
      result += seg!.suffix
      continue
    }

    // Find the char-offset range for this segment in plainText
    let charStart = 0
    for (let k = 0; k < si; k++) charStart += segments[k]!.text.length

    // Split text into runs of same flag
    let runStart = 0
    let currentFlag = charFlags[charStart]
    for (let ci = 1; ci <= seg!.text.length; ci++) {
      const flag = ci < seg!.text.length ? charFlags[charStart + ci] : -1 // sentinel
      if (flag !== currentFlag) {
        const runText = seg!.text.slice(runStart, ci)
        if (currentFlag === 1) {
          result += `<span data-diff-span data-diff-add>${escapeHtml(runText)}</span>`
        } else if (currentFlag === 2) {
          result += `<span data-diff-span data-diff-remove>${escapeHtml(runText)}</span>`
        } else {
          result += escapeHtml(runText)
        }
        runStart = ci
        currentFlag = flag
      }
    }

    result += seg!.suffix // closing tags after this text
  }

  return result
}

/**
 * Parse highlighted HTML into a flat list of { prefix, text, suffix } segments.
 * Each segment represents one run of plain text with its surrounding open/close tags.
 * prefix = all opening tags before this text
 * text   = the plain text content
 * suffix = all closing tags after this text (before the next text or end)
 */
function parseHighlightedSegments(html: string): Array<{ prefix: string; text: string; suffix: string }> {
  const segments: Array<{ prefix: string; text: string; suffix: string }> = []
  let i = 0
  const tagStack: string[] = [] // stack of opening tags for nesting
  let pendingPrefix = ""

  while (i < html.length) {
    if (html[i] === "<") {
      const close = html.indexOf(">", i)
      if (close === -1) {
        // Malformed — treat rest as text
        if (i < html.length) {
          segments.push({ prefix: pendingPrefix, text: html.slice(i), suffix: "" })
          pendingPrefix = ""
        }
        break
      }
      const tag = html.slice(i, close + 1)

      if (tag.startsWith("</")) {
        // Closing tag — pop from stack and add to the suffix of the last segment
        if (tagStack.length > 0) tagStack.pop()
        // Accumulate closing tags; they'll be appended as suffix of the next text segment
        // or as a trailing suffix if no more text.
        pendingPrefix += tag
      } else if (tag.endsWith("/>")) {
        // Self-closing tag — treat as a zero-length text segment
        segments.push({ prefix: pendingPrefix + tag, text: "", suffix: "" })
        pendingPrefix = ""
      } else {
        // Opening tag — push to stack
        tagStack.push(tag)
        pendingPrefix += tag
      }
      i = close + 1
    } else {
      // Text content — find end of text run
      const end = html.indexOf("<", i)
      const text = end === -1 ? html.slice(i) : html.slice(i, end)
      i += text.length

      // Compute suffix: close all currently open tags, then reopen them for the next segment
      const suffix = tagStack.map(() => "</span>").join("")
      const carryPrefix = tagStack.join("") // reopen for next segment

      segments.push({ prefix: pendingPrefix, text, suffix })
      pendingPrefix = carryPrefix
    }
  }

  // Trailing tags without text
  if (pendingPrefix) {
    segments.push({ prefix: pendingPrefix, text: "", suffix: "" })
  }

  return segments
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
