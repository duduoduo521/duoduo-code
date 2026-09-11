/**
 * Smart Layer Client — unified entry point for the duo-smart-layer Rust sidecar.
 *
 * Usage:
 *   const clients = createSmartLayerClients()
 *   if (clients) {
 *     const results = await clients.memory.search("auth", 20)
 *   }
 *
 * When the smart layer is unavailable (no env var or connection failure),
 * createSmartLayerClients() returns null, allowing the app to degrade gracefully.
 */

export { SmartLayerClient, SmartLayerError } from "./client"
export { AgentClient } from "./agent"
export type { LoopConfig, SubTaskRequest } from "./agent"
export { decomposeTask } from "./decompose"
export { MemoryClient } from "./memory"
export { QualityClient } from "./quality"
export { IntentClient } from "./intent"
export { GraphClient } from "./graph"
export { BlackboardClient } from "./blackboard"
export { AstClient } from "./ast"
export { PlanClient } from "./plan"

export type {
  SmartLayerConfig,
  // Memory
  MemoryEntry,
  MemorySearchRequest,
  MemoryStoreRequest,

  // Quality
  CodeArtifact,
  QualityValidateRequest,
  QualityLevel,
  QualityReport,
  QualityCheck,
  // Intent
  IntentClarifyRequest,
  ClarificationResult,
  Entity,
  Ambiguity,
  SuggestedMode,
  // Health
  HealthResponse,
} from "./types"

import { SmartLayerClient } from "./client"
import { AgentClient } from "./agent"
import { MemoryClient } from "./memory"
import { QualityClient } from "./quality"
import { IntentClient } from "./intent"
import { GraphClient } from "./graph"
import { BlackboardClient } from "./blackboard"
import { AstClient } from "./ast"
import { PlanClient } from "./plan"
import type { SmartLayerConfig } from "./types"
import fs from "fs"
import path from "path"
import os from "os"

/** All smart layer sub-clients bundled together. */
export interface SmartLayerClients {
  client: SmartLayerClient
  agent: AgentClient
  memory: MemoryClient
  quality: QualityClient
  intent: IntentClient
  graph: GraphClient
  blackboard: BlackboardClient
  ast: AstClient
  plan: PlanClient
}

/**
 * Resolve the data directory used by the Rust Tauri app (`duo_utils::path::data_dir()`).
 *
 * The Rust side uses `XDG_DATA_HOME/duoduo` if `XDG_DATA_HOME` is set,
 * otherwise falls back to the OS-standard data directory joined with `"duoduo"`.
 * This must match the path written by `write_smart_layer_url_file()` in
 * `smart_layer.rs`.
 */
function rustDataDir(): string {
  const isWindows = process.platform === "win32"
  const isMac = process.platform === "darwin"

  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, "duoduo")
  }
  if (isWindows) {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "duoduo")
  }
  if (isMac) {
    return path.join(os.homedir(), "Library", "Application Support", "duoduo")
  }
  // Linux / other Unix
  return path.join(os.homedir(), ".local", "share", "duoduo")
}

/**
 * Discover the smart-layer URL (and password) from the well-known file written
 * by the Rust Tauri app. Returns `undefined` if the file does not exist,
 * cannot be read, or has no URL line. The file format is `url\npassword`
 * (password is optional for backward compatibility with old single-line files).
 */
function discoverSmartLayerUrlFromFile():
  | { url: string; password?: string }
  | undefined {
  const urlFile = path.join(rustDataDir(), "smart-layer-url")
  try {
    const content = fs.readFileSync(urlFile, "utf-8")
    const lines = content.split("\n")
    const url = lines[0]?.trim()
    const password = lines[1]?.trim() || undefined
    if (!url) return undefined
    return { url, password }
  } catch {
    return undefined
  }
}

