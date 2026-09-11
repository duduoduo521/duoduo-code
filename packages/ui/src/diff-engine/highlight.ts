import { createHighlighter, type Highlighter, bundledLanguages, type BundledLanguage } from "shiki"

// ---------------------------------------------------------------------------
// DuoDuoCode theme definition (migrated from @pierre/diffs registerCustomTheme)
// ---------------------------------------------------------------------------

export interface DuoDuoCodeTokenColors {
  scope: string | string[]
  settings: { foreground?: string; fontStyle?: string }
}

export const duoDuoCodeTheme = {
  name: "DuoDuoCode",
  colors: {
    "editor.background": "var(--color-background-stronger)",
    "editor.foreground": "var(--text-base)",
    "gitDecoration.addedResourceForeground": "var(--syntax-diff-add)",
    "gitDecoration.deletedResourceForeground": "var(--syntax-diff-delete)",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: { foreground: "var(--syntax-comment)" },
    },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "var(--syntax-property)" } },
    {
      scope: ["constant", "entity.name.constant", "variable.other.constant", "variable.language", "entity"],
      settings: { foreground: "var(--syntax-constant)" },
    },
    {
      scope: ["entity.name", "meta.export.default", "meta.definition.variable"],
      settings: { foreground: "var(--syntax-type)" },
    },
    { scope: ["meta.object.member"], settings: { foreground: "var(--syntax-primitive)" } },
    {
      scope: [
        "variable.parameter.function",
        "meta.jsx.children",
        "meta.block",
        "meta.tag.attributes",
        "entity.name.constant",
        "meta.embedded.expression",
        "meta.template.expression",
        "string.other.begin.yaml",
        "string.other.end.yaml",
      ],
      settings: { foreground: "var(--syntax-punctuation)" },
    },
    { scope: ["entity.name.function", "support.type.primitive"], settings: { foreground: "var(--syntax-primitive)" } },
    { scope: ["support.class.component"], settings: { foreground: "var(--syntax-type)" } },
    { scope: "keyword", settings: { foreground: "var(--syntax-keyword)" } },
    {
      scope: [
        "keyword.operator",
        "storage.type.function.arrow",
        "punctuation.separator.key-value.css",
        "entity.name.tag.yaml",
        "punctuation.separator.key-value.mapping.yaml",
      ],
      settings: { foreground: "var(--syntax-operator)" },
    },
    { scope: ["storage", "storage.type"], settings: { foreground: "var(--syntax-keyword)" } },
    {
      scope: ["storage.modifier.package", "storage.modifier.import", "storage.type.java"],
      settings: { foreground: "var(--syntax-primitive)" },
    },
    {
      scope: [
        "string",
        "punctuation.definition.string",
        "string punctuation.section.embedded source",
        "entity.name.tag",
      ],
      settings: { foreground: "var(--syntax-string)" },
    },
    { scope: "support", settings: { foreground: "var(--syntax-primitive)" } },
    {
      scope: ["support.type.object.module", "variable.other.object", "support.type.property-name.css"],
      settings: { foreground: "var(--syntax-object)" },
    },
    { scope: "meta.property-name", settings: { foreground: "var(--syntax-property)" } },
    { scope: "variable", settings: { foreground: "var(--syntax-variable)" } },
    { scope: "variable.other", settings: { foreground: "var(--syntax-variable)" } },
    {
      scope: [
        "invalid.broken",
        "invalid.illegal",
        "invalid.unimplemented",
        "invalid.deprecated",
        "message.error",
        "markup.deleted",
        "meta.diff.header.from-file",
        "punctuation.definition.deleted",
        "brackethighlighter.unmatched",
        "token.error-token",
      ],
      settings: { foreground: "var(--syntax-critical)" },
    },
    { scope: "carriage-return", settings: { foreground: "var(--syntax-keyword)" } },
    { scope: "string source", settings: { foreground: "var(--syntax-variable)" } },
    { scope: "string variable", settings: { foreground: "var(--syntax-constant)" } },
    {
      scope: [
        "source.regexp",
        "string.regexp",
        "string.regexp.character-class",
        "string.regexp constant.character.escape",
        "string.regexp source.ruby.embedded",
        "string.regexp string.regexp.arbitrary-repitition",
        "string.regexp constant.character.escape",
      ],
      settings: { foreground: "var(--syntax-regexp)" },
    },
    { scope: "support.constant", settings: { foreground: "var(--syntax-primitive)" } },
    { scope: "support.variable", settings: { foreground: "var(--syntax-variable)" } },
    { scope: "meta.module-reference", settings: { foreground: "var(--syntax-info)" } },
    { scope: "punctuation.definition.list.begin.markdown", settings: { foreground: "var(--syntax-punctuation)" } },
    {
      scope: ["markup.heading", "markup.heading entity.name"],
      settings: { fontStyle: "bold", foreground: "var(--syntax-info)" },
    },
    { scope: "markup.quote", settings: { foreground: "var(--syntax-info)" } },
    { scope: "markup.italic", settings: { fontStyle: "italic" } },
    { scope: "markup.bold", settings: { fontStyle: "bold", foreground: "var(--text-strong)" } },
    {
      scope: [
        "markup.raw",
        "markup.inserted",
        "meta.diff.header.to-file",
        "punctuation.definition.inserted",
        "markup.changed",
        "punctuation.definition.changed",
        "markup.ignored",
        "markup.untracked",
      ],
      settings: { foreground: "var(--text-base)" },
    },
    { scope: "meta.diff.range", settings: { fontStyle: "bold", foreground: "var(--syntax-unknown)" } },
    { scope: "meta.diff.header", settings: { foreground: "var(--syntax-unknown)" } },
    { scope: "meta.separator", settings: { fontStyle: "bold", foreground: "var(--syntax-unknown)" } },
    { scope: "meta.output", settings: { foreground: "var(--syntax-unknown)" } },
    { scope: "meta.export.default", settings: { foreground: "var(--syntax-unknown)" } },
    {
      scope: [
        "brackethighlighter.tag",
        "brackethighlighter.curly",
        "brackethighlighter.round",
        "brackethighlighter.square",
        "brackethighlighter.angle",
        "brackethighlighter.quote",
      ],
      settings: { foreground: "var(--syntax-unknown)" },
    },
    {
      scope: ["constant.other.reference.link", "string.other.link"],
      settings: { fontStyle: "underline", foreground: "var(--syntax-unknown)" },
    },
    { scope: "token.info-token", settings: { foreground: "var(--syntax-info)" } },
    { scope: "token.warn-token", settings: { foreground: "var(--syntax-warning)" } },
    { scope: "token.debug-token", settings: { foreground: "var(--syntax-info)" } },
  ],
  semanticTokenColors: {
    comment: "var(--syntax-comment)",
    string: "var(--syntax-string)",
    number: "var(--syntax-constant)",
    regexp: "var(--syntax-regexp)",
    keyword: "var(--syntax-keyword)",
    variable: "var(--syntax-variable)",
    parameter: "var(--syntax-variable)",
    property: "var(--syntax-property)",
    function: "var(--syntax-primitive)",
    method: "var(--syntax-primitive)",
    type: "var(--syntax-type)",
    class: "var(--syntax-type)",
    namespace: "var(--syntax-type)",
    enumMember: "var(--syntax-primitive)",
    "variable.constant": "var(--syntax-constant)",
    "variable.defaultLibrary": "var(--syntax-unknown)",
  },
} as const

