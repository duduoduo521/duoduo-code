import { DuoduoError } from "@/util/error"
import z from "zod"
import { Effect, Cause } from "effect"
import * as Tool from "./tool"
import { createSmartLayerClients } from "@/smart-layer"
import { resolveBlackboardSubmitBase } from "./cascade-flow"

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Resolve the promptId used to scope blackboard access.
 *
 * Tool.Context does not expose a dedicated `promptID` field, so we fall
 * back to the session ID, which uniquely identifies the current conversation
 * / task and is the correct scoping key for the blackboard.
 */
function promptIdFromContext(ctx: Tool.Context): string {
  const extra = ctx.extra as Record<string, unknown> | undefined
  const explicit = extra?.["promptID"]
  if (typeof explicit === "string" && explicit.length > 0) return explicit
  return ctx.sessionID
}

/** Common metadata shape so all return paths type-check uniformly. */
interface BlackboardMetadata {
  success: boolean
  source: string
  promptId: string
  found?: boolean
  key?: string
  filePath?: string
  version?: string
  count?: number
  id?: string
}

function unavailable(promptId: string, title: string): { title: string; metadata: BlackboardMetadata; output: string } {
  return {
    title,
    metadata: { success: false, source: "blackboard", promptId },
    output: "Blackboard is not available (smart layer not configured). Set DUO_SMART_LAYER_URL to enable.",
  }
}

/**
 * Resolve whether the Rust-side "语法校验" (syntax_check) switch is OFF, in
 * which case the tree-sitter L1 gate should be skipped on stable submission.
 * Mirrors how Rust native edits derive `skip_syntax_check = !syntax_check`.
 *
 * Falls back to `false` (gate ON) if the loop config cannot be read, so the
 * syntax gate is never silently disabled.
 */
export function fetchSkipSyntaxCheck(clients: ReturnType<typeof createSmartLayerClients>): Effect.Effect<boolean> {
  if (!clients?.agent) return Effect.succeed(false)
  return Effect.tryPromise({
    try: () => clients.agent.getLoopConfig(),
    catch: (e) => new Cause.UnknownError(e),
  }).pipe(
    Effect.orElseSucceed(() => ({ syntaxCheck: true })),
    Effect.map((cfg) => cfg.syntaxCheck === false),
  )
}

// ─── blackboard_read ───────────────────────────────────────────────────────

const readParameters = z.object({
  key: z
    .string()
    .optional()
    .describe(
      'The blackboard key to read (e.g. "architecture", "api-contract"). Either key or filePath must be provided.',
    ),
  filePath: z
    .string()
    .optional()
    .describe(
      "A file path whose content was previously submitted to the blackboard. When provided, the stored file content is returned.",
    ),
})

export const BlackboardReadTool = Tool.define(
  "blackboard_read",
  Effect.gen(function* () {
    return {
      description: [
        "- Read content from the shared blackboard for the current task",
        "- Retrieve a shared context value by `key`, or a previously submitted file by `filePath`",
        "- Use this to coordinate work and avoid duplicating effort across sub-agents",
      ].join("\n"),
      parameters: readParameters,
      execute: (params: z.infer<typeof readParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const promptId = promptIdFromContext(ctx)
          const clients = createSmartLayerClients()
          if (!clients) return unavailable(promptId, params.key ?? params.filePath ?? "blackboard")

          const result = yield* Effect.tryPromise({
            try: () =>
              clients.blackboard.read({
                promptId,
                key: params.key,
                filePath: params.filePath,
                agentId: ctx.agent,
              }),
            catch: (error) =>
              new DuoduoError({ message: String(`blackboard_read failed: ${error instanceof Error ? error.message : String(error)}`), cause: error }),
          })

          const meta: BlackboardMetadata = {
            success: result.found,
            source: "blackboard",
            promptId,
            found: result.found,
            key: params.key,
            filePath: params.filePath,
            version: result.version !== undefined ? String(result.version) : undefined,
          }

          const lines: string[] = [`<blackboard_read promptId="${promptId}">`]
          if (params.key) lines.push(`<key>${params.key}</key>`)
          if (params.filePath) lines.push(`<filePath>${params.filePath}</filePath>`)
          if (!result.found) {
            lines.push("<result>not found</result>")
          } else {
            lines.push("<result>")
            lines.push(`found: ${result.found}`)
            if (result.version !== undefined) lines.push(`version: ${result.version}`)
            if (result.updatedBy) lines.push(`updatedBy: ${result.updatedBy}`)
            if (result.updatedAt) lines.push(`updatedAt: ${result.updatedAt}`)
            if (result.content) lines.push("<content>")
            if (result.content) lines.push(result.content)
            if (result.content) lines.push("</content>")
            lines.push("</result>")
          }
          lines.push("</blackboard_read>")

          return {
            title: params.key ?? params.filePath ?? "blackboard",
            metadata: meta,
            output: lines.join("\n"),
          }
        }),
    }
  }),
)

