import z from "zod"
import { Effect, Cause } from "effect"
import { createSmartLayerClients } from "@/smart-layer"
import type { KGEntity } from "@/smart-layer/graph"
import { GraphIndexStatus } from "@/project/graph-index-status"
import { Instance } from "@/project/instance"
import * as Tool from "./tool"
import DESCRIPTION from "./graph_query.txt"

const FALLBACK_MESSAGE = "Knowledge graph query not available. Use grep for text-based search instead."

const MAX_HOPS = 3

/** Format a node's location from properties (file + startLine/line). */
function formatLocation(properties?: Record<string, unknown>): string {
  if (!properties) return ""
  const file = (properties.file ?? properties.sourceFile) as string | number | undefined
  const line = (properties.startLine ?? properties.line) as string | number | undefined
  if (file != null && line != null) return `, file: ${file}:${line}`
  if (file != null) return `, file: ${file}`
  return ""
}

/** Format graph results into LLM-readable text. */
function formatResult(queryType: string, target: string, result: unknown, relationFilter?: string): string {
  if (!result) return "No results found."

  // neighborsWithEdges returns { nodes, edges }
  if (typeof result === "object" && result !== null && "nodes" in result && "edges" in result) {
    const { nodes, edges } = result as {
      nodes: KGEntity[]
      edges: Array<{ id: string; source: string; target: string; relation: string }>
    }

    let filteredEdges = edges
    if (relationFilter) {
      filteredEdges = edges.filter((e) => e.relation.toLowerCase().includes(relationFilter.toLowerCase()))
    }

    if (nodes.length === 0 && filteredEdges.length === 0) {
      return `No graph results for "${target}" (query: ${queryType}).`
    }

    const lines: string[] = [`Graph query: ${queryType} for "${target}"`]
    lines.push("")
    lines.push(`Nodes (${nodes.length}):`)
    for (const node of nodes.slice(0, 50)) {
      lines.push(`  - [${node.type}] ${node.label} (id: ${node.id}${formatLocation(node.properties)})`)
    }
    if (nodes.length > 50) {
      lines.push(`  ... and ${nodes.length - 50} more`)
    }

    lines.push("")
    lines.push(`Edges (${filteredEdges.length}):`)
    for (const edge of filteredEdges.slice(0, 50)) {
      lines.push(`  - ${edge.source} --[${edge.relation}]--> ${edge.target}`)
    }
    if (filteredEdges.length > 50) {
      lines.push(`  ... and ${filteredEdges.length - 50} more`)
    }

    return lines.join("\n")
  }

  // shortest_path returns string[] (ordered node IDs forming the path)
  if (Array.isArray(result)) {
    if (result.length > 0 && typeof result[0] === "string") {
      const path = result as string[]
      if (path.length === 0) {
        return `No path found for "${target}" (query: ${queryType}).`
      }
      const lines = [`Shortest path: ${queryType} for "${target}"`, ""]
      path.forEach((id, i) => lines.push(`  ${i + 1}. ${id}`))
      return lines.join("\n")
    }

    const entities = result as KGEntity[]
    if (entities.length === 0) {
      return `No graph results for "${target}" (query: ${queryType}).`
    }

    const lines: string[] = [`Graph query: ${queryType} for "${target}"`]
    lines.push("")
    lines.push(`Results (${entities.length}):`)
    for (const entity of entities.slice(0, 50)) {
      lines.push(`  - [${entity.type}] ${entity.label} (id: ${entity.id}${formatLocation(entity.properties)})`)
    }
    if (entities.length > 50) {
      lines.push(`  ... and ${entities.length - 50} more`)
    }

    return lines.join("\n")
  }

  // Fallback: stringify
  return JSON.stringify(result, null, 2)
}

