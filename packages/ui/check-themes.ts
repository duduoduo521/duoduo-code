/**
 * Sanity-checks every shipped theme: both variants must resolve without
 * throwing, and must produce the same token keys as the default theme —
 * a missing key would silently fall back to the baked-in default at runtime.
 *
 * Usage:  bun run check-themes.ts   (from packages/ui)
 */
import { resolveTheme } from "./src/theme/resolve"
import { DEFAULT_THEMES, DEFAULT_THEME_ID } from "./src/theme/default-themes"
import type { DesktopTheme } from "./src/theme/types"

let failed = false
const reference = new Set(Object.keys(resolveTheme(DEFAULT_THEMES[DEFAULT_THEME_ID]!).light))

for (const [id, theme] of Object.entries(DEFAULT_THEMES)) {
  const cast = theme as DesktopTheme
  for (const [mode, tokens] of Object.entries(resolveTheme(cast))) {
    const keys = Object.keys(tokens)
    const missing = [...reference].filter((key) => !keys.includes(key))
    const extra = keys.filter((key) => !reference.has(key))

    if (missing.length || extra.length) {
      failed = true
      console.error(`✗ ${id} (${mode}): missing=${missing.length} extra=${extra.length}`)
      if (missing.length) console.error(`    missing: ${missing.slice(0, 8).join(", ")}`)
      if (extra.length) console.error(`    extra:   ${extra.slice(0, 8).join(", ")}`)
      continue
    }
    console.log(`✓ ${id} (${mode}): ${keys.length} tokens`)
  }
}

if (failed) {
  console.error("\nTheme check FAILED")
  process.exit(1)
}
console.log(`\nAll ${Object.keys(DEFAULT_THEMES).length} themes OK (${reference.size} tokens each).`)
