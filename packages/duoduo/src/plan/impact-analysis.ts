import { collectPlanEntityIds, parsePlanCandidateContent } from "./plan-match"

export type ImpactGraph = {
  entityId: string
  nodes: unknown[]
  edges: Array<{ id?: string; source?: string; target?: string; relation?: string }>
}

export type OperationImpact = {
  operation: unknown
  entityId?: string
  impactedBy: string[]
  missingCoverage: string[]
  risk: "none" | "low" | "medium"
}

export function collectAstOperations(candidates: unknown[]): unknown[] {
  const operations: unknown[] = []
  for (const candidate of candidates) {
    const content = parsePlanCandidateContent(candidate)
    const value = content?.["ast_operations"] ?? content?.["astOperations"]
    if (Array.isArray(value)) operations.push(...value)
  }
  return operations
}

function operationEntityId(operation: unknown): string | undefined {
  if (!operation || typeof operation !== "object") return undefined
  const op = operation as Record<string, unknown>
  if (typeof op.entityId === "string") return op.entityId
  const file = typeof op.file === "string" ? op.file : undefined
  const symbol = typeof op.symbol === "string" ? op.symbol : undefined
  if (file && symbol) return `function:${symbol}@${file}`
  return undefined
}

function coveredEntities(candidates: unknown[], operations: unknown[]) {
  const covered = new Set(collectPlanEntityIds(candidates))
  for (const operation of operations) {
    const id = operationEntityId(operation)
    if (id) covered.add(id)
  }
  return covered
}

export function analyzeAstOperationImpact(input: { candidates: unknown[]; impactGraphs: ImpactGraph[] }): OperationImpact[] {
  const operations = collectAstOperations(input.candidates)
  if (operations.length === 0) return []

  const covered = coveredEntities(input.candidates, operations)
  const graphByEntity = new Map(input.impactGraphs.map((graph) => [graph.entityId, graph]))

  return operations.map((operation) => {
    const entityId = operationEntityId(operation)
    if (!entityId) {
      return { operation, impactedBy: [], missingCoverage: [], risk: "low" as const }
    }

    const graph = graphByEntity.get(entityId)
    const incoming = (graph?.edges ?? [])
      .filter((edge) => edge.target === entityId && typeof edge.source === "string")
      .filter((edge) => ["Calls", "DependsOn", "Implements", "Inherits"].includes(String(edge.relation)))
      .map((edge) => edge.source!)

    const missingCoverage = incoming.filter((source) => !covered.has(source))
    return {
      operation,
      entityId,
      impactedBy: incoming,
      missingCoverage,
      risk: missingCoverage.length > 0 ? "medium" : incoming.length > 0 ? "low" : "none",
    }
  })
}
