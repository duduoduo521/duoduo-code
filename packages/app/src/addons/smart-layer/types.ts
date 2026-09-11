/**
 * Smart Layer UI Types — shared type definitions for all smart layer UI addon modules.
 *
 * These types mirror the Rust duo-types and the TS client types in
 * packages/duoduo/src/smart-layer/types.ts, but are tailored for
 * the UI layer (e.g., using Accessors for reactive state).
 */

// ─── Connection Status ───

export type SmartLayerConnectionStatus = "connected" | "disconnected" | "checking"

// ─── Memory ───

export interface MemoryEntry {
  id: string
  content: string
  summary?: string
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

/** Wire format of `MemoryStatsV2` (duo-types/src/memory.rs, `rename_all = "camelCase"`). */
export interface MemoryStats {
  totalEntries: number
  byLayer: Record<string, LayerStats>
  storageSizeBytes: number
  schemaVersion: string
  oldestEntry: string | null
  newestEntry: string | null
}

export interface LayerStats {
  count: number
  avgImportance: number
  pinnedCount: number
  /** Legacy field — always 0 since consolidation was removed. Never rendered. */
  compressedCount: number
}

export { MEMORY_LAYERS } from "../memory/types"
export type { MemoryLayerId } from "../memory/types"

// ─── Quality ───

export interface QualityCheck {
  name: string
  passed: boolean
  score: number
}

export interface QualityReport {
  passed: boolean
  score: number
  checks: QualityCheck[]
  suggestions: string[]
}

// ─── Knowledge Graph Indexing ───

export interface KGIndexProgress {
  /** 0–100 percentage */
  progress: number
  filesDone?: number
  filesTotal?: number
}

export type KGIndexStatus =
  | { status: "idle" }
  | { status: "indexing"; progress: number; files_done?: number; files_total?: number }
  | { status: "ready" }
  | { status: "failed"; reason?: string }

// ─── Intent ───

export interface Entity {
  name: string
  value: string
}

export interface Ambiguity {
  question: string
  options: string[]
}

export type SuggestedMode = "Chat" | "Agent"

export interface ClarificationResult {
  intentType: string
  confidence: number
  entities: Entity[]
  ambiguities: Ambiguity[]
  suggestedMode: SuggestedMode
}

export interface GraphStatsDetail {
  nodeCount: number
  edgeCount: number
  indexedFileCount: number
  persistent: boolean
  nodeTypeDistribution: Record<string, number>
  relationTypeDistribution: Record<string, number>
}

export interface RecentFile {
  path: string
  entityCount: number
  indexedAt: string
}
