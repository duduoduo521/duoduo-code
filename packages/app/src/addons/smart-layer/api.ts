/**
 * Smart Layer API client (lightweight, for UI consumption).
 *
 * Kept free of SolidJS imports on purpose: it is a plain HTTP client, and
 * keeping it in its own module lets the unit tests exercise the real class
 * instead of a re-implemented copy that can drift from production.
 */

import type {
  MemoryEntry,
  MemoryStats,
  QualityReport,
  ClarificationResult,
  KGIndexStatus,
  GraphStatsDetail,
  RecentFile,
} from "./types"

// ─── Smart Layer API Client (lightweight, for UI consumption) ───

// Exported so tests exercise this implementation directly instead of a
// re-implemented copy (which drifts silently from the real client).
export interface SmartLayerApiConfig {
  url: string
  username?: string
  /** Pre-computed Basic Auth header (e.g. "Basic dXNlcjpwYXNz").
   *  Preferred over passing plaintext password - the caller should
   *  compute this via the platform.smartLayer().getAuthHeader() method
   *  so the raw password is never stored in a reactive signal. */
  authHeader?: string
  timeout?: number
}

export class SmartLayerApi {
  private url: string
  private authHeader: string | undefined
  private timeout: number

  constructor(config: SmartLayerApiConfig) {
    this.url = config.url
    this.timeout = config.timeout ?? 10000
    // Accept pre-computed authHeader directly (avoids exposing plaintext password)
    this.authHeader = config.authHeader
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const headers: Record<string, string> = {}
    // Only set Content-Type when there IS a body. Sending it on bodyless
    // GET/DELETE requests triggers a CORS preflight (OPTIONS round-trip)
    // that adds latency and can fail when the sidecar is slow to respond.
    if (body !== undefined) headers["Content-Type"] = "application/json"
    if (this.authHeader) headers["Authorization"] = this.authHeader

    // Per-request timeout override (e.g. long-running installs). Pass 0 to
    // disable the timeout entirely. Falls back to the default `this.timeout`.
    const timeout = timeoutMs ?? this.timeout
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: timeout > 0 ? AbortSignal.timeout(timeout) : undefined,
    })

    if (!response.ok) {
      // Try to extract structured error info from the response body
      // (UnifiedError returns { error, code, error_type, retryable, retry_after_ms })
      let detail = response.statusText
      try {
        const errBody = (await response.json()) as {
          error?: string
          code?: number
          error_type?: string
          retryable?: boolean
          retry_after_ms?: number
        }
        if (errBody.error) detail = errBody.error
        const err = new Error(`SmartLayer ${response.status}: ${detail}`) as Error & {
          status?: number
          errorType?: string
          retryable?: boolean
          retryAfterMs?: number
        }
        err.status = response.status
        err.errorType = errBody.error_type
        err.retryable = errBody.retryable
        err.retryAfterMs = errBody.retry_after_ms
        throw err
      } catch (e) {
        // If JSON parsing failed and we haven't thrown our enriched error yet,
        // fall through to the simple error
        if (e instanceof Error && "errorType" in e) throw e
        throw new Error(`SmartLayer ${response.status}: ${detail}`, { cause: e })
      }
    }
    return response.json() as Promise<T>
  }

  // ─── Generic HTTP methods (public) ───
  get<T>(path: string, timeoutMs?: number): Promise<T> {
    return this.request("GET", path, undefined, timeoutMs)
  }

  post<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.request("POST", path, body, timeoutMs)
  }

  del<T>(path: string, timeoutMs?: number): Promise<T> {
    return this.request("DELETE", path, undefined, timeoutMs)
  }

  patch<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.request("PATCH", path, body, timeoutMs)
  }

  // Health
  health() {
    return this.request<{ status: string; version: string }>("GET", "/health")
  }

  // Memory
  searchMemory(query: string, limit = 10, layers?: string[]): Promise<MemoryEntry[]> {
    return this.request("POST", "/memory/search", { query, limit, layers })
  }

  storeMemory(
    content: string,
    layer: string,
    tags?: string[],
    options?: {
      importance?: number
      pin?: boolean
      sessionId?: string
      memoryType?: string
      metadata?: unknown
      projectPath?: string
    },
  ): Promise<{ id: string; stored: boolean }> {
    return this.request("POST", "/memory/store", {
      content,
      layer,
      tags,
      importance: options?.importance,
      pin: options?.pin,
      // camelCase — MemoryStoreRequest renames; the old snake_case keys were
      // silently dropped, so session/memoryType/project scoping never applied.
      sessionId: options?.sessionId,
      memoryType: options?.memoryType,
      metadata: options?.metadata,
      projectPath: options?.projectPath,
    })
  }

  /** Enhanced stats (v2) — the only stats endpoint since v1 was removed. */
  memoryStats(): Promise<MemoryStats> {
    return this.request("GET", "/memory/stats/v2")
  }

  /** Wire format is `MemoryDeleteResponse { deleted, vacuumed }` (camelCase).
   * The old `deleted_count` / `deleted: boolean` shapes never existed on the
   * wire — toasts read `undefined` (P2-09). */
  deleteMemory(id: string): Promise<{ deleted: number; vacuumed: boolean }> {
    return this.request("DELETE", `/memory/${encodeURIComponent(id)}`)
  }

  clearMemory(layer?: string): Promise<{ deleted: number; vacuumed: boolean }> {
    if (layer) {
      return this.request("DELETE", `/memory/layer/${encodeURIComponent(layer)}`)
    }
    return this.request("DELETE", "/memory/clear")
  }

  // Quality
  validateQuality(
    artifact: { type: string; content: string; language: string; filePath?: string },
    qualityLevel: string,
  ): Promise<QualityReport> {
    return this.request("POST", "/quality/validate", { artifact, qualityLevel })
  }

  // Intent
  clarifyIntent(userInput: string, projectContext?: Record<string, string>): Promise<ClarificationResult> {
    return this.request("POST", "/intent/clarify", { userInput, projectContext })
  }

  // LLM Configuration
  configureLlm(config: {
    provider: string
    apiKey?: string
    baseURL?: string
    defaultModelId: string
    /** Maximum context window in tokens (e.g. Xunfei Spark=202745, GPT-4=128000). */
    contextWindow?: number
    /** Maximum concurrent agents across all projects (default 5). */
    maxConcurrentAgents?: number
    /** Maximum subagents a single agent can spawn concurrently (default 3). */
    maxConcurrentSubagents?: number
    /** Maximum LLM API call retry attempts (default 3). */
    maxRetryAttempts?: number
    /** Per-round tool-call concurrency inside a single agent loop (default 4, hard-capped at 16). */
    toolConcurrency?: number
    /** [LLM-05] Ordered fallback model IDs tried when the primary model is unavailable. */
    fallbackModels?: string[]
    /** Sampling temperature override for agent/executor LLM calls. None => 0.0 (deterministic). */
    temperature?: number
    /** Whether to enable the model's thinking/reasoning mode. None => enabled by default. */
    enableThinking?: boolean
    /** Thinking/reasoning effort level sent as `reasoning_effort` in extra_body. None => "high". Accepts "low" | "medium" | "high". */
    thinkingEffort?: string
  }): Promise<{ configured: boolean; with_llm: boolean }> {
    return this.request("POST", "/agent/config", config)
  }

  getLlmConfig(): Promise<{
    configured: boolean
    provider: string
    defaultModelId: string
    baseURL?: string
    contextWindow?: number
    maxOutputTokens?: number
    maxConcurrentAgents?: number
    maxConcurrentSubagents?: number
    maxRetryAttempts?: number
    toolConcurrency?: number
    /** These four were previously declared-but-never-returned (agent.rs only
     * serialized part of LlmConfig); get_llm_config now round-trips them so
     * the settings UI can rebuild the configureLlm payload. */
    fallbackModels?: string[]
    temperature?: number
    enableThinking?: boolean
    thinkingEffort?: string
  }> {
    return this.request("GET", "/agent/config")
  }

  /** Test a provider/model for connectivity + prompt-caching support.
   *  Called on the "add model" submit so a broken/unsupported model
   *  can't be saved. The cached result is remembered on the model config. */
  testProvider(config: {
    provider: string
    model: string
    apiKey?: string
    baseURL: string
    temperature?: number
    topP?: number
  }): Promise<{ ok: boolean; promptCaching: boolean; modelId?: string; error?: string }> {
    return this.request("POST", "/agent/test", config)
  }

  // Keyring (secure API key storage)
  /** Store an API key in the OS keyring securely. */
  keyringStore(provider: string, apiKey: string): Promise<{ ok: boolean }> {
    return this.request("POST", "/agent/keyring/store", { provider, apiKey })
  }

  /** Check if an API key exists in the OS keyring (does not expose the key value). */
  keyringHas(provider: string): Promise<{ hasKey: boolean }> {
    return this.request("GET", `/agent/keyring/has?provider=${encodeURIComponent(provider)}`)
  }

  /** Delete an API key from the OS keyring. */
  keyringDelete(provider: string): Promise<{ ok: boolean }> {
    return this.request("POST", "/agent/keyring/delete", { provider })
  }

  // ─── Knowledge Graph ────────────────────────────────────────────────────

  /** Force a full reindex of a project (clears existing data first).
   *  Uses the async endpoint so the request returns immediately
   *  and the frontend tracks progress via polling.
   */
  /** Rust answers `{"task_id": ...}` (snake_case, graph.rs). */
  forceReindex(projectPath: string): Promise<{ task_id: string; status: unknown }> {
    return this.request("POST", "/graph/force-reindex-async", { projectPath })
  }

  /** Incrementally update a file in the knowledge graph. */
  graphUpdateFile(path: string, content: string, language: string): Promise<unknown> {
    return this.request("POST", "/graph/update-file", { path, content, language })
  }

  // ─── Project scoping ───
  //
  // Every graph endpoint is scoped by the project *directory*, never by a
  // project id: the backend derives the index key from the directory, so a
  // caller cannot accidentally address a key that indexing never wrote.

  /** Get current KG indexing status for a project. */
  getIndexStatus(projectPath?: string): Promise<KGIndexStatus> {
    const params = projectPath ? `?project_path=${encodeURIComponent(projectPath)}` : ""
    return this.request("GET", `/graph/index-status${params}`)
  }

  /** Cancel ongoing KG background indexing for a project. */
  cancelIndex(projectPath?: string): Promise<{ cancelled: boolean }> {
    return this.request("POST", "/graph/cancel-index", { project_path: projectPath ?? "" })
  }

  /** Close a project's KG index. `clear=true` wipes it; `false` marks it
   *  closed so the retention sweep removes it later. */
  closeProjectIndex(projectPath: string, clear: boolean): Promise<{ closed: boolean }> {
    return this.request("POST", "/graph/close-project-index", { project_path: projectPath, clear })
  }

  /** Get detailed graph statistics including type distributions. */
  graphStatsDetail(projectPath?: string): Promise<GraphStatsDetail> {
    const params = projectPath ? `?project_path=${encodeURIComponent(projectPath)}` : ""
    return this.request("GET", `/graph/stats-detail${params}`)
  }

  /** Get recently indexed files. */
  getRecentFiles(projectPath?: string): Promise<{ files: RecentFile[] }> {
    const params = projectPath ? `?project_path=${encodeURIComponent(projectPath)}` : ""
    return this.request("GET", `/graph/recent-files${params}`)
  }

  /** Get files that failed to read in the last indexing run for a project. */
  getFailedFiles(projectPath?: string): Promise<{ files: Array<{ path: string; error: string }> }> {
    const params = projectPath ? `?project_path=${encodeURIComponent(projectPath)}` : ""
    return this.request("GET", `/graph/failed-files${params}`)
  }

  /** Get the index registry (retention days + per-project metadata). */
  getIndexRegistry(): Promise<{
    retention_days: number
    projects: Array<{
      project_id: string
      name: string
      directory: string
      last_indexed_at: number
      closed_at: number | null
      size_bytes: number
    }>
  }> {
    return this.request("GET", "/graph/index-registry")
  }

  /** Set the retention window (days) for closed projects. */
  setRetention(days: number): Promise<{ retention_days: number }> {
    return this.request("PUT", "/graph/index-retention", { days })
  }

  /** Clear every project's index. */
  clearAllIndexes(): Promise<{ cleared: boolean }> {
    return this.request("POST", "/graph/clear-all-indexes", {})
  }

  /** Retry indexing a single file that previously failed. */
  retryFile(projectPath: string, filePath: string): Promise<{ ok: boolean; error?: string }> {
    return this.request("POST", "/graph/retry-file", { path: filePath, projectPath })
  }
}
