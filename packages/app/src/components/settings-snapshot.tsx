import { Component, Show, createMemo, createSignal, onMount } from "solid-js"
import { useParams } from "@solidjs/router"
import { Button } from "@duoduo-ai/ui/button"
import { TextField } from "@duoduo-ai/ui/text-field"
import { showToast } from "@duoduo-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { decode64 } from "@/utils/base64"
import { SettingsList } from "./settings-list"
import { SettingsPage } from "./settings-page"

interface SnapshotStats {
  gitdir: string
  exists: boolean
  sizeBytes: number
  defaultPruneDays: number
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export const SettingsSnapshot: Component = () => {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const server = useServer()
  const params = useParams()

  // Snapshots are per-project, so every request must carry the directory the
  // instance middleware uses to resolve the owning snapshot repository.
  const directory = createMemo(() => decode64(params.dir))

  const [stats, setStats] = createSignal<SnapshotStats | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [pruneDays, setPruneDays] = createSignal("30")
  const [cleanupLoading, setCleanupLoading] = createSignal(false)
  // Starts empty and is only filled after stats load successfully — never a
  // placeholder default that could overwrite the real configured retention.
  const [retention, setRetention] = createSignal("")
  const [retentionSaving, setRetentionSaving] = createSignal(false)

  // Backend `POST /snapshot/cleanup` validates 1..=3650; mirror it client-side
  // with an explicit toast instead of silently dropping invalid input.
  const validDays = (raw: string): number | null => {
    const days = parseInt(raw, 10)
    if (isNaN(days) || days <= 0 || days > 3650) {
      showToast({ variant: "error", title: language.t("settings.snapshot.invalidDays") })
      return null
    }
    return days
  }

  const endpoint = (path: string) => {
    const dir = directory()
    if (!dir) return
    return `${globalSDK.url}${path}?directory=${encodeURIComponent(dir)}`
  }

  // Build the Authorization header from the active server connection so that
  // raw fetch() calls pass the AuthMiddleware when a password is configured.
  const authHeaders = (): Record<string, string> => {
    const http = server.current?.http
    if (!http?.password) return {}
    return {
      Authorization: `Basic ${btoa(`${http.username ?? "duoduocode"}:${http.password}`)}`,
    }
  }

  const fetchStats = async () => {
    const url = endpoint("/snapshot/stats")
    if (!url) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const response = await fetch(url, { headers: authHeaders() })
      if (!response.ok) throw new Error(await response.text())
      const data = (await response.json()) as SnapshotStats
      setStats(data)
      // The configured retention is reflected in `defaultPruneDays`, so prefill
      // the input from there. (The `GET /config` endpoint is occupied by the
      // experimental HTTP API, so we read retention via the snapshot stats.)
      if (typeof data.defaultPruneDays === "number" && data.defaultPruneDays > 0) {
        setRetention(String(data.defaultPruneDays))
      }
    } catch {
      showToast({ variant: "error", title: language.t("common.requestFailed") })
    } finally {
      setLoading(false)
    }
  }

