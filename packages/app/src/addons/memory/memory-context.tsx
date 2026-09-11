/**
 * Memory Context — provides reactive access to the smart layer memory system.
 *
 * Manages search queries, layer selection, and memory stats.
 * Uses createSimpleContext pattern consistent with the rest of the app.
 *
 * Usage:
 *   const mem = useMemory()
 *   mem.search("auth bug")       // trigger a memory search
 *   mem.results                  // reactive search results
 *   mem.stats                    // reactive memory statistics
 */

import { createSimpleContext } from "@duoduo-ai/ui/context"
import { createSignal, createMemo, createEffect } from "solid-js"
import { useSmartLayer } from "../smart-layer/context"
import type { MemorySearchResult, MemoryStats, MemoryLayerId } from "./types"

/**
 * Builds the memory context value.
 *
 * Extracted out of the provider so unit tests can drive this real
 * implementation with a stubbed smart-layer client, instead of exercising a
 * re-implemented copy that silently drifts from production.
 */
export function createMemoryContext(sl: ReturnType<typeof useSmartLayer>) {
  // ─── Search State ───

  const [query, setQuery] = createSignal("")
  const [selectedLayer, setSelectedLayer] = createSignal<MemoryLayerId | undefined>(undefined)
  const [results, setResults] = createSignal<MemorySearchResult[]>([])
  const [searchLoading, setSearchLoading] = createSignal(false)
  const [searchError, setSearchError] = createSignal<string | null>(null)

  // ─── Stats State ───

  const [stats, setStats] = createSignal<MemoryStats | null>(null)
  const [statsLoading, setStatsLoading] = createSignal(false)

  // ─── Active Tab ───

  const [activeTab, setActiveTab] = createSignal<"search" | "profile" | "progressive" | "stats">("search")

  // ─── Search ───

  // P2-12: monotonically increasing request token. Only the response of the
  // LATEST issued search may touch the signals — a slow earlier response
  // arriving late must be discarded, otherwise it overwrites the results of
  // the query the user is actually looking at.
  let searchSeq = 0

  const search = async (searchQuery?: string) => {
    const q = searchQuery ?? query()
    if (!q.trim()) {
      searchSeq++ // invalidate any in-flight search
      setResults([])
      return
    }

    if (!sl.api) {
      setSearchError("Smart layer not connected")
      return
    }

    const seq = ++searchSeq
    setSearchLoading(true)
    setSearchError(null)

    try {
      const layers = selectedLayer() !== undefined ? [selectedLayer()!] : undefined
      const searchResults = await sl.api.searchMemory(q, 20, layers)
      if (seq !== searchSeq) return // a newer search (or a clear) superseded this one
      setResults(searchResults)
    } catch (e) {
      if (seq !== searchSeq) return
      setSearchError(e instanceof Error ? e.message : "Search failed")
      setResults([])
    } finally {
      if (seq === searchSeq) setSearchLoading(false)
    }
  }

  // ─── Store ───

  const store = async (content: string, layer: string, tags?: string[]) => {
    if (!sl.api) throw new Error("Smart layer not connected")
    return sl.api.storeMemory(content, layer, tags)
  }

  // ─── Delete ───

  const deleteMemory = async (id: string) => {
    if (!sl.api) throw new Error("Smart layer not connected")
    const result = await sl.api.deleteMemory(id)
    // Refresh stats after deletion
    // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
    refreshStats()
    return result
  }

  const clearMemory = async (layer?: string) => {
    if (!sl.api) throw new Error("Smart layer not connected")
    const result = await sl.api.clearMemory(layer)
    // Refresh stats after clearing
    // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
    refreshStats()
    return result
  }

  // ─── Refresh Stats ───

  const refreshStats = async () => {
    if (!sl.api) return

    setStatsLoading(true)
    try {
      const result = await sl.api.memoryStats()
      setStats(result)
    } catch {
      // Stats fetch failure is non-critical
    } finally {
      setStatsLoading(false)
    }
  }

  // Reactively refresh stats when smart layer connects
  // (onMount won't work if smart layer isn't connected yet at mount time)
  createEffect(() => {
    // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
    if (sl.connected) refreshStats()
  })

  // ─── Derived State ───

  const hasResults = createMemo(() => results().length > 0)
  const totalEntries = createMemo(() => stats()?.totalEntries ?? 0)

  return {
    // Search
    get query() {
      return query()
    },
    setQuery,
    get selectedLayer() {
      return selectedLayer()
    },
    setSelectedLayer,
    get results() {
      return results()
    },
    get searchLoading() {
      return searchLoading()
    },
    get searchError() {
      return searchError()
    },
    search,
    hasResults,

    // Store
    store,

    // Delete
    deleteMemory,
    clearMemory,

    // Stats
    get stats() {
      return stats()
    },
    get statsLoading() {
      return statsLoading()
    },
    refreshStats,
    totalEntries,

    // Tab
    get activeTab() {
      return activeTab()
    },
    setActiveTab,
  }
}

// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const { use: useMemory, provider: MemoryProvider } = createSimpleContext({
  name: "Memory",
  gate: false,
  init: () => createMemoryContext(useSmartLayer()),
})
