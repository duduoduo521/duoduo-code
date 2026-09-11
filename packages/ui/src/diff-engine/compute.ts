import { structuredPatch, parsePatch } from "diff"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiffLineType = "context" | "addition" | "deletion" | "hunk-header" | "no-newline"

export type DiffSide = "additions" | "deletions"

export interface DiffLine {
  /** Unique 0-based index across all lines in the diff */
  index: number
  /** Type of this line */
  type: DiffLineType
  /** Text content (without +/- prefix) */
  content: string
  /** Line number in the old file (undefined for pure additions / hunk-headers) */
  oldLineNumber?: number
  /** Line number in the new file (undefined for pure deletions / hunk-headers) */
  newLineNumber?: number
  /** 0-based hunk index */
  hunkIndex: number
  /** Side for selection/bookmark purposes */
  side: DiffSide
}

export interface DiffHunk {
  index: number
  startIndex: number
  endIndex: number
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

export interface DiffResult {
  lines: DiffLine[]
  hunks: DiffHunk[]
  additionCount: number
  deletionCount: number
}

// ---------------------------------------------------------------------------
// Main computation
// ---------------------------------------------------------------------------

export function computeDiff(before: string, after: string): DiffResult {
  const patch = structuredPatch("a", "b", before, after, "", "", {
    context: Number.MAX_SAFE_INTEGER,
  })

  const lines: DiffLine[] = []
  const hunks: DiffHunk[] = []
  let additionCount = 0
  let deletionCount = 0

  let oldLine = 0
  let newLine = 0

  for (let hunkIdx = 0; hunkIdx < patch.hunks.length; hunkIdx++) {
    const hunk = patch.hunks[hunkIdx]
    oldLine = hunk!.oldStart
    newLine = hunk!.newStart

    // Hunk header
    const headerLine: DiffLine = {
      index: lines.length,
      type: "hunk-header",
      content: hunk!.lines.length ? `@@ -${hunk!.oldStart},${hunk!.oldLines} +${hunk!.newStart},${hunk!.newLines} @@` : "",
      hunkIndex: hunkIdx,
      side: "additions",
    }
    lines.push(headerLine)

    const hunkStartIndex = headerLine.index

    for (const raw of hunk!.lines) {
      const prefix = raw[0]
      const content = raw.slice(1)

      const line: DiffLine = {
        index: lines.length,
        type: prefix === "+" ? "addition" : prefix === "-" ? "deletion" : "context",
        content,
        hunkIndex: hunkIdx,
        side: prefix === "-" ? "deletions" : "additions",
      }

      if (prefix === "+") {
        line.newLineNumber = newLine++
        additionCount++
      } else if (prefix === "-") {
        line.oldLineNumber = oldLine++
        deletionCount++
      } else if (prefix === " ") {
        line.oldLineNumber = oldLine++
        line.newLineNumber = newLine++
      }

      // Handle "\ No newline at end of file" markers.
      // structuredPatch emits these as raw lines starting with literal '\'
      // (a single backslash char). After `raw.slice(1)` the leading '\' is
      // gone, so checking `content.startsWith("\\ No newline")` (which means
      // backslash + space + ...) NEVER matches. We detect via the prefix
      // char directly, with a content fallback for any patch source that
      // strips the prefix differently.
      if (prefix === "\\" || content.startsWith(" No newline")) {
        line.type = "no-newline"
      }

      lines.push(line)
    }

    hunks.push({
      index: hunkIdx,
      startIndex: hunkStartIndex,
      endIndex: lines.length,
      oldStart: hunk!.oldStart,
      oldCount: hunk!.oldLines,
      newStart: hunk!.newStart,
      newCount: hunk!.newLines,
    })
  }

  return { lines, hunks, additionCount, deletionCount }
}

// ---------------------------------------------------------------------------
// From raw patch string
// ---------------------------------------------------------------------------

export function computeDiffFromPatch(patchStr: string): DiffResult {
  const [parsed] = parsePatch(patchStr)
  if (!parsed) return { lines: [], hunks: [], additionCount: 0, deletionCount: 0 }

  const beforeLines: string[] = []
  const afterLines: string[] = []

  for (const hunk of parsed.hunks) {
    for (const line of hunk.lines) {
      const prefix = line[0]
      const content = line.slice(1)
      if (prefix === "-") {
        beforeLines.push(content)
      } else if (prefix === "+") {
        afterLines.push(content)
      } else {
        beforeLines.push(content)
        afterLines.push(content)
      }
    }
  }

  return computeDiff(beforeLines.join("\n"), afterLines.join("\n"))
}

// ---------------------------------------------------------------------------
// Lines-for-side helper (replaces pierre's deletionLines/additionLines)
// ---------------------------------------------------------------------------

export function linesForSide(lines: DiffLine[], side: DiffSide): string[] {
  const result: string[] = []
  for (const line of lines) {
    if (line.type === "hunk-header" || line.type === "no-newline") continue
    if (side === "deletions" && (line.type === "deletion" || line.type === "context")) {
      result.push(line.content)
    }
    if (side === "additions" && (line.type === "addition" || line.type === "context")) {
      result.push(line.content)
    }
  }
  return result
}
