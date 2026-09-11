import { Component, Show, createSignal, onMount } from "solid-js"
import { useParams } from "@solidjs/router"
import { Button } from "@duoduo-ai/ui/button"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { TextField } from "@duoduo-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { useSmartLayer } from "@/addons/smart-layer/context"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { showToast } from "@duoduo-ai/ui/toast"
import { decode64 } from "@/utils/base64"
import { SettingsList } from "./settings-list"
import { SettingsPage } from "./settings-page"
import { DialogConfirm } from "./dialog-confirm"

interface StorageStats {
  memoryCount: number
  blackboardFiles: number
  blackboardSizeBytes: number
  backupFiles: number
  backupSizeBytes: number
  dbSizeBytes: number
  memoryFilesSizeBytes: number
  otherSizeBytes: number
  totalSizeBytes: number
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export const SettingsStorage: Component = () => {
  const language = useLanguage()
  const sl = useSmartLayer()
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const params = useParams()

  const [stats, setStats] = createSignal<StorageStats | null>(null)
  const [loading, setLoading] = createSignal(true)

  const [cleanupLoading, setCleanupLoading] = createSignal(false)
  const [deleteDays, setDeleteDays] = createSignal("30")
  const [pendingCount, setPendingCount] = createSignal<number | null>(null)
  const [countLoading, setCountLoading] = createSignal(false)
  const [deleteLoading, setDeleteLoading] = createSignal(false)

  const [projectDays, setProjectDays] = createSignal("0")
  const [projectCountLoading, setProjectCountLoading] = createSignal(false)
  const [projectDeleteLoading, setProjectDeleteLoading] = createSignal(false)

  const fetchStats = async () => {
    const api = sl.api
    if (!api) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const data = await api.get<StorageStats>("/storage/stats")
      setStats(data)
    } catch {
      showToast({ variant: "error", title: language.t("common.requestFailed") })
    } finally {
      setLoading(false)
    }
  }

  onMount(fetchStats)

