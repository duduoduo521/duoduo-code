/**
 * Regenerates the baked-in fallback colour block of `src/styles/theme.css`
 * from the default theme (`themes/dawn.json`).
 *
 * The fallback must exist because it is what paints the very first frame —
 * before any theme JSON is fetched and applied at runtime. Keeping it
 * generated (instead of hand-maintained) guarantees the first frame and the
 * runtime-resolved theme can never drift apart.
 *
 * Everything above the `FALLBACK_MARKER` line (typography, motion, radii,
 * shadows, spacing) is preserved verbatim; only the colour block is replaced.
 *
 * Usage:  bun run gen-theme-fallback.ts   (from packages/ui)
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolveTheme } from "./src/theme/resolve"
import type { DesktopTheme } from "./src/theme/types"
import dawn from "./src/theme/themes/dawn.json"

// Stable marker so this script can be re-run repeatedly: everything before it
// is hand-authored and preserved, everything from it on is regenerated.
const FALLBACK_MARKER = "GENERATED-COLOR-BLOCK-START"
const THEME_FILE = "src/styles/theme.css"

const theme = dawn as unknown as DesktopTheme
const { light, dark } = resolveTheme(theme)

const block = (tokens: Record<string, string>, indent: string) =>
  Object.entries(tokens)
    .map(([key, value]) => `${indent}--${key}: ${value};`)
    .join("\n")

const source = readFileSync(THEME_FILE, "utf8")
const lines = source.split(/\r?\n/)
const markerIndex = lines.findIndex((line) => line.includes(FALLBACK_MARKER))
if (markerIndex === -1) {
  throw new Error(`Marker "${FALLBACK_MARKER}" not found in ${THEME_FILE} — nothing to regenerate.`)
}

const head = lines.slice(0, markerIndex).join("\n").replace(/\s+$/, "")

const generated = `${head}

  /* GENERATED-COLOR-BLOCK-START
     ${theme.name} (${theme.id}) — light. Source: themes/${theme.id}.json via resolve.ts.
     Do not edit by hand — run \`bun run gen-theme-fallback.ts\` instead. */
${block(light, "  ")}

  @media (prefers-color-scheme: dark) {
    color-scheme: dark;
    --text-mix-blend-mode: plus-lighter;

    /* ${theme.name} — dark */
${block(dark, "    ")}
  }
}
`

writeFileSync(THEME_FILE, generated, "utf8")
console.log(`Regenerated ${THEME_FILE}: ${Object.keys(light).length} light / ${Object.keys(dark).length} dark tokens.`)
