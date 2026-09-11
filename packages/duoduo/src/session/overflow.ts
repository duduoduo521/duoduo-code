import type { Config } from "@/config"
import type { Provider } from "@/provider"
import { ProviderTransform } from "@/provider"
import type { MessageV2 } from "./message-v2"
import * as Token from "@/util/token"

const COMPACTION_BUFFER = 20_000

/**
 * Context utilization target — the fraction of model context that should be
 * used for INPUT before triggering compaction. Keeping this well below 100%
 * is critical for LLM attention quality:
 *
 * - Research ("Lost in the Middle", Liu et al. 2023) shows LLM performance
 *   degrades significantly when context exceeds ~60-70% of capacity.
 * - Over-stuffed context causes the model to "lose focus" — it can't
 *   distinguish signal from noise, misses instructions in the middle,
 *   and produces lower-quality responses.
 * - A 65% target leaves 35% headroom: output tokens + breathing room
 *   for the model to maintain coherent attention across the full context.
 *
 * This is the MAXIMUM utilization target. Compaction triggers BEFORE
 * reaching this threshold (see isEstimatedOverflow), so actual usage
 * will typically be lower.
 */
const CONTEXT_UTILIZATION_TARGET = 0.65

// ─── Runtime-discovered context windows ───
// When a model's limit.context is 0 (unconfigured), overflow errors from the
// LLM API often reveal the actual context window (e.g. Xunfei:
// "Range of input length should be [1, 202745]"). We cache these discovered
// values keyed by providerID/modelID so that subsequent overflow checks
// (isEstimatedOverflow, isOverflow, etc.) can use them as a fallback,
// enabling proactive compaction before the next API call also fails.
const discoveredContextWindows: Map<string, number> = new Map()

/** Cache key for discovered context windows: providerID/modelID */
function discoveredKey(model: Provider.Model): string {
  return `${model.providerID}/${model.id}`
}

/** Persist a runtime-discovered context window for a model.
 * Only writes when no value is already cached (first discovery wins),
 * to avoid overwriting with stale/inaccurate values from subsequent errors.
 * Returns true if the value was stored, false if already present. */
export function persistDiscoveredContextWindow(model: Provider.Model, contextWindow: number): boolean {
  const key = discoveredKey(model)
  if (discoveredContextWindows.has(key)) return false
  if (contextWindow <= 0) return false
  discoveredContextWindows.set(key, contextWindow)
  return true
}

/** Retrieve a runtime-discovered context window for a model.
 * Returns undefined if no value has been discovered for this model. */
export function getDiscoveredContextWindow(model: Provider.Model): number | undefined {
  return discoveredContextWindows.get(discoveredKey(model))
}

// ─── Runtime-discovered output (max_tokens) limits ───
// When a model's limit.output is wrong/too high, the LLM API rejects the
// request with a max_tokens error. We retry with progressively smaller values
// (see SessionPrompt.delegateToRustRunLoop) and cache the first value that
// succeeds, so subsequent turns skip the retry dance. Same shape as the
// discoveredContextWindows cache above.
const discoveredOutputLimits: Map<string, number> = new Map()

/** Persist a runtime-discovered output limit for a model.
 * Only writes when no value is already cached (first discovery wins).
 * Returns true if stored, false if already present or invalid. */
export function persistDiscoveredOutputLimit(model: Provider.Model, outputLimit: number): boolean {
  const key = discoveredKey(model)
  if (discoveredOutputLimits.has(key)) return false
  if (outputLimit <= 0) return false
  discoveredOutputLimits.set(key, outputLimit)
  return true
}

/** Retrieve a runtime-discovered output limit for a model.
 * Returns undefined if no value has been discovered for this model. */
export function getDiscoveredOutputLimit(model: Provider.Model): number | undefined {
  return discoveredOutputLimits.get(discoveredKey(model))
}

/** Resolve the effective context window for a model.
 * Priority: model.limit.context (configured) > runtime-discovered > inferred from model name > safe default
 * The safe default (128K) ensures overflow detection still works for unconfigured models. */