// ─── blackboard_write ─────────────────────────────────────────────────────

const writeParameters = z.object({
  key: z.string().describe('A short, stable identifier for this finding (e.g. "auth-flow", "db-schema").'),
  value: z.string().describe("The finding content / value to store on the blackboard."),
})

export const BlackboardWriteTool = Tool.define(
  "blackboard_write",
  Effect.gen(function* () {
    return {
      description: [
        "- Write a finding to the shared blackboard so other sub-agents can read it",
        "- Use a stable `key` so the finding can be retrieved by `blackboard_read`",
        "- Include enough context that a sub-agent who did not do the work can act on it",
        "- Do not write ephemeral progress updates here; reserve it for durable, shareable findings",
      ].join("\n"),
      parameters: writeParameters,
      execute: (params: z.infer<typeof writeParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const promptId = promptIdFromContext(ctx)
          const clients = createSmartLayerClients()
          if (!clients) return unavailable(promptId, `write: ${params.key}`)

          const result = yield* Effect.tryPromise({
            try: () =>
              clients.blackboard.write({
                promptId,
                agentId: ctx.agent,
                key: params.key,
                value: params.value,
              }),
            catch: (error) =>
              new DuoduoError({ message: String(`blackboard_write failed: ${error instanceof Error ? error.message : String(error)}`), cause: error }),
          })

          return {
            title: `write: ${params.key}`,
            metadata: {
              success: result.written,
              source: "blackboard",
              promptId,
              key: params.key,
            } as BlackboardMetadata,
            output: result.written
              ? `Finding "${params.key}" written to blackboard.`
              : `Finding "${params.key}" was not stored.`,
          }
        }),
    }
  }),
)

// ─── blackboard_find ──────────────────────────────────────────────────────

const findParameters = z.object({
  query: z
    .string()
    .optional()
    .describe("Search query used to filter blackboard context entries. When omitted, all entries are returned."),
  limit: z.coerce.number().optional().describe("Maximum number of entries to return (default 20)."),
})

export const BlackboardFindTool = Tool.define(
  "blackboard_find",
  Effect.gen(function* () {
    return {
      description: [
        "- Retrieve the full blackboard state snapshot for the current task",
        "- Optionally filter context entries by a `query` substring (case-insensitive)",
        "- Useful when you do not know the exact `key` but need to discover prior findings",
        "- Returns a JSON snapshot of all keys and file submissions on the blackboard",
      ].join("\n"),
      parameters: findParameters,
      execute: (params: z.infer<typeof findParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const promptId = promptIdFromContext(ctx)
          const clients = createSmartLayerClients()
          if (!clients) return unavailable(promptId, "blackboard_find")

          const state = yield* Effect.tryPromise({
            try: () => clients.blackboard.state(promptId),
            catch: (error) =>
              new DuoduoError({ message: String(`blackboard_find failed: ${error instanceof Error ? error.message : String(error)}`), cause: error }),
          })

          // The state is a free-form record; filter entries by query if provided.
          const entries = Object.entries(state)
          const query = params.query?.toLowerCase()
          const filtered = query
            ? entries.filter(([k, v]) => k.toLowerCase().includes(query) || String(v).toLowerCase().includes(query))
            : entries
          const limit = params.limit ?? 20
          const sliced = filtered.slice(0, limit)

          const lines: string[] = [`<blackboard_find promptId="${promptId}">`]
          lines.push(`<total>${filtered.length}</total>`)
          if (sliced.length > 0) {
            lines.push("<entries>")
            for (const [key, value] of sliced) {
              lines.push(`  <entry key="${key}">`)
              lines.push(`    ${String(value)}`)
              lines.push("  </entry>")
            }
            lines.push("</entries>")
          } else {
            lines.push("<entries>(no matches)</entries>")
          }
          lines.push("</blackboard_find>")

          return {
            title: params.query ?? "blackboard_find",
            metadata: {
              success: true,
              source: "blackboard",
              promptId,
              count: sliced.length,
            } as BlackboardMetadata,
            output: lines.join("\n"),
          }
        }),
    }
  }),
)

