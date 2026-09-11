import { SmartLayerClient } from "./client"

// ─── Types ────────────────────────────────────────────────────────────────

/** KG entity node. */
export interface KGEntity {
  id: string
  label: string
  type: string
  properties?: Record<string, unknown>
}

/** KG relation edge. */
export interface KGRelation {
  id: string
  sourceId: string
  targetId: string
  relationType: string
  weight?: number
  properties?: Record<string, unknown>
}

/**
 * Graph query request (shortest_path / subgraph / neighbors / nodes_by_type / search).
 *
 * Callers scope a query with `projectPath`, never with a project id: the
 * backend derives the graph's project identity from the directory, so there is
 * no way for a query to filter by a key that indexing never wrote.
 */
export interface GraphQueryRequest {
  queryType: "shortest_path" | "subgraph" | "neighbors" | "nodes_by_type" | "search"
  fromId?: string
  toId?: string
  centerId?: string
  hops?: number
  nodeId?: string
  nodeType?: string
  searchQuery?: string
  limit?: number
  projectPath?: string
}

/** Graph query response (path of node IDs or list of entities). */
export type GraphQueryResponse = string[] | KGEntity[]

/** Project indexing request. */
export interface GraphIndexRequest {
  projectPath: string
  rootFilter?: string
}

/** Project indexing response. */
export interface GraphIndexResponse {
  projectPath: string
  filesIndexed: number
  entitiesCreated: number
  edgesCreated: number
}

/** File indexing request (reuses existing type). */
export interface IndexFileRequest {
  path: string
  content: string
  language: string
  /**
   * Project root path. The backend derives the graph's project identity from
   * it; the graph routes reject the request when it is missing.
   */
  projectPath?: string
}

/** File indexing response. */
export interface IndexFileResponse {
  indexed: boolean
  path: string
}

/** Detailed graph statistics for a project. */
export interface GraphStatsDetail {
  nodeCount: number
  edgeCount: number
  indexedFileCount: number
  persistent: boolean
  nodeTypeDistribution: Record<string, number>
  relationTypeDistribution: Record<string, number>
}

// ─── Client ───────────────────────────────────────────────────────────────

/**
 * GraphClient provides typed access to the knowledge graph API.
 *
 * Supports:
 *   - Query: shortest_path, subgraph, neighbors, nodes_by_type
 *   - Write: add-entity, add-relation (passive mechanism — AI/MCP driven)
 *   - Indexing: index-project, index-file, update-file, remove-file
 *   - Stats: node/edge/file counts
 */
export class GraphClient {
  constructor(private client: SmartLayerClient) {}

  // ─── Query ────────────────────────────────────────────────────────────

  /** Query the knowledge graph (shortest_path / subgraph / neighbors / nodes_by_type). */
  async query(req: GraphQueryRequest): Promise<GraphQueryResponse> {
    return this.client.post<GraphQueryResponse>("/graph/query", req)
  }

  /** Find shortest path between two nodes. */
  async shortestPath(fromId: string, toId: string, projectPath?: string): Promise<string[]> {
    const result = await this.query({ queryType: "shortest_path", fromId, toId, projectPath })
    if (!Array.isArray(result) || result.length === 0) return result as string[]
    return typeof result[0] === "string" ? (result as string[]) : []
  }

  /** Get N-hop subgraph around a center node. */
  async subgraph(centerId: string, hops = 1, projectPath?: string): Promise<KGEntity[]> {
    const result = await this.query({ queryType: "subgraph", centerId, hops, projectPath })
    if (!Array.isArray(result) || result.length === 0) return result as KGEntity[]
    return typeof result[0] === "object" ? (result as KGEntity[]) : []
  }

  /** Get neighbors of a node. */
  async neighbors(nodeId: string, projectPath?: string): Promise<KGEntity[]> {
    const result = await this.query({ queryType: "neighbors", nodeId, projectPath })
    if (!Array.isArray(result) || result.length === 0) return result as KGEntity[]
    return typeof result[0] === "object" ? (result as KGEntity[]) : []
  }

  /** Find all nodes of a given type, optionally scoped to a project directory. */
  async nodesByType(nodeType: string, projectPath?: string): Promise<KGEntity[]> {
    const result = await this.query({ queryType: "nodes_by_type", nodeType, projectPath })
    if (!Array.isArray(result) || result.length === 0) return result as KGEntity[]
    return typeof result[0] === "object" ? (result as KGEntity[]) : []
  }

