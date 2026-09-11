import { Component, For, Show, createEffect, createResource, createSignal, onMount, onCleanup } from "solid-js"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { Button } from "@duoduo-ai/ui/button"
import { Icon } from "@duoduo-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useSmartLayer } from "@/addons/smart-layer/context"

export const DialogGraph: Component<{ directory?: string }> = (props) => {
  const language = useLanguage()
  const sl = useSmartLayer()

  const fetchStats = async (directory: string | undefined) => {
    const client = sl.api
    if (!client) return null
    try {
      return await client.graphStatsDetail(directory)
    } catch {
      return null
    }
  }

  const fetchRecentFiles = async (directory: string | undefined) => {
    const client = sl.api
    if (!client) return { files: [] }
    try {
      return await client.getRecentFiles(directory)
    } catch {
      return { files: [] }
    }
  }

  // Use props.directory as the reactive source so the resource re-fetches
  // when the user switches projects.
  const [stats, { refetch: refetchStats }] = createResource(
    () => props.directory,
    fetchStats,
  )
  const [recentFiles, { refetch: refetchRecent }] = createResource(
    () => props.directory,
    fetchRecentFiles,
  )

  // Per-project indexing status, polled so the progress bar reflects the
  // project this dialog was opened for (even while another project indexes
  // in the background). This replaces the old global isKGIndexing signal.
  const fetchStatus = async (directory: string | undefined) => {
    const client = sl.api
    if (!client) return null
    try {
      return await client.getIndexStatus(directory)
    } catch {
      return null
    }
  }
  const [status, { refetch: refetchStatus }] = createResource(
    () => props.directory,
    fetchStatus,
  )

  // Refresh stats when KG indexing completes (e.g., after reindex)
  onMount(() => {
    const unsubscribe = sl.onIndexComplete(() => {
      // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
      refetchStats()
      // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
      refetchRecent()
      void fetchFailedFiles()
    })
    // Poll status + failed files every second while the dialog is open.
    const timer = setInterval(() => {
      // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
      refetchStatus()
      void fetchFailedFiles()
    }, 1000)
    // Also fetch on initial mount
    void fetchFailedFiles()
    onCleanup(() => {
      clearInterval(timer)
      unsubscribe()
    })
  })

  const handleReindex = () => {
    // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
    if (props.directory) sl.reindexProject(props.directory)
  }

  const handleCancel = () => {
    void sl.api?.cancelIndex(props.directory)
  }

  const [failedFiles, setFailedFiles] = createSignal<Array<{ path: string; error: string }>>([])

  const fetchFailedFiles = async () => {
    const client = sl.api
    if (!client) return
    try {
      const result = await client.getFailedFiles(props.directory)
      setFailedFiles(result.files ?? [])
    } catch {
      setFailedFiles([])
    }
  }

  // Derived per-project indexing flags.
  const isIndexing = () => status()?.status === "indexing"
  const isReady = () => status()?.status === "ready"
  const isFailed = () => status()?.status === "failed"
  const progressPct = () => {
    const s = status()
    return s && s.status === "indexing" ? s.progress : 0
  }

  // Refresh stats / recent / failed files when THIS dialog's project finishes
  // indexing. Relying solely on the global `sl.onIndexComplete` is unreliable
  // here because that callback reflects the *active* project's status poll
  // (context.tsx applyKGStatus), so a kanban opened for a non-active project
  // would keep showing stale data until reopened. Detecting the indexing→ready
  // (or failed) transition locally makes the refresh work for any project.
  let prevIndexStatus: string | undefined
  createEffect(() => {
    const current = status()?.status
    if (
      current &&
      prevIndexStatus === "indexing" &&
      (current === "ready" || current === "failed")
    ) {
      // oxlint-disable-next-line no-floating-promises -- fire-and-forget UI refresh
      refetchStats()
      // oxlint-disable-next-line no-floating-promises -- fire-and-forget UI refresh
      refetchRecent()
      void fetchFailedFiles()
    }
    prevIndexStatus = current
  })

  const retryFile = async (filePath: string) => {
    const client = sl.api
    if (!client) return
    try {
      const result = await client.retryFile(props.directory ?? "", filePath)
      if (result.ok) {
        setFailedFiles((prev) => prev.filter((f) => f.path !== filePath))
        // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
        refetchStats()
        // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
        refetchRecent()
      }
    } catch {
      // silently ignore
    }
  }

  const distributionMax = (dist: Record<string, number> | undefined) => {
    if (!dist) return 1
    const vals = Object.values(dist)
    return vals.length ? vals.reduce((a, b) => (a > b ? a : b), 1) : 1
  }

  return (
    <Dialog size="x-large" title={language.t("graphKanban.title")} transition>
      <div class="flex flex-col gap-6 p-6 overflow-y-auto" style={{ "max-height": "min(80vh, 800px)" }}>
        {/* ── Overview Stats ── */}
        <div class="grid grid-cols-4 gap-3">
          <StatCard label={language.t("graphKanban.stat.nodeCount")} value={isIndexing() && stats()?.nodeCount === 0 ? "—" : (stats()?.nodeCount ?? "—")} />
          <StatCard label={language.t("graphKanban.stat.edgeCount")} value={isIndexing() && stats()?.edgeCount === 0 ? "—" : (stats()?.edgeCount ?? "—")} />
          <StatCard label={language.t("graphKanban.stat.indexedFiles")} value={isIndexing() && stats()?.indexedFileCount === 0 ? "—" : (stats()?.indexedFileCount ?? "—")} />
          <StatCard
            label={language.t("graphKanban.stat.persistent")}
            value={
              stats()?.persistent ? language.t("graphKanban.persistent.yes") : language.t("graphKanban.persistent.no")
            }
          />
        </div>

        {/* ── Index Status ── */}
        <section class="flex flex-col gap-2">
          <h3 class="text-13-semibold text-text-strong">{language.t("graphKanban.indexStatus.title")}</h3>
          <div class="flex items-center gap-3">
            <Show
              when={isIndexing()}
              fallback={
                <Show
                  when={isReady()}
                  fallback={
                    <Show
                      when={isFailed()}
                      fallback={
                        <span class="text-12-regular px-2 py-0.5 rounded bg-accent/10 text-accent">
                          {language.t("graphKanban.indexStatus.idle")}
                        </span>
                      }
                    >
                      <span class="text-12-regular px-2 py-0.5 rounded bg-red-500/10 text-red-600">
                        {language.t("graphKanban.indexStatus.failedStatus")}
                      </span>
                    </Show>
                  }
                >
                  <span class="text-12-regular px-2 py-0.5 rounded bg-green-500/10 text-green-600">
                    {language.t("graphKanban.indexStatus.ready")}
                  </span>
                </Show>
              }
            >
              <span class="text-12-regular px-2 py-0.5 rounded bg-yellow-500/10 text-yellow-600">
                {language.t("graphKanban.indexStatus.indexing")}
              </span>
            </Show>
            <Show when={isIndexing()}>
              <div class="flex items-center gap-2 flex-1">
                <div
                  class="flex-1 h-2 rounded-full overflow-hidden"
                  style={{ background: "var(--border-weak-base)" }}
                >
                  <div
                    class="h-full rounded-full"
                    style={{
                      width: `${progressPct()}%`,
                      background: "var(--border-active)",
                      "transition": "width 0.3s ease",
                    }}
                  />
                </div>
                <span class="text-12-regular text-text-weak">{progressPct()}%</span>
              </div>
            </Show>
            <div class="flex gap-2 ml-auto">
              <Show when={isIndexing()}>
                <Button variant="ghost" size="small" onClick={handleCancel}>
                  {language.t("graphKanban.indexStatus.cancel")}
                </Button>
              </Show>
              <Show when={!isIndexing()}>
                <Button variant="secondary" size="small" onClick={handleReindex}>
                  {isReady()
                    ? language.t("graphKanban.indexStatus.reindex")
                    : language.t("graphKanban.indexStatus.startIndex")}
                </Button>
              </Show>
            </div>
          </div>
        </section>

        {/* ── Failed Files ── */}
        <Show when={failedFiles().length > 0}>
          <section class="flex flex-col gap-2">
            <h3 class="text-13-semibold text-text-weak">
              {language.t("graphKanban.indexStatus.failed", { count: failedFiles().length })}
            </h3>
            <div class="flex flex-col gap-1">
              <For each={failedFiles()}>
                {(f) => (
                  <div class="flex items-center gap-2 text-12-regular">
                    <span class="text-text-weak truncate flex-1" title={f.error}>{f.path}</span>
                    <span class="text-red-500 shrink-0">{f.error}</span>
                    <Button variant="ghost" size="small" onClick={() => retryFile(f.path)}>
                      {language.t("graphKanban.indexStatus.retryFile")}
                    </Button>
                  </div>
                )}
              </For>
            </div>
          </section>
        </Show>

        {/* ── Entity Type Distribution ── */}
        <section class="flex flex-col gap-2">
          <h3 class="text-13-semibold text-text-strong">{language.t("graphKanban.nodeTypeDistribution")}</h3>
          <Show
            when={stats()?.nodeTypeDistribution && Object.keys(stats()!.nodeTypeDistribution).length > 0}
            fallback={<p class="text-12-regular text-text-weak">{language.t("graphKanban.distribution.empty")}</p>}
          >
            <div class="flex flex-col gap-1.5">
              <For each={stats()?.nodeTypeDistribution ? Object.entries(stats()!.nodeTypeDistribution) : []}>
                {([type, count]) => (
                  <BarRow label={type} count={count} max={distributionMax(stats()?.nodeTypeDistribution)} />
                )}
              </For>
            </div>
          </Show>
        </section>

        {/* ── Relation Type Distribution ── */}
        <section class="flex flex-col gap-2">
          <h3 class="text-13-semibold text-text-strong">{language.t("graphKanban.relationTypeDistribution")}</h3>
          <Show
            when={stats()?.relationTypeDistribution && Object.keys(stats()!.relationTypeDistribution).length > 0}
            fallback={<p class="text-12-regular text-text-weak">{language.t("graphKanban.distribution.empty")}</p>}
          >
            <div class="flex flex-col gap-1.5">
              <For each={stats()?.relationTypeDistribution ? Object.entries(stats()!.relationTypeDistribution) : []}>
                {([type, count]) => (
                  <BarRow label={type} count={count} max={distributionMax(stats()?.relationTypeDistribution)} />
                )}
              </For>
            </div>
          </Show>
        </section>

        {/* ── Recently Indexed Files ── */}
        <section class="flex flex-col gap-2">
          <h3 class="text-13-semibold text-text-strong">{language.t("graphKanban.recentFiles.title")}</h3>
          <Show
            when={recentFiles()?.files?.length}
            fallback={<p class="text-12-regular text-text-weak">{language.t("graphKanban.recentFiles.empty")}</p>}
          >
            <div class="border border-border-weak-base rounded-md overflow-hidden">
              <table class="w-full text-12-regular">
                <thead>
                  <tr class="bg-background-stronger text-text-weak">
                    <th class="text-left px-3 py-1.5 font-medium">{language.t("graphKanban.recentFiles.path")}</th>
                    <th class="text-right px-3 py-1.5 font-medium">
                      {language.t("graphKanban.recentFiles.entityCount")}
                    </th>
                    <th class="text-right px-3 py-1.5 font-medium">
                      {language.t("graphKanban.recentFiles.indexedAt")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <For each={recentFiles()?.files ?? []}>
                    {(file) => (
                      <tr class="border-t border-border-weaker-base">
                        <td class="px-3 py-1.5 truncate max-w-xs" title={file.path}>
                          {file.path}
                        </td>
                        <td class="text-right px-3 py-1.5">{file.entityCount}</td>
                        <td class="text-right px-3 py-1.5 text-text-weak">{file.indexedAt}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </section>
      </div>
    </Dialog>
  )
}

function StatCard(props: { label: string; value: string | number }) {
  return (
    <div class="flex flex-col gap-1 p-3 rounded-md border border-border-weak-base bg-background-base">
      <span class="text-11-regular text-text-weak">{props.label}</span>
      <span class="text-18-semibold text-text-strong">{props.value}</span>
    </div>
  )
}

function BarRow(props: { label: string; count: number; max: number }) {
  const pct = () => (props.max ? (props.count / props.max) * 100 : 0)
  return (
    <div class="flex items-center gap-2">
      <span class="text-12-regular text-text-base w-28 truncate shrink-0" title={props.label}>
        {props.label}
      </span>
      <div class="flex-1 h-4 rounded-sm bg-background-stronger overflow-hidden">
        <div class="h-full bg-accent/60 rounded-sm transition-all" style={{ width: `${pct()}%` }} />
      </div>
      <span class="text-12-regular text-text-weak w-10 text-right shrink-0">{props.count}</span>
    </div>
  )
}