// ─── blackboard_submit_draft ─────────────────────────────────────────────

const draftParameters = z.object({
  filePath: z.string().describe("The path of the file the draft corresponds to."),
  content: z.string().describe("The full content of the code draft."),
  baseVersion: z.coerce
    .number()
    .optional()
    .describe("Explicit base version override. Omit to use the file's current blackboard version."),
  planId: z.string().optional().describe("Optional plan ID linking this submission to a specific plan."),
})

export const BlackboardSubmitDraftTool = Tool.define(
  "blackboard_submit_draft",
  Effect.gen(function* () {
    return {
      description: [
        "- Submit a code draft to the blackboard for the current task",
        "- Drafts are work-in-progress and can be superseded by later submissions",
        "- Other sub-agents can read drafts via `blackboard_read` with `filePath`",
        "- Use `blackboard_submit_stable` once the code is reviewed and ready",
      ].join("\n"),
      parameters: draftParameters,
      execute: (params: z.infer<typeof draftParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const promptId = promptIdFromContext(ctx)
          const clients = createSmartLayerClients()
          if (!clients) return unavailable(promptId, `draft: ${params.filePath}`)

          const skipSyntaxCheck = yield* fetchSkipSyntaxCheck(clients)

          const result = yield* Effect.tryPromise({
            try: async () => {
              // Query the CURRENT version: defaulting to 0 accepted the first
              // submit and made every later one conflict (P1-04). An explicit
              // `baseVersion` argument still wins over the lookup.
              const base = await resolveBlackboardSubmitBase(
                clients.blackboard,
                promptId,
                params.filePath,
                params.content,
              )
              return clients.blackboard.submit({
                promptId,
                agentId: ctx.agent,
                filePath: params.filePath,
                content: params.content,
                baseVersion: params.baseVersion ?? base.baseVersion,
                baseAstHash: base.baseAstHash,
                newAstHash: base.newAstHash,
                status: "draft",
                planId: params.planId,
                skipSyntaxCheck,
              })
            },
            catch: (error) =>
              new DuoduoError({ message: String(`blackboard_submit_draft failed: ${error instanceof Error ? error.message : String(error)}`), cause: error }),
          })

          return {
            title: `draft: ${params.filePath}`,
            metadata: {
              success: result.success,
              source: "blackboard",
              promptId,
              filePath: params.filePath,
              version: result.newVersion !== undefined ? String(result.newVersion) : undefined,
              id: result.submissionId !== undefined ? String(result.submissionId) : undefined,
            } as BlackboardMetadata,
            output: result.success
              ? `Draft for "${params.filePath}" submitted to blackboard${result.newVersion !== undefined ? ` (version ${result.newVersion})` : ""}.`
              : `Draft for "${params.filePath}" was not stored${result.resultType ? ` (${result.resultType})` : ""}.`,
          }
        }),
    }
  }),
)

// ─── blackboard_submit_stable ─────────────────────────────────────────────

const stableParameters = z.object({
  filePath: z.string().describe("The path of the file the stable version corresponds to."),
  content: z.string().describe("The full content of the stable version."),
  baseVersion: z.coerce
    .number()
    .optional()
    .describe("Explicit base version override. Omit to use the file's current blackboard version."),
  planId: z.string().optional().describe("Optional plan ID linking this submission to a specific plan."),
})

