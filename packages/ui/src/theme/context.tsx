import { createEffect, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createSimpleContext } from "../context/helper"
import dawnThemeJson from "./themes/dawn.json"
import { DEFAULT_THEME_ID } from "./default-themes"
import { resolveThemeVariant, themeToCss } from "./resolve"
import type { DesktopTheme } from "./types"

export type ColorScheme = "light" | "dark" | "system"

const STORAGE_KEYS = {
  THEME_ID: "duoduo-theme-id",
  COLOR_SCHEME: "duoduo-color-scheme",
  THEME_CSS_LIGHT: "duoduo-theme-css-light",
  THEME_CSS_DARK: "duoduo-theme-css-dark",
} as const

// NOTE: distinct from the `duoduo-theme` id used by ./loader.ts. That one is
// written by applyTheme() when loading a theme from a URL; this one is the
// runtime-managed style element for theme switching. They must not collide, or
// the two mechanisms would overwrite each other's CSS.
const THEME_STYLE_ID = "duoduo-theme-runtime"
let files: Record<string, () => Promise<{ default: DesktopTheme }>> | undefined
let ids: string[] | undefined
let known: Set<string> | undefined

function getFiles() {
  if (files) return files
  files = import.meta.glob<{ default: DesktopTheme }>("./themes/*.json")
  return files
}

function themeIDs() {
  if (ids) return ids
  ids = Object.keys(getFiles())
    .map((path) => path.slice("./themes/".length, -".json".length))
    .sort()
  return ids
}

function knownThemes() {
  if (known) return known
  known = new Set(themeIDs())
  return known
}

// Fallback display names, used only until a theme's JSON has loaded — the JSON
// itself carries the authoritative `name`.
const names: Record<string, string> = {
  dawn: "晨雾",
  cinnabar: "朱砂",
  celadon: "青瓷",
  violet: "墨紫",
}
const dawnTheme = dawnThemeJson as DesktopTheme

/**
 * Resolves a persisted or requested id to one that actually exists.
 *
 * Earlier builds shipped 37 themes (oc-2, tokyonight, …) whose ids can still
 * sit in localStorage. Those files are gone now, so anything unknown falls back
 * to the default — otherwise returning users would land on an unstyled UI.
 */
function normalize(id: string | null | undefined): string {
  if (id && knownThemes().has(id)) return id
  return DEFAULT_THEME_ID
}

function read(key: string) {
  if (typeof localStorage !== "object") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.setItem(key, value)
  } catch {}
}

function drop(key: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.removeItem(key)
  } catch {}
}

function clear() {
  drop(STORAGE_KEYS.THEME_CSS_LIGHT)
  drop(STORAGE_KEYS.THEME_CSS_DARK)
}

function readWithMigration(key: string): string | null {
  return read(key)
}

function ensureThemeStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
  if (existing) return existing
  const element = document.createElement("style")
  element.id = THEME_STYLE_ID
  document.head.appendChild(element)
  return element
}

