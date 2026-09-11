import * as i18n from "@solid-primitives/i18n"
import { createEffect, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@duoduo-ai/ui/context"
import { Persist, persisted } from "@/utils/persist"
import { dict as en } from "@/i18n/en"
import { dict as uiEn } from "@duoduo-ai/ui/i18n/en"
import { type Locale, detectLocale, normalizeLocale, loadDict } from "@/i18n/core"

export { type Locale } from "@/i18n/core"

type RawDictionary = typeof en & typeof uiEn
type Dictionary = i18n.Flatten<RawDictionary>

function cookie(locale: Locale) {
  return `oc_locale=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`
}

const LOCALES: readonly Locale[] = ["en", "zh"]

const INTL: Record<Locale, string> = {
  en: "en",
  zh: "zh-Hans",
}

const LABEL_KEY: Record<Locale, keyof Dictionary> = {
  en: "language.en",
  zh: "language.zh",
}

const base = i18n.flatten({ ...en, ...uiEn })
const dicts = new Map<Locale, Dictionary>([["en", base]])

function readStoredLocale() {
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

const warm = readStoredLocale() ?? detectLocale()
if (warm !== "en") void loadDict(warm)

// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext({
  name: "Language",
  init: (props: { locale?: Locale }) => {
    const initial = props.locale ?? readStoredLocale() ?? detectLocale()
    const [store, setStore, _, ready] = persisted(
      Persist.global("language", ["language.v1"]),
      createStore({
        locale: initial,
      }),
    )

    const locale = createMemo<Locale>(() => normalizeLocale(store.locale))
    const intl = createMemo(() => INTL[locale()])

    const [dict] = createResource(locale, loadDict, {
      initialValue: dicts.get(initial) ?? base,
    })

    function resolveTemplate(template: string, params?: Record<string, string | number | boolean>): string {
      if (!params) return template
      return template.replace(/\{\{?(\w+)\}?\}/g, (_, key) => {
        const value = params[key]
        return value !== undefined && value !== null ? String(value) : `{{${key}}}`
      })
    }

    const t = i18n.translator(() => dict() ?? base, resolveTemplate) as (
      key: keyof Dictionary,
      params?: Record<string, string | number | boolean>,
    ) => string

    const label = (value: Locale) => t(LABEL_KEY[value])

    createEffect(() => {
      if (typeof document !== "object") return
      document.documentElement.lang = locale()
      document.cookie = cookie(locale())
    })

    return {
      ready,
      locale,
      intl,
      locales: LOCALES,
      label,
      t,
      setLocale(next: Locale) {
        setStore("locale", normalizeLocale(next))
      },
    }
  },
})