export function resolveContextWindow(model: Provider.Model): number {
  if (model.limit.context > 0) return model.limit.context
  const discovered = discoveredContextWindows.get(discoveredKey(model))
  if (discovered) return discovered
  const inferred = inferContextFromModel(model)
  if (inferred > 0) return inferred
  // Safe default: most modern models support at least 128K context.
  // This allows proactive overflow detection to work even for unconfigured
  // models. The LLM's actual context will be discovered from overflow errors.
  return 128_000
}

/** Attempt to infer the context size from model name/id.
 * Common patterns: "glm-4-200k", "deepseek-r1-128k", "qwen2.5-1m".
 * Returns 0 if no recognizable context size is found. */
function inferContextFromModel(model: Provider.Model): number {
  const text = `${model.name} ${model.id}`.toLowerCase()

  // Match Nk/NK patterns: "200k", "128k", "32k", "1k"
  const kMatch = text.match(/(\d+)k\b/i)
  if (kMatch) {
    const n = Number.parseInt(kMatch[1]!, 10)
    if (n > 0) return n * 1000
  }

  // Match Nm/NM patterns: "1m", "2m"
  const mMatch = text.match(/(\d+)m\b/i)
  if (mMatch) {
    const n = Number.parseInt(mMatch[1]!, 10)
    if (n > 0) return n * 1_000_000
  }

  // Match Ng/NG patterns (giga): "1g", "2g"
  const gMatch = text.match(/(\d+)g\b/i)
  if (gMatch) {
    const n = Number.parseInt(gMatch[1]!, 10)
    if (n > 0) return n * 1_000_000_000
  }

  return 0
}

/** Extract a context window size from an LLM error message.
 *
 * Supported patterns:
 * - Xunfei: "Range of input length should be [1, N]"
 * - OpenAI: "maximum context length is N tokens"
 * - Generic: "context length: N" / "maximum context length: N"
 * - Generic: "This model's maximum context length is N tokens"
 *
 * Returns the extracted number, or undefined if no pattern matches. */
