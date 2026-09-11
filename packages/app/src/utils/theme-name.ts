type Translate = (key: string, params?: Record<string, string | number | boolean>) => string

/**
 * Localised display name for a theme.
 *
 * Shipped themes carry a `theme.name.<id>` entry in both dictionaries, so the
 * label follows the UI language — a Chinese user sees 晨雾, an English user sees
 * "Dawn". Themes registered at runtime (plugins) have no translation we could
 * ship ahead of time, so they fall back to the `name` field in their own JSON.
 */
export function themeName(id: string, t: Translate, fallback: string): string {
  const key = `theme.name.${id}`
  const value = t(key)
  // @solid-primitives/i18n returns the key itself when a lookup misses, which is
  // how we tell "no translation" apart from a translated value.
  return value === key ? fallback : value
}
