import { createSignal } from "solid-js"

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

const supportsHighlight = typeof CSS !== "undefined" && "highlights" in CSS

// Inject ::highlight styles dynamically — lightningcss (Tailwind v4 minifier) does not
// recognize ::highlight as a valid pseudo-element, so we avoid putting it in CSS files.
if (supportsHighlight) {
  const style = document.createElement("style")
  style.textContent = `
::highlight(duoduo-find) {
  background-color: rgba(252, 243, 203, 0.35);
}
::highlight(duoduo-find-current) {
  background-color: rgba(251, 221, 70, 0.55);
}
`
  document.head.appendChild(style)
}

// ---------------------------------------------------------------------------
// CodeFind interface
// ---------------------------------------------------------------------------

export interface CodeFind {
  open: () => boolean
  query: () => string
  count: () => number
  index: () => number
  setQuery: (q: string) => void
  focus: () => void
  next: (dir?: number) => void
  close: () => void
  refresh: (opts?: { reset?: boolean }) => void
  onPointerDown: (e: PointerEvent) => void
  onFocus: (e: FocusEvent) => void
  onKeyDown: (e: KeyboardEvent) => void
  pos: () => { top: number; right: number }
  setInput: (el: HTMLInputElement) => void
  onInputKeyDown: (e: KeyboardEvent) => void
}

// ---------------------------------------------------------------------------
// useCodeFind
// ---------------------------------------------------------------------------

