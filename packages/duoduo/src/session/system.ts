import { basename } from "node:path"
import { DuoduoError } from "@/util/error"
import { Context, Effect, Layer } from "effect"

import { Instance } from "../project/instance"
import { Instruction } from "./instruction"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import PROMPT_SHARED from "./prompt/shared.txt"

// Shared hard-constraints layer. Placed FIRST in every provider's prompt array
// so it forms a stable cache prefix (see buildEnvironmentLines cache note) and
// is deduplicated across all provider-specific files. Provider files below keep
// ONLY model-specific tuning (tone, formatting, workflow emphasis); all repeated
// rules (identity, security, tool policy, commit policy) live here once.
const SHARED = [PROMPT_SHARED]
import type { Provider } from "@/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { createSmartLayerClients } from "@/smart-layer"
import { Flag } from "@/flag/flag"
import { Log } from "@/util"
import type { TaskPhase } from "@/quality/types"

/**
 * Prompt-family identifiers returned by {@link resolvePromptFamily}.
 * Kept as a separate pure layer so routing is unit-testable without importing
 * the (bundler-only) `.txt` prompt assets.
 */
export type PromptFamily = "codex" | "beast" | "gpt" | "gemini" | "anthropic" | "trinity" | "kimi" | "default"

/**
 * Match an OpenAI reasoning-model id (`o1`, `o3-mini`, `openai/o3`, ...).
 *
 * The original implementation used `id.includes("o1")`, which matched any id
 * merely *containing* those two characters — `llama-o1`, `qwen-o3-max` and
 * `minimax-o1` were all misrouted to the OpenAI-specific BEAST prompt.
 *
 * OpenAI o-series ids always lead with the family marker (optionally behind a
 * provider namespace such as `openai/`), whereas the false positives carry it
 * as a trailing qualifier of a different vendor's family. Anchoring the match
 * to the start of the id — not merely to a separator boundary — is therefore
 * what actually separates the two cases. The trailing boundary additionally
 * rejects ids like `o1pro` that are not real o-series releases.
 */
const O_SERIES_ID = /^(?:[a-z0-9_.-]+\/)?o[1-9]\d*(?:$|[-_.])/

/**
 * Resolve the prompt family for a model id.
 *
 * Ordering rationale (each branch is order-sensitive):
 *  1. `codex` FIRST — codex models are also `gpt-*` (e.g. `gpt-4-codex`), so
 *     any `gpt-4`/o-series check placed before it would swallow them and the
 *     dedicated codex prompt would be unreachable.
 *  2. `gpt-4` / o-series → BEAST, but the o-series match is token-bounded so
 *     it cannot capture non-OpenAI ids.
 *  3. Remaining `gpt*` → GPT.
 */
export function resolvePromptFamily(modelId: string): PromptFamily {
  const id = modelId.toLowerCase()
  // Codex must be checked before every other OpenAI branch — see above.
  if (id.includes("codex")) return "codex"
  if (id.includes("gpt-4") || O_SERIES_ID.test(id)) return "beast"
  if (id.includes("gpt")) return "gpt"
  if (id.includes("gemini-")) return "gemini"
  if (id.includes("claude")) return "anthropic"
  if (id.includes("trinity")) return "trinity"
  if (id.includes("kimi")) return "kimi"
  return "default"
}

const PROMPT_BY_FAMILY: Record<PromptFamily, string> = {
  codex: PROMPT_CODEX,
  beast: PROMPT_BEAST,
  gpt: PROMPT_GPT,
  gemini: PROMPT_GEMINI,
  anthropic: PROMPT_ANTHROPIC,
  trinity: PROMPT_TRINITY,
  kimi: PROMPT_KIMI,
  default: PROMPT_DEFAULT,
}

export function provider(model: Provider.Model) {
  return [...SHARED, PROMPT_BY_FAMILY[resolvePromptFamily(model.api.id)]]
}

const smartLayerLog = Log.create({ service: "smart-layer" })

