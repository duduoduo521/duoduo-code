import { SmartLayerClient } from "./client"

// ─── Types ────────────────────────────────────────────────────────────────

/** Agent scope definition for blackboard initialization. */
export interface BlackboardAgentScope {
  agentId: string
  scope: string[]
}

/** Initial file to seed into the blackboard on init. */
export interface BlackboardInitialFile {
  path: string
  content: string
}

/** Blackboard init request. */
export interface BlackboardInitRequest {
  sessionId: string
  promptId: string
  agentScopes?: BlackboardAgentScope[]
  initialFiles?: BlackboardInitialFile[]
}

/** Blackboard init response. */
export interface BlackboardInitResponse {
  promptId: string
  initialized: boolean
}

/** Blackboard read request (key or filePath, mutually exclusive). */
export interface BlackboardReadRequest {
  promptId: string
  key?: string
  filePath?: string
  agentId?: string
}

/** Blackboard read response. */
export interface BlackboardReadResponse {
  promptId: string
  found: boolean
  content?: string
  version?: number
  astHash?: string
  updatedBy?: string
  updatedAt?: string
}

/** Blackboard write (shared context KV) request. */
export interface BlackboardWriteRequest {
  promptId: string
  agentId: string
  key: string
  value: string
}

/** Blackboard write response. */
export interface BlackboardWriteResponse {
  promptId: string
  key: string
  written: boolean
}

/** A4: prefix listing request for shared-context KV entries. */
export interface BlackboardListRequest {
  promptId: string
  prefix: string
}

export interface BlackboardListEntry {
  key: string
  value: string
  updatedBy: string
  updatedAt: string
}

export interface BlackboardListResponse {
  promptId: string
  entries: BlackboardListEntry[]
}

/** Blackboard submit request (draft or stable file submission). */
export interface BlackboardSubmitRequest {
  promptId: string
  agentId: string
  filePath: string
  content: string
  baseVersion: number
  status: "draft" | "stable"
  baseAstHash?: string
  newAstHash?: string
  planId?: string
  /**
   * When true, ask the Rust side to skip the tree-sitter syntax gate
   * (expert escape hatch). Mirrors `LoopConfig.syntax_check === false`.
   * Defaults to false (syntax check always runs) when omitted.
   */
  skipSyntaxCheck?: boolean
}

/** Blackboard submit response. */
export interface BlackboardSubmitResponse {
  promptId: string
  filePath: string
  success: boolean
  newVersion?: number
  submissionId?: number
  resultType?: string
  detail?: unknown
}

/** Blackboard promote request. */
export interface BlackboardPromoteRequest {
  promptId: string
  agentId: string
  filePath: string
  newAstHash: string
}

/** Blackboard promote response. */
export interface BlackboardPromoteResponse {
  promptId: string
  filePath: string
  promoted: boolean
  newVersion?: number
}

/** Blackboard destroy request. */
export interface BlackboardDestroyRequest {
  promptId: string
}

/** Blackboard destroy response. */
export interface BlackboardDestroyResponse {
  promptId: string
  destroyed: boolean
}

/** Blackboard annotation request (attach a review comment / note to a file). */
export interface BlackboardAnnotationRequest {
  promptId: string
  agentId: string
  filePath: string
  annotationType?: string
  content: string
}

/** Blackboard annotation response. */
export interface BlackboardAnnotationResponse {
  promptId: string
  filePath: string
  annotationId: number
  written: boolean
}

/** Blackboard state (full snapshot). */
export interface BlackboardState {
  [key: string]: unknown
}

// ─── Client ───────────────────────────────────────────────────────────────

/**
 * BlackboardClient provides typed access to the blackboard coordination API.
 *
 * The blackboard enables multi-agent file coordination with per-prompt
 * isolated sessions, including:
 *   - init/destroy: lifecycle management per prompt
 *   - read/write: shared context KV store
 *   - submit: draft/stable file submission with version tracking
 *   - promote: promote a draft to stable
 *   - state: full blackboard snapshot
 */
export class BlackboardClient {
  constructor(private client: SmartLayerClient) {}

