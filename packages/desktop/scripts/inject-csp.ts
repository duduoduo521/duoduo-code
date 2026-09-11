/**
 * Inject CSP meta tag into dist/index.html for production builds.
 *
 * This script runs AFTER `vite build` and BEFORE `tauri build` completes.
 * CSP is injected via <meta> tag so that:
 *   - Dev mode (tauri dev) is unaffected — no CSP in dev server responses
 *   - Production builds get full CSP protection
 *   - The CSP policy covers all known requirements:
 *     - Shiki WASM: script-src 'wasm-unsafe-eval'
 *     - KaTeX inline styles: style-src 'unsafe-inline'
 *     - AI Provider APIs (dynamic domains): connect-src https:
 *     - Smart Layer local API: connect-src http://127.0.0.1:* http://localhost:*
 *     - Tauri 2 IPC: connect-src http://ipc.localhost
 *     - Shiki Worker: worker-src 'self' blob:
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const srcTauriConf = resolve(import.meta.dirname, "..", "src-tauri", "tauri.conf.json")

/**
 * The policy is read from `app.security.csp` in tauri.conf.json rather than
 * duplicated here.
 *
 * This matters: Tauri enforces the config policy AND the <meta> tag, and a
 * resource must satisfy both. A divergence silently blocks whatever the
 * stricter side omits — e.g. dropping 'wasm-unsafe-eval' from either one
 * breaks every WebAssembly module (Shiki, ghostty-vt, pdfjs) with no error
 * beyond a console message. Reading from one source makes drift impossible.
 */
function loadPolicy(): string {
  const conf = JSON.parse(readFileSync(srcTauriConf, "utf8"))
  const csp = conf?.app?.security?.csp
  if (!csp || typeof csp !== "object") {
    throw new Error(`[inject-csp] No app.security.csp found in ${srcTauriConf}`)
  }
  return Object.entries(csp as Record<string, unknown>)
    .filter(([directive]) => !directive.startsWith("//")) // "//" keys are comments
    .map(([directive, value]) => `${directive} ${String(value)}`)
    .join("; ")
}

const CSP_POLICY = loadPolicy()

const distDir = resolve(import.meta.dirname, "..", "dist")
const indexPath = resolve(distDir, "index.html")

try {
  const html = readFileSync(indexPath, "utf8")

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${CSP_POLICY}">`
  const existingCspRegex =
    /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content="[^"]*"\s*\/?>/i

  let modified = html
  if (existingCspRegex.test(html)) {
    // CSP meta already present — replace its content (e.g. to add media-src)
    modified = html.replace(existingCspRegex, cspMeta)
    console.log("[inject-csp] CSP meta updated in dist/index.html")
  } else {
    // Insert right after <head>
    modified = html.replace("<head>", `<head>\n    ${cspMeta}`)

    if (modified === html) {
      console.error("[inject-csp] Could not find <head> tag in index.html")
      process.exit(1)
    }
    console.log("[inject-csp] CSP meta injected into dist/index.html")
  }

  writeFileSync(indexPath, modified, "utf8")
} catch (err) {
  if (err.code === "ENOENT") {
    console.warn("[inject-csp] dist/index.html not found, skipping CSP injection")
    process.exit(0)
  }
  throw err
}