export const BlackboardSubmitStableTool = Tool.define(
  "blackboard_submit_stable",
  Effect.gen(function* () {
    return {
      description: [
        "- Submit a stable, reviewed version of code to the blackboard",
        "- Stable versions supersede drafts for the same file path",
        "- Use this only when the code is tested and ready for other sub-agents to consume",
        "- Other sub-agents can read stable versions via `blackboard_read` with `filePath`",
      ].join("\n"),
      parameters: stableParameters,
      execute: (params: z.infer<typeof stableParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const promptId = promptIdFromContext(ctx)
          const clients = createSmartLayerClients()
          if (!clients) return unavailable(promptId, `stable: ${params.filePath}`)

          const skipSyntaxCheck = yield* fetchSkipSyntaxCheck(clients)

          const result = yield* Effect.tryPromise({
            try: async () => {
              // Query the CURRENT version: defaulting to 0 accepted the first
              // submit and made every later one conflict (P1-04). An explicit
              // `baseVersion` argument still wins over the lookup.
              const base = await resolveBlackboardSubmitBase(
                clients.blackboard,
                promptId,
                params.filePath,
                params.content,
              )
              return clients.blackboard.submit({
                promptId,
                agentId: ctx.agent,
                filePath: params.filePath,
                content: params.content,
                baseVersion: params.baseVersion ?? base.baseVersion,
                baseAstHash: base.baseAstHash,
                newAstHash: base.newAstHash,
                status: "stable",
                planId: params.planId,
                skipSyntaxCheck,
              })
            },
            catch: (error) =>
              new DuoduoError({ message: String(`blackboard_submit_stable failed: ${error instanceof Error ? error.message : String(error)}`), cause: error }),
          })

          return {
            title: `stable: ${params.filePath}`,
            metadata: {
              success: result.success,
              source: "blackboard",
              promptId,
              filePath: params.filePath,
              version: result.newVersion !== undefined ? String(result.newVersion) : undefined,
              id: result.submissionId !== undefined ? String(result.submissionId) : undefined,
            } as BlackboardMetadata,
            output: result.success
              ? `Stable version for "${params.filePath}" submitted to blackboard${result.newVersion !== undefined ? ` (version ${result.newVersion})` : ""}.`
              : `Stable version for "${params.filePath}" was not stored${result.resultType ? ` (${result.resultType})` : ""}.`,
          }
        }),
    }
  }),
)

// ─── blackboard_annotate ──────────────────────────────────────────────────

const annotateParameters = z.object({
  filePath: z.string().describe("The path of the file the annotation is attached to."),
  content: z.string().describe("The review comment / annotation text."),
  annotationType: z.string().optional().describe("Annotation category (default 'review')."),
})

export const BlackboardAnnotateTool = Tool.define(
  "blackboard_annotate",
  Effect.gen(function* () {
    return {
      description: [
        "- Attach a review comment / annotation to a file on the blackboard",
        "- Annotations are surfaced to the main loop's self-review (Reflect) phase",
        "- Use after identifying an issue during code review",
      ].join("\n"),
      parameters: annotateParameters,
      execute: (params: z.infer<typeof annotateParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const promptId = promptIdFromContext(ctx)
          const clients = createSmartLayerClients()
          if (!clients) return unavailable(promptId, `annotate: ${params.filePath}`)

          const result = yield* Effect.tryPromise({
            try: () =>
              clients.blackboard.annotate({
                promptId,
                agentId: ctx.agent,
                filePath: params.filePath,
                content: params.content,
                annotationType: params.annotationType,
              }),
            catch: (error) =>
              new DuoduoError({ message: String(`blackboard_annotate failed: ${error instanceof Error ? error.message : String(error)}`), cause: error }),
          })

          return {
            title: `annotate: ${params.filePath}`,
            metadata: {
              success: result.written,
              source: "blackboard",
              promptId,
              filePath: params.filePath,
              id: String(result.annotationId),
            } as BlackboardMetadata,
            output: result.written
              ? `Annotation for "${params.filePath}" recorded on blackboard (id ${result.annotationId}).`
              : `Annotation for "${params.filePath}" was not stored.`,
          }
        }),
    }
  }),
)
