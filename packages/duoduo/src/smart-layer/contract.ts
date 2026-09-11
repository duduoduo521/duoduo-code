import { Effect } from "effect"
import { DuoduoError } from "@/util/error"
import { createSmartLayerClients } from "@/smart-layer"
import { Flag } from "@/flag/flag"
import { Instance } from "@/project/instance"
import { Log } from "@/util"
import type { GraphClient, KGEntity } from "@/smart-layer/graph"
import type { InterfaceContract } from "@/smart-layer/types"

/**
 * ③ Contract planner — M1.
 *
 * Given a target file and the current project, derive an `InterfaceContract`
 * from the knowledge graph (KG `Class` node + its member `Function`/`Field`
 * neighbors). The contract is consumed two ways:
 *   - structured (`interface_contract`) → sent to Rust and checked on writes (B5)
 *   - rendered text (`renderFileContract`) → injected into the sub-agent
 *     `system_prompt` (M2).
 *
 * Every KG query is independently wrapped so a KG outage degrades to
 * "no contract" (`undefined`) rather than crashing the request — the same
 * resilience pattern as `system.ts`'s `projectGuidance` / `buildSharedTypesSection`.
 * When the KG has no `Class` node for the target file, returns `undefined` so
 * callers fall back to "no contract" (R6.1, zero regression).
 */

const contractLog = Log.create({ service: "contract" })

/** Lenient path comparison: exact (normalized) match OR suffix match. Handles
 *  KG absolute `properties.file` vs a planner-provided relative/absolute path. */
const fileMatches = (kgFile: string, target: string): boolean => {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "")
  const a = norm(kgFile)
  const b = norm(target)
  return a === b || a.endsWith(b) || b.endsWith(a)
}

/** Query nodes of `nodeType` scoped to the project, keeping only those whose
 *  `properties.file` matches `targetFile`. KG failure ⇒ empty list. */
const nodesByFile = (
  graph: GraphClient,
  nodeType: string,
  targetFile: string,
  projectPath: string,
): Effect.Effect<KGEntity[], unknown, never> =>
  Effect.tryPromise({
    try: () =>
      graph.nodesByType(nodeType, projectPath).then((xs) =>
        xs.filter((e) => {
          const f = e.properties?.["file"]
          return typeof f === "string" && fileMatches(f, targetFile)
        }),
      ),
    catch: () => new DuoduoError({ message: "kg nodesByType failed", messageZh: "kg nodesByType 查询失败", cause: undefined }),
  }).pipe(Effect.catch(() => Effect.succeed([] as KGEntity[])))

/** Get a node's member nodes (functions / fields). KG failure ⇒ empty list. */
const neighborsEffect = (
  graph: GraphClient,
  nodeId: string,
): Effect.Effect<KGEntity[], unknown, never> =>
  Effect.tryPromise({
    try: () => graph.neighbors(nodeId),
    catch: () => new DuoduoError({ message: "kg neighbors failed", messageZh: "kg neighbors 查询失败", cause: undefined }),
  }).pipe(Effect.catch(() => Effect.succeed([] as KGEntity[])))

/**
 * Collect cross-file related entity names for a root node via BFS up to
 * `maxDepth` hops (A: full coverage).
 *
 * Rules (correct + low-noise, not best-effort):
 *  - Only neighbors whose `properties.file` is a STRING and does NOT match the
 *    target file are kept as cross-file relations. Nodes WITHOUT a `file`
 *    property are DROPPED (B: no `file` ⇒ not treated as cross-file, eliminating
 *    the previous noise where missing/empty `file` was counted as cross-file).
 *  - Each node visited at most once (memoized by id) → no exponential blow-up.
 *  - Result capped at `maxRelated` → prompt size bounded.
 *
 * KG failure at any hop ⇒ empty list (degrades gracefully).
 */
const crossFileRelatedEffect = (
  graph: GraphClient,
  rootId: string,
  targetFile: string,
  projectPath: string,
  maxDepth = 2,
  maxRelated = 40,
): Effect.Effect<string[], unknown, never> =>
  Effect.tryPromise({
    try: () =>
      graph.neighborsWithEdges(rootId, projectPath).then(async () => {
        const related: string[] = []
        const visited = new Set<string>([rootId])
        let frontier: string[] = [rootId]
        for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
          const next: string[] = []
          for (const id of frontier) {
            if (related.length >= maxRelated) break
            const { nodes } = await graph.neighborsWithEdges(id, projectPath)
            for (const n of nodes) {
              if (related.length >= maxRelated) break
              if (visited.has(n.id)) continue
              visited.add(n.id)
              const f = n.properties?.["file"]
              // B: no `file` property ⇒ drop (do NOT treat as cross-file)
              if (typeof f !== "string") continue
              if (fileMatches(f, targetFile)) continue // same-file member
              const name = n.label.includes(".") ? n.label.split(".").pop()! : n.label
              if (name && !related.includes(name)) {
                related.push(name)
                next.push(n.id) // expand this cross-file node one more hop
              }
            }
          }
          frontier = next
        }
        return related
      }),
    catch: () => new DuoduoError({ message: "kg neighbors-with-edges failed", messageZh: "kg neighbors-with-edges 查询失败", cause: undefined }),
  }).pipe(Effect.catch(() => Effect.succeed([] as string[])))