// ---------------------------------------------------------------------------
// Shared highlighter singleton
// ---------------------------------------------------------------------------

let sharedHighlighter: Promise<Highlighter> | null = null

export function getDiffHighlighter(): Promise<Highlighter> {
  if (sharedHighlighter) return sharedHighlighter

  sharedHighlighter = createHighlighter({
    themes: [duoDuoCodeTheme as any],
    langs: [],
  })

  return sharedHighlighter
}

export async function ensureLanguage(lang: string): Promise<string> {
  const highlighter = await getDiffHighlighter()
  const language = lang in bundledLanguages ? (lang as BundledLanguage) : "text"
  if (!highlighter.getLoadedLanguages().includes(language)) {
    await highlighter.loadLanguage(language)
  }
  return language
}

/**
 * Highlight a single line of code, returning HTML string.
 * Replaces @pierre/diffs' internal Shiki integration.
 */
export async function highlightLine(code: string, lang: string): Promise<string> {
  const highlighter = await getDiffHighlighter()
  const language = await ensureLanguage(lang)
  const html = highlighter.codeToHtml(code, {
    lang: language,
    theme: "DuoDuoCode",
    tabindex: false,
  })
  // codeToHtml wraps in <pre><code>, we only need the inner content
  const match = html.match(/<code[^>]*>([\s\S]*)<\/code>/)
  return match ? match[1]! : html
}

/**
 * Highlight multiple lines in batch. Returns a map from 0-based line index to HTML.
 */
export async function highlightLines(lines: string[], lang: string): Promise<Map<number, string>> {
  const highlighter = await getDiffHighlighter()
  const language = await ensureLanguage(lang)
  const result = new Map<number, string>()

  const fullCode = lines.join("\n")
  const html = highlighter.codeToHtml(fullCode, {
    lang: language,
    theme: "DuoDuoCode",
    tabindex: false,
  })

  // Split the highlighted output back into individual lines
  const codeMatch = html.match(/<code[^>]*>([\s\S]*)<\/code>/)
  const inner = codeMatch ? codeMatch[1] : html

  // Simple line-split preserving HTML tags (each line is delimited by \n in the text nodes)
  const splitLines = splitHighlightedHtml(inner!)
  for (let i = 0; i < Math.min(lines.length, splitLines.length); i++) {
    result.set(i, splitLines[i]!)
  }

  return result
}

/**
 * Split highlighted HTML content into per-line HTML fragments.
 * Closes open spans at line boundaries and reopens them on the next line
 * to ensure each fragment is valid standalone HTML.
 */
function splitHighlightedHtml(html: string): string[] {
  const lines: string[] = []
  let current = ""
  const openSpans: string[] = []

  let i = 0
  while (i < html.length) {
    if (html[i] === "<") {
      const close = html.indexOf(">", i)
      if (close === -1) {
        current += html.slice(i)
        break
      }
      const tag = html.slice(i, close + 1)
      current += tag
      if (tag.startsWith("</span")) {
        // Pop the matching open span
        if (openSpans.length > 0) openSpans.pop()
      } else if (tag.startsWith("<span") && !tag.endsWith("/>")) {
        openSpans.push(tag)
      }
      i = close + 1
    } else if (html[i] === "\n") {
      // Close any open spans at line boundary
      for (let j = openSpans.length - 1; j >= 0; j--) {
        current += "</span>"
      }
      lines.push(current)
      // Reopen the spans on the next line
      current = openSpans.join("")
      i++
    } else {
      const next = html.indexOf("<", i)
      const nl = html.indexOf("\n", i)
      const end = next === -1 ? (nl === -1 ? html.length : nl) : nl === -1 ? next : Math.min(next, nl)
      current += html.slice(i, end)
      i = end
    }
  }

  if (current) lines.push(current)
  return lines
}
