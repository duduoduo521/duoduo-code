import * as i18n from "@solid-primitives/i18n"

import { dict as en } from "./en"
import { dict as uiEn } from "@duoduo-ai/ui/i18n/en"

export type Locale = "en" | "zh"

type RawDictionary = typeof en & typeof uiEn
type Dictionary = i18n.Flatten<RawDictionary>

const base = i18n.flatten({ ...en, ...uiEn })
const dicts = new Map<Locale, Dictionary>([["en", base]])

const LOCALES: readonly Locale[] = ["en", "zh"]

const localeMatchers: Array<{ locale: Locale; match: (language: string) => boolean }> = [
  { locale: "en", match: (language) => language.startsWith("en") },
  { locale: "zh", match: (language) => language.startsWith("zh") },
]

export function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    const normalized = language.toLowerCase()
    const match = localeMatchers.find((entry) => entry.match(normalized))
    if (match) return match.locale
  }

  return "en"
}

export function normalizeLocale(value: string): Locale {
  return LOCALES.includes(value as Locale) ? (value as Locale) : "en"
}

function readStoredLocale(): Locale | undefined {
  if (typeof localStorage !== "object") return
  try {
    const raw = localStorage.getItem("duoduocode.global.dat:language")
    if (!raw) return
    const next = JSON.parse(raw) as { locale?: string }
    if (typeof next?.locale !== "string") return
    return normalizeLocale(next.locale)
  } catch {
    return
  }
}

const loaders: Record<Exclude<Locale, "en">, () => Promise<Dictionary>> = {
  zh: () =>
    Promise.all([import("./zh"), import("@duoduo-ai/ui/i18n/zh")]).then(([app, ui]) => ({
      ...base,
      ...i18n.flatten({ ...app.dict, ...ui.dict }),
    })) as Promise<Dictionary>,
}

export function loadDict(locale: Locale): Promise<Dictionary> {
  const hit = dicts.get(locale)
  if (hit) return Promise.resolve(hit)
  if (locale === "en") return Promise.resolve(base)
  const load = loaders[locale]
  if (!load) return Promise.resolve(base)
  return load().then((next: Dictionary) => {
    dicts.set(locale, next)
    return next
  })
}

export function loadLocaleDict(locale: Locale): Promise<void> {
  return loadDict(locale).then(() => undefined)
}

// ─── Module-level state (for non-component usage) ─────────────────────

let _locale: Locale = readStoredLocale() ?? detectLocale()
let _dict: Dictionary = base

// Warm: load non-en dict at module init time if needed
if (_locale !== "en") void loadDict(_locale).then((d) => (_dict = d))

function resolveTemplate(template: string, params?: Record<string, string | number | boolean>): string {
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = params[key]
    return value !== undefined && value !== null ? String(value) : `{{${key}}}`
  })
}

const translate = i18n.translator(() => _dict, resolveTemplate)

/**
 * Module-level t() — for usage outside SolidJS component tree
 * (loading screen, CLI error messages, etc.)
 */
export function t(key: keyof Dictionary, params?: Record<string, string | number | boolean>): string {
  return translate(key, params as any)
}

/** Get the current resolved locale. */
export function currentLocale(): Locale {
  return _locale
}

/**
 * Initialize i18n from stored preference.
 * Call this early before any t() calls to ensure correct locale.
 */
export async function initI18n(): Promise<Locale> {
  const stored = readStoredLocale()
  if (stored) _locale = stored

  _dict = await loadDict(_locale)
  return _locale
}
