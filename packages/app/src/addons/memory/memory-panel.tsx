/**
 * Memory Panel — sidebar panel for browsing and searching the smart layer memory system.
 *
 * Features:
 *   - Tab switcher: Search / Stats
 *   - Layer filter tabs (ephemeral / short-term / long-term)
 *   - Search input with results list
 *   - Memory stats overview
 *   - Graceful degradation when smart layer is disconnected
 */

import { Show, For, createEffect, createSignal } from "solid-js"
import { useMemory } from "./memory-context"
import { useSmartLayer } from "../smart-layer/context"
import { useLanguage } from "../../context/language"
import { DialogConfirm } from "@/components/dialog-confirm"
import { MEMORY_LAYERS } from "./types"
import type { MemorySearchResult } from "./types"
import { TextField } from "@duoduo-ai/ui/text-field"
import { Spinner } from "@duoduo-ai/ui/spinner"
import { ScrollView } from "@duoduo-ai/ui/scroll-view"
import { Icon } from "@duoduo-ai/ui/icon"
import { IconButton } from "@duoduo-ai/ui/icon-button"
import { Button } from "@duoduo-ai/ui/button"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { showToast } from "@duoduo-ai/ui/toast"

export function MemoryPanel() {
  const mem = useMemory()
  const sl = useSmartLayer()
  const language = useLanguage()

  // Auto-search when query changes (debounced by the user's typing speed)
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const q = mem.query
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
      if (q.trim()) mem.search(q)
      // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
      else mem.search("") // clears results
    }, 300)
  })

  return (
    <div data-component="memory-panel" class="flex flex-col h-full gap-2 p-3">
      {/* Tab Switcher */}
      <div class="flex gap-1 border-b border-border-weak-base pb-1">
        <button
          class={`px-2.5 py-1 text-xs rounded-sm transition-colors ${
            mem.activeTab === "search"
              ? "bg-background-stronger text-text-strong"
              : "text-text-weak hover:text-text-base"
          }`}
          onClick={() => mem.setActiveTab("search")}
          type="button"
        >
          {language.t("memory.tab.search")}
        </button>
        <button
          class={`px-2.5 py-1 text-xs rounded-sm transition-colors ${
            mem.activeTab === "profile"
              ? "bg-background-stronger text-text-strong"
              : "text-text-weak hover:text-text-base"
          }`}
          onClick={() => mem.setActiveTab("profile")}
          type="button"
        >
          {language.t("memory.tab.profile")}
        </button>
        <button
          class={`px-2.5 py-1 text-xs rounded-sm transition-colors ${
            mem.activeTab === "progressive"
              ? "bg-background-stronger text-text-strong"
              : "text-text-weak hover:text-text-base"
          }`}
          onClick={() => mem.setActiveTab("progressive")}
          type="button"
        >
          {language.t("memory.tab.progressive")}
        </button>
        <button
          class={`px-2.5 py-1 text-xs rounded-sm transition-colors ${
            mem.activeTab === "stats"
              ? "bg-background-stronger text-text-strong"
              : "text-text-weak hover:text-text-base"
          }`}
          onClick={() => mem.setActiveTab("stats")}
          type="button"
        >
          {language.t("memory.tab.stats")}
        </button>
      </div>

      {/* Disconnected state */}
      <Show when={!sl.connected}>
        <div class="flex flex-col items-center justify-center gap-2 py-8 text-text-weak">
          <span class="text-sm">{language.t("memory.disconnected")}</span>
          <button class="text-xs text-interactive-base hover:underline" onClick={() => sl.checkHealth()} type="button">
            {language.t("smartLayer.retry")}
          </button>
        </div>
      </Show>

      {/* Connected content */}
      <Show when={sl.connected}>
        <Show when={mem.activeTab === "search"}>
          <MemorySearchContent />
        </Show>
        <Show when={mem.activeTab === "profile"}>
          <ProfileContent />
        </Show>
        <Show when={mem.activeTab === "progressive"}>
          <ProgressiveContent />
        </Show>
        <Show when={mem.activeTab === "stats"}>
          <MemoryStatsContent />
        </Show>
      </Show>
    </div>
  )
}

// ─── Layer Tabs ───