  /** Initialize a per-prompt blackboard session. */
  async init(req: BlackboardInitRequest): Promise<BlackboardInitResponse> {
    return this.client.post<BlackboardInitResponse>("/blackboard/init", {
      session_id: req.sessionId,
      prompt_id: req.promptId,
      agent_scopes: req.agentScopes,
      initial_files: req.initialFiles,
    })
  }

  /** Read a shared context key or file from the blackboard. */
  async read(req: BlackboardReadRequest): Promise<BlackboardReadResponse> {
    return this.client.post<BlackboardReadResponse>("/blackboard/read", {
      prompt_id: req.promptId,
      key: req.key,
      file_path: req.filePath,
      agent_id: req.agentId,
    })
  }

  /** Write a shared context key-value pair to the blackboard. */
  async write(req: BlackboardWriteRequest): Promise<BlackboardWriteResponse> {
    return this.client.post<BlackboardWriteResponse>("/blackboard/write", {
      prompt_id: req.promptId,
      agent_id: req.agentId,
      key: req.key,
      value: req.value,
    })
  }

  /** A4: list shared context entries whose key starts with `prefix`. */
  async list(req: BlackboardListRequest): Promise<BlackboardListResponse> {
    return this.client.post<BlackboardListResponse>("/blackboard/list", {
      prompt_id: req.promptId,
      prefix: req.prefix,
    })
  }

  /** Submit a file draft or stable version to the blackboard. */
  async submit(req: BlackboardSubmitRequest): Promise<BlackboardSubmitResponse> {
    return this.client.post<BlackboardSubmitResponse>("/blackboard/submit", {
      prompt_id: req.promptId,
      agent_id: req.agentId,
      file_path: req.filePath,
      content: req.content,
      base_version: req.baseVersion,
      status: req.status,
      base_ast_hash: req.baseAstHash,
      new_ast_hash: req.newAstHash,
      plan_id: req.planId,
      skip_syntax_check: req.skipSyntaxCheck ?? false,
    })
  }

  /** Promote a draft submission to stable. */
  async promote(req: BlackboardPromoteRequest): Promise<BlackboardPromoteResponse> {
    return this.client.post<BlackboardPromoteResponse>("/blackboard/promote", {
      prompt_id: req.promptId,
      agent_id: req.agentId,
      file_path: req.filePath,
      new_ast_hash: req.newAstHash,
    })
  }

  /** Destroy a per-prompt blackboard session, releasing resources. */
  async destroy(req: BlackboardDestroyRequest): Promise<BlackboardDestroyResponse> {
    return this.client.post<BlackboardDestroyResponse>("/blackboard/destroy", {
      prompt_id: req.promptId,
    })
  }

  /** Attach an annotation (e.g. a code-review comment) to a file on the blackboard. */
  async annotate(req: BlackboardAnnotationRequest): Promise<BlackboardAnnotationResponse> {
    return this.client.post<BlackboardAnnotationResponse>("/blackboard/annotate", {
      prompt_id: req.promptId,
      agent_id: req.agentId,
      file_path: req.filePath,
      annotation_type: req.annotationType,
      content: req.content,
    })
  }

  /** Get the full blackboard state snapshot for a prompt. */
  async state(promptId: string): Promise<BlackboardState> {
    return this.client.get<BlackboardState>("/blackboard/state", { prompt_id: promptId })
  }

  /**
   * Fetch the CURRENT version + ast hash of a file (P1-04). Used by submit
   * callers to send a truthful `baseVersion`/`baseAstHash` to the optimistic
   * lock — the previous hard-coded `baseVersion: 0` made every SECOND submit
   * to the same file conflict. Returns `found: false` for files that have no
   * blackboard version yet (base 0 / empty hash is then truthful).
   */
  async getVersion(promptId: string, filePath: string): Promise<{
    found: boolean
    version?: number
    astHash?: string
  }> {
    return this.client.post<{ prompt_id: string; file_path: string; found: boolean; version?: number; ast_hash?: string }>(
      "/blackboard/version",
      { prompt_id: promptId, file_path: filePath },
    ).then((r) => ({
      found: r.found,
      version: r.version,
      astHash: r.ast_hash,
    }))
  }
}