/**
 * Build an `InterfaceContract` for a single target file from the KG.
 *
 * Root nodes are gathered from BOTH `Class` nodes AND module-level
 * `Function`/`Method` nodes (C: non-class files such as pure utility modules
 * DO have KG variable-level nodes — they were skipped before only because the
 * query was hard-coded to "Class only"). Each root contributes its members
 * (Class) and its cross-file relations.
 *
 * Returns `undefined` when KG is disabled, the sidecar is down, no matching
 * node exists for the file, or any KG query fails.
 */
export const buildFileContract = (
  targetFile: string,
): Effect.Effect<InterfaceContract | undefined, unknown, never> =>
  Effect.gen(function* () {
    if (!Flag.DUODUO_KG_ENABLED) {
      contractLog.debug("buildFileContract: skipped (DUODUO_KG_ENABLED=false)")
      return undefined
    }
    const clients = createSmartLayerClients()
    if (!clients) {
      contractLog.debug("buildFileContract: skipped (smart-layer unavailable)")
      return undefined
    }
    // Scope by the project directory: the backend derives the graph's project
    // identity from it, so this addresses the nodes indexing wrote.
    const directory = Instance.directory

    // C: include Class AND module-level Function/Method so non-class files
    // (utilities, config, pure-function modules) also get KG-assisted contracts.
    const classNodes = yield* nodesByFile(clients.graph, "Class", targetFile, directory)
    const funcNodes = yield* nodesByFile(clients.graph, "Function", targetFile, directory)
    const methodNodes = yield* nodesByFile(clients.graph, "Method", targetFile, directory)
    const rootNodes = [...classNodes, ...funcNodes, ...methodNodes]
    if (rootNodes.length === 0) {
      // No KG node for this file ⇒ no structured contract (R6.1, zero regression).
      return undefined
    }

    const contract: InterfaceContract = { properties: {}, methods: {}, related: [] }
    for (const root of rootNodes) {
      // Inheritance (Class only): read `extends` from the class properties.
      if (root.type === "Class") {
        const ext = root.properties?.["extends"]
        if (typeof ext === "string" && !contract.extends) contract.extends = ext
      }

      // For Class roots, surface members as the contract surface. For
      // Function/Method roots the node itself is the unit; its neighbors carry
      // the cross-file relations we care about.
      if (root.type === "Class") {
        const members = yield* neighborsEffect(clients.graph, root.id)
        for (const m of members) {
          const name = m.label.includes(".") ? m.label.split(".").pop()! : m.label
          if (!name) continue
          if (m.type === "Function" || m.type === "Method") {
            contract.methods[name] = {}
          } else if (m.type === "Field" || m.type === "Property") {
            contract.properties[name] = ""
          }
        }
      }

      // Cross-file related entities (true cross-file dependency, not members).
      const related = yield* crossFileRelatedEffect(clients.graph, root.id, targetFile, directory)
      for (const r of related) {
        if (!contract.related!.includes(r)) contract.related!.push(r)
      }
    }
    return contract
  }).pipe(
    // Every KG failure degrades to "no contract" — never breaks the request.
    Effect.catch(() => Effect.succeed(undefined)),
  )

/**
 * Render a contract as a text segment for injection into a sub-agent's
 * `system_prompt` (M2). Includes the "KG is a snapshot, code is source of
 * truth" disclaimer required by §8.0.
 */
export const renderFileContract = (targetFile: string, contract: InterfaceContract): string => {
  const lines: string[] = [
    `## File Contract (${targetFile})`,
    "",
    "This contract is derived from the knowledge-graph snapshot and may be slightly out of date — the actual current code is the source of truth. Implement the interface faithfully.",
  ]
  if (contract.extends) lines.push(`Extends: ${contract.extends}`)
  const methods = Object.keys(contract.methods)
  if (methods.length) lines.push(`Methods (must be implemented): ${methods.join(", ")}`)
  const props = Object.keys(contract.properties)
  if (props.length) lines.push(`Properties: ${props.join(", ")}`)
  return lines.join("\n")
}
