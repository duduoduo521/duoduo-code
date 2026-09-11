/**
 * Compatibility types for annotations and file descriptors.
 * These replace the annotation types from @pierre/diffs.
 */

export interface DiffLineAnnotation<T = unknown> {
  /** Side: "additions" or "deletions" */
  side?: "additions" | "deletions"
  /** Line number for the annotation */
  lineNumber: number
  /** Custom metadata for the annotation */
  metadata: T
}

export interface LineAnnotation<T = unknown> {
  lineNumber: number
  data: T
}

/**
 * Describes file contents for diff/text rendering.
 * Replaces the `FileContents` type from @pierre/diffs.
 *
 * NOTE: `name` is required when used with @pierre/diffs' PierreFile
 * (for language inference). When used with diff-engine's DiffViewer,
 * only `contents` and `lang` are needed.
 */
export interface FileContents {
  contents: string
  name?: string
  lang?: string
}

/**
 * Options for file rendering configuration.
 * Replaces the `FileOptions` type from @pierre/diffs.
 */
export interface FileOptions<T = unknown> {
  annotations?: LineAnnotation<T>[]
  highlighter?: string
}
