import { describe, expect, test } from "bun:test"
import { resolvePromptFamily, type PromptFamily } from "../../src/session/system"

/**
 * Regression guard for `provider()` prompt routing.
 *
 * Two defects were fixed here:
 *  1. `gpt-4` / o-series were checked BEFORE `codex`, so codex models — which
 *     are also `gpt-*` — were routed to the BEAST prompt and the dedicated
 *     codex prompt was unreachable.
 *  2. o-series detection used a bare `id.includes("o1")` substring test, which
 *     matched any id merely containing those characters (`llama-o1`,
 *     `qwen-o3-max`, `minimax-o1`) and misrouted foreign models to an
 *     OpenAI-specific prompt.
 */
describe("resolvePromptFamily", () => {
  const cases: Array<[string, PromptFamily]> = [
    // ── codex must win over every other OpenAI branch ──
    ["gpt-5-codex", "codex"],
    ["gpt-4-codex", "codex"],
    ["codex-mini-latest", "codex"],
    ["openai/gpt-5-codex", "codex"],

    // ── gpt-4 family → beast ──
    ["gpt-4", "beast"],
    ["gpt-4o", "beast"],
    ["gpt-4o-mini", "beast"],
    ["gpt-4-turbo", "beast"],
    ["gpt-4.1", "beast"],

    // ── genuine OpenAI o-series → beast ──
    ["o1", "beast"],
    ["o1-preview", "beast"],
    ["o1-mini", "beast"],
    ["o3", "beast"],
    ["o3-mini", "beast"],
    ["o3-pro", "beast"],
    ["o4-mini", "beast"],
    ["openai/o3", "beast"],
    ["openai/o1-preview", "beast"],

    // ── other gpt models → gpt ──
    ["gpt-3.5-turbo", "gpt"],
    ["gpt-5", "gpt"],

    // ── other vendors ──
    ["gemini-2.5-pro", "gemini"],
    ["gemini-1.5-flash", "gemini"],
    ["claude-sonnet-4-5", "anthropic"],
    ["claude-opus-4", "anthropic"],
    ["trinity-large", "trinity"],
    ["kimi-k2", "kimi"],
    ["moonshotai/kimi-k2", "kimi"],

    // ── the misrouting the fix targets: foreign models carrying an o-series
    //    suffix must NOT be treated as OpenAI reasoning models ──
    ["llama-o1", "default"],
    ["qwen-o3-max", "default"],
    ["minimax-o1", "default"],
    ["yi-o1-chat", "default"],

    // ── unrelated ──
    ["deepseek-chat", "default"],
    ["deepseek-reasoner", "default"],
    ["glm-4.6", "default"],
    ["codestral-latest", "default"],
    ["o1pro", "default"], // not a real o-series release
  ]

  for (const [id, expected] of cases) {
    test(`${id} → ${expected}`, () => {
      expect(resolvePromptFamily(id)).toBe(expected)
    })
  }

  test("codex is checked before gpt-4 and the o-series", () => {
    // The ordering bug in one assertion: a codex model that also matches the
    // gpt-4 branch must still resolve to codex.
    expect(resolvePromptFamily("gpt-4-codex")).toBe("codex")
    expect(resolvePromptFamily("gpt-4-codex")).not.toBe("beast")
  })

  test("routing is case-insensitive", () => {
    expect(resolvePromptFamily("GPT-4")).toBe("beast")
    expect(resolvePromptFamily("Claude-Sonnet-4-5")).toBe("anthropic")
    expect(resolvePromptFamily("Kimi-K2-Instruct")).toBe("kimi")
    expect(resolvePromptFamily("Trinity-1")).toBe("trinity")
    expect(resolvePromptFamily("GPT-5-Codex")).toBe("codex")
    expect(resolvePromptFamily("O3-Mini")).toBe("beast")
  })

  test("every model id resolves to exactly one family", () => {
    const families = new Set<PromptFamily>()
    for (const [id] of cases) families.add(resolvePromptFamily(id))
    // Sanity: the table exercises every branch.
    expect(families).toEqual(
      new Set<PromptFamily>(["codex", "beast", "gpt", "gemini", "anthropic", "trinity", "kimi", "default"]),
    )
  })

  test("resolution is deterministic", () => {
    for (const [id, expected] of cases) {
      for (let i = 0; i < 3; i++) expect(resolvePromptFamily(id)).toBe(expected)
    }
  })

  test("empty and degenerate ids fall back to default", () => {
    expect(resolvePromptFamily("")).toBe("default")
    expect(resolvePromptFamily("-")).toBe("default")
    expect(resolvePromptFamily("o")).toBe("default")
    expect(resolvePromptFamily("o0")).toBe("default")
  })
})
