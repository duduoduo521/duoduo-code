import { marked } from "marked"
import markedKatex from "marked-katex-extension"
import markedShiki from "marked-shiki"
import katex from "katex"
import { createHighlighter, type Highlighter, bundledLanguages, type BundledLanguage } from "shiki"
import { createSimpleContext } from "./helper"
import { duoDuoCodeTheme } from "../diff-engine/highlight"

// Register the DuoDuoCode theme directly with Shiki
// (replaces @pierre/diffs' registerCustomTheme)

function renderMathInText(text: string): string {
  let result = text

  // Display math: $$...$$
  const displayMathRegex = /\$\$([\s\S]*?)\$\$/g
  result = result.replace(displayMathRegex, (_, math) => {
    try {
      return katex.renderToString(math, {
        displayMode: true,
        throwOnError: false,
      })
    } catch {
      return `$$${math}$$`
    }
  })

  // Inline math: $...$
  const inlineMathRegex = /(?<!\$)\$(?!\$)((?:[^$\\]|\\.)+?)\$(?!\$)/g
  result = result.replace(inlineMathRegex, (_, math) => {
    try {
      return katex.renderToString(math, {
        displayMode: false,
        throwOnError: false,
      })
    } catch {
      return `$${math}$`
    }
  })

  return result
}

function renderMathExpressions(html: string): string {
  // Split on code/pre/kbd tags to avoid processing their contents
  const codeBlockPattern = /(<(?:pre|code|kbd)[^>]*>[\s\S]*?<\/(?:pre|code|kbd)>)/gi
  const parts = html.split(codeBlockPattern)

  return parts
    .map((part, i) => {
      // Odd indices are the captured code blocks - leave them alone
      if (i % 2 === 1) return part
      // Process math only in non-code parts
      return renderMathInText(part)
    })
    .join("")
}

// Eagerly preload the shared Shiki highlighter with common languages.
// Uses createHighlighter directly — no longer depends on @pierre/diffs wrapper.
const COMMON_LANGS: BundledLanguage[] = ["typescript", "tsx", "javascript", "jsx", "json", "bash", "python", "rust"]

let sharedHighlighter: Promise<Highlighter> | null =
  typeof window !== "undefined"
    ? (async () => {
        const highlighter = await createHighlighter({
          themes: [duoDuoCodeTheme as any],
          langs: [],
        })
        COMMON_LANGS.forEach((lang) => highlighter.loadLanguage(lang))
        return highlighter
      })()
    : null

function getSharedHighlighterInstance(): Promise<Highlighter> {
  if (sharedHighlighter) return sharedHighlighter
  sharedHighlighter = createHighlighter({
    themes: [duoDuoCodeTheme as any],
    langs: [],
  })
  return sharedHighlighter
}

async function ensureLanguage(highlighter: Highlighter, lang: string) {
  const language = lang in bundledLanguages ? lang : "text"
  if (!highlighter.getLoadedLanguages().includes(language)) {
    await highlighter.loadLanguage(language as BundledLanguage)
  }
  return language
}

async function highlightCodeBlocks(html: string): Promise<string> {
  const codeBlockRegex = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g
  const matches = [...html.matchAll(codeBlockRegex)]
  if (matches.length === 0) return html

  const highlighter = sharedHighlighter ? await sharedHighlighter : await getSharedHighlighterInstance()

  let result = html
  for (const match of matches) {
    const [fullMatch, lang, escapedCode] = match as unknown as [string, string, string]
    const code = escapedCode
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")

    const language = await ensureLanguage(highlighter, lang || "text")
    const highlighted = highlighter.codeToHtml(code, {
      lang: language,
      theme: "DuoDuoCode",
      tabindex: false,
    })
    result = result.replace(fullMatch, () => highlighted)
  }

  return result
}

export type NativeMarkdownParser = (markdown: string) => Promise<string>

// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: (props: { nativeParser?: NativeMarkdownParser }) => {
    const jsParser = marked.use(
      {
        renderer: {
          link({ href, title, text }) {
            const titleAttr = title ? ` title="${title}"` : ""
            return `<a href="${href}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
          },
        },
      },
      markedKatex({
        throwOnError: false,
        nonStandard: true,
      }),
      markedShiki({
        async highlight(code, lang) {
          const highlighter = sharedHighlighter ? await sharedHighlighter : await getSharedHighlighterInstance()
          const language = await ensureLanguage(highlighter, lang || "text")
          return highlighter.codeToHtml(code, {
            lang: language,
            theme: "DuoDuoCode",
            tabindex: false,
          })
        },
      }),
    )

    if (props.nativeParser) {
      const nativeParser = props.nativeParser
      return {
        async parse(markdown: string): Promise<string> {
          const html = await nativeParser(markdown)
          const withMath = renderMathExpressions(html)
          return highlightCodeBlocks(withMath)
        },
      }
    }

    return jsParser
  },
})
