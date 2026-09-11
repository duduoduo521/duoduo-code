import { Component, Show, createSignal, onMount } from "solid-js"
import { Button } from "@duoduo-ai/ui/button"
import { TextField } from "@duoduo-ai/ui/text-field"
import { showToast } from "@duoduo-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { SettingsList } from "./settings-list"
import { SettingsPage } from "./settings-page"

type LogInfo = {
  root: string
  today_dir: string
  today: string
}

function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } }
  }
  const fn = w.__TAURI__?.core?.invoke
  if (!fn) return Promise.reject(new Error("tauri invoke unavailable"))
  return fn(cmd, args) as Promise<T>
}

export const SettingsLogs: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const t = language.t

  const [info, setInfo] = createSignal<LogInfo | null>(null)
  const [cleaning, setCleaning] = createSignal(false)

  const isDesktop = () => platform.platform === "desktop"

  onMount(async () => {
    if (!isDesktop()) return
    try {
      const data = await invoke<LogInfo>("log_info")
      setInfo(data)
    } catch {
      // Non-fatal: the directory listing is best-effort.
    }
  })

  const onClean = async () => {
    if (!isDesktop()) return
    setCleaning(true)
    try {
      const count = await invoke<number>("clean_logs", {
        retentionDays: settings.logs.retentionDays(),
      })
      showToast({ title: t("settings.logs.cleaned", { count }), variant: "success" })
      // Re-read the directory info so the displayed paths reflect the disk
      // state after cleanup (the today dir may have been pruned/recreated).
      try {
        setInfo(await invoke<LogInfo>("log_info"))
      } catch {
        // Best-effort refresh only.
      }
    } catch {
      showToast({ title: t("settings.logs.clean"), description: "Failed to clean logs", variant: "error" })
    } finally {
      setCleaning(false)
    }
  }

  const onOpen = () => {
    const dir = info()?.today_dir ?? info()?.root
    if (dir && platform.openPath) void platform.openPath(dir)
  }

  return (
    <SettingsPage
      title={t("settings.logs.title")}
      description={t("settings.logs.description")}
    >

      <Show when={!isDesktop()}>
        <div class="text-13-regular text-text-weak">{t("settings.logs.onlyDesktop")}</div>
      </Show>

      <Show when={isDesktop()}>
        <SettingsList>
          <div class="flex items-center justify-between px-2 py-3">
            <div class="flex flex-col min-w-0">
              <span class="text-14-medium">{t("settings.logs.location")}</span>
              <span class="text-12-regular text-text-weak break-all">{info()?.root ?? "…"}</span>
            </div>
            <Button variant="secondary" icon="folder-add-left" onClick={onOpen} disabled={!info()}>
              {t("settings.logs.open")}
            </Button>
          </div>
          <div class="flex items-center justify-between px-2 py-3 border-t border-border-subtle">
            <div class="flex flex-col min-w-0">
              <span class="text-14-medium">{t("settings.logs.today")}</span>
              <span class="text-12-regular text-text-weak break-all">{info()?.today_dir ?? "…"}</span>
            </div>
          </div>
        </SettingsList>

        <SettingsList>
          <div class="flex items-center justify-between px-2 py-3">
            <div class="flex flex-col">
              <span class="text-14-medium">{t("settings.logs.retention")}</span>
              <span class="text-12-regular text-text-weak">{t("settings.logs.retentionHint")}</span>
            </div>
            <div class="w-28">
              <TextField
                type="number"
                min={1}
                max={365}
                value={String(settings.logs.retentionDays())}
                onChange={(raw: string) => {
                  // Invalid/empty input: keep the current value and tell the
                  // user, instead of silently rewriting it to a default.
                  const parsed = Math.trunc(Number(raw))
                  if (!raw.trim() || !Number.isFinite(parsed) || parsed < 1 || parsed > 365) {
                    showToast({ variant: "error", title: t("settings.logs.invalidRetention") })
                    return
                  }
                  settings.logs.setRetentionDays(parsed)
                }}
              />
            </div>
          </div>
        </SettingsList>

        <div class="flex justify-end">
          <Button variant="ghost" icon="circle-x" onClick={onClean} disabled={cleaning()}>
            {cleaning() ? t("settings.logs.cleaning") : t("settings.logs.clean")}
          </Button>
        </div>
      </Show>
    </SettingsPage>
  )
}