/**
 * Create a full set of smart layer clients from environment variables.
 *
 * Reads:
 *   - DUO_SMART_LAYER_URL (required, e.g. "http://127.0.0.1:12345")
 *   - DUO_SMART_LAYER_TIMEOUT (optional, ms, default 30000)
 *   - DUO_SMART_LAYER_USERNAME (optional, for Basic Auth)
 *   - DUO_SMART_LAYER_PASSWORD (optional, for Basic Auth)
 *
 * If `DUO_SMART_LAYER_URL` is not set, falls back to the URL file written
 * by the Rust Tauri app (runtime discovery for the case where smart-layer
 * was not ready at sidecar spawn time).
 *
 * Returns null when no URL is available, so callers can degrade gracefully
 * without memory/pipeline enhancements.
 */

/**
 * Cached singleton — reuses HTTP connections across calls within the same process.
 */
let cachedClients: SmartLayerClients | null = null
let cachedUrl: string | undefined

export function createSmartLayerClients(): SmartLayerClients | null {
  // Environment variable takes priority; fall back to the URL file
  // written by the Rust Tauri app for runtime discovery.
  const fileDiscovered = discoverSmartLayerUrlFromFile()
  const url = process.env.DUO_SMART_LAYER_URL || fileDiscovered?.url
  if (!url) {
    // Don't cache the null result — the URL file may appear later.
    // Only cache when we have a valid URL so that subsequent calls
    // can retry file discovery.
    cachedClients = null
    cachedUrl = undefined
    return null
  }

  // Return cached instance if URL hasn't changed
  if (cachedClients && cachedUrl === url) return cachedClients

  const timeout = Number(process.env.DUO_SMART_LAYER_TIMEOUT) || 30000
  const { username, password } = resolveSmartLayerCredentials(fileDiscovered)

  const config: SmartLayerConfig = { url, timeout }
  const client = new SmartLayerClient(config, username && password ? { username, password } : undefined)

  cachedUrl = url
  cachedClients = {
    client,
    agent: new AgentClient(client),
    memory: new MemoryClient(client),
    quality: new QualityClient(client),
    intent: new IntentClient(client),
    graph: new GraphClient(client),
    blackboard: new BlackboardClient(client),
    ast: new AstClient(client),
    plan: new PlanClient(client),
  }

  return cachedClients
}

/**
 * Resolve smart-layer credentials with the same precedence as the clients:
 * env vars first, then the password from the well-known URL file. When the
 * password comes from the file the username defaults to `"smart-layer"` (the
 * file only carries url + password). An absent password degrades to "no auth"
 * rather than throwing.
 */
function resolveSmartLayerCredentials(
  fileDiscovered: { url: string; password?: string } | undefined,
): { username?: string; password?: string } {
  const password = process.env.DUO_SMART_LAYER_PASSWORD || fileDiscovered?.password
  // The Rust sidecar validates the username against its constant
  // "smart-layer" (`SMART_LAYER_AUTH_USER`) and the desktop never injects
  // `DUO_SMART_LAYER_USERNAME`, so any available password must be paired with
  // that default — otherwise the header is omitted and every request 401s.
  const username = process.env.DUO_SMART_LAYER_USERNAME || (password ? "smart-layer" : undefined)
  return { username, password }
}

/**
 * Resolve the smart-layer connection (URL + Basic-Auth header) using the same
 * precedence as {@link createSmartLayerClients}. Raw-`fetch` callers (the
 * streaming endpoints in `session/llm.ts` cannot go through `SmartLayerClient`)
 * MUST use this: in desktop mode the Rust sidecar is spawned with
 * `DUO_SMART_LAYER_PASSWORD` and `require_auth` rejects unauthenticated
 * requests with 401, so discovering the URL without the credentials still
 * fails (P0-06).
 *
 * Returns `undefined` when no URL is available — callers must not cache that
 * result, because the URL file may appear later (smart-layer is spawned
 * fire-and-forget).
 */
export function resolveSmartLayerConnection():
  | { url: string; authHeader?: string }
  | undefined {
  const fileDiscovered = discoverSmartLayerUrlFromFile()
  const url = process.env.DUO_SMART_LAYER_URL || fileDiscovered?.url
  if (!url) return undefined
  const { username, password } = resolveSmartLayerCredentials(fileDiscovered)
  return {
    url,
    authHeader: username && password ? `Basic ${btoa(`${username}:${password}`)}` : undefined,
  }
}


