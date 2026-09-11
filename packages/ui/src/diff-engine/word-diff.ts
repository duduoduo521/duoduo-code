import { diffWords } from "diff"

export interface WordDiffPart {
  value: string
  added?: boolean
  removed?: boolean
}

/**
 * Compute word-level diff between two lines.
 * Returns segments with added/removed flags for inline highlighting.
 */
export function computeWordDiff(oldLine: string, newLine: string): WordDiffPart[] {
  const changes = diffWords(oldLine, newLine)
  const result: WordDiffPart[] = []

  for (const change of changes) {
    result.push({
      value: change.value,
      added: change.added,
      removed: change.removed,
    })
  }

  return result
}

/**
 * Apply word-diff to a pair of deletion/addition lines from the same hunk.
 * For deletion lines, mark removed segments. For addition lines, mark added segments.
 * Returns only the relevant segments for the given side.
 */
export function wordDiffForSide(
  oldLine: string,
  newLine: string,
  side: "additions" | "deletions",
): WordDiffPart[] {
  const changes = computeWordDiff(oldLine, newLine)
  const result: WordDiffPart[] = []

  for (const part of changes) {
    if (side === "deletions" && !part.added) {
      result.push({ value: part.value, removed: part.removed })
    }
    if (side === "additions" && !part.removed) {
      result.push({ value: part.value, added: part.added })
    }
  }

  return result
}