function getSystemMode(): "light" | "dark" {
  if (typeof window !== "object") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function applyThemeCss(theme: DesktopTheme, themeId: string, mode: "light" | "dark") {
  const isDark = mode === "dark"
  const variant = isDark ? theme.dark : theme.light
  const tokens = resolveThemeVariant(variant, isDark)
  const css = themeToCss(tokens)

  // The zero theme is already baked into styles/theme.css, so caching it would
  // only risk serving stale tokens after the fallback is regenerated.
  if (themeId !== DEFAULT_THEME_ID) {
    write(isDark ? STORAGE_KEYS.THEME_CSS_DARK : STORAGE_KEYS.THEME_CSS_LIGHT, css)
  }

  const fullCss = `:root {
  color-scheme: ${mode};
  --text-mix-blend-mode: ${isDark ? "plus-lighter" : "multiply"};
  ${css}
}`

  document.getElementById("duoduo-theme-preload")?.remove()
  ensureThemeStyleElement().textContent = fullCss
  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
}

function cacheThemeVariants(theme: DesktopTheme, themeId: string) {
  if (themeId === DEFAULT_THEME_ID) return
  for (const mode of ["light", "dark"] as const) {
    const isDark = mode === "dark"
    const variant = isDark ? theme.dark : theme.light
    const tokens = resolveThemeVariant(variant, isDark)
    const css = themeToCss(tokens)
    write(isDark ? STORAGE_KEYS.THEME_CSS_DARK : STORAGE_KEYS.THEME_CSS_LIGHT, css)
  }
}

// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: (props: { defaultTheme?: string; onThemeApplied?: (theme: DesktopTheme, mode: "light" | "dark") => void }) => {
    const themeId = normalize(readWithMigration(STORAGE_KEYS.THEME_ID) ?? props.defaultTheme)
    const colorScheme =
      (readWithMigration(STORAGE_KEYS.COLOR_SCHEME) as ColorScheme | null) ?? "dark"
    const mode = colorScheme === "system" ? getSystemMode() : colorScheme
    const [store, setStore] = createStore({
      themes: {
        [DEFAULT_THEME_ID]: dawnTheme,
      } as Record<string, DesktopTheme>,
      themeId,
      colorScheme,
      mode,
      previewThemeId: null as string | null,
      previewScheme: null as ColorScheme | null,
    })

    const loads = new Map<string, Promise<DesktopTheme | undefined>>()

    const load = (id: string) => {
      const next = normalize(id)
      const hit = store.themes[next]
      if (hit) return Promise.resolve(hit)
      const pending = loads.get(next)
      if (pending) return pending
      const file = getFiles()[`./themes/${next}.json`]
      if (!file) return Promise.resolve(undefined)
      const task = file()
        .then((mod) => {
          const theme = mod.default
          setStore("themes", next, theme)
          return theme
        })
        .finally(() => {
          loads.delete(next)
        })
      loads.set(next, task)
      return task
    }

    const applyTheme = (theme: DesktopTheme, themeId: string, mode: "light" | "dark") => {
      applyThemeCss(theme, themeId, mode)
      props.onThemeApplied?.(theme, mode)
    }

    const ids = () => {
      const extra = Object.keys(store.themes)
        .filter((id) => !knownThemes().has(id))
        .sort()
      const all = themeIDs()
      if (extra.length === 0) return all
      return [...all, ...extra]
    }

    const loadThemes = () => Promise.all(themeIDs().map(load)).then(() => store.themes)

    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.THEME_ID && e.newValue) {
        const next = normalize(e.newValue)
        setStore("themeId", next)
        if (next === DEFAULT_THEME_ID) {
          clear()
          return
        }
        void load(next).then((theme) => {
          if (!theme || store.themeId !== next) return
          cacheThemeVariants(theme, next)
        })
      }
      if (e.key === STORAGE_KEYS.COLOR_SCHEME && e.newValue) {
        setStore("colorScheme", e.newValue as ColorScheme)
        setStore("mode", e.newValue === "system" ? getSystemMode() : (e.newValue as "light" | "dark"))
      }
    }

    onMount(() => {
      makeEventListener(window, "storage", onStorage)

      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
      const onMedia = () => {
        if (store.colorScheme !== "system") return
        setStore("mode", getSystemMode())
      }
      makeEventListener(mediaQuery, "change", onMedia)

      const rawTheme = readWithMigration(STORAGE_KEYS.THEME_ID)
      const savedTheme = normalize(rawTheme ?? props.defaultTheme)
      const savedScheme =
        (readWithMigration(STORAGE_KEYS.COLOR_SCHEME) as ColorScheme | null) ?? "dark"
      if (rawTheme && rawTheme !== savedTheme) {
        write(STORAGE_KEYS.THEME_ID, savedTheme)
        clear()
      }
      if (savedTheme !== store.themeId) setStore("themeId", savedTheme)
      if (savedScheme !== store.colorScheme) setStore("colorScheme", savedScheme)
      setStore("mode", savedScheme === "system" ? getSystemMode() : savedScheme)
      void load(savedTheme).then((theme) => {
        if (!theme || store.themeId !== savedTheme) return
        cacheThemeVariants(theme, savedTheme)
      })
    })

    createEffect(() => {
      const theme = store.themes[store.themeId]
      if (!theme) return
      applyTheme(theme, store.themeId, store.mode)
    })

    const setTheme = (id: string) => {
      const next = normalize(id)
      setStore("themeId", next)
      if (next === DEFAULT_THEME_ID) {
        write(STORAGE_KEYS.THEME_ID, next)
        clear()
        return
      }
      void load(next).then((theme) => {
        if (!theme || store.themeId !== next) return
        cacheThemeVariants(theme, next)
        write(STORAGE_KEYS.THEME_ID, next)
      })
    }

    const setColorScheme = (scheme: ColorScheme) => {
      setStore("colorScheme", scheme)
      write(STORAGE_KEYS.COLOR_SCHEME, scheme)
      setStore("mode", scheme === "system" ? getSystemMode() : scheme)
    }

    return {
      themeId: () => store.themeId,
      colorScheme: () => store.colorScheme,
      mode: () => store.mode,
      ids,
      name: (id: string) => store.themes[id]?.name ?? names[id] ?? id,
      loadThemes,
      themes: () => store.themes,
      setTheme,
      setColorScheme,
      registerTheme: (theme: DesktopTheme) => setStore("themes", theme.id, theme),
      previewTheme: (id: string) => {
        const next = normalize(id)
        setStore("previewThemeId", next)
        void load(next).then((theme) => {
          if (!theme || store.previewThemeId !== next) return
          const mode = store.previewScheme
            ? store.previewScheme === "system"
              ? getSystemMode()
              : store.previewScheme
            : store.mode
          applyTheme(theme, next, mode)
        })
      },
      previewColorScheme: (scheme: ColorScheme) => {
        setStore("previewScheme", scheme)
        const mode = scheme === "system" ? getSystemMode() : scheme
        const id = store.previewThemeId ?? store.themeId
        void load(id).then((theme) => {
          if (!theme) return
          if ((store.previewThemeId ?? store.themeId) !== id) return
          if (store.previewScheme !== scheme) return
          applyTheme(theme, id, mode)
        })
      },
      commitPreview: () => {
        if (store.previewThemeId) {
          setTheme(store.previewThemeId)
        }
        if (store.previewScheme) {
          setColorScheme(store.previewScheme)
        }
        setStore("previewThemeId", null)
        setStore("previewScheme", null)
      },
      cancelPreview: () => {
        setStore("previewThemeId", null)
        setStore("previewScheme", null)
        void load(store.themeId).then((theme) => {
          if (!theme) return
          applyTheme(theme, store.themeId, store.mode)
        })
      },
    }
  },
})
