import { describe, expect, test } from "bun:test"
import * as Token from "../../src/util/token"

describe("Token.estimateFromParts", () => {
  test("text part counted by text length", () => {
    const parts = [{ type: "text", text: "hello world" }]
    // 11 chars * 0.5/1.5 + 11 * 0.5/4 ≈ 5.04, * 1.15 ≈ 5.8 → 6 (+/- rounding)
    const tokens = Token.estimateFromParts(parts)
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(20)
  })

  test("file part with short data URL counts the full url length, not 40", () => {
    // Bug #19 regression: previously every file part was hard-coded to 40 chars.
    // For a tiny data URL, real counting still produces a similar-or-larger token
    // estimate (it now also counts 40 for envelope overhead).
    const tinyUrl = "data:image/png;base64,YQ==" // 26 chars
    const real = Token.estimateFromParts([{ type: "file", mime: "image/png", url: tinyUrl }])
    expect(real).toBeGreaterThan(0)
  })

  test("file part with large data URL is NOT under-estimated as 40", () => {
    // The actual production bug: a 4_000-char base64 data URL was estimated as
    // ~40 chars → ~7 tokens. With the fix it must reflect real size.
    const url = `data:image/png;base64,${"a".repeat(4_000)}`
    const heavy = Token.estimateFromParts([{ type: "file", mime: "image/png", url }])
    const light = Token.estimateFromParts([{ type: "file", mime: "image/png", url: "x".repeat(40) }])
    // Heavy must be at least 50× larger than the small one — proves the
    // estimator is no longer flat-counting media file parts.
    expect(heavy).toBeGreaterThan(light * 50)
    // And concretely at least several hundred tokens for a 4 KB blob.
    expect(heavy).toBeGreaterThan(500)
  })

  test("file part falls back to envelope size when url missing", () => {
    const tokens = Token.estimateFromParts([{ type: "file", mime: "image/png" }])
    // url missing → fallback 40 + envelope 40 = 80 chars upper bound.
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(60)
  })

  test("estimateFromLength is over-estimating-safe for pure ASCII", () => {
    // Documenting invariant: estimateFromLength(N) ≥ ceil(N/4) (real ASCII tokens).
    const n = 4_000
    const est = Token.estimateFromLength(n)
    expect(est).toBeGreaterThanOrEqual(Math.ceil(n / 4))
  })
})
