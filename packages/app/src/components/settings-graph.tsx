import { Component, For, Show, createSignal, onMount } from "solid-js"
import { Button } from "@duoduo-ai/ui/button"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { TextField } from "@duoduo-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { useSmartLayer } from "@/addons/smart-layer/context"
import { showToast } from "@duoduo-ai/ui/toast"
import { SettingsList } from "./settings-list"
import { SettingsPage } from "./settings-page"
import { DialogConfirm } from "./dialog-confirm"

interface RegistryProject {
  project_id: string
  name: string
  directory: string
  last_indexed_at: number
  closed_at: number | null
  size_bytes: number
}

interface RegistryInfo {
  retention_days: number
  projects: RegistryProject[]
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatDate(unixSeconds: number | null): string {
  if (!unixSeconds) return "—"
  const d = new Date(unixSeconds * 1000)
  return d.toLocaleString()
}

export const SettingsGraph: Component = () => {
  const language = useLanguage()
  const sl = useSmartLayer()

  const [registry, setRegistry] = createSignal<RegistryInfo | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [retentionDays, setRetentionDays] = createSignal("90")
  const [savingRetention, setSavingRetention] = createSignal(false)
  const [busyProject, setBusyProject] = createSignal<string | null>(null)
  const [clearingAll, setClearingAll] = createSignal(false)
  const [confirmClearAll, setConfirmClearAll] = createSignal(false)

  const fetchRegistry = async () => {
    const api = sl.api
    if (!api) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const data = await api.getIndexRegistry()
      setRegistry(data)
      setRetentionDays(String(data.retention_days ?? 90))
    } catch {
      showToast({ variant: "error", title: language.t("common.requestFailed") })
    } finally {
      setLoading(false)
    }
  }

  onMount(fetchRegistry)

  const handleSaveRetention = async () => {
    const api = sl.api
    if (!api) return
    const days = parseInt(retentionDays(), 10)
    if (isNaN(days) || days <= 0) {
      showToast({ variant: "error", title: language.t("settings.graph.invalidDays") })
      return
    }
    setSavingRetention(true)
    try {
      await api.setRetention(days)
      showToast({ variant: "success", title: language.t("settings.graph.retentionSaved") })
      await fetchRegistry()
    } catch (e: any) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: e?.message })
    } finally {
      setSavingRetention(false)
    }
  }

  // Scoped by directory: `project_id` is a backend-internal key, and every
  // graph endpoint addresses a project by path.
  const handleClearProject = async (directory: string) => {
    const api = sl.api
    if (!api) return
    setBusyProject(directory)
    try {
      await api.closeProjectIndex(directory, true)
      showToast({ variant: "success", title: language.t("settings.graph.clearedOne") })
      await fetchRegistry()
    } catch (e: any) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: e?.message })
    } finally {
      setBusyProject(null)
    }
  }

  const handleClearAll = async () => {
    const api = sl.api
    if (!api) return
    setClearingAll(true)
    setConfirmClearAll(false)
    try {
      const res = await api.clearAllIndexes()
      if (res.cleared) {
        showToast({ variant: "success", title: language.t("settings.graph.clearedAll") })
      } else {
        showToast({ variant: "error", title: language.t("settings.graph.clearAllFailed") })
      }
      await fetchRegistry()
    } catch (e: any) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: e?.message })
    } finally {
      setClearingAll(false)
    }
  }

  return (
    <SettingsPage
      title={language.t("settings.graph.title")}
      description={language.t("settings.graph.desc")}
    >

      <Show
        when={!loading() && !!sl.api}
        fallback={
          sl.api ? (
            <div class="text-13-regular text-text-weak">{language.t("common.loading.ellipsis")}</div>
          ) : (
            <div class="text-13-regular text-text-weak">{language.t("memory.stats.unavailable")}</div>
          )
        }
      >
        {/* Retention window */}
        <SettingsList>
          <div class="flex flex-col gap-4 py-3">
            <div class="flex flex-col gap-1">
              <div class="text-13-medium text-text-strong">
                {language.t("settings.graph.retentionDays")}
              </div>
              <div class="text-12-regular text-text-weak">
                {language.t("settings.graph.retentionDaysDesc")}
              </div>
            </div>
            <div class="flex items-end gap-3">
              <div class="flex flex-col gap-2 flex-1">
                <TextField
                  value={retentionDays()}
                  onChange={(v: string) => setRetentionDays(v)}
                  placeholder="90"
                  type="number"
                />
              </div>
              <Button
                size="small"
                variant="secondary"
                onClick={handleSaveRetention}
                disabled={savingRetention() || !retentionDays() || !sl.api}
              >
                {savingRetention()
                  ? language.t("common.loading.ellipsis")
                  : language.t("settings.graph.save")}
              </Button>
            </div>
          </div>
        </SettingsList>

        {/* Indexed projects list */}
        <SettingsList>
          <div class="flex flex-col gap-2 py-3">
            <div class="text-13-medium text-text-strong">
              {language.t("settings.graph.indexedProjects")}
            </div>
            <Show
              when={(registry()?.projects.length ?? 0) > 0}
              fallback={
                <div class="text-12-regular text-text-weak">
                  {language.t("settings.graph.noProjects")}
                </div>
              }
            >
              <div class="flex flex-col divide-y divide-border-base">
                <For each={registry()?.projects ?? []}>
                  {(p) => (
                    <div class="flex items-center justify-between gap-3 py-2">
                      <div class="flex flex-col gap-0.5 min-w-0">
                        <span class="text-13-regular text-text-strong truncate">{p.name}</span>
                        <span class="text-12-regular text-text-weak truncate">{p.project_id}</span>
                        <span class="text-12-regular text-text-weak">
                          {language.t("settings.graph.lastIndexed")}: {formatDate(p.last_indexed_at)}
                          {" · "}
                          {formatBytes(p.size_bytes)}
                        </span>
                        <span class="text-12-regular text-text-weak">
                          {p.closed_at
                            ? language.t("settings.graph.statusClosed")
                            : language.t("settings.graph.statusOpen")}
                        </span>
                      </div>
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={() => handleClearProject(p.directory)}
                        disabled={busyProject() !== null}
                      >
                        {busyProject() === p.directory
                          ? language.t("common.loading.ellipsis")
                          : language.t("settings.graph.clearOne")}
                      </Button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </SettingsList>

        {/* Clear all */}
        <SettingsList>
          <div class="flex flex-col gap-4 py-3">
            <div class="flex flex-col gap-1">
              <div class="text-13-medium text-text-strong">
                {language.t("settings.graph.clearAll")}
              </div>
              <div class="text-12-regular text-text-weak">
                {language.t("settings.graph.clearAllDesc")}
              </div>
            </div>
            <div class="flex justify-end">
              <Button
                size="small"
                variant="ghost"
                onClick={() => setConfirmClearAll(true)}
                disabled={clearingAll() || (registry()?.projects.length ?? 0) === 0 || !sl.api}
              >
                {language.t("settings.graph.clearAll")}
              </Button>
            </div>
          </div>
        </SettingsList>
      </Show>

      {/* Confirm clear-all dialog */}
      <Show when={confirmClearAll()}>
        <DialogConfirm
          title={language.t("settings.graph.clearAll")}
          danger
          busy={clearingAll()}
          message={language.t("settings.graph.clearAllConfirm")}
          onConfirm={handleClearAll}
          onCancel={() => setConfirmClearAll(false)}
        />
      </Show>
    </SettingsPage>
  )
}
