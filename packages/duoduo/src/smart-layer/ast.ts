import { SmartLayerClient } from "./client"

// ─── Types ────────────────────────────────────────────────────────────────

export interface ValidateSyntaxRequest {
  code: string
  language: string
}

/** Wire format of `duo_types::FunctionDef` (`common.rs:701-713`, camelCase). */
export interface FunctionDef {
  name: string
  returnType?: string
  startLine: number
  endLine: number
  parameters?: string[]
  documentation?: string
}

export interface ValidateSyntaxResponse {
  valid: boolean
  errors: string[]
  /** `FunctionDef[]` objects, NOT strings — the old `string[]` declaration
   * never matched the payload. */
  functions: FunctionDef[]
  language: string
}

/**
 * Wire format of `StructuralDiffRequest` (`routes/ast.rs:30-37`, NO
 * `rename_all` ⇒ snake_case keys). `agentId` is a required `String` on the
 * Rust side — the old camelCase keys made every call 400.
 */
export interface StructuralDiffRequest {
  file_path: string
  old_code: string
  new_code: string
  language: string
  agent_id: string
}

/** Wire format of `FileChangeEntry` (`duo-types/blackboard.rs:63-69`, no
 * rename ⇒ snake_case). */
export interface StructuredChange {
  symbol_name: string
  change_kind: string
  old_signature: string
  new_signature: string
}

/** Wire format of `StructuredChangeList` (`blackboard.rs:72-77`). */
export interface StructuralDiffResponse {
  file: string
  agent_id: string
  changes: StructuredChange[]
}

export interface ComputeHashRequest {
  code: string
  language: string
}
export interface ComputeHashResponse {
  hash: string
}

// ─── Client ───────────────────────────────────────────────────────────────

/**
 * AstClient provides typed access to the AST analysis API.
 *
 * Supports:
 *   - validateSyntax: check code syntax and extract functions
 *   - structuralDiff: compute structured changes between two code versions
 *   - computeHash: compute an AST-based hash for change detection
 */
export class AstClient {
  constructor(private client: SmartLayerClient) {}

  /** Validate code syntax and extract function names. */
  async validateSyntax(req: ValidateSyntaxRequest): Promise<ValidateSyntaxResponse> {
    return this.client.post<ValidateSyntaxResponse>("/ast/validate-syntax", req)
  }

  /** Compute structured changes between two code versions. */
  async structuralDiff(req: StructuralDiffRequest): Promise<StructuralDiffResponse> {
    return this.client.post<StructuralDiffResponse>("/ast/structural-diff", req)
  }

  /** Compute an AST-based hash for change detection. */
  async computeHash(req: ComputeHashRequest): Promise<ComputeHashResponse> {
    return this.client.post<ComputeHashResponse>("/ast/compute-hash", req)
  }
}
