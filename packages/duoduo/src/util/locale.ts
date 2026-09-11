export function titlecase(str: string) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function time(input: number): string {
  const date = new Date(input)
  return date.toLocaleTimeString(undefined, { timeStyle: "short" })
}

export function datetime(input: number): string {
  const date = new Date(input)
  const localTime = time(input)
  const localDate = date.toLocaleDateString()
  return `${localTime} · ${localDate}`
}

export function todayTimeOrDateTime(input: number): string {
  const date = new Date(input)
  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()

  if (isToday) {
    return time(input)
  } else {
    return datetime(input)
  }
}

export function number(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}

export function duration(input: number) {
  if (input < 1000) {
    return `${input}ms`
  }
  if (input < 60000) {
    return `${(input / 1000).toFixed(1)}s`
  }
  if (input < 3600000) {
    const minutes = Math.floor(input / 60000)
    const seconds = Math.floor((input % 60000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  if (input < 86400000) {
    const hours = Math.floor(input / 3600000)
    const minutes = Math.floor((input % 3600000) / 60000)
    return `${hours}h ${minutes}m`
  }
  const hours = Math.floor(input / 3600000)
  const days = Math.floor((input % 3600000) / 86400000)
  return `${days}d ${hours}h`
}

export function truncate(str: string, len: number): string {
  if (str.length <= len) return str
  return str.slice(0, len - 1) + "…"
}

export function truncateMiddle(str: string, maxLength: number = 35): string {
  if (str.length <= maxLength) return str

  const ellipsis = "…"
  const keepStart = Math.ceil((maxLength - ellipsis.length) / 2)
  const keepEnd = Math.floor((maxLength - ellipsis.length) / 2)

  return str.slice(0, keepStart) + ellipsis + str.slice(-keepEnd)
}

export function pluralize(count: number, singular: string, plural: string): string {
  const template = count === 1 ? singular : plural
  return template.replace("{}", count.toString())
}

// ── UI language (i18n) resolution ────────────────────────────────────────────
//
// The app (packages/app) stores the user's UI language in
// localStorage["duoduo-ai.settings"] under the `language` field, managed by
// packages/app/src/i18n/core.ts. The sidecar runs in the same renderer
// process / shared origin, so we read the SAME key here to stay consistent
// with the user's system/language setting instead of hard-coding any locale.
//
// Supported values mirror the app's i18n: "en" | "zh" (plus regional variants
// like "zh-hans" / "zh-hant", normalized to "zh").

export type Locale = "en" | "zh"

const SETTINGS_KEY = "duoduo-ai.settings"
const SUPPORTED: Locale[] = ["en", "zh"]

/** Normalize a raw language string into a supported Locale. */
export function normalizeLocale(raw: string | null | undefined): Locale {
  if (!raw) return defaultLocale()
  const key = raw.toLowerCase()
  if (key.startsWith("zh")) return "zh"
  if (key === "en" || key.startsWith("en")) return "en"
  // Unknown locale → fall back to the OS/browser detection below.
  return defaultLocale()
}

/** Detect the locale from the browser/navigator when no stored setting exists. */
export function defaultLocale(): Locale {
  if (typeof navigator !== "undefined" && navigator.language) {
    return normalizeLocale(navigator.language)
  }
  return "en"
}

/**
 * Read the currently effective locale.
 *
 * Priority:
 *   1. language stored by the app in localStorage["duoduo-ai.settings"]
 *   2. navigator.language (system/browser preference)
 *   3. "en" (safe default)
 */
export function currentLocale(): Locale {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as { language?: string }
        const stored = parsed.language
        // Only honor a stored value if it is actually a supported locale;
        // otherwise fall through to system detection.
        if (stored && SUPPORTED.includes(normalizeLocale(stored) as Locale)) {
          return normalizeLocale(stored)
        }
      }
    }
  } catch {
    // localStorage / JSON can throw in private mode or when unavailable.
    // Fall through to system detection.
  }
  return defaultLocale()
}

/**
 * Pick a localized string by the current locale.
 * Pass `{ en, zh }`; the matching one is returned.
 */
export function t(messages: Record<Locale, string>): string {
  return messages[currentLocale()] ?? messages.en
}
