/**
 * Convenience function to register commonly used CodeMirror language extensions.
 *
 * IMPORTANT: This file imports @codemirror/lang-* packages as dynamic imports.
 * These packages must be installed for this to work:
 *
 *   bun add @codemirror/lang-javascript @codemirror/lang-css @codemirror/lang-html \
 *           @codemirror/lang-json @codemirror/lang-markdown @codemirror/lang-python \
 *           @codemirror/lang-java @codemirror/lang-rust @codemirror/lang-cpp \
 *           @codemirror/lang-go @codemirror/lang-sql @codemirror/lang-php @codemirror/lang-xml
 *
 * If a language package is not installed, it will fail silently and the editor
 * will work without syntax highlighting for that language.
 *
 * Usage (at app startup):
 * ```ts
 * import { registerCommonLanguages } from "@duoduo-ai/ui/codemirror/languages-common"
 * registerCommonLanguages()
 * ```
 */

import { registerLanguage } from "./languages"

export function registerCommonLanguages(): void {
  // JavaScript / TypeScript
  registerLanguage("js", () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: false })))
  registerLanguage("jsx", () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })))
  registerLanguage("ts", () =>
    import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: false, typescript: true })),
  )
  registerLanguage("tsx", () =>
    import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true })),
  )
  registerLanguage("mjs", () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: false })))
  registerLanguage("cjs", () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: false })))

  // CSS
  registerLanguage("css", () => import("@codemirror/lang-css").then((m) => m.css()))

  // HTML
  registerLanguage("html", () => import("@codemirror/lang-html").then((m) => m.html()))
  registerLanguage("htm", () => import("@codemirror/lang-html").then((m) => m.html()))

  // JSON
  registerLanguage("json", () => import("@codemirror/lang-json").then((m) => m.json()))

  // Markdown
  registerLanguage("md", () => import("@codemirror/lang-markdown").then((m) => m.markdown()))
  registerLanguage("markdown", () => import("@codemirror/lang-markdown").then((m) => m.markdown()))

  // Python
  registerLanguage("py", () => import("@codemirror/lang-python").then((m) => m.python()))

  // Java
  registerLanguage("java", () => import("@codemirror/lang-java").then((m) => m.java()))

  // Rust
  registerLanguage("rs", () => import("@codemirror/lang-rust").then((m) => m.rust()))

  // C/C++
  registerLanguage("c", () => import("@codemirror/lang-cpp").then((m) => m.cpp()))
  registerLanguage("cpp", () => import("@codemirror/lang-cpp").then((m) => m.cpp()))
  registerLanguage("h", () => import("@codemirror/lang-cpp").then((m) => m.cpp()))
  registerLanguage("hpp", () => import("@codemirror/lang-cpp").then((m) => m.cpp()))

  // Go
  registerLanguage("go", () => import("@codemirror/lang-go").then((m) => m.go()))

  // SQL
  registerLanguage("sql", () => import("@codemirror/lang-sql").then((m) => m.sql()))

  // PHP
  registerLanguage("php", () => import("@codemirror/lang-php").then((m) => m.php()))

  // XML
  registerLanguage("xml", () => import("@codemirror/lang-xml").then((m) => m.xml()))
}