function LayerTabs() {
  const mem = useMemory()
  const language = useLanguage()

  return (
    <div class="flex gap-0.5" data-component="memory-layer-tabs">
      <button
        class={`px-2 py-0.5 text-[11px] rounded-sm transition-colors ${
          mem.selectedLayer === undefined
            ? "bg-background-stronger text-text-strong"
            : "text-text-weak hover:text-text-base"
        }`}
        onClick={() => mem.setSelectedLayer(undefined)}
        type="button"
      >
        {language.t("memory.layer.all")}
      </button>
      <For each={MEMORY_LAYERS}>
        {(layer) => (
          <button
            class={`px-2 py-0.5 text-[11px] rounded-sm transition-colors ${
              mem.selectedLayer === layer.id
                ? "bg-background-stronger text-text-strong"
                : "text-text-weak hover:text-text-base"
            }`}
            onClick={() => mem.setSelectedLayer(layer.id)}
            type="button"
          >
            {language.t(layer.labelKey)}
          </button>
        )}
      </For>
    </div>
  )
}

// ─── Search Content ───

function MemorySearchContent() {
  const mem = useMemory()
  const language = useLanguage()

  const handleSearch = (value: string) => {
    mem.setQuery(value)
  }

  return (
    <div class="flex flex-col gap-2 flex-1 min-h-0">
      {/* Search Input */}
      <TextField
        placeholder={language.t("memory.search.placeholder")}
        value={mem.query}
        onInput={(e) => handleSearch(e.currentTarget.value)}
      />

      {/* Layer Filter */}
      <LayerTabs />

      {/* Loading */}
      <Show when={mem.searchLoading}>
        <div class="flex items-center justify-center py-4">
          <Spinner class="w-4 h-4" />
        </div>
      </Show>

      {/* Error */}
      <Show when={mem.searchError}>
        <div class="text-xs text-text-on-critical-base px-1">{mem.searchError}</div>
      </Show>

      {/* Results */}
      <Show when={!mem.searchLoading && mem.hasResults}>
        <ScrollView class="flex-1 min-h-0">
          <div class="flex flex-col gap-1.5">
            <For each={mem.results}>{(entry) => <MemoryEntryCard entry={entry} />}</For>
          </div>
        </ScrollView>
      </Show>

      {/* Empty State */}
      <Show when={!mem.searchLoading && !mem.hasResults && mem.query.trim()}>
        <div class="text-xs text-text-weak py-4 text-center">{language.t("memory.search.empty")}</div>
      </Show>

      {/* Initial State */}
      <Show when={!mem.searchLoading && !mem.hasResults && !mem.query.trim()}>
        <div class="text-xs text-text-weak py-4 text-center">{language.t("memory.search.hint")}</div>
      </Show>
    </div>
  )
}

// ─── Memory Entry Card ───

function MemoryEntryCard(props: { entry: MemorySearchResult }) {
  const language = useLanguage()
  const mem = useMemory()
  const dialog = useDialog()

  const [deleting, setDeleting] = createSignal(false)

  const layerLabel = () => {
    const layer = MEMORY_LAYERS.find((l) => l.id === props.entry.layer)
    return layer ? language.t(layer.labelKey) : `L${props.entry.layer}`
  }

  const truncatedContent = () => {
    const c = props.entry.content
    return c.length > 200 ? c.slice(0, 200) + "..." : c
  }

  const formattedDate = () => {
    try {
      return new Date(props.entry.created_at).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    } catch {
      return props.entry.created_at
    }
  }

  const scorePercent = () => {
    return Math.round(props.entry.score * 100)
  }

  const handleDelete = () => {
    dialog.show(() => (
      <DialogConfirmDeleteMemory
        id={props.entry.id}
        contentPreview={truncatedContent()}
        onConfirm={async () => {
          setDeleting(true)
          try {
            await mem.deleteMemory(props.entry.id)
            showToast({
              variant: "success",
              icon: "circle-check",
              title: language.t("memory.delete.success"),
            })
            // Re-search to remove the deleted entry from results
            // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
            mem.search(mem.query)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            showToast({ title: language.t("common.requestFailed"), description: message })
          } finally {
            setDeleting(false)
          }
        }}
      />
    ))
  }

  return (
    <div
      data-component="memory-entry"
      class="flex flex-col gap-1 p-2 rounded-sm bg-background-stronger hover:bg-background-strong transition-colors cursor-default"
    >
      {/* Header: layer + score + date + delete button */}
      <div class="flex items-center justify-between text-[10px] text-text-weak">
        <span class="flex items-center gap-1">
          <span class="px-1 py-0.5 rounded bg-background-base text-text-weak">{layerLabel()}</span>
          <Show when={props.entry.score > 0}>
            <span>{scorePercent()}%</span>
          </Show>
        </span>
        <span class="flex items-center gap-1">
          <span>{formattedDate()}</span>
          <IconButton
            icon="trash"
            size="small"
            variant="ghost"
            disabled={deleting()}
            onClick={handleDelete}
            aria-label={language.t("common.delete")}
          />
        </span>
      </div>

      {/* Content preview */}
      <p class="text-xs text-text-base leading-relaxed whitespace-pre-wrap break-words">{truncatedContent()}</p>

      {/* Tags */}
      <Show when={props.entry.tags.length > 0}>
        <div class="flex flex-wrap gap-0.5">
          <For each={props.entry.tags.slice(0, 5)}>
            {(tag) => <span class="px-1 py-0 rounded text-[10px] bg-background-base text-text-weak">{tag}</span>}
          </For>
        </div>
      </Show>
    </div>
  )
}

