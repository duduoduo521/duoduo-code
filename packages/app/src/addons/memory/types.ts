/**
 * Memory UI Types — type definitions for the memory panel and related components.
 */

import type { MemoryStats } from "../smart-layer/types"

export type { MemoryStats } from "../smart-layer/types"

export interface MemorySearchResult {
  id: string
  content: string
  layer: string
  score: number
  created_at: string
  tags: string[]
  metadata?: unknown
  project_path?: string
  importance?: number
  pin?: boolean
  compressed?: boolean
  session_id?: string
  memory_type?: string
  updated_at?: string
}

/** Memory layers used in the UI tab system — 6-layer architecture (L0-L5) */
export const MEMORY_LAYERS = [
  { id: "ephemeral", labelKey: "memory.layer.ephemeral", descriptionKey: "memory.layer.ephemeral.description" },
  { id: "episode", labelKey: "memory.layer.episode", descriptionKey: "memory.layer.episode.description" },
  { id: "semantic", labelKey: "memory.layer.semantic", descriptionKey: "memory.layer.semantic.description" },
  { id: "permanent", labelKey: "memory.layer.permanent", descriptionKey: "memory.layer.permanent.description" },
  { id: "profile", labelKey: "memory.layer.profile", descriptionKey: "memory.layer.profile.description" },
  { id: "progressive", labelKey: "memory.layer.progressive", descriptionKey: "memory.layer.progressive.description" },
] as const

export type MemoryLayerId = (typeof MEMORY_LAYERS)[number]["id"]

/** State for the memory search UI */
export interface MemorySearchState {
  query: string
  selectedLayer: MemoryLayerId | undefined
  results: MemorySearchResult[]
  loading: boolean
  error: string | null
}

/** State for the memory panel overall */
export interface MemoryPanelState {
  activeTab: "search" | "profile" | "progressive" | "stats"
  search: MemorySearchState
  stats: MemoryStats | null
  statsLoading: boolean
}
