export type PlanPreference = {
  id?: string
  category?: string
  content?: string
  metadata?: unknown
}

export type PlanMatchResult = {
  selected?: unknown
  candidates: Array<{ candidate: unknown; score: number; reasons: string[]; rejected: boolean }>
  note: string
}

export function parsePlanCandidateContent(candidate: unknown): Record<string, unknown> | undefined {
  if (!candidate || typeof candidate !== "object") return undefined
  const content = (candidate as { content?: unknown }).content
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content)
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }
  if (content && typeof content === "object") return content as Record<string, unknown>
  return candidate as Record<string, unknown>
}

export function collectPlanEntityIds(candidates: unknown[]): string[] {
  const ids = new Set<string>()
  for (const candidate of candidates) {
    const content = parsePlanCandidateContent(candidate)
    const entities = content?.["intent_kg_entities"]
    if (!Array.isArray(entities)) continue
    for (const entity of entities) {
      if (typeof entity === "string" && entity.length > 0) ids.add(entity)
    }
  }
  return [...ids]
}

export function entitySearchName(entityId: string) {
  const [kindAndName] = entityId.split("@")
  const [, name] = kindAndName?.split(":") ?? []
  return name || entityId
}

function tokenize(input: string) {
  return new Set(
    input
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  )
}

function textFromCandidate(candidate: unknown) {
  const content = parsePlanCandidateContent(candidate)
  return [
    content?.["intent"],
    content?.["reasoning_summary"],
    content?.["reasoningSummary"],
    Array.isArray(content?.["risks"]) ? content?.["risks"]?.join(" ") : undefined,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
}

function preferenceTexts(preferences: PlanPreference[], category: string) {
  return preferences
    .filter((entry) => entry.category === category)
    .map((entry) => entry.content ?? "")
    .filter(Boolean)
}

export function matchPlanCandidates(input: {
  query: string
  candidates: unknown[]
  preferences?: PlanPreference[]
}): PlanMatchResult {
  const queryTokens = tokenize(input.query)
  const rejectedTexts = preferenceTexts(input.preferences ?? [], "rejected_plan")
  const preferredTexts = preferenceTexts(input.preferences ?? [], "preference")

  const ranked = input.candidates.map((candidate) => {
    const reasons: string[] = []
    let score = 0
    const text = textFromCandidate(candidate)
    const candidateTokens = tokenize(text)
    let overlap = 0
    for (const token of queryTokens) {
      if (candidateTokens.has(token)) overlap++
    }
    if (overlap > 0) {
      score += overlap * 2
      reasons.push(`token-overlap:${overlap}`)
    }

    const content = parsePlanCandidateContent(candidate)
    const entities = content?.["intent_kg_entities"]
    if (Array.isArray(entities) && entities.length > 0) {
      score += Math.min(entities.length, 5)
      reasons.push(`kg-entities:${entities.length}`)
    }

    for (const pref of preferredTexts) {
      const prefTokens = tokenize(pref)
      if ([...prefTokens].some((token) => candidateTokens.has(token))) {
        score += 2
        reasons.push("preference-match")
        break
      }
    }

    let rejected = false
    for (const rejectedText of rejectedTexts) {
      const rejectedTokens = [...tokenize(rejectedText)].filter((token) => token.length >= 3)
      if (rejectedTokens.length === 0) continue
      const overlap = rejectedTokens.filter((token) => candidateTokens.has(token)).length
      if (overlap / rejectedTokens.length >= 0.8) {
        score -= 10
        rejected = true
        reasons.push("rejected-plan-similar")
        break
      }
    }

    return { candidate, score, reasons, rejected }
  })

  ranked.sort((a, b) => b.score - a.score)
  const selected = ranked.find((item) => !item.rejected && item.score > 0)?.candidate
  return {
    selected,
    candidates: ranked,
    note: "Read-only plan match. This ranking is context only and never bypasses confirmation, validation, or write guards.",
  }
}
