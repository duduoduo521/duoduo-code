import { formatPatch, parsePatch, structuredPatch } from "diff"
import type { SnapshotFileDiff, VcsFileDiff } from "@duoduo-ai/sdk/v2"
import { computeDiff, linesForSide, type DiffResult } from "../diff-engine"

type LegacyDiff = {
  file: string
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

type ReviewDiff = SnapshotFileDiff | VcsFileDiff | LegacyDiff

export type ViewDiff = {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
  diffResult: DiffResult
  before: string
  after: string
}

const MAX_CACHE_SIZE = 50
const cache = new Map<string, DiffResult>()

function trimCache() {
  if (cache.size <= MAX_CACHE_SIZE) return
  // Map iterates in insertion order; delete the oldest entries first
  const excess = cache.size - MAX_CACHE_SIZE
  let count = 0
  for (const key of cache.keys()) {
    if (count >= excess) break
    cache.delete(key)
    count++
  }
}

function patch(diff: ReviewDiff) {
  if (typeof diff.patch === "string") {
    // `parsePatch` strictly validates the unified-diff hunk counts and throws
    // (e.g. "Added line count did not match for hunk") when a real-world patch
    // is malformed — such as a git diff whose `\ No newline at end of file`
    // marker or binary content shifts the hunk line counts. Never let a bad
    // patch crash the whole diff view; fall back to `before`/`after` (or the
    // raw patch) instead.
    try {
      const [parsed] = parsePatch(diff.patch)
      if (parsed) {
        const beforeLines = []
        const afterLines = []

        for (const hunk of parsed.hunks) {
          for (const line of hunk.lines) {
            if (line.startsWith("-")) {
              beforeLines.push(line.slice(1))
            } else if (line.startsWith("+")) {
              afterLines.push(line.slice(1))
            } else {
              // context line (starts with ' ')
              beforeLines.push(line.slice(1))
              afterLines.push(line.slice(1))
            }
          }
        }

        return {
          before: beforeLines.join("\n"),
          after: afterLines.join("\n"),
          patch: diff.patch,
        }
      }
    } catch (err) {
      console.warn("session-diff: failed to parse patch, falling back", err)
    }

    // Fallback: if we have explicit before/after content, prefer that; otherwise
    // just surface the raw patch so the view still renders.
    const hasContent =
      "before" in diff && typeof diff.before === "string"
        ? diff.before
        : "after" in diff && typeof diff.after === "string"
          ? diff.after
          : ""
    if (hasContent) {
      return {
        before: "before" in diff && typeof diff.before === "string" ? diff.before : "",
        after: "after" in diff && typeof diff.after === "string" ? diff.after : "",
        patch: diff.patch,
      }
    }
    return { before: "", after: "", patch: diff.patch }
  }
  return {
    before: "before" in diff && typeof diff.before === "string" ? diff.before : "",
    after: "after" in diff && typeof diff.after === "string" ? diff.after : "",
    patch: formatPatch(
      structuredPatch(
        diff.file,
        diff.file,
        "before" in diff && typeof diff.before === "string" ? diff.before : "",
        "after" in diff && typeof diff.after === "string" ? diff.after : "",
        "",
        "",
        { context: Number.MAX_SAFE_INTEGER },
      ),
    ),
  }
}

function compute(file: string, before: string, after: string) {
  const key = before + "\0" + after
  const hit = cache.get(key)
  if (hit) return hit

  const value = computeDiff(before, after)
  cache.set(key, value)
  trimCache()
  return value
}

export function normalize(diff: ReviewDiff): ViewDiff {
  const next = patch(diff)
  return {
    file: diff.file,
    patch: next.patch,
    additions: diff.additions,
    deletions: diff.deletions,
    status: diff.status,
    diffResult: compute(diff.file, next.before, next.after),
    before: next.before,
    after: next.after,
  }
}

export function text(diff: ViewDiff, side: "deletions" | "additions") {
  // `linesForSide` returns each line WITHOUT a trailing newline.
  // Callers (e.g. `previewSelectedLines` in pierre/selection-bridge) treat
  // the result as a multi-line string and `.split("\n")` it back into rows,
  // so we must rejoin with "\n" and append a trailing "\n" to match the
  // conventional shape of raw file content (the other previewSelectedLines
  // call sites pass exactly that). Joining with "" collapses every line
  // into a single row and breaks line-range selection in session review.
  const lines = linesForSide(diff.diffResult.lines, side)
  if (lines.length === 0) return ""
  return lines.join("\n") + "\n"
}
