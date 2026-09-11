import { Component, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { TextField } from "@duoduo-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { useSmartLayer } from "@/addons/smart-layer/context"
import { showToast } from "@duoduo-ai/ui/toast"
import { SettingsList } from "./settings-list"
import { SettingsPage } from "./settings-page"

export const SettingsConcurrency: Component = () => {
  const language = useLanguage()
  const sl = useSmartLayer()

  const [config, setConfig] = createStore({
    maxConcurrentAgents: 5,
    maxConcurrentSubagents: 3,
    maxRetryAttempts: 3,
    toolConcurrency: 4,
  })
  const [loaded, setLoaded] = createStore({ done: false, unavailable: false })

  // Load current config on mount
  onMount(async () => {
    try {
      const api = sl.api
      if (!api) {
        // Smart layer not connected: keep inputs disabled instead of
        // silently accepting edits that can never be saved.
        setLoaded({ done: false, unavailable: true })
        return
      }
      const data = await api.getLlmConfig()
      setConfig({
        maxConcurrentAgents: data.maxConcurrentAgents ?? 5,
        maxConcurrentSubagents: data.maxConcurrentSubagents ?? 3,
        maxRetryAttempts: data.maxRetryAttempts ?? 3,
        toolConcurrency: data.toolConcurrency ?? 4,
      })
    } catch {
      // Use defaults
    }
    setLoaded("done", true)
  })

  // Debounce writes so per-keystroke edits don't fire a GET+POST each time.
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(saveTimer))

  const flush = async () => {
    try {
      const api = sl.api
      if (!api) return
      // Fetch current full config, merge concurrency fields, and POST back
      const current = await api.getLlmConfig()
      // Guard: never invent a provider/model when nothing is configured yet.
      if (!current.provider || !current.defaultModelId) {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
        })
        return
      }
      await api.configureLlm({
        provider: current.provider,
        defaultModelId: current.defaultModelId,
        ...(current.baseURL ? { baseURL: current.baseURL } : {}),
        ...(current.contextWindow ? { contextWindow: current.contextWindow } : {}),
        ...(current.maxOutputTokens ? { maxOutputTokens: current.maxOutputTokens } : {}),
        ...(current.temperature !== undefined ? { temperature: current.temperature } : {}),
        ...(current.enableThinking !== undefined ? { enableThinking: current.enableThinking } : {}),
        ...(current.thinkingEffort !== undefined ? { thinkingEffort: current.thinkingEffort } : {}),
        maxConcurrentAgents: config.maxConcurrentAgents,
        maxConcurrentSubagents: config.maxConcurrentSubagents,
        maxRetryAttempts: config.maxRetryAttempts,
        toolConcurrency: config.toolConcurrency,
      })
    } catch {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
      })
    }
  }

  const save = (field: string, value: number) => {
    const isAgents = field === "maxConcurrentAgents"
    const clamped = Math.max(
      1,
      Math.min(
        isAgents ? 100 : field === "toolConcurrency" ? 16 : 10,
        value,
      ),
    )
    setConfig(field as any, clamped)
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
      flush()
    }, 400)
  }

  return (
    <SettingsPage
      title={language.t("settings.concurrency.title")}
      description={language.t("settings.concurrency.description")}
    >

      <Show when={loaded.unavailable}>
        <div class="text-13-regular text-text-weak">
          {language.t("smartLayer.settingsUnavailable")}
        </div>
      </Show>

      <SettingsList>
        <div class="flex flex-col gap-4 py-3">
          {/* Max Concurrent Agents */}
          <div class="flex flex-wrap items-center gap-4 sm:flex-nowrap">
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-14-medium text-text-strong">
                {language.t("settings.concurrency.maxAgents.title")}
              </span>
              <span class="text-12-regular text-text-weak">
                {language.t("settings.concurrency.maxAgents.description")}
              </span>
            </div>
            <div class="flex w-full justify-end sm:w-auto sm:shrink-0">
              <TextField
                value={String(config.maxConcurrentAgents)}
                disabled={!loaded.done}
                onChange={(v) => {
                  const n = parseInt(v, 10)
                  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
                  if (!isNaN(n) && n >= 1 && n <= 100) save("maxConcurrentAgents", n)
                }}
              />
            </div>
          </div>

          {/* Max Subagents per Agent */}
          <div class="flex flex-wrap items-center gap-4 sm:flex-nowrap">
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-14-medium text-text-strong">
                {language.t("settings.concurrency.maxSubagents.title")}
              </span>
              <span class="text-12-regular text-text-weak">
                {language.t("settings.concurrency.maxSubagents.description")}
              </span>
            </div>
            <div class="flex w-full justify-end sm:w-auto sm:shrink-0">
              <TextField
                value={String(config.maxConcurrentSubagents)}
                disabled={!loaded.done}
                onChange={(v) => {
                  const n = parseInt(v, 10)
                  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
                  if (!isNaN(n) && n >= 1 && n <= 10) save("maxConcurrentSubagents", n)
                }}
              />
            </div>
          </div>

          {/* LLM Retry Attempts */}
          <div class="flex flex-wrap items-center gap-4 sm:flex-nowrap">
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-14-medium text-text-strong">
                {language.t("settings.concurrency.retryAttempts.title")}
              </span>
              <span class="text-12-regular text-text-weak">
                {language.t("settings.concurrency.retryAttempts.description")}
              </span>
            </div>
            <div class="flex w-full justify-end sm:w-auto sm:shrink-0">
              <TextField
                value={String(config.maxRetryAttempts)}
                disabled={!loaded.done}
                onChange={(v) => {
                  const n = parseInt(v, 10)
                  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
                  if (!isNaN(n) && n >= 1 && n <= 10) save("maxRetryAttempts", n)
                }}
              />
            </div>
          </div>

          {/* Per-round tool concurrency (hard-capped at 16) */}
          <div class="flex flex-wrap items-center gap-4 sm:flex-nowrap">
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-14-medium text-text-strong">
                {language.t("settings.concurrency.toolConcurrency.title")}
              </span>
              <span class="text-12-regular text-text-weak">
                {language.t("settings.concurrency.toolConcurrency.description")}
              </span>
            </div>
            <div class="flex w-full justify-end sm:w-auto sm:shrink-0">
              <TextField
                value={String(config.toolConcurrency)}
                disabled={!loaded.done}
                onChange={(v) => {
                  const n = parseInt(v, 10)
                  // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
                  if (!isNaN(n) && n >= 1 && n <= 16) save("toolConcurrency", n)
                }}
              />
            </div>
          </div>
        </div>
      </SettingsList>
    </SettingsPage>
  )
}
