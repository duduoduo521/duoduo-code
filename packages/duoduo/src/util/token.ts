const ASCII_CHARS_PER_TOKEN = 4
// 1 CJK char ≈ 1 token (cl100k average ~1.3). Using 1.0 keeps estimates on the
// safe side — a slight over-estimate makes compaction trigger a bit earlier,
// never later. The previous 1.5 under-counted Chinese by ~40%, which risked
// silently exceeding the real context window before compaction kicked in.
const CJK_CHARS_PER_TOKEN = 1.0

/** CJK Unicode ranges: Han, Hiragana, Katakana, Hangul, CJK extensions */
function isCJK(ch: string): boolean {
  const cp = ch.codePointAt(0)!
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xff00 && cp <= 0xffef) || // Halfwidth/Fullwidth Forms
    (cp >= 0x3000 && cp <= 0x303f) || // CJK Symbols and Punctuation
    (cp >= 0x2e80 && cp <= 0x2eff) || // CJK Radicals Supplement
    (cp >= 0x31c0 && cp <= 0x31ef) // CJK Strokes
  )
}

export function estimate(input: string): number {
  if (!input) return 0
  let cjkCount = 0
  let asciiCount = 0
  for (const ch of input) {
    if (isCJK(ch)) cjkCount++
    else asciiCount++
  }
  // CJK characters consume ~1.5x more tokens than ASCII per character
  // (1 CJK char ≈ 1-2 tokens, 1 ASCII char ≈ 0.25 tokens)
  return Math.round(cjkCount / CJK_CHARS_PER_TOKEN + asciiCount / ASCII_CHARS_PER_TOKEN)
}

/** Estimate token count directly from message parts, skipping
 *  the expensive toModelMessagesEffect + JSON.stringify pipeline.
 *  This counts CJK/ASCII characters in all text-bearing fields
 *  (text parts, tool output, reasoning text, etc.) and applies a
 *  ~15% overhead factor to account for JSON structure (keys, brackets,
 *  commas) and metadata fields that don't contribute much text.
 *
 *  Deliberately over-estimates: compaction triggers earlier which is
 *  safe — we have 41.5% headroom from the hard context limit.
 *  Only under-estimation would cause issues (API overflow errors). */
export function estimateFromParts(
  parts: Array<{
    type: string
    text?: string
    state?: any
    prompt?: string
    description?: string
    summary?: string
    url?: string
    mime?: string
  }>,
): number {
  // Count CJK and ASCII characters separately so the estimate is accurate for
  // both Chinese and English/code. Structural bytes (JSON keys, tool names,
  // envelopes, base64 data URLs) are ASCII and counted as such.
  let cjk = 0
  let ascii = 0
  const count = (text: string | undefined) => {
    if (!text) return
    for (const ch of text) {
      if (isCJK(ch)) cjk++
      else ascii++
    }
  }
  for (const part of parts) {
    switch (part.type) {
      case "text":
      case "reasoning":
        count(part.text)
        break
      case "tool": {
        const state = part.state
        if (!state) break
        // Completed tool output is the biggest contributor.
        // Compacted outputs are replaced with a short placeholder
        // in toModelMessagesEffect, so count them conservatively.
        if (state.status === "completed") {
          if (state.time?.compacted) ascii += 40 // "[Old tool result content cleared]" placeholder length
          else count(state.output)
          ascii += 20 // tool name + title + input keys structure overhead
        } else if (state.status === "error") {
          count(state.error)
          ascii += 20
        } else if (state.status === "pending" || state.status === "running") {
          count(state.raw)
          ascii += 20
        }
        break
      }
      case "file": {
        // Data URLs carry the full base64 payload inline (ASCII) — count their length.
        // Remote URLs are short (http://…) and the 40-char envelope covers them.
        const urlLen = part.url?.length ?? 0
        ascii += urlLen > 0 ? urlLen : 40
        // Envelope overhead: "[Attached mime: filename]" or JSON image block keys
        ascii += 40
        break
      }
      case "subtask":
        count(part.prompt)
        count(part.description)
        break
      case "review":
        count(part.summary)
        break
      // step-start, step-finish, patch, agent, compaction, retry:
      // negligible text contribution, skip for speed.
    }
  }
  if (cjk === 0 && ascii === 0) return 0
  // 15% overhead: JSON keys, brackets, commas, role markers, etc. that the
  // char scan skips but JSON.stringify would add.
  return Math.round((cjk / CJK_CHARS_PER_TOKEN + ascii / ASCII_CHARS_PER_TOKEN) * 1.15)
}

/** Estimate tokens from a raw character length (as if it were all
 *  mixed CJK/ASCII text) with a structure overhead multiplier.
 *  Generic helper for callers that only have a character count, not the
 *  original text (estimateFromParts now counts CJK/ASCII directly). */
export function estimateFromLength(charLength: number, overheadFactor = 1.15): number {
  if (!charLength) return 0
  // Assume ~50% CJK for mixed content (slight over-estimate is safe).
  // For pure ASCII this over-estimates by ~25%, which is still safe
  // given our 41.5% headroom from the hard context limit.
  const cjkHalf = charLength * 0.5
  const asciiHalf = charLength * 0.5
  return Math.round((cjkHalf / CJK_CHARS_PER_TOKEN + asciiHalf / ASCII_CHARS_PER_TOKEN) * overheadFactor)
}

/** Quick check whether estimated tokens approach the model's context limit.
 * Used for proactive (pre-send) overflow detection before the LLM call. */
export function isApproachingLimit(
  estimatedTokens: number,
  modelContextLimit: number,
  threshold = 0.8, // 80% of context limit
): boolean {
  if (modelContextLimit === 0) return false // unknown limit, skip check
  return estimatedTokens >= modelContextLimit * threshold
}
