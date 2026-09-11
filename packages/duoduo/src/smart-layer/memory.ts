import { SmartLayerClient } from "./client"

/**
 * Wire format of `MemoryEntry` (duo-types/src/memory.rs, `rename_all =
 * "camelCase"`). All snake_case fields previously declared here never matched
 * the actual payload — e.g. `h.session_id === sessionID` was always false,
 * silently killing in-session memory recall (P1-12).
 */
export interface MemorySearchResult {
  id: string
  content: string
  layer: string
  score: number
  createdAt: string
  tags: string[]
  metadata?: unknown
  projectPath?: string
  importance?: number
  pin?: boolean
  compressed?: boolean
  sessionId?: string
  memoryType?: string
  updatedAt?: string
}

export interface MemoryStoreResult {
  id: string
  stored: boolean
}

export interface MemoryDeleteResult {
  deleted: number
  vacuumed: boolean
}

export interface CoreMemoryEntry {
  id: string
  userId: string
  projectId: string
  content: string
  category: string
  metadata: unknown
  createdAt: string
  updatedAt?: string
}

export interface PatternEntry {
  id: number
  userId: string
  projectId: string
  patternType: string
  patternKey: string
  preferredValue: string
  confidence: number
  sampleCount: number
  lastUsed: string
  createdAt: string
}

export interface PatternQueryResult {
  patterns: PatternEntry[]
  total: number
}

/**
 * MemoryClient provides typed access to the duo-smart-layer memory system API.
 *
 * Memory is organized in 6 layers (L0-L5):
 *   - L0: Ephemeral (context assembly, never persisted)
 *   - L1: Episode (short-term memory)
 *   - L2: Semantic (importance ≥ 0.4)
 *   - L3: Permanent (importance ≥ 0.8 or pinned)
 *   - L4: Profile (user profile, core_memories table)
 *   - L5: Progressive (user patterns, user_patterns table)
 *
 * ## Wire-format note (P1-11)
 * Every POST/PUT/DELETE-JSON handler on the Rust side deserializes into a
 * struct marked `#[serde(rename_all = "camelCase")]`, and unknown fields are
 * silently ignored — snake_case keys therefore vanish without any error
 * (`projectPath` lost ⇒ project isolation off; `dryRun` lost ⇒ "preview"
 * writes the DB; missing `userId` ⇒ 400). Request bodies below therefore send
 * camelCase. GET/DELETE **query** parameters are different: those structs have
 * no `rename_all`, so they stay snake_case (`user_id`, `project_id`, …).
 */
export class MemoryClient {
  constructor(private client: SmartLayerClient) {}

  /**
   * Search memory entries by query string.
   * Returns matching entries ranked by relevance score.
   */
  async search(
    query: string,
    limit = 10,
    layers?: string[],
    tags?: string[],
    projectPath?: string,
  ): Promise<MemorySearchResult[]> {
    return this.client.post<MemorySearchResult[]>("/memory/search", {
      query,
      limit,
      layers,
      tags,
      projectPath,
    })
  }

  /**
   * Store a new memory entry.
   * Layer is auto-determined by importance when layer="auto".
   */
  async store(
    content: string,
    layer: string,
    options?: {
      id?: string
      importance?: number
      pin?: boolean
      sessionId?: string
      memoryType?: string
      metadata?: Record<string, unknown>
      tags?: string[]
      projectPath?: string
    },
  ): Promise<MemoryStoreResult> {
    return this.client.post<MemoryStoreResult>("/memory/store", {
      id: options?.id,
      content,
      layer,
      importance: options?.importance,
      pin: options?.pin,
      sessionId: options?.sessionId,
      memoryType: options?.memoryType,
      metadata: options?.metadata,
      tags: options?.tags,
      projectPath: options?.projectPath,
    })
  }

  /** Get all core memories (user profile) for a user. */
  async getProfile(userId = "default", projectId?: string): Promise<CoreMemoryEntry[]> {
    const params: Record<string, string> = { user_id: userId }
    if (projectId) params.project_id = projectId
    return this.client.get<CoreMemoryEntry[]>("/memory/profile", params)
  }

  /** Create or update a core memory (user profile). */
  async updateProfile(data: {
    content: string
    category?: string
    userId?: string
    projectId?: string
    metadata?: unknown
  }): Promise<CoreMemoryEntry> {
    return this.client.post<CoreMemoryEntry>("/memory/profile", {
      content: data.content,
      category: data.category,
      userId: data.userId,
      projectId: data.projectId,
      metadata: data.metadata,
    })
  }
}