export const GraphQueryTool = Tool.define(
  "graph_query",
  Effect.gen(function* () {
    const graphIndex = yield* GraphIndexStatus.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        query_type: z
          .enum([
            "references_of",
            "callers_of",
            "dependencies_of",
            "implements_of",
            "subgraph",
            "search",
            "shortest_path",
            "similar",
          ])
          .describe("Type of graph query"),
        target: z.string().describe("Symbol name or node ID to query (e.g. 'function:execute_loop_inner')"),
        source: z
          .string()
          .optional()
          .describe("Source node ID for shortest_path queries (e.g. 'function:foo')"),
        hops: z.number().optional().default(1).describe("Graph traversal depth (default 1, max 3)"),
        relation_filter: z.string().optional().describe("Edge type filter (e.g. 'Calls', 'Implements', 'Contains')"),
        limit: z.number().optional().default(20).describe("Maximum number of results"),
      }),
      execute: (
        params: {
          query_type:
            | "references_of"
            | "callers_of"
            | "dependencies_of"
            | "implements_of"
            | "subgraph"
            | "search"
            | "shortest_path"
            | "similar"
          target: string
          source?: string
          hops?: number
          relation_filter?: string
          limit?: number
        },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          // Resolve optional params early so metadata is consistent across all return paths
          const hops = Math.min(params.hops ?? 1, MAX_HOPS)
          const limit = params.limit ?? 20
          const baseMetadata = {
            query_type: params.query_type,
            target: params.target,
            hops,
            limit,
          } as const

          if (!params.target) {
            throw new Error("target is required")
          }

          if (params.query_type === "shortest_path" && !params.source) {
            throw new Error("source is required for shortest_path queries")
          }

          yield* ctx.ask({
            permission: "graph_query",
            patterns: [params.target],
            always: ["*"],
            metadata: {
              ...baseMetadata,
              relation_filter: params.relation_filter,
            },
          })

          // Check if graph index is ready
          const indexStatus = yield* graphIndex.get()
          if (indexStatus.type === "idle" || indexStatus.type === "indexing") {
            return {
              title: `${params.query_type}: ${params.target}`,
              metadata: { ...baseMetadata, available: false },
              output:
                indexStatus.type === "indexing"
                  ? `Knowledge graph is currently indexing (progress: ${indexStatus.progress ?? 0}%). Please try again later.`
                  : FALLBACK_MESSAGE,
            }
          }

          if (indexStatus.type === "failed") {
            return {
              title: `${params.query_type}: ${params.target}`,
              metadata: { ...baseMetadata, available: false },
              output: FALLBACK_MESSAGE,
            }
          }

          // Obtain SmartLayerClients (may be null if sidecar is not running)
          const clients = createSmartLayerClients()
          if (!clients?.graph) {
            return {
              title: `${params.query_type}: ${params.target}`,
              metadata: { ...baseMetadata, available: false },
              output: FALLBACK_MESSAGE,
            }
          }

          const graph = clients.graph

          const result: unknown = yield* Effect.tryPromise({
            try: (): Promise<unknown> => {
              switch (params.query_type) {
                case "references_of":
                case "callers_of":
                case "implements_of":
                  return graph.neighborsWithEdges(params.target, Instance.directory)
                case "dependencies_of":
                case "subgraph":
                  return graph.subgraph(params.target, hops, Instance.directory)
                case "search":
                  return graph.search(params.target, { limit, projectPath: Instance.directory })
                case "similar":
                  // Semantic reuse search is executed via the Rust run-loop
                  // graph_query tool (which has the embedding index). In this
                  // TS path we degrade to a name-based search so the tool still
                  // returns useful results instead of failing.
                  return graph.search(params.target, { limit, projectPath: Instance.directory })
                case "shortest_path":
                  return graph.shortestPath(params.source!, params.target, Instance.directory)
              }
            },
            catch: (error) => new Cause.UnknownError(error),
          })

          if (!result) {
            return {
              title: `${params.query_type}: ${params.target}`,
              metadata: { ...baseMetadata, available: false },
              output: FALLBACK_MESSAGE,
            }
          }

          const output = formatResult(params.query_type, params.target, result, params.relation_filter)

          return {
            title: `${params.query_type}: ${params.target}`,
            metadata: { ...baseMetadata, available: true },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