export function useCodeFind(containerRef: () => HTMLElement | undefined): CodeFind {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [count, setCount] = createSignal(0)
  const [index, setIndex] = createSignal(0)

  let inputEl: HTMLInputElement | undefined
  let ranges: Range[] = []

  // -----------------------------------------------------------------------
  // Find all matching ranges in [data-code] elements
  // -----------------------------------------------------------------------

  function findAll(q: string): Range[] {
    const container = containerRef()
    if (!container || !q) return []

    const found: Range[] = []
    const lower = q.toLowerCase()
    const codeEls = container.querySelectorAll("[data-code]")

    for (const el of codeEls) {
      if (!(el instanceof HTMLElement)) continue
      const text = el.textContent ?? ""
      const lowerText = text.toLowerCase()

      let offset = 0
      while (offset < lowerText.length) {
        const pos = lowerText.indexOf(lower, offset)
        if (pos === -1) break

        const range = createRangeForPosition(el, pos, q.length)
        if (range) found.push(range)
        offset = pos + 1
      }
    }

    return found
  }

  // -----------------------------------------------------------------------
  // Create a Range spanning `len` characters starting at char-offset `start`
  // within the textContent of `el`
  // -----------------------------------------------------------------------

  function createRangeForPosition(el: HTMLElement, start: number, len: number): Range | null {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null)
    let charIndex = 0
    let startNode: Text | null = null
    let startOffset = 0
    let endNode: Text | null = null
    let endOffset = 0

    let node: Text | null
    while ((node = walker.nextNode() as Text | null)) {
      const textLen = node.textContent?.length ?? 0

      if (!startNode && charIndex + textLen > start) {
        startNode = node
        startOffset = start - charIndex
      }

      if (charIndex + textLen >= start + len) {
        endNode = node
        endOffset = start + len - charIndex
        break
      }

      charIndex += textLen
    }

    if (!startNode || !endNode) return null

    try {
      const range = document.createRange()
      range.setStart(startNode, startOffset)
      range.setEnd(endNode, endOffset)
      return range
    } catch {
      return null
    }
  }

  // -----------------------------------------------------------------------
  // Highlight — CSS Custom Highlight API (preferred) or <mark> spans (fallback)
  // -----------------------------------------------------------------------

  function updateHighlights() {
    // Strategy 1: CSS Custom Highlight API (Safari 17.2+, Chromium 105+)
    // Not available on WebKitGTK (Linux).
    if (supportsHighlight) {
      CSS.highlights.delete("duoduo-find")
      CSS.highlights.delete("duoduo-find-current")

      if (ranges.length === 0) return

      try {
        CSS.highlights.set("duoduo-find", new Highlight(...ranges))
      } catch {
        // May fail if ranges are invalid; ignore
      }

      const idx = index()
      if (idx >= 0 && idx < ranges.length) {
        try {
          CSS.highlights.set("duoduo-find-current", new Highlight(ranges[idx]!))
        } catch {
          // ignore
        }
      }
      return
    }

    // Strategy 2: <mark> spans fallback (WebKitGTK / older browsers)
    // We wrap each match in a <mark data-find-match> element.
    // The current match gets data-find-match-current instead.
    clearMarkHighlights()

    if (ranges.length === 0) return

    const idx = index()
    for (let i = 0; i < ranges.length; i++) {
      try {
        const mark = document.createElement("mark")
        mark.setAttribute("data-find-match", "")
        if (i === idx) mark.setAttribute("data-find-match-current", "")
        ranges[i]!.surroundContents(mark)
        // Re-create the range to point at the mark for scroll purposes
        const newRange = document.createRange()
        newRange.selectNode(mark)
        ranges[i] = newRange
      } catch {
        // surroundContents can fail if the range crosses element boundaries
        // Skip this match
      }
    }
  }

  function clearMarkHighlights() {
    const container = containerRef()
    if (!container) return

    // Remove <mark data-find-match> elements, replacing them with their text content
    const marks = container.querySelectorAll("mark[data-find-match]")
    for (const mark of marks) {
      if (!(mark instanceof HTMLElement)) continue
      const parent = mark.parentNode
      if (!parent) continue
      // Move all children out of the mark
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark)
      }
      parent.removeChild(mark)
    }
  }

  // -----------------------------------------------------------------------
  // Scroll to current match
  // -----------------------------------------------------------------------

  function scrollToCurrent() {
    const idx = index()
    if (idx < 0 || idx >= ranges.length) return
    const range = ranges[idx]
    const el = range!.startContainer.parentElement
    if (el) {
      el.scrollIntoView({ block: "nearest" })
    }
  }

  // -----------------------------------------------------------------------
  // Run search
  // -----------------------------------------------------------------------

  function doSearch(resetIndex = true) {
    const q = query()

    // Clear previous mark-based highlights before re-searching
    clearMarkHighlights()

    ranges = findAll(q)
    setCount(ranges.length)
    if (resetIndex || ranges.length === 0) {
      setIndex(0)
    } else {
      const idx = index()
      if (idx >= ranges.length) setIndex(ranges.length - 1)
    }
    updateHighlights()
    if (ranges.length > 0) scrollToCurrent()
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  function setQueryFn(q: string) {
    setQuery(q)
    doSearch(true)
  }

  function focusFn() {
    queueMicrotask(() => inputEl?.focus())
  }

  function nextFn(dir: number = 1) {
    const c = count()
    if (c === 0) return
    const cur = index()
    // Wrap around
    let next = (cur + dir) % c
    if (next < 0) next += c

    // For mark-based fallback, update the current mark
    if (!supportsHighlight) {
      // Remove current marker from old match
      const oldMarks = containerRef()?.querySelectorAll("mark[data-find-match]")
      if (oldMarks) {
        for (const m of oldMarks) {
          if (m instanceof HTMLElement) m.removeAttribute("data-find-match-current")
        }
      }
      // Add current marker to new match
      const newMark = containerRef()?.querySelectorAll("mark[data-find-match]")?.[next]
      if (newMark instanceof HTMLElement) newMark.setAttribute("data-find-match-current", "")
    }

    setIndex(next)

    if (supportsHighlight) {
      updateHighlights()
    }
    scrollToCurrent()
  }

  function closeFn() {
    setOpen(false)
    setQuery("")
    clearMarkHighlights()
    ranges = []
    setCount(0)
    setIndex(0)
    if (supportsHighlight) {
      CSS.highlights.delete("duoduo-find")
      CSS.highlights.delete("duoduo-find-current")
    }
  }

  function refreshFn(opts?: { reset?: boolean }) {
    doSearch(opts?.reset ?? false)
  }

  function onPointerDownFn(_e: PointerEvent) {}

  function onFocusFn(_e: FocusEvent) {}

  function posFn(): { top: number; right: number } {
    const container = containerRef()
    if (!container) return { top: 0, right: 0 }
    const rect = container.getBoundingClientRect()
    return {
      top: rect.top,
      right: window.innerWidth - rect.right,
    }
  }

  function setInputFn(el: HTMLInputElement) {
    inputEl = el
  }

  function onInputKeyDownFn(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault()
      nextFn(e.shiftKey ? -1 : 1)
    } else if (e.key === "Escape") {
      e.preventDefault()
      closeFn()
    }
  }

  // -----------------------------------------------------------------------
  // Ctrl+F / Cmd+F handler — bound to the container element
  // -----------------------------------------------------------------------

  function handleFindKeyDown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
      e.preventDefault()
      e.stopPropagation()
      setOpen(true)
      focusFn()
    }
  }

  return {
    open,
    query,
    count,
    index,
    setQuery: setQueryFn,
    focus: focusFn,
    next: nextFn,
    close: closeFn,
    refresh: refreshFn,
    onPointerDown: onPointerDownFn,
    onFocus: onFocusFn,
    onKeyDown: handleFindKeyDown,
    pos: posFn,
    setInput: setInputFn,
    onInputKeyDown: onInputKeyDownFn,
  }
}
