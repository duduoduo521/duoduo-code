import type { Message, Part } from "@duoduo-ai/sdk/v2/client"

/** Per-category token counts reported by the Rust backend (estimate_request_breakdown).
 *  The SDK dropped this type from its public exports, so we declare it locally to keep
 *  the UI breakdown feature working against whatever the backend actually returns. */
export type TokenBreakdown = {
  messages: number
  systemPrompt: number
  tools: number
  skills: number
  /** true = per-category counts are heuristic estimates (only `other` is calibrated). */
  estimated?: boolean
}

export type SessionContextBreakdownKey =
  // frontend-estimated categories
  | "system"
  | "user"
  | "assistant"
  | "tool"
  | "other"
  // backend-reported categories (from Rust TokenBreakdown)
  | "messages"
  | "systemPrompt"
  | "tools"
  | "skills"

export type SessionContextBreakdownSegment = {
  key: SessionContextBreakdownKey
  tokens: number
  width: number
  percent: number
}

/** CJK Unicode ranges: Han, Hiragana, Katakana, Hangul, CJK extensions */
const isCJK = (ch: string): boolean => {
  const cp = ch.codePointAt(0)!
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x2e80 && cp <= 0x2eff) ||
    (cp >= 0x31c0 && cp <= 0x31ef)
  )
}

/** Weighted char count: a CJK char ≈ 1 token (≈4 ASCII chars), an ASCII char
 *  ≈ 0.25 token. Feeding this into estimateTokens (chars / 4) yields a
 *  CJK-aware estimate while keeping pure-ASCII results identical to chars/4. */
const weightedChars = (text: string): number => {
  let n = 0
  for (const ch of text) n += isCJK(ch) ? 4 : 1
  return n
}

const estimateTokens = (chars: number) => Math.ceil(chars / 4)
const toPercent = (tokens: number, input: number) => (tokens / input) * 100
const toPercentLabel = (tokens: number, input: number) => Math.round(toPercent(tokens, input) * 10) / 10

const charsFromUserPart = (part: Part) => {
  if (part.type === "text") return weightedChars(part.text)
  if (part.type === "file") return weightedChars(part.source?.text.value ?? "")
  if (part.type === "agent") return weightedChars(part.source?.value ?? "")
  return 0
}

const charsFromAssistantPart = (part: Part) => {
  if (part.type === "text") return { assistant: weightedChars(part.text), tool: 0 }
  if (part.type === "reasoning") return { assistant: weightedChars(part.text), tool: 0 }
  if (part.type !== "tool") return { assistant: 0, tool: 0 }

  const input = Object.keys(part.state.input).length * 16
  if (part.state.status === "pending") return { assistant: 0, tool: input + weightedChars(part.state.raw) }
  if (part.state.status === "completed") return { assistant: 0, tool: input + weightedChars(part.state.output) }
  if (part.state.status === "error") return { assistant: 0, tool: input + weightedChars(part.state.error) }
  return { assistant: 0, tool: input }
}

/** Map token entries to breakdown segments.
 *  The last segment's percent is calculated as 100 minus the sum of all
 *  preceding segments, so the displayed percentages always sum to exactly 100%. */
const buildSegments = (
  entries: Array<{ key: SessionContextBreakdownKey; tokens: number }>,
  input: number,
): SessionContextBreakdownSegment[] => {
  const nonZero = entries.filter((x) => x.tokens > 0)
  if (nonZero.length === 0) return []

  const segments = nonZero.map((x) => ({
    key: x.key,
    tokens: x.tokens,
    width: toPercent(x.tokens, input),
    percent: toPercentLabel(x.tokens, input),
  }))

  // Fix last item so percentages sum to exactly 100
  const sumExceptLast = segments.slice(0, -1).reduce((s, seg) => s + seg.percent, 0)
  segments[segments.length - 1]!.percent = Math.round((100 - sumExceptLast) * 10) / 10

  return segments as SessionContextBreakdownSegment[]
}

export function estimateSessionContextBreakdown(args: {
  messages: Message[]
  parts: Record<string, Part[] | undefined>
  input: number
  systemPrompt?: string
}) {
  if (!args.input) return []

  const counts = args.messages.reduce(
    (acc, msg) => {
      const parts = args.parts[msg.id] ?? []
      if (msg.role === "user") {
        const user = parts.reduce((sum, part) => sum + charsFromUserPart(part), 0)
        return { ...acc, user: acc.user + user }
      }

      if (msg.role !== "assistant") return acc
      const assistant = parts.reduce(
        (sum, part) => {
          const next = charsFromAssistantPart(part)
          return {
            assistant: sum.assistant + next.assistant,
            tool: sum.tool + next.tool,
          }
        },
        { assistant: 0, tool: 0 },
      )
      return {
        ...acc,
        assistant: acc.assistant + assistant.assistant,
        tool: acc.tool + assistant.tool,
      }
    },
    {
      system: weightedChars(args.systemPrompt ?? ""),
      user: 0,
      assistant: 0,
      tool: 0,
    },
  )

  const tokens = {
    system: estimateTokens(counts.system),
    user: estimateTokens(counts.user),
    assistant: estimateTokens(counts.assistant),
    tool: estimateTokens(counts.tool),
  }
  const estimated = tokens.system + tokens.user + tokens.assistant + tokens.tool

  if (estimated <= args.input) {
    return buildSegments(
      [
        { key: "system", tokens: tokens.system },
        { key: "user", tokens: tokens.user },
        { key: "assistant", tokens: tokens.assistant },
        { key: "tool", tokens: tokens.tool },
        { key: "other", tokens: args.input - estimated },
      ],
      args.input,
    )
  }

  const scale = args.input / estimated
  const scaled = {
    system: Math.floor(tokens.system * scale),
    user: Math.floor(tokens.user * scale),
    assistant: Math.floor(tokens.assistant * scale),
    tool: Math.floor(tokens.tool * scale),
  }
  const total = scaled.system + scaled.user + scaled.assistant + scaled.tool
  return buildSegments(
    [
      { key: "system", tokens: scaled.system },
      { key: "user", tokens: scaled.user },
      { key: "assistant", tokens: scaled.assistant },
      { key: "tool", tokens: scaled.tool },
      { key: "other", tokens: Math.max(0, args.input - total) },
    ],
    args.input,
  )
}

/** Build breakdown segments from backend-reported TokenBreakdown (Rust side).
 *  The backend provides more accurate per-category counts using
 *  estimate_request_breakdown + LLM-reported prompt_tokens calibration. */
export function buildBreakdownFromBackend(breakdown: TokenBreakdown, input: number) {
  if (!input) return []

  const messages = Math.round(breakdown.messages)
  const systemPrompt = Math.round(breakdown.systemPrompt)
  const tools = Math.round(breakdown.tools)
  const skills = Math.round(breakdown.skills)
  // other absorbs rounding drift so the sum always equals input exactly
  const other = input - messages - systemPrompt - tools - skills

  return buildSegments(
    [
      { key: "messages", tokens: messages },
      { key: "systemPrompt", tokens: systemPrompt },
      { key: "tools", tokens: tools },
      { key: "skills", tokens: skills },
      { key: "other", tokens: Math.max(0, other) },
    ],
    input,
  )
}