  /** Search nodes by case-insensitive substring match on label. */
  async search(
    searchQuery: string,
    options?: { nodeType?: string; limit?: number; projectPath?: string },
  ): Promise<KGEntity[]> {
    const result = await this.query({
      queryType: "search",
      searchQuery,
      nodeType: options?.nodeType,
      limit: options?.limit,
      ...(options?.projectPath ? { projectPath: options.projectPath } : {}),
    })
    if (!Array.isArray(result) || result.length === 0) return result as KGEntity[]
    return typeof result[0] === "object" ? (result as KGEntity[]) : []
  }

  // ─── Project Indexing (passive mechanism — auto-build graph from source) ─

  /**
   * Incrementally update a file in the knowledge graph.
   *
   * Removes old entities for the file, then re-indexes with new content.
   * This is the key passive mechanism entry point for file change events.
   */
  async updateFile(
    path: string,
    content: string,
    language: string,
    projectPath?: string,
  ): Promise<IndexFileResponse> {
    return this.client.post<IndexFileResponse>("/graph/update-file", {
      path,
      content,
      language,
      projectPath,
    })
  }

  /**
   * Remove all entities associated with a file from the knowledge graph.
   */
  async removeFile(path: string, projectPath?: string): Promise<IndexFileResponse> {
    return this.client.post<IndexFileResponse>("/graph/remove-file", {
      path,
      content: "",
      language: "",
      projectPath,
    })
  }

  // ─── Stats ────────────────────────────────────────────────────────────

  /** Trigger background indexing, returns immediately with current status.
   * The Rust handler answers `{"task_id": "...", "status": ...}` (snake_case,
   * graph.rs) — the old `taskId` read was always `undefined`. */
  async indexProjectAsync(
    projectPath: string,
    rootFilter?: string,
  ): Promise<{ task_id: string; status: unknown }> {
    return this.client.post("/graph/index-project-async", { projectPath, rootFilter })
  }

  /** Force a full reindex (clears existing data first). Returns immediately. */
  async forceReindexAsync(projectPath: string): Promise<{ task_id: string; status: unknown }> {
    return this.client.post("/graph/force-reindex-async", { projectPath })
  }

  /** Get current indexing status for a project directory. */
  async getIndexStatus(projectPath?: string): Promise<unknown> {
    const params = projectPath ? `?project_path=${encodeURIComponent(projectPath)}` : ""
    return this.client.get(`/graph/index-status${params}`)
  }

  /** Get detailed graph statistics (node/edge/file counts + type distributions) for a project. */
  async graphStatsDetail(projectPath?: string): Promise<GraphStatsDetail> {
    const params = projectPath ? `?project_path=${encodeURIComponent(projectPath)}` : ""
    return this.client.get<GraphStatsDetail>(`/graph/stats-detail${params}`)
  }

  /** Get neighbors with edge relation types. */
  async neighborsWithEdges(
    nodeId: string,
    projectPath?: string,
  ): Promise<{
    nodes: KGEntity[]
    edges: { id: string; source: string; target: string; relation: string }[]
  }> {
    return this.client.post("/graph/neighbors-with-edges", { nodeId, projectPath })
  }

  /** Cancel ongoing background indexing for a project directory. */
  async cancelIndex(projectPath?: string): Promise<{ cancelled: boolean }> {
    return this.client.post("/graph/cancel-index", { project_path: projectPath ?? "" })
  }

  /** Delete project KG cache from memory and disk. */
  async deleteProjectCache(projectPath: string): Promise<{ deleted: boolean }> {
    return this.client.del("/graph/project-cache", { project_path: projectPath })
  }

  /** Clear in-memory graph data only, preserving bincode cache on disk. */
  async clearProjectMemory(projectPath: string): Promise<{ cleared: boolean }> {
    return this.client.post("/graph/clear-memory", { project_path: projectPath })
  }

  /** Get the list of files that failed to read in the last indexing run for a project. */
  async getFailedFiles(projectPath?: string): Promise<{ files: Array<{ path: string; error: string }> }> {
    const params = projectPath ? `?project_path=${encodeURIComponent(projectPath)}` : ""
    return this.client.get(`/graph/failed-files${params}`)
  }

  /** Retry indexing a single file that previously failed. */
  async retryFile(projectPath: string, path: string): Promise<{ ok: boolean; error?: string }> {
    return this.client.post("/graph/retry-file", { path, projectPath })
  }
}