  const handleCleanupBlackboard = async () => {
    const api = sl.api
    if (!api) return
    setCleanupLoading(true)
    try {
      const data = await api.post<{ deletedFiles: number; freedBytes: number }>("/storage/blackboard/cleanup")
      showToast({
        variant: "success",
        title: language.t("settings.storage.cleanedFiles", {
          count: data.deletedFiles ?? 0,
          size: formatBytes(data.freedBytes ?? 0),
        }),
      })
      await fetchStats()
    } catch (e: any) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: e?.message })
    } finally {
      setCleanupLoading(false)
    }
  }

  const handleCountBefore = async () => {
    const api = sl.api
    if (!api) return
    const days = parseInt(deleteDays(), 10)
    if (isNaN(days) || days <= 0) return
    setCountLoading(true)
    setPendingCount(null)
    try {
      const data = await api.get<{ count: number }>(`/memory/count-before/${days}`)
      setPendingCount(data.count ?? 0)
    } catch (e: any) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: e?.message })
    } finally {
      setCountLoading(false)
    }
  }

  const handleDeleteBefore = async () => {
    const api = sl.api
    if (!api) return
    const days = parseInt(deleteDays(), 10)
    if (isNaN(days) || days <= 0) return
    setDeleteLoading(true)
    try {
      const data = await api.del<{ deleted: number }>(`/memory/before/${days}`)
      showToast({
        variant: "success",
        title: language.t("settings.storage.deleted", { count: data.deleted ?? 0 }),
      })
      setPendingCount(null)
      await fetchStats()
    } catch (e: any) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: e?.message })
    } finally {
      setDeleteLoading(false)
    }
  }

  // 清理范围：后端 project 表中"最近项目"记录（即全局 sync 的 project 列表），
  // 当前正在打开的项目会被后端保护，不会删除。
  const [projectConfirmOpen, setProjectConfirmOpen] = createSignal(false)
  const [projectConfirmCount, setProjectConfirmCount] = createSignal(0)

  const currentWorktree = () => decode64(params.dir) || ""

  const handleCleanupProjects = () => {
    const days = parseInt(projectDays(), 10)
    if (isNaN(days) || days < 0) {
      showToast({ variant: "error", title: language.t("settings.storage.invalidDays") })
      return
    }
    const open = currentWorktree()
    // 数据源为全局"最近项目"列表（与首页完全一致），排除当前打开的项目。
    const removable = (globalSync.data.project ?? [])
      .map((p) => p.worktree)
      .filter((wt) => wt && wt !== open)
    setProjectConfirmCount(removable.length)
    setProjectConfirmOpen(true)
  }

  const handleProjectConfirmDelete = async () => {
    const client = sdk.client
    if (!client) return
    const days = parseInt(projectDays(), 10)
    const open = currentWorktree()
    const count = projectConfirmCount()
    setProjectDeleteLoading(true)
    setProjectConfirmOpen(false)
    try {
      // 清理后端 project 表中可删除的记录；当前打开的项目由后端自动保护，
      // 这里再把当前 worktree 显式加入保护集，双保险。
      await client.project.cleanup({ days, protectedWorktrees: open ? [open] : [] })
      // 删除后重新拉取项目列表，刷新全局"最近项目"记录（首页同步更新）。
      const list = (await client.project.list()).data ?? []
      globalSync.set("project", list)
      showToast({
        variant: "success",
        title: language.t("settings.storage.cleanupProjectsDeleted", {
          count,
        }),
      })
    } catch (e: any) {
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: e?.message })
    } finally {
      setProjectDeleteLoading(false)
    }
  }

  return (
    <SettingsPage
      title={language.t("settings.storage.title")}
      description={language.t("settings.storage.stats")}
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
        <SettingsList>
          <div class="flex flex-col gap-3 py-3">
            <div class="text-13-medium text-text-strong">{language.t("settings.storage.stats")}</div>

            <div class="flex items-center justify-between text-13-regular">
              <span class="text-text-base">{language.t("settings.storage.memoryCount")}</span>
              <span class="text-text-strong">{stats()?.memoryCount ?? 0}</span>
            </div>

            <div class="flex items-center justify-between text-13-regular">
              <span class="text-text-base">{language.t("settings.storage.blackboardFiles")}</span>
              <span class="text-text-strong">{stats()?.blackboardFiles ?? 0}</span>
            </div>

            <div class="flex items-center justify-between text-13-regular">
              <span class="text-text-base">{language.t("settings.storage.blackboardSize")}</span>
              <span class="text-text-strong">{formatBytes(stats()?.blackboardSizeBytes ?? 0)}</span>
            </div>

            <div class="flex items-center justify-between text-13-regular">
              <span class="text-text-base">{language.t("settings.storage.backupFiles")}</span>
              <span class="text-text-strong">{stats()?.backupFiles ?? 0}</span>
            </div>

            <div class="flex items-center justify-between text-13-regular">
              <span class="text-text-base">{language.t("settings.storage.backupSize")}</span>
              <span class="text-text-strong">{formatBytes(stats()?.backupSizeBytes ?? 0)}</span>
            </div>

            <div class="flex items-center justify-between text-13-regular">
              <span class="text-text-base">{language.t("settings.storage.dbSize")}</span>
              <span class="text-text-strong">{formatBytes(stats()?.dbSizeBytes ?? 0)}</span>
            </div>

            <div class="flex items-center justify-between text-13-regular">
              <span class="text-text-base">{language.t("settings.storage.memoryFiles")}</span>
              <span class="text-text-strong">{formatBytes(stats()?.memoryFilesSizeBytes ?? 0)}</span>
            </div>

            <div class="flex items-center justify-between text-13-regular">
              <span class="text-text-base">{language.t("settings.storage.otherFiles")}</span>
              <span class="text-text-strong">{formatBytes(stats()?.otherSizeBytes ?? 0)}</span>
            </div>

            <div class="flex items-center justify-between text-13-regular">
              <span class="text-text-base">{language.t("settings.storage.totalSize")}</span>
              <span class="text-text-strong">{formatBytes(stats()?.totalSizeBytes ?? 0)}</span>
            </div>
          </div>
        </SettingsList>
      </Show>

      <SettingsList>
        <div class="flex flex-col gap-4 py-3">
          <div class="flex flex-col gap-1">
            <div class="text-13-medium text-text-strong">{language.t("settings.storage.cleanupBlackboard")}</div>
            <div class="text-12-regular text-text-weak">{language.t("settings.storage.cleanupBlackboardDesc")}</div>
          </div>
          <div class="flex justify-end">
            <Button size="small" onClick={handleCleanupBlackboard} disabled={cleanupLoading() || !sl.api}>
              {cleanupLoading() ? language.t("common.loading.ellipsis") : language.t("settings.storage.cleanup")}
            </Button>
          </div>
        </div>
      </SettingsList>

      <SettingsList>
        <div class="flex flex-col gap-4 py-3">
          <div class="text-13-medium text-text-strong">{language.t("settings.storage.deleteOldMemories")}</div>
          <div class="text-12-regular text-text-weak">{language.t("settings.storage.deleteBeforeDays")}</div>

          <div class="flex items-center gap-3">
            <div class="flex flex-col gap-2 flex-1">
              <TextField
                value={deleteDays()}
                onChange={(v: string) => {
                  setDeleteDays(v)
                  setPendingCount(null)
                }}
                placeholder="30"
                type="number"
              />
            </div>
            <Button
              size="small"
              onClick={handleCountBefore}
              disabled={countLoading() || !deleteDays() || !sl.api}
            >
              {countLoading() ? language.t("common.loading.ellipsis") : language.t("common.confirm")}
            </Button>
          </div>

          <Show when={pendingCount() !== null}>
            <div class="text-13-regular text-text-base">
              {pendingCount()} {language.t("settings.storage.countBefore")}
            </div>
            <div class="flex justify-end">
              <Button
                size="small"
                variant="primary"
                onClick={handleDeleteBefore}
                disabled={deleteLoading() || pendingCount() === 0 || !sl.api}
              >
                {deleteLoading() ? language.t("common.loading.ellipsis") : language.t("settings.storage.confirmDelete")}
              </Button>
            </div>
          </Show>
        </div>
      </SettingsList>

      <SettingsList>
        <div class="flex flex-col gap-4 py-3">
          <div class="flex flex-col gap-1">
            <div class="text-13-medium text-text-strong">{language.t("settings.storage.cleanupProjects")}</div>
            <div class="text-12-regular text-text-weak">{language.t("settings.storage.cleanupProjectsDesc")}</div>
            <div class="text-12-regular text-text-warning mt-1">
              {language.t("settings.storage.cleanupProjectsTip")}
            </div>
          </div>

          <div class="flex items-center gap-3">
            <div class="flex flex-col gap-2 flex-1">
              <TextField
                value={projectDays()}
                onChange={(v: string) => setProjectDays(v)}
                placeholder="0"
                type="number"
              />
            </div>
            <Button
              size="small"
              onClick={handleCleanupProjects}
              disabled={projectCountLoading() || projectDeleteLoading() || !projectDays()}
            >
              {projectCountLoading() || projectDeleteLoading()
                ? language.t("common.loading.ellipsis")
                : language.t("settings.storage.confirmCleanup")}
            </Button>
          </div>
        </div>
      </SettingsList>

      <Show when={projectConfirmOpen()}>
        <DialogConfirm
          title={language.t("settings.storage.cleanupProjects")}
          danger
          busy={projectDeleteLoading()}
          confirmDisabled={projectConfirmCount() === 0}
          confirmLabel={language.t("settings.storage.confirmDelete")}
          message={
            projectConfirmCount() > 0
              ? language.t("settings.storage.cleanupProjectsConfirm", { count: projectConfirmCount() })
              : language.t("settings.storage.cleanupProjectsNone")
          }
          onConfirm={handleProjectConfirmDelete}
          onCancel={() => setProjectConfirmOpen(false)}
        />
      </Show>
    </SettingsPage>
  )
}
