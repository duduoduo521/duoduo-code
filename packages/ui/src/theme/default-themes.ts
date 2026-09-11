import type { DesktopTheme } from "./types"
import dawnThemeJson from "./themes/dawn.json"
import cinnabarThemeJson from "./themes/cinnabar.json"
import celadonThemeJson from "./themes/celadon.json"
import violetThemeJson from "./themes/violet.json"

/**
 * `dawn` is the zero theme: its resolved tokens are baked into
 * `styles/theme.css` so the very first paint is correct before any theme is
 * fetched. Keep it in sync via `bun run gen-theme-fallback.ts`.
 */
export const DEFAULT_THEME_ID = "dawn"

export const dawnTheme = dawnThemeJson as DesktopTheme
export const cinnabarTheme = cinnabarThemeJson as DesktopTheme
export const celadonTheme = celadonThemeJson as DesktopTheme
export const violetTheme = violetThemeJson as DesktopTheme

export const DEFAULT_THEMES: Record<string, DesktopTheme> = {
  dawn: dawnTheme,
  cinnabar: cinnabarTheme,
  celadon: celadonTheme,
  violet: violetTheme,
}
