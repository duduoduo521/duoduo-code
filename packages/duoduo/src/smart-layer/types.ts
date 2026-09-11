// ─── Memory System Types ───

export interface MemoryEntry {
  id: string
  content: string
  summary?: string
  layer: string
  score: number
  created_at: string
  tags: string[]
  metadata?: unknown
  project_path?: string
  importance?: number
  pin?: boolean
  compressed?: boolean
  session_id?: string
  memory_type?: string
  updated_at?: string
}

export interface MemorySearchRequest {
  query: string
  limit?: number
  layers?: string[]
  tags?: string[]
}

export interface MemoryStoreRequest {
  content: string
  summary?: string
  layer: string
  importance?: number
  pin?: boolean
  session_id?: string
  memory_type?: string
  metadata?: unknown
  tags?: string[]
}

export interface MemoryDeleteResponse {
  deleted: number
  vacuumed: boolean
}

// ─── Quality Types ───

export interface CodeArtifact {
  type: string
  content: string
  language: string
  /** Wire format is camelCase — `QualityCodeArtifact` in `duo-types/pipeline.rs`
   * carries `#[serde(rename_all = "camelCase")]`. */
  filePath?: string
}

export interface QualityValidateRequest {
  artifact: CodeArtifact
  /** Wire format is camelCase (`qualityLevel`) — the Rust struct renames. Note
   * this differs from the blackboard structs, which have NO `rename_all` and
   * therefore use snake_case on the wire. */
  qualityLevel: QualityLevel
  interfaceContract?: InterfaceContract
  sharedTypes?: SharedTypeDefinition[]
  /** When true, the Rust pipeline uses the user's configured LLM for a
   * content-correctness judgment. Offline / no-LLM → silently degrades to regex. */
  enableLlmCheck?: boolean
  /** Diff (before -> after) for the LLM content judgment context. */
  diff?: string
  /** Related dependencies (from knowledge graph) as LLM context. */
  kgRelated?: string[]
}

export type QualityLevel = "self_check" | "cross_review" | "standard" | "full" | "interface_consistency"

export interface LlmVerdict {
  passed: boolean
  reason: string
}

export interface QualityReport {
  passed: boolean
  score: number
  checks: QualityCheck[]
  suggestions: string[]
  llmVerdict?: LlmVerdict
}

export interface QualityCheck {
  name: string
  passed: boolean
  score: number
}

// ─── Intent Types ───

export interface IntentClarifyRequest {
  /** camelCase — `IntentClarifyRequest` (common.rs) has
   * `rename_all = "camelCase"`; the old `user_input` key never matched and the
   * required field's absence made every call 400. */
  userInput: string
  projectContext?: Record<string, string>
}

export interface ClarificationResult {
  intentType: string
  confidence: number
  entities: Entity[]
  ambiguities: Ambiguity[]
  suggestedMode: SuggestedMode
}

export interface Entity {
  name: string
  value: string
}

export interface Ambiguity {
  question: string
  options: string[]
}

export type SuggestedMode = "Chat" | "Agent"

// ─── Health Check ───

export interface HealthResponse {
  status: string
  version: string
  uptime_seconds: number
}

// ─── Smart Layer Config ───

export interface SmartLayerConfig {
  url: string
  timeout: number
}

// ─── Architecture Contract Types ──────────────────────

export interface MethodContract {
  params?: string[]
  returnType?: string
  description?: string
  sideEffects?: string[]
}

export interface InterfaceContract {
  extends?: string
  properties: Record<string, string>
  methods: Record<string, MethodContract>
  /** Cross-file related entities (1-hop KG neighbors that live in OTHER files,
   * e.g. callers/callees, imported types, overridden symbols). Used to enrich
   * LLM content-check context (kgRelated) with true cross-file dependencies. */
  related?: string[]
}

export interface SharedTypeDefinition {
  name: string
  kind: "enum" | "dto" | "constant"
  values?: string[]
  fields?: Record<string, string>
  value?: unknown
  file: string
}

export interface FilePlanEntry {
  path: string
  description: string
  interface?: InterfaceContract
  dependsOn: string[]
}

export interface ArchitectureContract {
  outputDocument?: string
  sharedTypes: SharedTypeDefinition[]
  constants: Record<string, unknown>
  codingStandards?: string
  filePlan: FilePlanEntry[]
}

export interface FileLayer {
  layerIndex: number
  entries: FilePlanEntry[]
}

export interface ToolDefinition {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolCall {
  id: string
  type: string
  function: {
    name: string
    arguments: string
  }
}

export interface AgenticLoopResult {
  filePath: string
  content: string
  roundsUsed: number
  filesRead: string[]
  validationWarnings: string[]
}