export function extractContextWindowFromError(errorText: string): number | undefined {
  // Pattern: "Range of input length should be [1, N]" (Xunfei Spark)
  const xunfeiMatch = errorText.match(/Range of input length should be \[1,\s*(\d+)\]/i)
  if (xunfeiMatch) {
    const n = Number.parseInt(xunfeiMatch[1]!, 10)
    if (n > 0) return n
  }

  // Pattern: "input token limit is N" (Xunfei Spark v2)
  const xunfeiV2Match = errorText.match(/input token limit is (\d+)/i)
  if (xunfeiV2Match) {
    const n = Number.parseInt(xunfeiV2Match[1]!, 10)
    if (n > 0) return n
  }

  // Pattern: "maximum context length is N tokens" (OpenAI)
  const openaiMatch = errorText.match(/maximum context length is (\d+)/i)
  if (openaiMatch) {
    const n = Number.parseInt(openaiMatch[1]!, 10)
    if (n > 0) return n
  }

  // Pattern: "This model's maximum context length is N tokens"
  const modelMatch = errorText.match(/model's maximum context length is (\d+)/i)
  if (modelMatch) {
    const n = Number.parseInt(modelMatch[1]!, 10)
    if (n > 0) return n
  }

  // Pattern: "maximum context length: N" or "context length: N"
  const genericMatch = errorText.match(/(?:maximum )?context length[:\s]+(\d+)/i)
  if (genericMatch) {
    const n = Number.parseInt(genericMatch[1]!, 10)
    if (n > 0) return n
  }

  return undefined
}

/** Memory context budget scales with model context size.
 * - 8K models:  2K tokens  (same as old default)
 * - 32K models: 4K tokens
 * - 128K models: 8K tokens
 * - 200K+ models: 12K tokens (capped)
 *
 * The budget is ~5% of usable context, with a floor of 2K and ceiling of 12K.
 * This ensures small models don't waste precious context on memories,
 * while large models can leverage richer recall including KG context. */
export function dynamicMemoryBudget(input: { cfg: Config.Info; model: Provider.Model }): number {
  const budget = effectiveUsable(input)
  if (budget === 0) return 2000 // unknown limit, use safe minimum

  // 5% of effective usable context, floored at 2K, capped at 12K
  const memBudget = Math.round(budget * 0.05)
  return Math.max(2000, Math.min(memBudget, 12_000))
}

/**
 * The hard upper bound for input tokens — the absolute maximum before we
 * risk hitting the model's API limit. Used as a safety net only.
 * input = context - maxOutputTokens - compactionBuffer
 *
 * When model.limit.context === 0 (unconfigured), falls back to the
 * runtime-discovered context window if available.
 */
export function usable(input: { cfg: Config.Info; model: Provider.Model }) {
  const context = resolveContextWindow(input.model)
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  if (input.model.limit.input) return Math.max(0, input.model.limit.input - reserved)
  // Reserve room for output, but never more than half the context. When
  // limit.output is unconfigured (0), maxOutputTokens falls back to
  // OUTPUT_TOKEN_MAX (32K default); for a small context window that fallback
  // can meet or exceed the context and drive usable() to 0 — which makes
  // isOverflow always true and triggers endless compaction. Real models always
  // have output well below context/2, so this cap is a no-op in normal cases
  // and only guards the degenerate unconfigured/small-context case.
  const outputReserve = Math.min(ProviderTransform.maxOutputTokens(input.model), Math.floor(context / 2))
  return Math.max(0, context - outputReserve)
}

/**
 * The EFFECTIVE usable context — the target maximum for input tokens that
 * preserves LLM attention quality. This is significantly lower than the
 * hard `usable()` limit:
 *
 *   effectiveUsable = usable() * CONTEXT_UTILIZATION_TARGET
 *
 * For a 128K model: usable() ≈ 100K → effectiveUsable ≈ 65K
 *   → 65K for input, 63K of headroom for output + attention quality
 *
 * For a 1M model: usable() ≈ 980K → effectiveUsable ≈ 637K
 *   → 637K for input, 363K of headroom
 *
 * All compaction and overflow decisions use effectiveUsable instead of
 * the hard usable() limit. This ensures the model always has enough
 * "breathing room" to maintain high-quality attention.
 */
export function effectiveUsable(input: { cfg: Config.Info; model: Provider.Model }): number {
  const hardLimit = usable(input)
  if (hardLimit === 0) return 0
  return Math.round(hardLimit * CONTEXT_UTILIZATION_TARGET)
}

export function isOverflow(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  if (input.cfg.compaction?.auto === false) return false
  // Use resolveContextWindow to include runtime-discovered fallback
  if (resolveContextWindow(input.model) === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  // Use effectiveUsable (attention-quality-aware) instead of raw usable()
  return count >= effectiveUsable(input)
}

/** Proactive pre-send overflow detection: estimate token count from the raw
 *  message payload before sending to the LLM. If approaching the model's
 *  effective context limit, trigger compaction preemptively to avoid:
 *  1. Wasting an API call that returns context_overflow
 *  2. Stuffing context so full that LLM attention quality degrades
 *
 *  This uses a lightweight character-level estimate (CJK-aware) rather than
 *  an exact tokenizer, so it may over-estimate slightly — that's acceptable
 *  because we want to compact BEFORE hitting the effective limit.
 *
 *  When model.limit.context === 0, falls back to the runtime-discovered
 *  context window. If no context window is known at all, returns false
 *  (skip the check — the LLM will tell us via an error). */
export function isEstimatedOverflow(input: {
  cfg: Config.Info
  model: Provider.Model
  /** JSON-serialized model messages payload (legacy — prefer estimatedTokens) */
  payload?: string
  /** Pre-computed token estimate, avoids JSON.stringify overhead */
  estimatedTokens?: number
}): boolean {
  if (input.cfg.compaction?.auto === false) return false
  // Use resolveContextWindow to include runtime-discovered fallback
  if (resolveContextWindow(input.model) === 0) return false

  const estimatedTokens = input.estimatedTokens ?? (input.payload ? Token.estimate(input.payload) : 0)
  const effectiveLimit = effectiveUsable(input)
  if (effectiveLimit === 0) return false
  // 90% of the EFFECTIVE limit (which is already 65% of hard limit).
  // This means compaction triggers at ~58.5% of the hard context limit,
  // ensuring the model always has generous headroom for quality output.
  return Token.isApproachingLimit(estimatedTokens, effectiveLimit, 0.9)
}
