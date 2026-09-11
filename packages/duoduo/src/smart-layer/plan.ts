import { SmartLayerClient } from "./client"

// ─── Types ────────────────────────────────────────────────────────────────

export interface PlanSaveRequest {
  intent: string
  intentTokens: string[]
  intentKgEntities: string[]
  reasoningSummary: string
  astOperations: unknown
  affectedKgSubgraph: unknown
  risks: string[]
  projectPath: string
  fileFingerprints: { filePath: string; baseAstHash: string; baseKgSubgraph: unknown }[]
  originatingSession: string
  originatingPrompt: string
}
export interface PlanSaveResponse {
  planId: string
}

export interface PlanSearchRequest {
  query: string
  projectPath: string
  limit?: number
}
export interface PlanSearchResponse {
  candidates: unknown[]
}

export interface PlanMatchRequest {
  planId: string
  currentFiles: { path: string; astHash: string }[]
}
export interface PlanMatchResponse {
  matchLevel: string
  adjustedPlan?: unknown
  mismatchDetails: string[]
}

export interface PlanUpdateRequest {
  planId: string
  field: string
  increment: number
}

// ─── Client ───────────────────────────────────────────────────────────────

/**
 * PlanClient provides typed access to the plan storage API.
 *
 * Supports:
 *   - save: persist a plan with intent, AST ops, and file fingerprints
 *   - search: find candidate plans by query
 *   - match: check how well a plan matches current file state
 *   - update: increment a counter field on a plan
 */
export class PlanClient {
  constructor(private client: SmartLayerClient) {}

  /** Save a plan and return its ID. */
  async save(req: PlanSaveRequest): Promise<PlanSaveResponse> {
    return this.client.post<PlanSaveResponse>("/plan/save", req)
  }

  /** Search for candidate plans by query. */
  async search(req: PlanSearchRequest): Promise<PlanSearchResponse> {
    return this.client.post<PlanSearchResponse>("/plan/search", req)
  }

  /** Check how well a plan matches the current file state. */
  async match(req: PlanMatchRequest): Promise<PlanMatchResponse> {
    return this.client.post<PlanMatchResponse>("/plan/match", req)
  }

  /** Increment a counter field on a plan (e.g. reuse count). */
  async update(req: PlanUpdateRequest): Promise<void> {
    return this.client.post<void>("/plan/update", req)
  }
}