export interface Interface {
  readonly environment: (model: Provider.Model, opts?: { locale?: string }) => string[]
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined, unknown, unknown>
  readonly structuredContext: (
    sessionID: string,
    phase?: TaskPhase,
    userMessage?: string,
    tokenBudget?: number,
    projectPath?: string,
  ) => Effect.Effect<string | undefined, unknown, unknown>
  /**
   * A-class enhancement: assemble guidance for injection into system prompts.
   * - Coding standards (AGENTS.md family) via Instruction.system() (local, zero network).
   * - Shared types (KG Class/TypeAlias nodes) when `includeSharedTypes` is set.
   *   Reuses the EXACT scoping of the existing structuredContext KG channel
   *   (project id = Instance.directory) so it returns the same project-scoped
   *   data with no new cross-project leakage. Every KG failure degrades to
   *   "no list" — never breaks the request.
   * `excludeRemoteUrls` drops remote instruction sources so sub-agents never
   * receive supply-chain-exposed content.
   */
  readonly projectGuidance: (args?: {
    excludeRemoteUrls?: boolean
    tokenBudget?: number
    includeSharedTypes?: boolean
  }) => Effect.Effect<string | undefined, unknown, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/SystemPrompt") {}

const LOCALE_LABELS: Record<string, string> = {
  en: "English",
  zh: "Chinese (Simplified, 简体中文)",
  "zh-hans": "Chinese (Simplified, 简体中文)",
  "zh-hant": "Chinese (Traditional, 繁體中文)",
}

function formatLocaleDirective(locale?: string): string {
  if (!locale) {
    return "You MUST respond in the same language as the user's message. If the user writes in Chinese, respond in Chinese. If the user writes in English, respond in English. You MUST also think and reason (including any chain-of-thought / internal monologue) in that same language."
  }
  const key = locale.toLowerCase()
  const label = LOCALE_LABELS[key] ?? LOCALE_LABELS[key.split("-")[0]!] ?? locale
  return `User interface language preference: ${locale} (${label}). You MUST respond in ${label} for all natural-language output (explanations, summaries, error reports, code comments-when-asked). Keep code identifiers, file paths, shell commands, and quoted technical strings unchanged. If the user explicitly asks for another language in this message, the explicit request wins for that turn only. Apply this language requirement to both your reasoning (thinking) and your final response.`
}

// ─── Environment directives (extracted for clarity) ───────────────────────
// Dynamic lines are runtime-interpolated (model id, working dir, date,
// locale) and MUST stay in code. They are assembled here rather than inlined
// inside `environment()` so the method body stays readable.
function buildEnvironmentLines(model: Provider.Model): string[] {
  const project = Instance.project
  return [
    `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
    `Here is some useful information about the environment you are running in:`,
    `Working directory: ${Instance.directory}`,
    `Workspace root folder: ${Instance.worktree}`,
    `Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
    `Platform: ${process.platform}`,
    // NOTE: "Today's date" is intentionally NOT part of the environment block.
    // It changes daily and would invalidate the provider prompt-cache prefix of
    // every stable system block that follows it. It is appended as a trailing
    // directive by each caller via dateDirective() instead (llm.ts / prompt.ts /
    // decompose.ts), so stable blocks keep their cache prefix across days.
    `If you are unsure about recent information (libraries, APIs, frameworks, versions, current events), use the webfetch tool to verify before answering.`,
  ]
}

// ─── Date directive (cache-friendly placement) ───────────────────────────
// The only line in the system prompt that changes every day. Kept as a
// separate trailing directive so the stable system blocks BEFORE it keep a
// byte-identical prompt-cache prefix across days. Callers append it at the
// END of the system sequence and must NOT mark it with cache_control (see
// transform.ts applyCaching — Anthropic allows max 4 cache breakpoints and
// caching a daily-changing line is pointless anyway).
export function dateDirective(): string {
  return `Today's date: ${new Date().toDateString()}`
}

// ─── Project-context surfacing guidance ──────────────────────────────────
// The product injects project context (memory / architecture / knowledge-graph)
// via structuredContext() and exposes a blackboard tool family, but the provider
// txt files never mention them — so models ignore features that already exist.
// This is an informational pointer (NOT a new behavioral rule), appended through
// the universal `environment()` hook so it reaches every session, including
// custom agent prompts, without duplicating across 8 txt files.
const PROJECT_CONTEXT_GUIDANCE = `When available for this session, you are provided with injected project context (memory of prior work, architecture notes, knowledge-graph hints). Leverage it to avoid re-deriving known facts; if it conflicts with the actual current code, the code is the source of truth.
A shared blackboard (blackboard_read / blackboard_write / blackboard_find) may also be available for coordinating multi-step or multi-agent work — consult it when a task spans many files or agents, and write durable findings back to it.`

// ─── Universal concise-reply directive ──────────────────────────────────
// Models must keep replies concise. Each provider txt states this slightly
// differently (or not at all), causing drift. This single baseline is injected
// through the universal `environment()` hook so every session — including
// custom agent prompts — gets a consistent directive without duplicating it
// across 8 txt files.
const CONCISE_GUIDANCE = `Keep your responses concise and to the point. Match the level of detail to the task: a simple question gets a one-line (often one-word) answer; a complex task gets a structured but brief explanation. Avoid unnecessary preamble, filler openers, meta-commentary, and repetition.`

// ─── Universal code-search strategy directive ───────────────────────────
// Previously duplicated verbatim across all 8 provider txt files
// (anthropic/beast/codex/default/gemini/gpt/kimi/trinity). Now injected once
// through the universal `environment()` hook so every session — including
// custom agent prompts and the Rust run-loop path (which receives the
// TS-assembled system prompt via postRunLoop.system_prompt) — gets a
// consistent directive without per-file drift.
//
// Rewritten to be position-independent: the original "MUST use ... first"
// implied a temporal ordering that only held when the sentence sat inline
// within a provider's workflow. As a universal tail directive, "MUST prefer
// X over Y" carries the same behavioral intent without depending on where it
// appears in the prompt.
const SEARCH_STRATEGY_GUIDANCE = `When searching for code (functions, classes, variables, dependencies), you MUST prefer graph_query or symbol_search over brute-force text search — they are faster and more accurate. Use grep only for raw text search in non-code files (logs, configs), and use glob only for filename pattern matching when graph_query is unavailable.`

// ─── Code-reuse directive ───────────────────────────────────────────────
// Injected through the universal `environment()` hook so every session —
// including custom agent prompts, the Rust run-loop path, parallel-dispatched
// sub-agents, and TS sub-agent prompts — gets a consistent, position-independent
// instruction to reuse existing project code instead of rewriting it.
//
// Why this matters: without an explicit directive, different agents (or
// parallel sub-agents) independently reimplement the same helper, so the
// codebase accumulates duplicated logic. This directive makes "reuse first"
// the default behavior. It pairs with the write-time reuse reminder gate in
// `submit_stable_with_write` (blackboard-coordinator), which surfaces existing
// candidates automatically on every file write.
const REUSE_GUIDANCE = `When writing OR editing code, you MUST reuse existing project code before creating anything new. Procedure:
1. Before implementing, query the knowledge graph for an existing implementation: graph_query (query_type="search") and symbol_search by the function/class/feature name you are about to write. Also recall_memory to surface prior conventions.
2. If an existing symbol satisfies the need, import and call it — do NOT reimplement it in a new file or copy its body inline.
3. Only create a new symbol when no reusable one exists. When you do, check whether the same logic is (or will be) needed by >= 2 call sites; if so, extract it into a shared module/utility rather than duplicating it at each site.
4. At the end of a task that introduced or modified code, use graph_query (query_type="references_of") on the new symbols: if the same logic is now duplicated across >= 2 locations, refactor it into a single shared function/module.
Prefer reuse over reimplementation. Duplicated logic across files is a defect, not a shortcut.`

// ─── Universal parallel-read directive ───────────────────────────────────
// Injected through the universal `environment()` hook so every session —
// including custom agent prompts and the Rust run-loop path — gets a
// consistent instruction to batch independent file reads into a single
// message instead of round-by-round serial reads.
const PARALLEL_READ_GUIDANCE = `When the user asks you to review, read, or compare multiple independent files or documents, you MUST issue all the relevant read_file calls within a SINGLE message so they execute in parallel — do not read them one per round in sequence. Only batch files the user explicitly referenced in the current request that are genuinely independent; do not blindly read every file in a project.`

// ─── structuredContext cache ────────────────────────────────────────────
// Avoids re-querying memory/architecture/KG on every LLM call within the
// same user turn (runLoop may call `run` multiple times for tool-use loops).
// TTL: 5 minutes.
// Memory/Architecture data rarely changes within a session; conversation history
// serves as short-term memory for subsequent turns.
//
// Cache key MUST be composite. The Rust /context/structured endpoint retrieves
// on (sessionID, phase, userMessage, tokenBudget, projectPath) — keying on
// sessionID alone returns a context assembled for a DIFFERENT user message /
// phase / budget / project, which is a correctness bug, not just a stale read.
// Within one user turn all five inputs are constant, so the composite key
// preserves exactly the intended hit (tool-use loops) and only eliminates the
// hits that were always wrong.
const STRUCTURED_CTX_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const MAX_CACHE_SIZE = 64
const structuredCtxCache = new Map<string, { result: string | undefined; timestamp: number }>()
const cacheStats = { hits: 0, misses: 0 }

/**
 * Stable non-cryptographic hash (FNV-1a 32-bit) used to fold `userMessage`
 * into the cache key without retaining the raw text in memory. Collisions are
 * irrelevant for correctness beyond the existing TTL semantics and the key
 * also carries the message length, which makes accidental collisions between
 * real prompts vanishingly unlikely.
 */
export function hashCacheComponent(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    // FNV prime 16777619, kept in 32-bit space via Math.imul.
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * Build the composite structuredContext cache key.
 *
 * Exported (and pure) so the key's discriminating power is unit-testable
 * without a running sidecar.
 */
export function buildStructuredCtxCacheKey(args: {
  sessionID: string
  phase: string
  userMessage?: string
  tokenBudget: number
  projectPath: string
}): string {
  const msg = args.userMessage ?? ""
  // Length is included alongside the hash so two different messages must
  // collide on BOTH to share a key.
  const msgPart = `${msg.length}:${hashCacheComponent(msg)}`
  return [
    args.sessionID,
    args.phase,
    msgPart,
    String(args.tokenBudget),
    hashCacheComponent(args.projectPath),
  ].join("|")
}


/**
 * Build the "## Shared Types" reference section from the knowledge graph.
 *
 * Correctness guards (each verified against code):
 *  - Gated by Flag.DUODUO_KG_ENABLED; returns undefined when KG is disabled.
 *  - createSmartLayerClients() returns null when the sidecar is down → skip.
 *  - Scoped by `Instance.directory`. The backend derives the graph's project
 *    identity from that same directory, so passing it is what makes the query
 *    address the nodes indexing wrote.
 *  - Each nodesByType call is independently wrapped: a failure yields [] rather
 *    than throwing, so a KG outage degrades to "no list", never a crashed request.
 *  - The list is reference-only with a "may be slightly out of date" disclaimer,
 *    because the KG is a snapshot (file-watcher refresh is best-effort).
 *  - Results are cached per project (TTL) so a multi-sub-agent turn does not
 *    hammer the sidecar with duplicated Class/TypeAlias queries.
 */
const SHARED_TYPES_TTL_MS = 5 * 60 * 1000
type SharedTypeNode = { label: string; type: string }
// Cache the raw KG nodes (not the rendered text) so a cache hit can still be
// re-truncated to the *current* budget. Storing pre-formatted strings would
// force a double-formatting bug (see renderSharedTypesSection).
const sharedTypesCache = new Map<
  string,
  { ts: number; classNodes: SharedTypeNode[]; typeAliasNodes: SharedTypeNode[] }
>()


/**
 * Pure renderer: turn already-fetched KG nodes into the "## Shared Types"
 * reference section (or `undefined` when there is nothing to show).
 *
 * Kept pure (no Effect / IO) so the truncation + capping branches are
 * unit-testable deterministically without a running sidecar.
 */
export const renderSharedTypesSection = (
  classNodes: { label: string; type: string }[],
  typeAliasNodes: { label: string; type: string }[],
  budget: number,
): string | undefined => {
  const all = [...classNodes, ...typeAliasNodes]
  if (all.length === 0) return undefined
  // Cap the list; boundary-truncate to stay within budget at render time.
  const MAX_TYPES = 80
  const lines = all.slice(0, MAX_TYPES).map((n) => `- ${n.label} (${n.type})`)
  const kept: string[] = []
  let len = 0
  for (const l of lines) {
    if (kept.length > 0 && len + l.length + 1 > budget) break
    kept.push(l)
    len += l.length + 1
  }
  if (kept.length === 0) return undefined
  return [
    "## Shared Types (reference only — may be slightly out of date; always trust the actual code)",
    ...kept,
  ].join("\n")
}

export const buildSharedTypesSection = (
  budget: number,
  directory: string,
): Effect.Effect<string | undefined, unknown, unknown> =>
  Effect.gen(function* () {
    if (!Flag.DUODUO_KG_ENABLED) {
      smartLayerLog.debug("buildSharedTypesSection: skipped (DUODUO_KG_ENABLED=false)")
      return undefined
    }
    const clients = createSmartLayerClients()
    if (!clients) {
      smartLayerLog.debug("buildSharedTypesSection: skipped (smart-layer unavailable)")
      return undefined
    }

    // ── Cache lookup (per project directory) ──
    const cached = sharedTypesCache.get(directory)
    let classNodes: SharedTypeNode[]
    let typeAliasNodes: SharedTypeNode[]
    if (cached && Date.now() - cached.ts < SHARED_TYPES_TTL_MS) {
      classNodes = cached.classNodes
      typeAliasNodes = cached.typeAliasNodes
      smartLayerLog.debug("buildSharedTypesSection: cache hit", {
        directory,
        count: classNodes.length + typeAliasNodes.length,
      })
    } else {
      const queryType = (nodeType: string) =>
        Effect.tryPromise({
          try: () =>
            // Defensive strip: nodesByType returns KGEntity[] (id + properties
            // super-set). Project down to the {label, type} SharedTypeNode shape
            // so a future KGEntity field change can't silently alter downstream
            // rendering through structural typing.
            clients.graph.nodesByType(nodeType, directory).then((xs) =>
              xs.map((e) => ({ label: e.label, type: e.type })),
            ),
          catch: () => new DuoduoError({ message: "kg nodesByType failed", messageZh: "kg nodesByType 查询失败", cause: undefined }),
        }).pipe(Effect.catch(() => Effect.succeed([] as SharedTypeNode[])))
      const [c, t] = yield* Effect.all([queryType("Class"), queryType("TypeAlias")])
      classNodes = c
      typeAliasNodes = t
      sharedTypesCache.set(directory, { ts: Date.now(), classNodes, typeAliasNodes })
      smartLayerLog.info("buildSharedTypesSection: queried KG", {
        directory,
        classCount: classNodes.length,
        typeAliasCount: typeAliasNodes.length,
      })
    }

    // Single source of truth for rendering: cap + budget truncation live in
    // renderSharedTypesSection, so we hand it the raw nodes (no pre-formatting).
    const section = renderSharedTypesSection(classNodes, typeAliasNodes, budget)
    if (!section) {
      smartLayerLog.debug("buildSharedTypesSection: empty, skipping", { directory })
    }
    return section
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const instruction = yield* Instruction.Service

    return Service.of({
      environment(model, opts) {
        const localeLine = formatLocaleDirective(opts?.locale)
        return [
          [...buildEnvironmentLines(model), localeLine, PROJECT_CONTEXT_GUIDANCE, CONCISE_GUIDANCE, SEARCH_STRATEGY_GUIDANCE, PARALLEL_READ_GUIDANCE, REUSE_GUIDANCE]
            .filter((x): x is string => !!x)
            .join("\n"),
        ]
      },

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),

      structuredContext(
        sessionID: string,
        phase: TaskPhase = "execute",
        userMessage?: string,
        tokenBudget = 2000,
        projectPath?: string,
      ): Effect.Effect<string | undefined, never, never> {
        return Effect.gen(function* () {
          // Resolve the effective project path ONCE so the cache key and the
          // request body cannot diverge (the `?? Instance.directory` fallback
          // must be part of the key, otherwise `undefined` and the explicit
          // directory would map to two entries holding identical results).
          const effectiveProjectPath = projectPath ?? Instance.directory

          // Check cache first — avoids repeated Rust-side assembly on
          // repeated LLM calls within the same user turn (tool-use loops).
          const cacheKey = buildStructuredCtxCacheKey({
            sessionID,
            phase,
            userMessage,
            tokenBudget,
            projectPath: effectiveProjectPath,
          })
          const cached = structuredCtxCache.get(cacheKey)
          if (cached) {
            const age = Date.now() - cached.timestamp
            if (age < STRUCTURED_CTX_CACHE_TTL_MS) {
              smartLayerLog.debug("structuredContext cache hit", {
                sessionID,
                ageMs: age,
              })
              cacheStats.hits++
              return cached.result
            }
            structuredCtxCache.delete(cacheKey)
          }

          cacheStats.misses++
          const ctxT0 = Date.now()

          // Delegate to Rust /context/structured endpoint.
          // The Rust side runs the full StructuredAssembler → GraphBuilder → Renderer
          // pipeline in-process (zero HTTP round-trips for memory/KG data).
          const clients = createSmartLayerClients()
          if (!clients) return undefined

          const rendered = yield* Effect.tryPromise({
            try: () =>
              clients.agent.postStructuredContext({
                sessionID,
                userMessage,
                tokenBudget,
                projectPath: effectiveProjectPath,
                phase,
                kgEnabled: Flag.DUODUO_KG_ENABLED,
              }),
            catch: () => new DuoduoError({ message: "Rust /context/structured failed", messageZh: "Rust /context/structured 请求失败", cause: undefined }),
          }).pipe(
            Effect.catch(() => Effect.void),
            Effect.map((r) => r?.rendered),
          )

          process.stderr.write(`[PERF] ${Date.now() - ctxT0}ms: structuredContext (Rust /context/structured)\n`)

          // Cache the result (including undefined) for subsequent calls
          structuredCtxCache.set(cacheKey, { result: rendered, timestamp: Date.now() })
          evictOldestIfNeeded()
          purgeExpiredEntries()

          return rendered
        })
      },

      projectGuidance(
        args?: { excludeRemoteUrls?: boolean; tokenBudget?: number; includeSharedTypes?: boolean },
      ): Effect.Effect<string | undefined, unknown, unknown> {
        return Effect.gen(function* () {
          const excludeRemote = args?.excludeRemoteUrls ?? false
          const includeShared = args?.includeSharedTypes ?? false
          const budget = args?.tokenBudget ?? 1500

          // ── ② Coding standards (AGENTS.md family, local) ──
          const blocks = yield* instruction.system()
          const filtered = excludeRemote
            ? blocks.filter((b) => !b.startsWith("Instructions from: http"))
            : blocks
          let codingStandards: string | undefined
          if (filtered.length > 0) {
            // Boundary-aware truncation: keep whole "Instructions from: ..." blocks so
            // we never cut a single rule in half (mitigates silent-spec-corruption).
            const kept: string[] = []
            let len = 0
            for (const b of filtered) {
              if (kept.length > 0 && len + b.length + 1 > budget) break
              kept.push(b)
              len += b.length + 1
            }
            if (kept.length > 0) codingStandards = ["## Coding Standards", ...kept].join("\n")
          }

          // ── ① Shared types (KG) — independently guarded so ② still injects
          //    even if the KG query fails entirely. ──
          const sharedTypes = includeShared
            ? yield* buildSharedTypesSection(budget, Instance.directory).pipe(
                Effect.catch(() => Effect.succeed(undefined)),
              )
            : undefined

          const sections = [codingStandards, sharedTypes].filter(Boolean) as string[]
          if (sections.length === 0) return undefined
          return sections.join("\n\n")
        }).pipe(
          // Never let an instruction/KG fetch failure break the user request.
          Effect.catch(() => Effect.succeed(undefined)),
        )
      },
    })
  }),
)

