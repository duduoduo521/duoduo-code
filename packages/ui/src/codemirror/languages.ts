import type { Extension } from "@codemirror/state"

/**
 * Maps file extensions (and full filenames) to CodeMirror language support.
 *
 * Language packages are NOT included in the base install to keep bundle size at ~80KB.
 * They must be installed separately and registered using `registerLanguage()`.
 *
 * To add a new language:
 * 1. Install the @codemirror/lang-* package: `bun add @codemirror/lang-javascript`
 * 2. Register it: `registerLanguage("ts", () => import("@codemirror/lang-javascript").then(m => m.javascript({ typescript: true })))`
 * 3. The language will be loaded when a file with that extension is opened
 *
 * For convenience, see `@duoduo-ai/ui/codemirror/languages-common` which provides
 * `registerCommonLanguages()` to register all commonly used languages at once
 * (requires language packages to be installed).
 */

type LanguageLoader = () => Promise<Extension>

/** Registry of file extension → lazy language loader */
const extensionMap: Record<string, LanguageLoader> = {}

/**
 * Registry of full filename (lowercase) → lazy language loader.
 * Used for files without extensions like Dockerfile, Makefile, etc.
 */
const filenameMap: Record<string, LanguageLoader> = {}

/**
 * Register a language loader for a file extension or full filename.
 * The loader is called lazily when a matching file is opened.
 *
 * @param key - A file extension (e.g. "ts") or a full filename (e.g. "dockerfile")
 * @param loader - Async function returning a CodeMirror Extension
 *
 * @example
 * ```ts
 * // By extension
 * registerLanguage("ts", () => import("@codemirror/lang-javascript").then(m => m.javascript({ typescript: true })))
 *
 * // By filename (for files without extensions)
 * registerLanguage("dockerfile", () => import("@codemirror/lang-java").then(m => m.java()))
 * ```
 */
export function registerLanguage(key: string, loader: LanguageLoader): void {
  // If the key contains a dot or has no dot but is a known filename pattern,
  // store it in the filename map. Otherwise, treat it as an extension.
  // Simple heuristic: keys without dots and longer than typical extensions (>=5 chars)
  // are treated as filenames. Extensions are typically 1-4 chars.
  // But to be safe, we register in both maps if it looks like it could be either.
  extensionMap[key] = loader
  // Also register as a filename candidate for exact basename matching
  filenameMap[key] = loader
}

/**
 * Extract the file extension and basename from a file path.
 * Returns both the extension (lowercase) and the basename (lowercase)
 * to support matching by extension (e.g. "ts") or full filename (e.g. "dockerfile").
 */
function extractFileParts(filePath: string): { ext: string; basename: string } {
  // Normalize path separators
  const normalized = filePath.replace(/\\/g, "/")
  const basename = normalized.split("/").pop()?.toLowerCase() ?? ""
  const ext = basename.split(".").pop()?.toLowerCase() ?? ""
  return { ext, basename }
}

/**
 * Returns the language loader for a given file path.
 * Checks filename-based matching first (e.g. Dockerfile, Makefile),
 * then falls back to extension-based matching.
 * Returns null if no language support is registered for the file type.
 */
export function getLanguageLoader(filePath: string): LanguageLoader | null {
  const { ext, basename } = extractFileParts(filePath)
  // Check filename first (exact match on basename without extension)
  // This handles files like "Dockerfile", "Makefile", "CMakeLists.txt"
  if (filenameMap[basename]) return filenameMap[basename]
  // Then check by extension
  return extensionMap[ext] ?? null
}

/**
 * Cache for loaded language extensions to avoid re-importing.
 * Keyed by the lookup key (extension or filename).
 */
const languageCache = new Map<string, Extension | null>()

/**
 * Resolves a language extension for a file path, with caching.
 * Returns null if no language support is available.
 */
export async function resolveLanguageExtension(filePath: string): Promise<Extension | null> {
  const { ext, basename } = extractFileParts(filePath)

  // Determine the cache key: prefer filename match, then extension
  const cacheKey = filenameMap[basename] ? basename : ext

  if (languageCache.has(cacheKey)) return languageCache.get(cacheKey) ?? null

  const loader = getLanguageLoader(filePath)
  if (!loader) {
    languageCache.set(cacheKey, null)
    return null
  }

  try {
    const extension = await loader()
    languageCache.set(cacheKey, extension)
    return extension
  } catch {
    // Language package not installed or failed to load
    languageCache.set(cacheKey, null)
    return null
  }
}