// ─── Confirm Dialog for deleting a single memory ───

function DialogConfirmDeleteMemory(props: { id: string; contentPreview: string; onConfirm: () => Promise<void> }) {
  const language = useLanguage()
  const dialog = useDialog()
  const [loading, setLoading] = createSignal(false)

  const handleConfirm = async () => {
    setLoading(true)
    try {
      await props.onConfirm()
    } finally {
      setLoading(false)
      dialog.close()
    }
  }

  return (
    <DialogConfirm
      title={language.t("common.delete")}
      danger
      busy={loading()}
      confirmLabel={language.t("common.delete")}
      message={language.t("memory.delete.confirm")}
      detail={props.contentPreview}
      onConfirm={handleConfirm}
      onCancel={() => dialog.close()}
    />
  )
}

// ─── Stats Content ───

function MemoryStatsContent() {
  const mem = useMemory()
  const language = useLanguage()
  const dialog = useDialog()

  const [clearing, setClearing] = createSignal(false)

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B"
    const k = 1024
    const sizes = ["B", "KB", "MB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
  }

  const layerStats = () => {
    const s = mem.stats
    if (!s) return []
    return MEMORY_LAYERS.map((layer) => {
      const ls = s.byLayer[String(layer.id)]
      return {
        ...layer,
        label: language.t(layer.labelKey),
        count: ls?.count ?? 0,
        avgImportance: ls?.avgImportance ?? 0,
        pinnedCount: ls?.pinnedCount ?? 0,
      }
    })
  }

  const handleClearLayer = (layerId: string, layerLabel: string) => {
    dialog.show(() => (
      <DialogConfirmClearMemory
        confirmMessage={language.t("memory.clear.confirm", { layer: layerLabel })}
        onConfirm={async () => {
          setClearing(true)
          try {
            const result = await mem.clearMemory(layerId)
            showToast({
              variant: "success",
              icon: "circle-check",
              title: language.t("memory.clear.success", { count: result.deleted }),
            })
            // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
            mem.refreshStats()
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            showToast({ title: language.t("common.requestFailed"), description: message })
          } finally {
            setClearing(false)
          }
        }}
      />
    ))
  }

  const handleClearAll = () => {
    dialog.show(() => (
      <DialogConfirmClearMemory
        confirmMessage={language.t("memory.clear.allConfirm")}
        onConfirm={async () => {
          setClearing(true)
          try {
            const result = await mem.clearMemory()
            showToast({
              variant: "success",
              icon: "circle-check",
              title: language.t("memory.clear.success", { count: result.deleted }),
            })
            // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
            mem.refreshStats()
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            showToast({ title: language.t("common.requestFailed"), description: message })
          } finally {
            setClearing(false)
          }
        }}
      />
    ))
  }

  return (
    <div class="flex flex-col gap-3">
      {/* Refresh button + Clear All button */}
      <div class="flex items-center justify-between">
        <span class="text-xs text-text-weak">{language.t("memory.stats.title")}</span>
        <div class="flex items-center gap-2">
          <button
            class="text-[11px] text-interactive-base hover:underline"
            onClick={() => mem.refreshStats()}
            disabled={mem.statsLoading}
            type="button"
          >
            {mem.statsLoading ? language.t("memory.stats.loading") : language.t("memory.stats.refresh")}
          </button>
        </div>
      </div>

      <Show when={mem.stats}>
        {(stats) => (
          <>
            {/* Overview */}
            <div class="grid grid-cols-2 gap-2">
              <div class="p-2 rounded bg-background-stronger">
                <div class="text-[10px] text-text-weak">{language.t("memory.stats.totalEntries")}</div>
                <div class="text-lg font-medium text-text-strong">{stats().totalEntries}</div>
              </div>
              <div class="p-2 rounded bg-background-stronger">
                <div class="text-[10px] text-text-weak">{language.t("memory.stats.storageSize")}</div>
                <div class="text-lg font-medium text-text-strong">{formatBytes(stats().storageSizeBytes)}</div>
              </div>
            </div>

            {/* Time span (v2) — shows how far back memory reaches */}
            <Show when={stats().oldestEntry || stats().newestEntry}>
              <div class="px-2 py-1 rounded bg-background-stronger text-xs flex justify-between">
                <span class="text-text-weak">{language.t("memory.stats.timeSpan")}</span>
                <span class="text-text-base">
                  {stats().oldestEntry
                    ? `${stats().oldestEntry!.slice(0, 10)} ~ ${stats().newestEntry?.slice(0, 10) ?? "?"}`
                    : (stats().newestEntry?.slice(0, 10) ?? "")}
                </span>
              </div>
            </Show>

            {/* Per-layer breakdown with clear buttons */}
            <div class="flex flex-col gap-1">
              <span class="text-[10px] text-text-weak">{language.t("memory.stats.byLayer")}</span>
              <For each={layerStats()}>
                {(item) => (
                  <div class="flex items-center justify-between px-2 py-1 rounded bg-background-stronger text-xs">
                    <span class="text-text-base">{item.label}</span>
                    <div class="flex items-center gap-2">
                      <span class="text-text-weak" title={language.t("memory.stats.avgImportance")}>
                        {item.count > 0 ? `⌀${item.avgImportance.toFixed(2)}` : ""}
                      </span>
                      <span class="text-text-weak" title={language.t("memory.stats.pinned")}>
                        {item.pinnedCount > 0 ? `📌${item.pinnedCount}` : ""}
                      </span>
                      <span class="text-text-strong">{item.count}</span>
                      <Show when={item.count > 0}>
                        <button
                          class="text-[10px] text-text-on-critical-weak hover:text-text-on-critical-base hover:underline"
                          onClick={() => handleClearLayer(item.id, item.label)}
                          disabled={clearing()}
                          type="button"
                        >
                          {language.t("memory.clear.button")}
                        </button>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>

            {/* Clear All button */}
            <Show when={stats().totalEntries > 0}>
              <div class="flex justify-end">
                <Button variant="secondary" size="small" icon="trash" disabled={clearing()} onClick={handleClearAll}>
                  {language.t("memory.clear.allButton")}
                </Button>
              </div>
            </Show>
          </>
        )}
      </Show>

      <Show when={!mem.stats && !mem.statsLoading}>
        <div class="text-xs text-text-weak py-4 text-center">{language.t("memory.stats.unavailable")}</div>
      </Show>
    </div>
  )
}

// ─── Confirm Dialog for clearing memories ───

function DialogConfirmClearMemory(props: { confirmMessage: string; onConfirm: () => Promise<void> }) {
  const language = useLanguage()
  const dialog = useDialog()
  const [loading, setLoading] = createSignal(false)

  const handleConfirm = async () => {
    setLoading(true)
    try {
      await props.onConfirm()
    } finally {
      setLoading(false)
      dialog.close()
    }
  }

  return (
    <DialogConfirm
      title={language.t("cache.clear.title")}
      danger
      busy={loading()}
      confirmLabel={language.t("memory.clear.button")}
      message={props.confirmMessage}
      onConfirm={handleConfirm}
      onCancel={() => dialog.close()}
    />
  )
}

// ─── L4 Profile Content ───

function ProfileContent() {
  const sl = useSmartLayer()
  const language = useLanguage()
  const [profiles, setProfiles] = createSignal<any[]>([])
  const [loading, setLoading] = createSignal(false)

  const loadProfiles = async () => {
    if (!sl.api) return
    setLoading(true)
    try {
      // Fetch L4 profile entries via the profile API
      const result = await sl.api.get<any[]>("/memory/profile?user_id=default")
      setProfiles(result)
    } catch {
      setProfiles([])
      showToast({ variant: "error", title: language.t("memory.profile.loadFailed") })
    } finally {
      setLoading(false)
    }
  }

  // Load on mount
  createEffect(() => {
    // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
    if (sl.connected) loadProfiles()
  })

  const categoryLabel = (cat: string) => {
    switch (cat) {
      case "profile":
        return language.t("memory.profile.category.profile")
      case "preference":
        return language.t("memory.profile.category.preference")
      case "declaration":
        return language.t("memory.profile.category.declaration")
      default:
        return cat
    }
  }

  return (
    <div class="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto">
      <Show when={loading()}>
        <div class="text-xs text-text-weak text-center py-4">{language.t("memory.profile.loading")}</div>
      </Show>
      <Show when={!loading() && profiles().length === 0}>
        <div class="text-xs text-text-weak text-center py-4">{language.t("memory.profile.empty")}</div>
      </Show>
      <Show when={!loading() && profiles().length > 0}>
        <For each={profiles()}>
          {(entry: any) => (
            <div class="flex flex-col gap-1 p-2 rounded-sm bg-background-stronger text-xs">
              <div class="flex items-center justify-between">
                <span class="px-1 py-0.5 rounded bg-background-base text-text-weak text-[10px]">
                  {categoryLabel(entry.category || "profile")}
                </span>
                <span class="text-[10px] text-text-weak">{entry.id?.slice(0, 8)}</span>
              </div>
              <div class="text-text-base whitespace-pre-wrap">{entry.content}</div>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

// ─── L5 Progressive Content ───

function ProgressiveContent() {
  const sl = useSmartLayer()
  const language = useLanguage()
  const [patterns, setPatterns] = createSignal<any[]>([])
  const [loading, setLoading] = createSignal(false)

  const loadPatterns = async () => {
    if (!sl.api) return
    setLoading(true)
    try {
      // Wire format is camelCase (`PatternQueryRequest` has
      // `rename_all = "camelCase"`); the old `user_id` key was dropped and the
      // endpoint 400'd on the missing required `userId`, so this tab was
      // permanently empty (P2-08).
      const result = await sl.api.post<{ patterns: any[] }>("/memory/patterns/query", {
        userId: "default",
        limit: 50,
        offset: 0,
      })
      setPatterns(result.patterns || [])
    } catch {
      setPatterns([])
      showToast({ variant: "error", title: language.t("memory.patterns.loadFailed") })
    } finally {
      setLoading(false)
    }
  }

  // Load on mount
  createEffect(() => {
    // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
    if (sl.connected) loadPatterns()
  })

  const patternTypeLabel = (pt: string) => {
    switch (pt) {
      case "deixis":
        return language.t("memory.progressive.type.deixis")
      case "command_pref":
        return language.t("memory.progressive.type.commandPref")
      case "sequence":
        return language.t("memory.progressive.type.sequence")
      default:
        return pt
    }
  }

  // Group patterns by patternType (wire format is camelCase — PatternEntry)
  const groupedPatterns = () => {
    const groups: Record<string, any[]> = {}
    for (const p of patterns()) {
      const key = p.patternType || "other"
      if (!groups[key]) groups[key] = []
      groups[key].push(p)
    }
    return groups
  }

  return (
    <div class="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto">
      <Show when={loading()}>
        <div class="text-xs text-text-weak text-center py-4">{language.t("memory.progressive.loading")}</div>
      </Show>
      <Show when={!loading() && patterns().length === 0}>
        <div class="text-xs text-text-weak text-center py-4">{language.t("memory.progressive.empty")}</div>
      </Show>
      <Show when={!loading() && patterns().length > 0}>
        <For each={Object.entries(groupedPatterns())}>
          {([type, items]: [string, any[]]) => (
            <div class="flex flex-col gap-1">
              <div class="text-[11px] text-text-weak font-medium px-1">
                {patternTypeLabel(type)} ({items.length})
              </div>
              <For each={items}>
                {(entry: any) => (
                  <div class="flex flex-col gap-1 p-2 rounded-sm bg-background-stronger text-xs">
                    <div class="flex items-center justify-between">
                      <span class="text-text-base">{entry.patternKey}</span>
                      <span class="text-[10px] text-text-weak">×{entry.sampleCount}</span>
                    </div>
                    <div class="text-text-weak">→ {entry.preferredValue}</div>
                    <div class="flex items-center gap-1">
                      <div class="flex-1 h-1 rounded bg-background-base overflow-hidden">
                        <div
                          class="h-full rounded bg-interactive-base"
                          style={{ width: `${Math.round((entry.confidence || 0) * 100)}%` }}
                        />
                      </div>
                      <span class="text-[10px] text-text-weak">{((entry.confidence || 0) * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}