// ─── KG Context Fetcher (removed — KG queries now handled Rust-side in /context/structured) ───

/** Evict the oldest entry when cache exceeds MAX_CACHE_SIZE. */
function evictOldestIfNeeded() {
  if (structuredCtxCache.size <= MAX_CACHE_SIZE) return
  let oldestKey: string | null = null
  let oldestTime = Infinity
  for (const [key, entry] of structuredCtxCache) {
    if (entry.timestamp < oldestTime) {
      oldestTime = entry.timestamp
      oldestKey = key
    }
  }
  if (oldestKey) structuredCtxCache.delete(oldestKey)
}

/** Purge entries that have exceeded the TTL. */
function purgeExpiredEntries() {
  for (const [key, entry] of structuredCtxCache) {
    if (Date.now() - entry.timestamp >= STRUCTURED_CTX_CACHE_TTL_MS) {
      structuredCtxCache.delete(key)
    }
  }
}

/** Get structured context cache statistics. For diagnostics only. */
export function getStructuredCtxCacheStats() {
  return {
    size: structuredCtxCache.size,
    maxSize: MAX_CACHE_SIZE,
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    hitRate: cacheStats.hits + cacheStats.misses > 0 ? cacheStats.hits / (cacheStats.hits + cacheStats.misses) : 0,
  }
}

export const defaultLayer = layer.pipe(
  Layer.provide(Skill.defaultLayer),
  Layer.provide(Instruction.defaultLayer),
)

export * as SystemPrompt from "./system"