  const handleSaveRetention = async () => {
    // `PATCH /config` is the canonical config-write endpoint (its POST/PATCH
    // path is not shadowed by the experimental HTTP API's `GET /config`).
    const url = endpoint("/config")
    if (!url) return
    const days = validDays(retention())
    if (days === null) return
    setRetentionSaving(true)
    try {
      const response = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ snapshot_retention_days: days }),
      })
      if (!response.ok) throw new Error(await response.text())
      showToast({ variant: "success", title: language.t("settings.snapshot.retentionSaved") })
      // Config write disposes & reloads the instance; re-read the effective
      // retention once the new instance is back up.
      await fetchStats()
    } catch (e: any) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: e?.message })
    } finally {
      setRetentionSaving(false)
    }
  }

  onMount(fetchStats)

  const handleCleanup = async () => {
    const url = endpoint("/snapshot/cleanup")
    if (!url) return
    const days = validDays(pruneDays())
    if (days === null) return
    setCleanupLoading(true)
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ days }),
      })
      if (!response.ok) throw new Error(await response.text())
      const data = (await response.json()) as { freedBytes: number }
      showToast({
        variant: "success",
        title: language.t("settings.snapshot.cleaned", { size: formatBytes(data.freedBytes ?? 0) }),
      })
      await fetchStats()
    } catch (e: any) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: e?.message })
    } finally {
      setCleanupLoading(false)
    }
  }

  return (
    <SettingsPage
      title={language.t("settings.snapshot.title")}
      description={language.t("settings.snapshot.description")}
    >

      <Show
        when={!loading() && !!directory()}
        fallback={
          <div class="text-13-regular text-text-weak">
            {directory() ? language.t("common.loading.ellipsis") : language.t("settings.snapshot.unavailable")}
          </div>
        }
      >
        <SettingsList>
          <div class="flex flex-col gap-3 py-3">
            <div class="text-13-medium text-text-strong">{language.t("settings.snapshot.stats")}</div>

            <div class="flex items-center justify-between text-13-regular">
              <span class="text-text-base">{language.t("settings.snapshot.size")}</span>
              <span class="text-text-strong">{formatBytes(stats()?.sizeBytes ?? 0)}</span>
            </div>

            <div class="flex items-center justify-between text-13-regular">
              <span class="text-text-base">{language.t("settings.snapshot.autoPrune")}</span>
              <span class="text-text-strong">
                {language.t("settings.snapshot.days", { count: stats()?.defaultPruneDays ?? 7 })}
              </span>
            </div>

            <Show when={stats()?.gitdir}>
              <div class="flex flex-col gap-1 text-13-regular">
                <span class="text-text-base">{language.t("settings.snapshot.location")}</span>
                <span class="text-12-regular text-text-weak break-all">{stats()?.gitdir}</span>
              </div>
            </Show>

            <Show when={stats() && !stats()!.exists}>
              <div class="text-12-regular text-text-weak">{language.t("settings.snapshot.empty")}</div>
            </Show>
          </div>
        </SettingsList>
      </Show>

      <SettingsList>
        <div class="flex flex-col gap-4 py-3">
          <div class="text-13-medium text-text-strong">{language.t("settings.snapshot.retention")}</div>
          <div class="text-12-regular text-text-weak">{language.t("settings.snapshot.retentionDesc")}</div>

          <div class="flex items-end gap-3">
            <div class="flex flex-col gap-2 flex-1">
              <TextField
                value={retention()}
                onChange={setRetention}
                placeholder="90"
                type="number"
              />
            </div>
            <Button
              size="small"
              variant="primary"
              onClick={handleSaveRetention}
              disabled={retentionSaving() || !retention() || !directory()}
            >
              {retentionSaving()
                ? language.t("common.loading.ellipsis")
                : language.t("settings.snapshot.retentionSave")}
            </Button>
          </div>
        </div>
      </SettingsList>

      <SettingsList>
        <div class="flex flex-col gap-4 py-3">
          <div class="text-13-medium text-text-strong">{language.t("settings.snapshot.cleanupTitle")}</div>
          <div class="text-12-regular text-text-weak">{language.t("settings.snapshot.cleanupDesc")}</div>

          <div class="flex items-end gap-3">
            <div class="flex flex-col gap-2 flex-1">
              <TextField value={pruneDays()} onChange={setPruneDays} placeholder="30" type="number" />
            </div>
            <Button
              size="small"
              variant="primary"
              onClick={handleCleanup}
              disabled={cleanupLoading() || !pruneDays() || !directory()}
            >
              {cleanupLoading() ? language.t("common.loading.ellipsis") : language.t("settings.snapshot.cleanup")}
            </Button>
          </div>
        </div>
      </SettingsList>
    </SettingsPage>
  )
}
