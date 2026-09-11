/**
 * Prepare lifecycle script.
 *
 * Runs `husky` to install git hooks, but only when a `.git` directory exists.
 * In this monorepo, `.git` lives in the parent directory (`duoduo-ide-zed/`),
 * not inside `duoduo-ai-ide/`, so husky would print ".git can't be found"
 * every time `bun install` runs. We skip it silently instead.
 */
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"

if (existsSync(".git")) {
  const result = spawnSync("husky", { stdio: "inherit", shell: true })
  if (result.status !== 0 && result.status !== null) {
    // Don't fail the entire install if husky has issues
    console.warn("husky exited with code", result.status)
  }
}

// Copy pdf.js cMaps + standard fonts into app/public so PDF preview renders
// CJK / special fonts correctly and works offline inside Tauri.
const pdfjs = spawnSync("bun", ["run", "scripts/copy-pdfjs-assets.ts"], { stdio: "inherit", shell: true })
if (pdfjs.status !== 0 && pdfjs.status !== null) {
  console.warn("copy-pdfjs-assets exited with code", pdfjs.status)
}
