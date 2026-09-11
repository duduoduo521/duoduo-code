// Core computation
export { computeDiff, computeDiffFromPatch, linesForSide } from "./compute"
export type { DiffLine, DiffHunk, DiffResult, DiffLineType, DiffSide } from "./compute"

// Selection
export {
  normalizeSelection,
  isLineInRange,
  lineSideFromElement,
  lineIndexFromElement,
  readTextSelection,
  renderSelectionInDom,
} from "./selection"
export type { LineSelection } from "./selection"

// Word-diff
export { computeWordDiff, wordDiffForSide } from "./word-diff"
export type { WordDiffPart } from "./word-diff"

// Syntax highlighting
export { duoDuoCodeTheme, getDiffHighlighter, ensureLanguage, highlightLine, highlightLines } from "./highlight"

// Find (search)
export { useCodeFind } from "./find"
export type { CodeFind } from "./find"

// Types
export type { DiffLineAnnotation, LineAnnotation, FileContents, FileOptions } from "./types"
export { DiffViewer } from "./DiffViewer"
export type { DiffViewerProps } from "./DiffViewer"
export { FileViewer } from "./FileViewer"
export type { FileViewerProps } from "./FileViewer"
