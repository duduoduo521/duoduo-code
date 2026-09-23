/**
 * Inline the entry stylesheet into dist/index.html for production builds.
 *
 * Runs AFTER `vite build` and BEFORE `tauri build` bundles the frontend.
 *
 * Why: in the default output the entry CSS ships as a separate file that a
 * Vite preload helper fetches via an async <link> right before the app chunk
 * executes. Inside a WebView that fetch can stall or one-shot fail — cold
 * disk cache on the first launch of a new build, antivirus scanning the new
 * files, or a rapid relaunch before the previous WebView2 process finished
 * flushing its cache — and the helper swallows the failure (allSettled
 * semantics), so the app mounts unstyled and the home logo renders at its
 * natural 2000px size.
 *
 * Inlining the CSS into <head> removes the async fetch from the equation:
 * every style is present the moment the HTML is parsed, so both the splash
 * and the editor are always styled. The separate CSS file is still emitted
 * (and still fetched by Vite's preload helper); duplicate rules are harmless.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const distDir = resolve(import.meta.dirname, "..", "dist")
const indexPath = resolve(distDir, "index.html")

try {
  const html = readFileSync(indexPath, "utf8")

  const marker = "data-inline-entry-css"
  // Drop a previously inlined block so reruns stay idempotent.
  const prevBlock = new RegExp(`<style ${marker}>[\\s\\S]*?</style>\\n?`, "i")
  let modified = html.replace(prevBlock, "")

  // The entry chunk is the module script loaded from /assets/.
  const entryMatch = modified.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+\.js)["']/i)
  if (!entryMatch) {
    console.warn("[inline-css] No entry module script found in dist/index.html, skipping")
    process.exit(0)
  }
  const entrySrc = entryMatch[1]
  const entryPath = resolve(distDir, `.${entrySrc}`)
  const entryJs = readFileSync(entryPath, "utf8")

  // Entry CSS = every .css asset referenced by the entry chunk (Vite lists
  // them in its __vite__mapDeps preload table).
  const cssRefs = [...new Set([...entryJs.matchAll(/assets\/[A-Za-z0-9._%-]+\.css/g)].map((m) => m[0]))]
  if (cssRefs.length === 0) {
    console.warn("[inline-css] Entry chunk references no .css assets, skipping")
    process.exit(0)
  }

  let css = ""
  for (const ref of cssRefs) {
    const cssPath = resolve(distDir, ref)
    try {
      css += readFileSync(cssPath, "utf8") + "\n"
    } catch {
      console.warn(`[inline-css] Referenced CSS not found: ${ref}, skipping it`)
    }
  }
  if (!css.trim()) {
    console.warn("[inline-css] No CSS content collected, skipping")
    process.exit(0)
  }
  // A literal "</style" inside the CSS would terminate the tag early.
  if (/<\/style/i.test(css)) {
    throw new Error("[inline-css] CSS contains '</style' — cannot inline safely")
  }

  const block = `<style ${marker}>\n${css}</style>\n`
  if (!modified.includes("</head>")) {
    console.error("[inline-css] Could not find </head> in dist/index.html")
    process.exit(1)
  }
  // Static parser-blocking <link> for the same stylesheet(s), in addition to
  // the inline copy. Field-tested (2026-09-23): the WebView2 runtime
  // occasionally pins a rogue `default-src 'self'` CSP onto the document,
  // which drops EVERY parser-inserted inline <style> from the CSSOM while
  // external same-origin stylesheets keep working. With this link the editor
  // is styled even in that state; the inline copy covers the (unrelated)
  // case of a link fetch stall. Duplicate rules are harmless.
  const links = cssRefs.map((ref) => `<link rel="stylesheet" href="/${ref}" />`).join("\n    ")
  modified = modified.replace("</head>", `${links}\n${block}</head>`)

  writeFileSync(indexPath, modified, "utf8")
  console.log(
    `[inline-css] Inlined ${cssRefs.length} stylesheet(s) (${css.length} bytes) into dist/index.html`,
  )
} catch (err) {
  if (err instanceof Error && "code" in err && err.code === "ENOENT") {
    console.warn("[inline-css] dist/index.html not found, skipping")
    process.exit(0)
  }
  throw err
}
