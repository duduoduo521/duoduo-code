/**
 * Copy pdf.js runtime assets (cMaps + standard fonts) into the app's public dir.
 *
 * pdf.js needs the character maps (CJK / special encodings) and the 14 standard
 * PDF fonts to render non-Latin text and embedded-font-less PDFs correctly. These
 * are shipped inside `pdfjs-dist` but must be served as static files, so we copy
 * them into `packages/app/public/pdfjs/` where Vite (and the Tauri webview) can
 * load them from `/pdfjs/cmaps/` and `/pdfjs/standard_fonts/`.
 *
 * The copy is idempotent: it skips when the target already contains files, unless
 * `--force` is passed. Missing source (e.g. pdfjs-dist not installed yet) is a
 * warning, not a hard failure, so `bun install` / `prepare` never breaks.
 *
 * Run from the repository root (the monorepo workspace root).
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..")

const SRC_ROOT = join(repoRoot, "node_modules", "pdfjs-dist")
const DEST_ROOT = join(repoRoot, "packages", "app", "public", "pdfjs")

const ASSETS = [
  { name: "cmaps", src: join(SRC_ROOT, "cmaps"), dest: join(DEST_ROOT, "cmaps") },
  { name: "standard_fonts", src: join(SRC_ROOT, "standard_fonts"), dest: join(DEST_ROOT, "standard_fonts") },
] as const

const force = process.argv.includes("--force")

const isNonEmptyDir = (path: string): boolean => existsSync(path) && readdirSync(path).length > 0

let copied = 0
let skipped = 0

for (const asset of ASSETS) {
  if (!existsSync(asset.src)) {
    console.warn(`[copy-pdfjs-assets] source missing, skip: ${asset.src}`)
    continue
  }
  if (!force && isNonEmptyDir(asset.dest)) {
    skipped++
    continue
  }
  mkdirSync(dirname(asset.dest), { recursive: true })
  cpSync(asset.src, asset.dest, { recursive: true })
  copied++
  console.log(`[copy-pdfjs-assets] copied ${asset.name} -> ${asset.dest}`)
}

if (copied === 0 && skipped > 0) {
  console.log("[copy-pdfjs-assets] pdfjs assets already present, nothing to do")
}
