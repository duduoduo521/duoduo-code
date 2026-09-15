/**
 * Prepare lifecycle script.
 *
 * Copies pdf.js runtime assets into the app's public dir so PDF preview
 * renders CJK / special fonts correctly and works offline inside Tauri.
 */
import { spawnSync } from "node:child_process"

const pdfjs = spawnSync("bun", ["run", "scripts/copy-pdfjs-assets.ts"], { stdio: "inherit", shell: true })
if (pdfjs.status !== 0 && pdfjs.status !== null) {
  console.warn("copy-pdfjs-assets exited with code", pdfjs.status)
}
