import { Schema } from "effect"

// This module used to hold the whole Super-RAG vocabulary (ElementRole,
// RSTRelation, NarrativeElement, RhetoricGraph, Blueprint, StructuredBudget,
// BridgeContext, the `Mutable*` aliases and the deprecated `Rhetorical*`
// aliases). That pipeline now lives entirely in the Rust `context-builder`
// crate, and nothing in `packages/**` referenced any of it — the only
// importers were this file's own tests. What remains is the part the TS
// cascade QA path actually consumes.

// ============================================================================
// TaskPhase — kept for system prompt integration
// ============================================================================

export const TaskPhase = Schema.Literals(["investigate", "plan", "execute", "verify"])
export type TaskPhase = Schema.Schema.Type<typeof TaskPhase>

// ============================================================================
// CascadeInput — kept unchanged
// ============================================================================

export class CascadeInput extends Schema.Class<CascadeInput>("CascadeInput")({
  filepath: Schema.String,
  content: Schema.String,
  language: Schema.optional(Schema.String),
}) {}

// ============================================================================
// CascadeReport — kept unchanged
// ============================================================================

export class CascadeReport extends Schema.Class<CascadeReport>("CascadeReport")({
  passed: Schema.Boolean,
  fixed: Schema.Boolean,
  content: Schema.String,
  issues: Schema.Array(
    Schema.Struct({
      severity: Schema.Literals(["error", "warning", "info"]),
      message: Schema.String,
      line: Schema.optional(Schema.Number),
    }),
  ),
  retries: Schema.Number,
  /** LLM content-correctness verdict (only present when LLM check enabled). */
  llmVerdict: Schema.optional(
    Schema.Struct({
      passed: Schema.Boolean,
      reason: Schema.String,
    }),
  ),
}) {}

export * as Types from "./types"
