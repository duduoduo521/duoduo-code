export type PlanPreview = {
  summary?: string
  risks?: string[]
  astOperations?: unknown[]
  impactAnalysis?: unknown[]
  operationImpact?: Array<{ entityId?: string; impactedBy?: string[]; missingCoverage?: string[]; risk?: string }>
  fallbackDiff?: string
}

export function planPreview(metadata: unknown): PlanPreview | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const value = (metadata as { planPreview?: unknown }).planPreview
  return value && typeof value === "object" ? (value as PlanPreview) : undefined
}

export function planOperationSummary(operation: unknown): string {
  if (!operation || typeof operation !== "object") return String(operation)
  const op = operation as Record<string, unknown>
  const kind = typeof op.op === "string" ? op.op : "operation"
  const file = typeof op.file === "string" ? op.file : undefined
  const symbol = typeof op.symbol === "string" ? op.symbol : undefined
  return [kind, symbol, file ? `in ${file}` : undefined].filter(Boolean).join(" ")
}

export function planPreviewImpactWarnings(preview: PlanPreview | undefined): string[] {
  if (!preview?.operationImpact?.length) return []
  const warnings: string[] = []
  for (const item of preview.operationImpact) {
    const missing = item.missingCoverage ?? []
    if (missing.length === 0) continue
    const target = item.entityId ?? "unknown entity"
    warnings.push(`${target}: ${missing.length} uncovered dependent ${missing.length === 1 ? "entity" : "entities"}`)
  }
  return warnings
}
